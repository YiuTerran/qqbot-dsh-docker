import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = (environmentName, relativePath) => {
    const configured = process.env[environmentName];
    if (!configured) return new URL(relativePath, import.meta.url);
    return configured.startsWith('file:') ? configured : pathToFileURL(resolve(configured)).href;
};

const pendingModule = await import(moduleUrl('QQBOT_PENDING_IMAGES_MODULE', '../defaults/qqbot-pending-images.mjs'));
const concurrencyModule = await import(moduleUrl('QQBOT_CONCURRENCY_MODULE', '../defaults/qqbot-concurrency.mjs'));
const {
    claimRecentImageSnapshot,
    createPendingImageCaptureMiddleware,
    createPendingImageNewCommandCleanup,
    createPendingImagePromptCache,
    createPendingImagePromptMiddleware,
    isRecentImageSnapshot,
    releaseRecentImageSnapshot,
    recentImageSnapshotAvailable,
    renderRecentImagePromptMetadata,
} = pendingModule;
const { createMergeConcurrencyGuard, getMergedGenerationRequests } = concurrencyModule;

const APP = '123456789';

function image(url, filename = 'photo.png', contentType = 'image/png', size = 1200) {
    return { url, filename, content_type: contentType, size };
}

function groupMessage({
    senderId = 'user-a', groupOpenid = 'group-a', appId = APP, id = 'message-a', content = '', attachments = [],
} = {}) {
    return { appId, kind: 'group', senderId, groupOpenid, messageId: id, content, attachments,
        replyTarget: { scope: 'group', targetId: groupOpenid, msgId: id } };
}

function c2cMessage({ senderId = 'user-a', appId = APP, id = 'message-a', content = '', attachments = [] } = {}) {
    return { appId, kind: 'c2c', senderId, messageId: id, content, attachments,
        replyTarget: { scope: 'c2c', targetId: senderId, msgId: id } };
}

function fakeClock(start = 0) {
    let time = start;
    let nextId = 0;
    const timers = new Map();
    return {
        now: () => time,
        setTimeout(callback, delay) {
            const handle = { id: ++nextId, at: time + delay, callback, unref() {} };
            timers.set(handle.id, handle);
            return handle;
        },
        clearTimeout(handle) { timers.delete(handle?.id); },
        advance(milliseconds) {
            time += milliseconds;
            for (;;) {
                const ready = [...timers.values()].filter((timer) => timer.at <= time)
                    .sort((left, right) => left.at - right.at)[0];
                if (!ready) break;
                timers.delete(ready.id);
                ready.callback();
            }
        },
        timerCount: () => timers.size,
    };
}

function makeCache(options = {}) {
    return createPendingImagePromptCache(options);
}

test('pure image messages are cached before mention handling and stop without downstream work', async () => {
    const cache = makeCache();
    const capture = createPendingImageCaptureMiddleware({ appId: APP, cache });
    const ctx = { message: groupMessage({
        content: `<@!${APP}>`, id: 'photo-source', attachments: [image('https://cdn.example/photo.png')],
    }), state: {} };
    let nextCalls = 0;
    ctx.stop = () => {};
    await capture(ctx, async () => { nextCalls++; });
    assert.equal(nextCalls, 0);
    assert.equal(ctx.state.qqbotPendingImageCaptured, true);
    assert.deepEqual(cache.inspect(ctx.message, APP), { count: 1, lastImageAt: cache.inspect(ctx.message, APP).lastImageAt });
});

