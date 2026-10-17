import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createImageSourceCache, createImageSourceRedactor, imageSourceIdentity,
    redactImageSourceHandles, createImageSourceMiddleware } from '../defaults/qqbot-image-sources.mjs';

const owner = { appId: '123456', scope: 'group', peerId: 'group-a', ownerId: 'alice' };
const attachment = { contentType: 'image/png', filename: 'quoted.png', url: 'https://example.test/image?rkey=PRIVATE' };
const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function bound(cache, identity = owner, session = 'session-a') {
    const ticket = cache.snapshot(identity);
    assert.equal(cache.bind(ticket, identity, session), true);
    return ticket;
}

test('generated sources survive new requests with fresh tickets, fixed TTL and owner/session isolation', async () => {
    let now = 100;
    const cache = createImageSourceCache({ now: () => now, generatedTtlMs: 100, cleanup: false });
    const original = bound(cache);
    const receipt = cache.publish(original, bytes, 'session-a');
    assert.match(receipt.editableHandle, /^imgsrc_/u);
    assert.equal(cache.available(original, receipt.editableHandle), false, 'later outputs cannot backfill a queued request');
    cache.close(original);
    for (let i = 0; i < 2; i++) {
        const ticket = bound(cache);
        assert.equal(cache.listed(ticket).length, 1);
        assert.deepEqual(await cache.read(ticket, receipt.editableHandle, () => assert.fail('generated source must not fetch'), undefined), bytes);
        cache.close(ticket);
    }
    for (const identity of [{ ...owner, ownerId: 'bob' }, { ...owner, peerId: 'group-b' }, { ...owner, appId: '9876' }]) {
        const ticket = bound(cache, identity);
        assert.equal(cache.available(ticket, receipt.editableHandle), false);
    }
    assert.equal(cache.available(bound(cache, owner, 'new-session'), receipt.editableHandle), false);
    now = 201;
    assert.equal(cache.listed(bound(cache)).length, 0);
    assert.equal(cache.stats().bytes, 0);
});

test('quoted metadata stays lazy, bytes are retained only after authorized use, and analysis does not consume edits', async () => {
    let now = 0;
    const cache = createImageSourceCache({ now: () => now, quotedTtlMs: 100, cleanup: false });
    cache.captureQuote(owner, [attachment]);
    assert.equal(cache.stats().bytes, 0);
    let loads = 0;
    const look = bound(cache);
    const ref = cache.listed(look)[0];
    await cache.read(look, ref.handle, async url => { loads++; assert.equal(url, attachment.url); return bytes; });
    cache.close(look);
    now = 80;
    const edit = bound(cache);
    const release = cache.lockEdit(edit, ref.handle);
    assert.throws(() => cache.lockEdit(edit, ref.handle), { imageSourceReason: 'source-busy' });
    assert.deepEqual(await cache.read(edit, ref.handle, () => assert.fail('cached byte mismatch')), bytes);
    release(); release();
    assert.equal(loads, 1);
    now = 101;
    assert.throws(() => cache.lockEdit(edit, ref.handle), { imageSourceReason: 'source-expired' });
    cache.clear();
    assert.equal(cache.stats().bytes, 0);
});

test('latest source group wins without replacing snapshots; unavailable latest sources never make older sources default', () => {
    const cache = createImageSourceCache({ maxGroups: 2, cleanup: false });
    const ticket = bound(cache);
    cache.publish(ticket, bytes, 'session-a');
    const queued = bound(cache);
    cache.captureQuote(owner, [attachment]);
    assert.equal(cache.listed(queued)[0].source, 'generated');
    assert.equal(cache.listed(queued)[0].defaultSource, true);
    const latest = bound(cache);
    assert.equal(cache.listed(latest)[0].source, 'quoted');
    assert.equal(cache.listed(latest)[0].defaultSource, true);
    assert.equal(cache.listed(latest)[1].defaultSource, false);
    cache.captureQuote(owner, [{ ...attachment, url: 'http://127.0.0.1/invalid' }]);
    assert.ok(cache.listed(bound(cache)).every(ref => !ref.defaultSource));
    assert.ok(cache.stats().groups <= 2);
});

test('cache byte limit counts in-use evicted sources until leases release; reset blocks late publication and old tickets', async () => {
    const cache = createImageSourceCache({ maxBytes: bytes.length, maxGroups: 2, cleanup: false });
    const original = bound(cache);
    const receipt = cache.publish(original, bytes, 'session-a');
    const ticket = bound(cache);
    const release = cache.lockEdit(ticket, receipt.editableHandle);
    cache.clearPeer(owner);
    assert.equal(cache.stats().bytes, bytes.length);
    assert.equal(cache.publish(ticket, bytes, 'session-a'), undefined);
    assert.equal(cache.publish(bound(cache), bytes, 'session-a'), undefined);
    release();
    assert.equal(cache.stats().bytes, 0);
    assert.ok(cache.publish(bound(cache), bytes, 'session-a'));
    cache.clear();
});

test('malformed identity, forged ticket, mismatched quoted reference and plain chat cannot mint image grants', () => {
    const cache = createImageSourceCache({ cleanup: false });
    assert.equal(cache.bind({}, owner, 'session-a'), false);
    assert.equal(imageSourceIdentity({ kind: 'group', senderId: 'alice', groupOpenid: '../bad' }, '123456'), undefined);
    const middleware = createImageSourceMiddleware({ appId: '123456', cache });
    const ctx = { message: { kind: 'group', senderId: 'alice', groupOpenid: 'group-a', refMsgIdx: 'right' },
        state: { quote: { refKey: 'wrong', attachments: [attachment] } } };
    middleware(ctx, () => {});
    assert.equal(cache.bind(ctx.state.qqbotImageSources, owner, 'session-a'), true);
    assert.deepEqual(cache.listed(ctx.state.qqbotImageSources), []);
});

test('handle redaction holds arbitrary chunk splits and masks complete and partial handles on flush', () => {
    const handle = 'imgsrc_' + 'A'.repeat(32);
    const text = `before ${handle} after`;
    assert.equal(redactImageSourceHandles(text), 'before [图片引用] after');
    for (let split = 0; split <= text.length; split++) {
        const redactor = createImageSourceRedactor();
        const result = redactor.push(text.slice(0, split)) + redactor.push(text.slice(split)) + redactor.finish();
        assert.equal(result, 'before [图片引用] after', String(split));
    }
    const redactor = createImageSourceRedactor();
    assert.equal(redactor.push('imgsrc_ABC'), '');
    assert.equal(redactor.finish(), '[图片引用]');
});

test('a delivered picture that cannot be cached supersedes the old default without revoking an in-use base', () => {
    const cache = createImageSourceCache({ maxBytes: bytes.length, cleanup: false });
    const first = cache.publish(bound(cache), bytes, 'session-a');
    const editing = bound(cache);
    const release = cache.lockEdit(editing, first.editableHandle);
    assert.equal(cache.publish(editing, bytes, 'session-a'), undefined);
    assert.ok(cache.listed(bound(cache)).every(image => !image.defaultSource));
    assert.equal(cache.available(editing, first.editableHandle), true);
    release();
    cache.clear();
});

test('protocol-relative QQ URLs are normalized and duplicate quoted records remain one candidate', () => {
    const cache = createImageSourceCache({ cleanup: false });
    cache.captureQuote(owner, [attachment, { ...attachment, url: attachment.url.replace('https:', '') }]);
    const ticket = bound(cache);
    assert.equal(cache.listed(ticket).length, 1);
});
