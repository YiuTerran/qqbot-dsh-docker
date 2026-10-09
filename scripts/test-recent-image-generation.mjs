// Native generation-provider coverage for memory-only recent image grants.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';

const generationUrl = process.env.QQBOT_GENERATION_MODULE
    ?? new URL('../defaults/qqbot-generation.mjs', import.meta.url).href;
const generation = await import(generationUrl);
const generationPath = generationUrl.startsWith('file:') ? fileURLToPath(generationUrl) : generationUrl;
const defaultsDir = dirname(generationPath);
const scopeUrl = process.env.QQBOT_GENERATION_SCOPE_MODULE
    ?? pathToFileURL(join(defaultsDir, 'qqbot-generation-scope.mjs')).href;
const {
    GENERATE_IMAGE_TOOL,
    registerGenerationTools,
    validateGenerationToolCall,
} = generation;
const {
    beginGenerationTurn,
    endGenerationTurn,
    generationRequestMetadata,
} = await import(scopeUrl);
const {
    beginDocumentTurn,
    endDocumentTurn,
    getDocumentTurn,
    runInDocumentExecution,
    bindDocumentExecution,
} = await import(pathToFileURL(join(defaultsDir, 'qqbot-document-scope.mjs')).href);
const { createPendingImagePromptCache } = await import(
    pathToFileURL(join(defaultsDir, 'qqbot-pending-images.mjs')).href,
);

const APP_ID = '123456789';
const IMAGE_URL = 'https://recent.example.test/batch/image.png';
const route = {
    apiKey: 'fixture-image-secret',
    baseUrl: 'https://image-api.example.test/v1',
    model: 'fixture-image-model',
    protocol: 'openai-images',
};

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const typeBytes = Buffer.from(type, 'ascii');
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    typeBytes.copy(chunk, 4);
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
    return chunk;
}

function createPngFixture() {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 6;
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

const png = createPngFixture();

function makeQuota() {
    return {
        async tryAcquire() { return { ok: true, release() {} }; },
        async reserve() { return { ok: true }; },
    };
}

function nativeCall(ctx, args, agent, callId) {
    return ctx.tools.execute({
        name: GENERATE_IMAGE_TOOL,
        arguments: args,
        agent,
        callId,
        signal: new AbortController().signal,
    });
}

async function makeNativeRuntime(t, { imageService, sender }) {
    const dshRoot = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/';
    const profilePeers = '/data/profiles/qqbot/node_modules/@deepseek-ai';
    const { mkdir, symlink } = await import('node:fs/promises');
    await mkdir(dirname(profilePeers), { recursive: true });
    try {
        await symlink(dshRoot, profilePeers, 'dir');
    }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
    }
    const { Context } = await import(`${dshRoot}cordis/lib/index.js`);
    const { default: SystemPrompt } = await import(`${dshRoot}dsh-system-prompt/lib/index.js`);
    const { default: ToolRuntime } = await import(`${dshRoot}dsh-tools/lib/index.js`);
    const ctx = new Context();
    t.after(() => ctx.fiber.dispose());
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime, { mode: 'native' });
    ctx.tools.guard((exec) => {
        bindDocumentExecution(exec);
        return validateGenerationToolCall(exec, route);
    });
    ctx.on('tools/execute', (exec, next) => runInDocumentExecution(exec, next));
    const senderWithAssetStub = Object.assign(Object.create(sender), {
        async sendAssetImageFile() {
            throw new Error('unexpected original asset delivery in recent-image generation tests');
        },
    });
    const registration = registerGenerationTools(ctx, {
        route,
        sender: senderWithAssetStub,
        quota: makeQuota(),
        imageService,
        markdownEnabled: false,
    });
    assert.equal(registration.imageEnabled, true);
    return ctx;
}