test('only same app, peer, and sender share a snapshot; group text needs an actual bot mention', () => {
    const cache = makeCache();
    const source = groupMessage({ attachments: [image('https://cdn.example/a.png')] });
    assert.equal(cache.capture(source, APP), true);
    assert.equal(cache.snapshot(groupMessage({ content: 'follow up' }), APP, { mention: { wasMentioned: false } }), undefined);
    assert.equal(cache.snapshot(groupMessage({ senderId: 'user-b', content: `<@${APP}> follow up` }), APP,
        { mention: { wasMentioned: true } }), undefined);
    assert.equal(cache.snapshot(groupMessage({ groupOpenid: 'group-b', content: `<@${APP}> follow up` }), APP,
        { mention: { wasMentioned: true } }), undefined);
    assert.equal(cache.snapshot(groupMessage({ content: `<@${APP}> /roll 1d20` }), APP,
        { mention: { wasMentioned: true } }), undefined, 'slash commands are not prompts');
    assert.equal(cache.snapshot(groupMessage({ appId: undefined, content: `<@${APP}> follow up` }), undefined,
        { mention: { wasMentioned: true } }), undefined);
    const snapshot = cache.snapshot(groupMessage({ content: `<@${APP}> describe this` }), APP,
        { mention: { wasMentioned: true } });
    assert.equal(snapshot.attachments.length, 1);
    assert.equal(cache.size(), 1, 'creating a snapshot does not claim or remove the pending key');
    assert.equal(recentImageSnapshotAvailable(snapshot), true);
});

test('private prompts can snapshot without a mention and images contain only safe metadata', () => {
    const cache = makeCache();
    const source = c2cMessage({ attachments: [image('//cdn.example/picture.jpg', 'picture.jpg', '')] });
    assert.equal(cache.capture(source, APP), true, 'a reliable image extension covers absent MIME metadata');
    const snapshot = cache.snapshot(c2cMessage({ content: 'please describe it' }), APP);
    assert.equal(snapshot.attachments[0].url, 'https://cdn.example/picture.jpg');
    assert.equal(snapshot.attachments[0].filename, 'picture.jpg');
    assert.equal(snapshot.attachments[0].content_type, 'image');
    assert.equal('localPath' in snapshot.attachments[0], false);
    assert.equal('path' in snapshot.attachments[0], false);
    assert.deepEqual(snapshot.sourceMessageIds, ['message-a']);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.attachments), true);
    assert.equal(Object.isFrozen(snapshot.attachments[0]), true);
});

test('image recognition rejects captions, other media, unsupported metadata, and unsafe URLs', () => {
    const cases = [
        groupMessage({ content: `<@${APP}> keep this caption`, attachments: [image('https://cdn.example/a.png')] }),
        groupMessage({ attachments: [image('https://cdn.example/a.png'), { url: 'https://cdn.example/voice.ogg', filename: 'voice.ogg', content_type: 'audio/ogg' }] }),
        groupMessage({ attachments: [{ ...image('https://cdn.example/a.png', 'a.png', 'application/pdf') }] }),
        groupMessage({ attachments: [image('https://cdn.example/a.avif', 'a.avif', '')] }),
        groupMessage({ attachments: [image('/data/qqbot-media/a.png')] }),
        groupMessage({ attachments: [image('http://cdn.example/a.png')] }),
        groupMessage({ attachments: [image('https://user:password@cdn.example/a.png')] }),
        groupMessage({ content: `<@other-user>`, attachments: [image('https://cdn.example/a.png')] }),
    ];
    for (const message of cases) {
        const cache = makeCache();
        assert.equal(cache.capture(message, APP), false);
        assert.equal(cache.size(), 0);
    }
    const cache = makeCache();
    assert.equal(cache.capture(groupMessage({ appId: undefined, attachments: [image('https://cdn.example/a.png')] }), undefined), false);
});

