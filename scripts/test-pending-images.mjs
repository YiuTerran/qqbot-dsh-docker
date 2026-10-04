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
    createPendingImageCaptureMiddleware,
    createPendingImageNewCommandCleanup,
    createPendingImagePromptCache,
    createPendingImagePromptMiddleware,
    renderDeferredImagePromptMetadata,
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

test('an image-only group message is cached before mention handling and returns without downstream work', async () => {
    const cache = makeCache();
    const capture = createPendingImageCaptureMiddleware({ appId: APP, cache });
    const ctx = { message: groupMessage({
        content: `<@!${APP}>`, id: 'photo-source', attachments: [image('https://cdn.example/photo.png')],
    }), state: {} };
    let nextCalls = 0;
    let modelCalls = 0;
    let downloadCalls = 0;
    let thinkingCalls = 0;
    ctx.stop = () => {};
    await capture(ctx, async () => {
        nextCalls++;
        modelCalls++;
        downloadCalls++;
        thinkingCalls++;
    });
    assert.equal(nextCalls, 0);
    assert.equal(modelCalls, 0);
    assert.equal(downloadCalls, 0);
    assert.equal(thinkingCalls, 0);
    assert.equal(ctx.state.qqbotPendingImageCaptured, true);
    assert.deepEqual(cache.inspect(ctx.message, APP), { count: 1, lastImageAt: cache.inspect(ctx.message, APP).lastImageAt });
});

test('only the same app, chat peer, and sender can consume, and group prompts need an actual bot mention', () => {
    const cache = makeCache();
    const source = groupMessage({ attachments: [image('https://cdn.example/a.png')] });
    assert.equal(cache.capture(source, APP), true);
    assert.equal(cache.consume(groupMessage({ content: 'follow up' }), APP, { mention: { wasMentioned: false } }), undefined);
    assert.equal(cache.consume(groupMessage({ senderId: 'user-b', content: 'follow up' }), APP, { mention: { wasMentioned: true } }), undefined);
    assert.equal(cache.consume(groupMessage({ groupOpenid: 'group-b', content: 'follow up' }), APP, { mention: { wasMentioned: true } }), undefined);
    assert.equal(cache.consume(groupMessage({ content: 'follow up' }), '987654321', { mention: { wasMentioned: true } }), undefined);
    assert.equal(cache.consume(groupMessage({ content: `<@${APP}> /roll 1d20` }), APP, { mention: { wasMentioned: true } }), undefined,
        'slash commands are not treated as image prompts');
    assert.equal(cache.inspect(source, APP).count, 1, 'misses leave the original bucket pending');
    const consumed = cache.consume(groupMessage({ content: `<@${APP}> describe this` }), APP, { mention: { wasMentioned: true } });
    assert.equal(consumed.attachments.length, 1);
    assert.equal(cache.consume(groupMessage({ content: `<@${APP}> describe this again` }), APP, { mention: { wasMentioned: true } }), undefined);
});

test('private prompts consume without a mention and image-only messages keep only safe image metadata', () => {
    const cache = makeCache();
    const source = c2cMessage({ attachments: [image('//cdn.example/picture.jpg', 'picture.jpg', '')] });
    assert.equal(cache.capture(source, APP), true, 'a reliable image extension covers absent MIME metadata');
    const consumed = cache.consume(c2cMessage({ content: 'please describe it' }), APP);
    assert.equal(consumed.attachments[0].url, 'https://cdn.example/picture.jpg');
    assert.equal(consumed.attachments[0].filename, 'picture.jpg');
    assert.equal(consumed.attachments[0].content_type, 'image', 'a reliable extension fallback reaches the image downloader');
    assert.equal('localPath' in consumed.attachments[0], false);
    assert.equal('path' in consumed.attachments[0], false);
    assert.equal(consumed.attachments[0].qqbotDeferredPromptSource, 'previous-image-only-message');
});