function makeImageBatch(cache, suffix = 'one') {
    const source = {
        appId: APP_ID,
        kind: 'group',
        senderId: 'sender-1',
        groupOpenid: 'group-1',
        messageId: `source-${suffix}`,
        content: '',
        attachments: [{
            url: IMAGE_URL,
            filename: `recent-${suffix}.png`,
            content_type: 'image/png',
        }],
        replyTarget: { scope: 'group', targetId: 'group-1', msgId: `source-${suffix}` },
    };
    assert.equal(cache.capture(source, APP_ID), true);
    const prompt = {
        ...source,
        messageId: `prompt-${suffix}`,
        content: 'Edit the recent image and remove the red mark.',
        attachments: [],
    };
    const snapshot = cache.snapshot(prompt, APP_ID, { mention: { wasMentioned: true } });
    assert.ok(snapshot);
    return { prompt, snapshot };
}

function makeOriginalRequest({ snapshot, ownerId = 'owner-1', targetId = 'group-1', msgId = 'prompt-1' }) {
    return {
        ownerId,
        replyTarget: { scope: 'group', targetId, msgId },
        text: 'Edit the recent image and remove the red mark.',
        currentAttachments: [],
        quotedAttachments: [],
        recentImageSnapshot: snapshot,
    };
}

function startTurn(agent, originalRequests) {
    beginDocumentTurn(agent, { content: 'Edit the recent image.' });
    const documentScope = getDocumentTurn(agent);
    const generationScope = beginGenerationTurn(agent, originalRequests, [], {
        documentScope,
        media: { enabled: true, maxMB: 10 },
    });
    return { documentScope, generationScope };
}

async function finishTurn(agent, documentScope, generationScope) {
    await endGenerationTurn(agent, generationScope);
    endDocumentTurn(agent, documentScope);
}

async function withFixtureHttp(t, handler) {
    const webModule = await import(pathToFileURL(join(defaultsDir, 'qqbot-web-pages.mjs')).href);
    const { PublicHttpProvider } = webModule;
    const original = PublicHttpProvider.prototype.requestOnce;
    PublicHttpProvider.prototype.requestOnce = handler;
    t.after(() => { PublicHttpProvider.prototype.requestOnce = original; });
}

function senderHarness() {
    const imageSends = [];
    const notices = [];
    return {
        imageSends,
        notices,
        sender: {
            async sendImage(request, bytes) {
                imageSends.push({ request, bytes: Buffer.from(bytes) });
                return { sent: true };
            },
            async sendNotice(request, text) {
                notices.push({ request, text });
                return { sent: true };
            },
        },
    };
}

test('recent image edits lazy-load once, claim the batch, and send through the original trusted target', async (t) => {
    let downloadCount = 0;
    await withFixtureHttp(t, async function (url, signal) {
        downloadCount += 1;
        assert.equal(String(url), IMAGE_URL);
        assert.equal(signal?.aborted, false);
        return {
            response: new Response(png, { headers: { 'content-type': 'image/png' } }),
            close: async () => {},
        };
    });
    const providerCalls = [];
    const sends = senderHarness();
    const ctx = await makeNativeRuntime(t, {
        sender: sends.sender,
        imageService: { async generate(input) { providerCalls.push(input); return Buffer.from(png); } },
    });
    const cache = createPendingImagePromptCache();
    const { prompt, snapshot } = makeImageBatch(cache);
    const agent = {};
    const { documentScope, generationScope } = startTurn(agent, [makeOriginalRequest({ snapshot })]);
    const [metadata] = generationRequestMetadata(generationScope);
    assert.equal(metadata.recentImages.length, 1);
    assert.match(metadata.recentImages[0].imageRef,
        new RegExp(`^qqbot-image:${metadata.requestId}:${metadata.recentImages[0].imageAttachmentId}$`, 'u'));
    assert.equal(downloadCount, 0, 'recent image bytes remain lazy until the edit operation');
    const output = await nativeCall(ctx, {
        requestId: metadata.requestId,
        imageAttachmentId: metadata.recentImages[0].imageAttachmentId,
        prompt: 'Remove the red mark and preserve everything else.',
    }, agent, 'recent-image-success');
    assert.equal(output.isError, false, JSON.stringify(output));
    assert.equal(output.value.status, 'sent');
    assert.equal(downloadCount, 1, 'the one recent attachment was downloaded exactly once');
    assert.equal(providerCalls.length, 1);
    assert.deepEqual(providerCalls[0].imageBytes, png, 'the provider receives the selected recent image bytes');
    assert.equal(providerCalls[0].prompt, 'Remove the red mark and preserve everything else.');
    assert.equal(sends.imageSends.length, 1);
    assert.deepEqual(sends.imageSends[0].bytes, png);
    assert.equal(sends.imageSends[0].request.ownerId, 'owner-1');
    assert.deepEqual(sends.imageSends[0].request.replyTarget,
        { scope: 'group', targetId: 'group-1', msgId: 'prompt-1' });
    assert.equal(sends.imageSends[0].request.isActive('image'), true);
    assert.equal(cache.snapshot(prompt, APP_ID, { mention: { wasMentioned: true } }), undefined,
        'a claimed batch is not restored to the pending prompt cache');
    await finishTurn(agent, documentScope, generationScope);
    cache.clear();
});