test('a same-sender non-image message closes the batch; the next pure image starts a fresh batch', () => {
    const cache = makeCache();
    cache.capture(groupMessage({ id: 'old', attachments: [image('https://cdn.example/old.png', 'old.png')] }), APP);
    const oldSnapshot = cache.snapshot(groupMessage({ content: `<@${APP}> first prompt` }), APP,
        { mention: { wasMentioned: true } });

    cache.capture(groupMessage({ content: 'unmentioned ordinary message' }), APP);
    const afterBoundary = cache.snapshot(groupMessage({ content: `<@${APP}> another prompt` }), APP,
        { mention: { wasMentioned: true } });
    assert.equal(afterBoundary.attachments[0].filename, 'old.png', 'ordinary text does not consume the batch');

    cache.capture(groupMessage({ id: 'new', attachments: [image('https://cdn.example/new.png', 'new.png')] }), APP);
    const latest = cache.snapshot(groupMessage({ content: `<@${APP}> use the latest` }), APP,
        { mention: { wasMentioned: true } });
    assert.deepEqual(latest.attachments.map(({ filename }) => filename), ['new.png']);
    assert.equal(recentImageSnapshotAvailable(oldSnapshot), true, 'queued snapshots keep their original batch');

    cache.capture(groupMessage({ id: 'other-sender-text', senderId: 'user-b', content: 'talking' }), APP);
    const stillLatest = cache.snapshot(groupMessage({ content: `<@${APP}> use this` }), APP,
        { mention: { wasMentioned: true } });
    assert.deepEqual(stillLatest.attachments.map(({ filename }) => filename), ['new.png'],
        'other members do not split this sender’s sequence');
});

test('invalid pure-image URLs close a valid batch and cannot partially append', () => {
    const cache = makeCache();
    cache.capture(groupMessage({ id: 'valid-old', attachments: [image('https://cdn.example/old.png', 'old.png')] }), APP);
    assert.equal(cache.capture(groupMessage({ id: 'bad', attachments: [image('file:///private/photo.png', 'bad.png')] }), APP), false);
    cache.capture(groupMessage({ id: 'valid-new', attachments: [image('https://cdn.example/new.png', 'new.png')] }), APP);
    const snapshot = cache.snapshot(groupMessage({ content: `<@${APP}> inspect it` }), APP,
        { mention: { wasMentioned: true } });
    assert.deepEqual(snapshot.attachments.map(({ filename }) => filename), ['new.png']);
});