test('image recognition rejects text, other media, explicit non-image MIME, and unsafe URLs', () => {
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

test('voice and document attachments are not mistaken for image-only input', () => {
    const cache = makeCache();
    for (const attachment of [
        { url: 'https://cdn.example/audio.ogg', filename: 'audio.ogg', content_type: 'audio/ogg' },
        { url: 'https://cdn.example/notes.pdf', filename: 'notes.pdf', content_type: 'application/pdf' },
    ]) {
        assert.equal(cache.capture(groupMessage({ attachments: [attachment] }), APP), false);
    }
});

test('continuous images merge, keep the newest eight, and expire five minutes after the latest image', () => {
    const clock = fakeClock();
    const cache = makeCache({ ttlMs: 300_000, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    assert.equal(cache.capture(groupMessage({ id: 'first', attachments: [image('https://cdn.example/1.png', '1.png')] }), APP), true);
    clock.advance(240_000);
    assert.equal(cache.capture(groupMessage({ id: 'second', attachments: Array.from({ length: 9 }, (_, index) =>
        image(`https://cdn.example/${index + 2}.png`, `${index + 2}.png`)) }), APP), true);
    assert.equal(cache.inspect(groupMessage(), APP).count, 8);
    clock.advance(60_000);
    assert.equal(cache.inspect(groupMessage(), APP).count, 8, 'the second image message extended the deadline');
    const consumed = cache.consume(groupMessage({ content: 'caption' }), APP, { mention: { wasMentioned: true } });
    assert.equal(consumed.attachments[0].filename, '3.png', 'overflow discards oldest images');
    assert.equal(consumed.attachments.at(-1).filename, '10.png');
    assert.equal(clock.timerCount(), 0, 'consumption cancels the expiry timer');

    const expiry = makeCache({ ttlMs: 300_000, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    const message = groupMessage({ attachments: [image('https://cdn.example/expiry.png')] });
    expiry.capture(message, APP);
    clock.advance(299_999);
    assert.equal(expiry.inspect(message, APP).count, 1);
    clock.advance(1);
    assert.equal(expiry.inspect(message, APP), undefined);
    assert.equal(expiry.size(), 0, 'a timer releases metadata without a later inbound message');
});

test('capacity is bounded and least recently captured buckets are evicted', () => {
    const cache = makeCache({ maxGroups: 2 });
    const a = groupMessage({ groupOpenid: 'group-a', senderId: 'user-a', attachments: [image('https://cdn.example/a.png')] });
    const b = groupMessage({ groupOpenid: 'group-b', senderId: 'user-a', attachments: [image('https://cdn.example/b.png')] });
    const c = groupMessage({ groupOpenid: 'group-c', senderId: 'user-a', attachments: [image('https://cdn.example/c.png')] });
    cache.capture(a, APP);
    cache.capture(b, APP);
    cache.capture(a, APP);
    cache.capture(c, APP);
    assert.equal(cache.size(), 2);
    assert.equal(cache.inspect(a, APP).count, 2);
    assert.equal(cache.inspect(b, APP), undefined);
    assert.equal(cache.inspect(c, APP).count, 1);
});

test('/new clears all pending senders in its peer and does not clear another app or peer', async () => {
    const cache = makeCache();
    const capture = (group, user, app = APP) => cache.capture(groupMessage({ groupOpenid: group, senderId: user,
        attachments: [image(`https://cdn.example/${group}-${user}.png`)] }), app);
    capture('group-a', 'user-a');
    capture('group-a', 'user-b');
    capture('group-b', 'user-a');
    capture('group-a', 'user-a', '999999999');
    const cleanup = createPendingImageNewCommandCleanup({ appId: APP, cache });
    const ctx = { message: groupMessage({ groupOpenid: 'group-a', senderId: 'user-a', content: `<@${APP}> /new` }) };
    let nextCalls = 0;
    await cleanup(ctx, async () => { nextCalls++; });
    assert.equal(nextCalls, 1, 'cleanup lets the real slash command execute');
    assert.equal(cache.inspect(groupMessage({ groupOpenid: 'group-a', senderId: 'user-a' }), APP), undefined);
    assert.equal(cache.inspect(groupMessage({ groupOpenid: 'group-a', senderId: 'user-b' }), APP), undefined);
    assert.equal(cache.inspect(groupMessage({ groupOpenid: 'group-b', senderId: 'user-a' }), APP).count, 1);
    assert.equal(cache.inspect(groupMessage({ groupOpenid: 'group-a', senderId: 'user-a' }), '999999999').count, 1);
});

test('the first eligible prompt atomically consumes once and preserves its exact text and current attachments', async () => {
    const cache = makeCache();
    cache.capture(groupMessage({ id: 'source', attachments: [image('https://cdn.example/old.png', 'old.png')] }), APP);
    const consume = createPendingImagePromptMiddleware({ appId: APP, cache });
    const prompts = [
        { message: groupMessage({ id: 'prompt-a', content: `<@${APP}> describe this`, attachments: [image('https://cdn.example/new.png', 'new.png')] }),
            state: { mention: { wasMentioned: true } } },
        { message: groupMessage({ id: 'prompt-b', content: `<@${APP}> describe this too` }),
            state: { mention: { wasMentioned: true } } },
    ];
    const release = [];
    const work = prompts.map((ctx) => consume(ctx, () => new Promise((resolve) => release.push(resolve))));
    assert.equal(prompts[0].message.content, `<@${APP}> describe this`);
    assert.deepEqual(prompts[0].message.attachments.map((attachment) => attachment.filename), ['new.png', 'old.png']);
    assert.equal(prompts[0].message.attachments[1].qqbotDeferredPromptSource, 'previous-image-only-message');
    assert.deepEqual(prompts[0].state.qqbotDeferredImagePrompt, { count: 1, sourceMessageIds: ['source'] });
    assert.deepEqual(prompts[1].message.attachments, []);
    for (const done of release) done();
    await Promise.all(work);
});

test('pending groups from merged users remain attached to their own generation request', async () => {
    const cache = makeCache();
    const userAImage = image('https://cdn.example/a.png', 'same-name.png');
    const userBImage = image('https://cdn.example/b.png', 'same-name.png');
    cache.capture(groupMessage({ senderId: 'user-a', id: 'a-image', attachments: [userAImage] }), APP);
    cache.capture(groupMessage({ senderId: 'user-b', id: 'b-image', attachments: [userBImage] }), APP);
    const consume = createPendingImagePromptMiddleware({ appId: APP, cache });
    const requestA = { message: groupMessage({ senderId: 'user-a', id: 'a-text', content: `<@${APP}> edit A` }),
        state: { mention: { wasMentioned: true } } };
    const requestB = { message: groupMessage({ senderId: 'user-b', id: 'b-text', content: `<@${APP}> edit B` }),
        state: { mention: { wasMentioned: true } } };
    await consume(requestA, () => {});
    await consume(requestB, () => {});

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
    assert.equal(requests[0].currentAttachments[0].url, userAImage.url);
    assert.equal(requests[1].currentAttachments[0].url, userBImage.url);
    assert.equal(requests[0].currentAttachments[0].promptSource, 'previous-image-only-message');
    assert.equal(requests[1].currentAttachments[0].promptSource, 'previous-image-only-message');
    assert.deepEqual(requests.map((request) => request.deferredImagePrompt?.count), [1, 1]);
    assert.match(renderDeferredImagePromptMetadata(requests), /Original request 1 includes 1 image/);
    assert.match(renderDeferredImagePromptMetadata(requests), /Original request 2 includes 1 image/);
    assert.doesNotMatch(renderDeferredImagePromptMetadata(requests), /https?:|user-a|user-b|a-image|b-image/u);
});

test('an aborted source receipt is not cached and image-only capture never sends a thinking message', async () => {
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
});

test('an already-aborted prompt cannot consume images for a later retry', async () => {
    const cache = makeCache();
    cache.capture(c2cMessage({ attachments: [image('https://cdn.example/a.png')] }), APP);
    const consume = createPendingImagePromptMiddleware({ appId: APP, cache });
    const controller = new AbortController();
    controller.abort();
    const ctx = { signal: controller.signal, message: c2cMessage({ content: 'caption' }), state: {} };
    await consume(ctx, async () => {});
    assert.equal(ctx.message.attachments.length, 0);
    assert.equal(cache.inspect(c2cMessage(), APP).count, 1);
});

test('a saturated merge queue drops the consumed prompt without leaking its image to a later request', async () => {
    const cache = makeCache();
    cache.capture(groupMessage({ attachments: [image('https://cdn.example/queued.png')] }), APP);
    const consume = createPendingImagePromptMiddleware({ appId: APP, cache });
    const prompt = { message: groupMessage({ content: `<@${APP}> use this image` }),
        state: { mention: { wasMentioned: true } }, stop(reason) { this.stopReason = reason; } };
    await consume(prompt, () => {});
    let releaseOwner;
    let startedOwner;
    const started = new Promise((resolve) => { startedOwner = resolve; });
    const ownerWait = new Promise((resolve) => { releaseOwner = resolve; });
    let dropped = 0;
    let promptRan = 0;
    const guard = createMergeConcurrencyGuard({ maxQueue: 0, onDrop: async () => { dropped++; } });
    const owner = { message: groupMessage({ senderId: 'other-user', content: 'busy' }), state: {} };
    const active = guard(owner, async () => { startedOwner(); await ownerWait; });
    await started;
    await guard(prompt, async () => { promptRan++; });
    assert.equal(prompt.stopReason, 'concurrency:merge-full');
    assert.equal(dropped, 1);
    assert.equal(promptRan, 0);
    assert.equal(cache.inspect(groupMessage(), APP), undefined,
        'the dropped prompt is consumed once and does not leak its image to a later turn');
    releaseOwner();
    await active;
});