test('provider failure consumes a claimed recent batch without retrying or sending an image', async (t) => {
    let downloadCount = 0;
    await withFixtureHttp(t, async function (url) {
        downloadCount += 1;
        assert.equal(String(url), IMAGE_URL);
        return { response: new Response(png, { headers: { 'content-type': 'image/png' } }), close: async () => {} };
    });
    let providerCount = 0;
    const sends = senderHarness();
    const ctx = await makeNativeRuntime(t, {
        sender: sends.sender,
        imageService: { async generate() { providerCount += 1; throw new Error('fixture provider failure'); } },
    });
    const cache = createPendingImagePromptCache();
    const { prompt, snapshot } = makeImageBatch(cache, 'failure');
    const agent = {};
    const { documentScope, generationScope } = startTurn(agent, [makeOriginalRequest({
        snapshot, ownerId: 'owner-failure', targetId: 'group-failure', msgId: 'prompt-failure',
    })]);
    const [metadata] = generationRequestMetadata(generationScope);
    const args = {
        requestId: metadata.requestId,
        imageAttachmentId: metadata.recentImages[0].imageAttachmentId,
        prompt: 'Remove the red mark.',
    };
    const failed = await nativeCall(ctx, args, agent, 'recent-image-provider-failure');
    assert.equal(failed.value.status, 'failed');
    assert.equal(downloadCount, 1);
    assert.equal(providerCount, 1);
    assert.equal(sends.imageSends.length, 0);
    assert.equal(cache.snapshot(prompt, APP_ID, { mention: { wasMentioned: true } }), undefined,
        'a failed edit does not put its claimed recent batch back in the pending cache');
    const repeatedCallId = await nativeCall(ctx, args, agent, 'recent-image-provider-failure');
    assert.equal(repeatedCallId.value.status, 'failed');
    assert.equal(downloadCount, 1, 'a duplicate native call id reuses the failed result rather than repeating the operation');
    assert.equal(providerCount, 1);
    await finishTurn(agent, documentScope, generationScope);
    cache.clear();
});