test('continuous images retain the newest eight and expire five minutes after the latest image', () => {
    const clock = fakeClock();
    const cache = makeCache({ ttlMs: 300_000, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    assert.equal(cache.capture(groupMessage({ id: 'first', attachments: [image('https://cdn.example/1.png', '1.png')] }), APP), true);
    clock.advance(240_000);
    assert.equal(cache.capture(groupMessage({ id: 'second', attachments: Array.from({ length: 9 }, (_, index) =>
        image(`https://cdn.example/${index + 2}.png`, `${index + 2}.png`)) }), APP), true);
    assert.equal(cache.inspect(groupMessage(), APP).count, 8);
    clock.advance(60_000);
    assert.equal(cache.inspect(groupMessage(), APP).count, 8, 'the second image message extended the deadline');
    const snapshot = cache.snapshot(groupMessage({ content: `<@${APP}> caption` }), APP,
        { mention: { wasMentioned: true } });
    assert.equal(snapshot.attachments[0].filename, '3.png', 'overflow discards oldest images');
    assert.equal(snapshot.attachments.at(-1).filename, '10.png');
    assert.deepEqual(snapshot.sourceMessageIds, ['second'], 'source ids follow the retained images');

    const expiry = makeCache({ ttlMs: 300_000, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    const message = groupMessage({ attachments: [image('https://cdn.example/expiry.png')] });
    expiry.capture(message, APP);
    const expiredSnapshot = expiry.snapshot(groupMessage({ content: `<@${APP}> caption` }), APP,
        { mention: { wasMentioned: true } });
    clock.advance(299_999);
    assert.equal(recentImageSnapshotAvailable(expiredSnapshot), true);
    clock.advance(1);
    assert.equal(recentImageSnapshotAvailable(expiredSnapshot), false);
    assert.equal(expiry.size(), 0, 'a timer releases metadata without another inbound message');
});

test('one of multiple snapshots claims the batch atomically and only that snapshot remains available', () => {
    const cache = makeCache();
    cache.capture(groupMessage({ id: 'source', attachments: [image('https://cdn.example/a.png')] }), APP);
    const first = cache.snapshot(groupMessage({ id: 'prompt-a', content: `<@${APP}> first` }), APP,
        { mention: { wasMentioned: true } });
    const second = cache.snapshot(groupMessage({ id: 'prompt-b', content: `<@${APP}> second` }), APP,
        { mention: { wasMentioned: true } });
    assert.notEqual(first, second);
    assert.equal(isRecentImageSnapshot(first), true);
    assert.equal(isRecentImageSnapshot({ attachments: first.attachments, sourceMessageIds: first.sourceMessageIds }), false,
        'copying public metadata cannot forge a capability');
    assert.equal(claimRecentImageSnapshot(first), true);
    assert.equal(claimRecentImageSnapshot(first), true, 'the owning request can check the same capability again');
    assert.equal(recentImageSnapshotAvailable(first), true);
    assert.equal(claimRecentImageSnapshot(second), false);
    assert.equal(recentImageSnapshotAvailable(second), false);
    assert.equal(cache.size(), 0, 'claim removes the pending key synchronously');
    assert.equal(cache.snapshot(groupMessage({ content: `<@${APP}> third` }), APP,
        { mention: { wasMentioned: true } }), undefined);
});

test('request release revokes its snapshot and cleans retired records without restoring claimed images', () => {
    const clock = fakeClock();
    const cache = makeCache({ now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    cache.capture(groupMessage({ id: 'source', attachments: [image('https://cdn.example/a.png')] }), APP);
    const firstRequest = cache.snapshot(groupMessage({ content: `<@${APP}> first` }), APP,
        { mention: { wasMentioned: true } });
    assert.equal(releaseRecentImageSnapshot(firstRequest), true);
    assert.equal(releaseRecentImageSnapshot(firstRequest), false, 'release is idempotent');
    assert.equal(recentImageSnapshotAvailable(firstRequest), false);
    assert.equal(cache.size(), 1, 'an unclaimed current batch remains available for a later request');
    const secondRequest = cache.snapshot(groupMessage({ content: `<@${APP}> second` }), APP,
        { mention: { wasMentioned: true } });
    assert.equal(recentImageSnapshotAvailable(secondRequest), true);
    assert.equal(claimRecentImageSnapshot(secondRequest), true);
    assert.equal(releaseRecentImageSnapshot(secondRequest), true);
    assert.equal(recentImageSnapshotAvailable(secondRequest), false);
    assert.equal(cache.size(), 0, 'claimed images are never restored to pending');
    assert.equal(clock.timerCount(), 0, 'release clears retired-record expiry timers');
});

test('capacity evicts the oldest pending key but keeps its already queued snapshot alive until expiry', () => {
    const clock = fakeClock();
    const cache = makeCache({ maxGroups: 2, ttlMs: 300_000, now: clock.now,
        setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    const a = groupMessage({ groupOpenid: 'group-a', attachments: [image('https://cdn.example/a.png')] });
    const b = groupMessage({ groupOpenid: 'group-b', attachments: [image('https://cdn.example/b.png')] });
    const c = groupMessage({ groupOpenid: 'group-c', attachments: [image('https://cdn.example/c.png')] });
    cache.capture(a, APP);
    const queuedA = cache.snapshot(groupMessage({ groupOpenid: 'group-a', content: `<@${APP}> queued` }), APP,
        { mention: { wasMentioned: true } });
    clock.advance(1);
    cache.capture(b, APP);
    clock.advance(1);
    cache.capture(c, APP);
    assert.equal(cache.size(), 2);
    assert.equal(cache.snapshot(groupMessage({ groupOpenid: 'group-a', content: `<@${APP}> later` }), APP,
        { mention: { wasMentioned: true } }), undefined);
    assert.equal(recentImageSnapshotAvailable(queuedA), true);
    assert.equal(claimRecentImageSnapshot(queuedA), true);
});

test('/new invalidates pending, superseded, and claimed snapshots across the same peer', async () => {
    const cache = makeCache();
    cache.capture(groupMessage({ id: 'old', attachments: [image('https://cdn.example/old.png')] }), APP);
    const old = cache.snapshot(groupMessage({ content: `<@${APP}> old request` }), APP,
        { mention: { wasMentioned: true } });
    cache.capture(groupMessage({ content: 'close old batch' }), APP);
    cache.capture(groupMessage({ id: 'new', attachments: [image('https://cdn.example/new.png')] }), APP);
    const current = cache.snapshot(groupMessage({ content: `<@${APP}> current request` }), APP,
        { mention: { wasMentioned: true } });
    assert.equal(claimRecentImageSnapshot(current), true);
    cache.capture(groupMessage({ senderId: 'user-b', id: 'peer', attachments: [image('https://cdn.example/peer.png')] }), APP);
    const otherSender = cache.snapshot(groupMessage({ senderId: 'user-b', content: `<@${APP}> other` }), APP,
        { mention: { wasMentioned: true } });
    cache.capture(groupMessage({ groupOpenid: 'group-b', id: 'other-group', attachments: [image('https://cdn.example/group.png')] }), APP);
    const otherGroup = cache.snapshot(groupMessage({ groupOpenid: 'group-b', content: `<@${APP}> other` }), APP,
        { mention: { wasMentioned: true } });
    cache.capture(groupMessage({ id: 'other-app', attachments: [image('https://cdn.example/app.png')] }), '999999999');
    const otherApp = cache.snapshot(groupMessage({ appId: '999999999', content: `<@999999999> other` }), '999999999',
        { mention: { wasMentioned: true } });

    const cleanup = createPendingImageNewCommandCleanup({ appId: APP, cache });
    const ctx = { message: groupMessage({ content: `<@${APP}> /new` }) };
    let nextCalls = 0;
    await cleanup(ctx, async () => { nextCalls++; });
    assert.equal(nextCalls, 1, '/new still reaches the normal command handler');
    assert.equal(recentImageSnapshotAvailable(old), false);
    assert.equal(recentImageSnapshotAvailable(current), false, 'claimed requests are revoked too');
    assert.equal(claimRecentImageSnapshot(current), false);
    assert.equal(recentImageSnapshotAvailable(otherSender), false, 'all senders in that peer are reset');
    assert.equal(recentImageSnapshotAvailable(otherGroup), true);
    assert.equal(recentImageSnapshotAvailable(otherApp), true);
});

test('current or quoted images retain explicit-source priority and never enter current attachments', async () => {
    const cache = makeCache();
    cache.capture(groupMessage({ attachments: [image('https://cdn.example/pending.png', 'pending.png')] }), APP);
    const currentImage = groupMessage({ content: `<@${APP}> use current`, attachments: [image('https://cdn.example/current.png')] });
    assert.equal(cache.snapshot(currentImage, APP, { mention: { wasMentioned: true } }), undefined);
    const quoteImage = groupMessage({ content: `<@${APP}> use quote` });
    assert.equal(cache.snapshot(quoteImage, APP, { mention: { wasMentioned: true }, quote: { attachments: [image('https://cdn.example/quote.png')] } }), undefined);
    assert.equal(cache.snapshot(groupMessage({ content: 'ordinary chat https://cdn.example/link.png' }), APP,
        { mention: { wasMentioned: false } }), undefined, 'ordinary group chat does not consume candidates');
    const explicitUrl = groupMessage({ content: `<@${APP}> inspect ${'x'.repeat(4_100)} https://cdn.example/current.png` });
    assert.equal(cache.snapshot(explicitUrl, APP, { mention: { wasMentioned: true } }), undefined,
        'a URL after the model text limit still has source priority');

    const ctx = { message: groupMessage({ content: `<@${APP}> use pending` }), state: { mention: { wasMentioned: true } } };
    const originalAttachments = ctx.message.attachments;
    const prompt = createPendingImagePromptMiddleware({ appId: APP, cache });
    await prompt(ctx, async () => {});
    assert.equal(ctx.message.attachments, originalAttachments);
    assert.deepEqual(ctx.message.attachments, []);
    assert.equal(isRecentImageSnapshot(ctx.state.qqbotRecentImages), true);
});

test('merged requests preserve exact snapshot identity and keep recent images separate from attachments', async () => {
    const cache = makeCache();
    cache.capture(groupMessage({ senderId: 'user-a', id: 'a-image', attachments: [image('https://cdn.example/a.png', 'same-name.png')] }), APP);
    cache.capture(groupMessage({ senderId: 'user-b', id: 'b-image', attachments: [image('https://cdn.example/b.png', 'same-name.png')] }), APP);
    const prompt = createPendingImagePromptMiddleware({ appId: APP, cache });
    const requestA = { message: groupMessage({ senderId: 'user-a', id: 'a-text', content: `<@${APP}> edit A`,
        attachments: [{ url: 'https://cdn.example/current-a.pdf', filename: 'current-a.pdf', content_type: 'application/pdf' }] }), state: { mention: { wasMentioned: true } } };
    const requestB = { message: groupMessage({ senderId: 'user-b', id: 'b-text', content: `<@${APP}> edit B` }),
        state: { mention: { wasMentioned: true } } };
    await prompt(requestA, () => {});
    await prompt(requestB, () => {});
    const snapshotA = requestA.state.qqbotRecentImages;
    const snapshotB = requestB.state.qqbotRecentImages;

    const guard = createMergeConcurrencyGuard();
    let ownerStarted;
    const started = new Promise((resolve) => { ownerStarted = resolve; });
    let releaseOwner;
    const holdOwner = new Promise((resolve) => { releaseOwner = resolve; });
    const blocker = { message: groupMessage({ senderId: 'user-c', id: 'blocker', content: `<@${APP}> hold` }), state: {} };
    const taskBlocker = guard(blocker, async () => { ownerStarted(); await holdOwner; });
    await started;
    const taskA = guard(requestA, async () => {});
    const taskB = guard(requestB, async () => {});
    releaseOwner();
    await Promise.all([taskBlocker, taskA, taskB]);

    const requests = getMergedGenerationRequests(requestA);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].ownerId, 'user-a');
    assert.equal(requests[1].ownerId, 'user-b');
    assert.equal(requests[0].currentAttachments[0].url, 'https://cdn.example/current-a.pdf');
    assert.equal(requests[0].recentImageSnapshot, snapshotA);
    assert.equal(requests[1].recentImageSnapshot, snapshotB);
    assert.deepEqual(requests[0].recentImageSnapshot.attachments.map(({ url }) => url), ['https://cdn.example/a.png']);
    assert.deepEqual(requests[1].recentImageSnapshot.attachments.map(({ url }) => url), ['https://cdn.example/b.png']);
    assert.equal(requests[0].currentAttachments.length, 1, 'recent images were not appended to current attachments');
    const metadata = renderRecentImagePromptMetadata(requests);
    assert.match(metadata, /Original request 1 has 1 optional recent-image candidate/u);
    assert.match(metadata, /Original request 2 has 1 optional recent-image candidate/u);
    assert.match(metadata, /Ignore them for ordinary chat and text-to-image requests/u);
    assert.doesNotMatch(metadata, /https?:|user-a|user-b|a-image|b-image/u);
});

test('an aborted capture does not cache an image and an aborted prompt does not create a snapshot', async () => {
    const cache = makeCache();
    const capture = createPendingImageCaptureMiddleware({ appId: APP, cache });
    const controller = new AbortController();
    controller.abort();
    let nextCalls = 0;
    await capture({ signal: controller.signal,
        message: groupMessage({ attachments: [image('https://cdn.example/a.png')] }), state: {} },
    async () => { nextCalls++; });
    assert.equal(nextCalls, 1);
    assert.equal(cache.size(), 0);

    cache.capture(c2cMessage({ attachments: [image('https://cdn.example/private.png')] }), APP);
    const prompt = createPendingImagePromptMiddleware({ appId: APP, cache });
    const aborted = { signal: controller.signal, message: c2cMessage({ content: 'caption' }), state: {} };
    await prompt(aborted, async () => {});
    assert.equal(aborted.state.qqbotRecentImages, undefined);
    assert.equal(cache.size(), 1);
});
