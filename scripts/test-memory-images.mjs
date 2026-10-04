import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Context } from '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js';
import { LocalAttachmentStore } from '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js';
import { withMemoryVisionImage } from '/opt/qqbot-defaults/qqbot-memory-images.mjs';

const sharp = createRequire(import.meta.url)('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/sharp');
const png = await sharp({ create: { width: 8, height: 4, channels: 4, background: { r: 20, g: 50, b: 100, alpha: 0.5 } } }).png().toBuffer();
const input = { data: png, mediaType: 'image/png' };
const target = { width: 4, height: 2, maxBytes: 1024 };
async function setup(t) {
    const home = await mkdtemp(join(tmpdir(), 'qqbot-memory-images-'));
    const runtime = new Context();
    const store = new LocalAttachmentStore(runtime, { dshHome: home });
    t.after(async () => { await runtime.fiber.dispose(); await rm(home, { recursive: true, force: true }); });
    return { home, runtime, store };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('real SDK storage reads recent images and request variants wholly in memory', async t => {
    const { home, store } = await setup(t);
    let ref;
    await withMemoryVisionImage(store, input, undefined, async current => {
        ref = current;
        assert.equal(store.imageHostPath(current), undefined);
        assert.deepEqual(Buffer.from((await store.readImage(current)).data), png);
        const request = await store.readImageRequest(current, target);
        const decoded = await sharp(request.data).metadata();
        assert.equal(decoded.width, 4);
        assert.equal(decoded.height, 2);
        assert.equal(decoded.hasAlpha, true);
        assert.equal(request.hasAlpha, true, 'request metadata reports alpha from the encoded output');
        assert.equal(request.attachment, current);
        assert.ok(request.bytes <= target.maxBytes);
        assert.deepEqual(await readdir(home), [], 'neither durable image objects nor request caches are written');
        await assert.rejects(store.readImage({ ...current, width: 99 }), /metadata/u);
    });
    await assert.rejects(store.readImage(ref), /authorized|expired/u);
    assert.throws(() => store.imageHostPath(ref), /authorized|expired/u);
    assert.deepEqual(await readdir(home), []);
});

test('request metadata reports the encoded output alpha channel for opaque images', async t => {
    const { store } = await setup(t);
    const opaque = await sharp({ create: { width: 8, height: 4, channels: 3, background: { r: 20, g: 50, b: 100 } } }).png().toBuffer();
    await withMemoryVisionImage(store, { data: opaque, mediaType: 'image/png' }, undefined, async ref => {
        const request = await store.readImageRequest(ref, { width: 4, height: 2, maxBytes: 1024 });
        const decoded = await sharp(request.data).metadata();
        assert.equal(decoded.hasAlpha, false);
        assert.equal(request.hasAlpha, false);
    });
});

test('parallel vision calls cannot read each other’s refs and normal durable images still work', async t => {
    const { home, store } = await setup(t);
    const durable = await store.saveImage(input);
    const ready = deferred(), finish = deferred();
    let firstRef;
    const first = withMemoryVisionImage(store, input, undefined, async ref => {
        firstRef = ref;
        ready.resolve();
        await finish.promise;
        assert.deepEqual(Buffer.from((await store.readImage(ref)).data), png);
    });
    await ready.promise;
    try {
        await withMemoryVisionImage(store, input, undefined, async ref => {
            assert.notEqual(ref.attachmentId, firstRef.attachmentId);
            await assert.rejects(store.readImage(firstRef), /authorized/u);
            await assert.rejects(store.readImageRequest(firstRef, target), /authorized/u);
            assert.throws(() => store.imageHostPath(firstRef), /authorized/u);
            assert.deepEqual(Buffer.from((await store.readImage(durable)).data), png);
            assert.ok(store.imageHostPath(durable).startsWith(home));
        });
    }
    finally { finish.resolve(); await first; }
    assert.deepEqual(Buffer.from((await store.readImage(durable)).data), png);
});

test('failure and cancellation revoke temporary references without any files', async t => {
    const { home, store } = await setup(t);
    let failedRef, cancelledRef;
    await assert.rejects(withMemoryVisionImage(store, input, undefined, async ref => {
        failedRef = ref;
        throw new Error('fixture vision failure');
    }), /fixture vision failure/u);
    const controller = new AbortController();
    await assert.rejects(withMemoryVisionImage(store, input, controller.signal, async ref => {
        cancelledRef = ref;
        controller.abort(new Error('fixture vision cancelled'));
        await store.readImageRequest(ref, target);
    }), /fixture vision cancelled/u);
    await assert.rejects(store.readImage(failedRef), /authorized/u);
    await assert.rejects(store.readImage(cancelledRef), /authorized/u);
    assert.deepEqual(await readdir(home), []);
});

test('bad formats and oversized bytes are rejected before callback or storage', async t => {
    const { home, store } = await setup(t);
    let calls = 0;
    await assert.rejects(withMemoryVisionImage(store, { data: Buffer.from('not an image'), mediaType: 'image/png' }, undefined, () => { calls++; }));
    await assert.rejects(withMemoryVisionImage(store, { data: Buffer.alloc(10 * 1024 * 1024 + 1), mediaType: 'image/png' }, undefined, () => { calls++; }), /byte limit/u);
    assert.equal(calls, 0);
    assert.deepEqual(await readdir(home), []);
});

test('distinct Cordis attachment service proxies share a stable memory-store identity', async t => {
    const { runtime } = await setup(t);
    const first = runtime.get('attachments'), second = runtime.get('attachments');
    assert.notEqual(first, second);
    await withMemoryVisionImage(first, input, undefined, async ref => {
        assert.deepEqual(Buffer.from((await second.readImage(ref)).data), png);
        assert.equal((await second.readImageRequest(ref, target)).hasAlpha, true);
    });
    await withMemoryVisionImage(second, input, undefined, async ref => {
        assert.deepEqual(Buffer.from((await first.readImage(ref)).data), png);
    });
});