test('cancelling a recent image download consumes the batch and never calls the provider or sender', async (t) => {
    let downloadCount = 0;
    let enteredDownload;
    const entered = new Promise((resolve) => { enteredDownload = resolve; });
    await withFixtureHttp(t, async function (url, signal) {
        downloadCount += 1;
        assert.equal(String(url), IMAGE_URL);
        enteredDownload();
        return new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(signal.reason ?? new Error('fixture aborted'));
            signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('fixture aborted')), { once: true });
        });
    });
    let providerCount = 0;
    const sends = senderHarness();
    const ctx = await makeNativeRuntime(t, {
        sender: sends.sender,
        imageService: { async generate() { providerCount += 1; return Buffer.from(png); } },
    });
    const cache = createPendingImagePromptCache();
    const { prompt, snapshot } = makeImageBatch(cache, 'cancel');
    const agent = {};
    const { documentScope, generationScope } = startTurn(agent, [makeOriginalRequest({
        snapshot, ownerId: 'owner-cancel', targetId: 'group-cancel', msgId: 'prompt-cancel',
    })]);
    const [metadata] = generationRequestMetadata(generationScope);
    const pendingCall = nativeCall(ctx, {
        requestId: metadata.requestId,
        imageAttachmentId: metadata.recentImages[0].imageAttachmentId,
        prompt: 'Remove the red mark.',
    }, agent, 'recent-image-cancelled');
    await entered;
    await finishTurn(agent, documentScope, generationScope);
    const cancelled = await pendingCall;
    assert.equal(downloadCount, 1);
    assert.equal(providerCount, 0);
    assert.equal(sends.imageSends.length, 0);
    assert.equal(sends.notices.length, 0, 'ending the original turn suppresses stale failure notices');
    assert.equal(cache.snapshot(prompt, APP_ID, { mention: { wasMentioned: true } }), undefined,
        'cancellation does not restore a claimed recent batch');
    assert.ok(cancelled.value?.status === 'expired' || cancelled.value?.status === 'failed');
    cache.clear();
});

test('a recent image authorization from an earlier request cannot cross into a new request', async (t) => {
    let downloadCount = 0;
    await withFixtureHttp(t, async function () {
        downloadCount += 1;
        return { response: new Response(png, { headers: { 'content-type': 'image/png' } }), close: async () => {} };
    });
    let providerCount = 0;
    const sends = senderHarness();
    const ctx = await makeNativeRuntime(t, {
        sender: sends.sender,
        imageService: { async generate(input) { providerCount += 1; return Buffer.from(png); } },
    });
    const oldCache = createPendingImagePromptCache();
    const { snapshot: oldSnapshot } = makeImageBatch(oldCache, 'old');
    const oldAgent = {};
    const oldTurns = startTurn(oldAgent, [makeOriginalRequest({
        snapshot: oldSnapshot, ownerId: 'owner-old', targetId: 'group-old', msgId: 'prompt-old',
    })]);
    const [oldMetadata] = generationRequestMetadata(oldTurns.generationScope);
    const oldImageId = oldMetadata.recentImages[0].imageAttachmentId;
    const oldRequestId = oldMetadata.requestId;
    await finishTurn(oldAgent, oldTurns.documentScope, oldTurns.generationScope);

    const newCache = createPendingImagePromptCache();
    const { snapshot: newSnapshot } = makeImageBatch(newCache, 'new');
    const newAgent = {};
    const newTurns = startTurn(newAgent, [makeOriginalRequest({
        snapshot: newSnapshot, ownerId: 'owner-new', targetId: 'group-new', msgId: 'prompt-new',
    })]);
    const [newMetadata] = generationRequestMetadata(newTurns.generationScope);
    assert.notEqual(newMetadata.requestId, oldRequestId);
    const rejected = await nativeCall(ctx, {
        requestId: oldRequestId,
        imageAttachmentId: oldImageId,
        prompt: 'Use the old image for this new request.',
    }, newAgent, 'recent-image-cross-request');
    assert.equal(rejected.isError, true);
    assert.match(JSON.stringify(rejected), /not authorized|expired|cancelled/u);
    assert.equal(downloadCount, 0);
    assert.equal(providerCount, 0);
    assert.equal(sends.imageSends.length, 0);
    await finishTurn(newAgent, newTurns.documentScope, newTurns.generationScope);
    oldCache.clear();
    newCache.clear();
});
