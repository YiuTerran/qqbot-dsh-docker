// Native generation and vision integration for reusable, request-rebound sources.
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

function startTurn(agent, originalRequests) {
    beginDocumentTurn(agent, { content: 'Edit the recent image.' });
    const documentScope = getDocumentTurn(agent);
    const generationScope = beginGenerationTurn(agent, originalRequests, [], {
        documentScope,
        record: { agent, sessionId: 'native-session-a' },
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

const { imageSources } = await import(pathToFileURL(join(defaultsDir, 'qqbot-image-sources.mjs')).href);
const { loadChatImageBytes } = await import(pathToFileURL(join(defaultsDir, 'qqbot-chat-policy.mjs')).href);
const identity = { appId: APP_ID, scope: 'group', peerId: 'group-1', ownerId: 'owner-1' };
function sourceRequest(options = {}) {
    const owner = { ...identity, ...options.identity };
    return { appId: owner.appId, ownerId: owner.ownerId,
        imageSourceTicket: imageSources.snapshot(owner),
        replyTarget: { scope: owner.scope, targetId: owner.peerId, msgId: 'native-message-' + Math.random() },
        text: options.text ?? 'Edit this image.', currentAttachments: options.current ?? [], quotedAttachments: options.quoted ?? [] };
}
async function executeLook(ctx, args, agent, callId) {
    return ctx.tools.execute({ name: 'qqbot_describe_image', arguments: args, agent, callId,
        signal: new AbortController().signal });
}

test('native generation -> next-turn vision -> editing uses exactly the generated bytes and fresh request refs', async t => {
    imageSources.clear();t.after(() => imageSources.clear());
    const calls = [];
    const sends = senderHarness();
    const ctx = await makeNativeRuntime(t, { sender: sends.sender, imageService: {
        async generate(input) { calls.push(input);return Buffer.from(png); },
    } });
    // The real adapter vision tool must receive a call-local memory attachment.
    const { registerDescribeImageTool } = await import('/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/media/vision-tool.js');
    const attachments = { async saveImage() { assert.fail('source images must never be saved to disk'); },
        async readImage() { assert.fail('unbound memory read'); }, async readImageRequest() { assert.fail('unbound variant'); }, imageHostPath() { return undefined; } };
    let visionCalls = 0;
    registerDescribeImageTool({ get(name) {
        if (name === 'tools') return ctx.tools;
        if (name === 'attachments') return attachments;
        if (name === 'llm') return { async *stream(options) {
            visionCalls++;
            const ref = options.messages[0].content[0].attachment;
            const image = await attachments.readImage(ref);
            assert.ok(image.data.byteLength > 0);
            assert.equal(attachments.imageHostPath(ref), undefined);
            yield { type: 'block-end', index: 0, block: { type: 'text', text: 'A red test pixel.' } };
            yield { type: 'finish', reason: { kind: 'stop' } };
        } };
    } }, { enabled: true, provider: 'fixture', model: 'fixture', maxBytes: 10485760, maxTokens: 16384, timeoutMs: 10000 }, { warn() {}, info() {} });
    const agent = {};
    let turn = startTurn(agent, [sourceRequest({ text: 'Generate a red pixel.' })]);
    let meta = generationRequestMetadata(turn.generationScope)[0];
    const generated = await nativeCall(ctx, { requestId: meta.requestId, prompt: 'A red pixel.' }, agent, 'generate-first');
    assert.equal(generated.value.status, 'sent');
    assert.match(generated.value.editableHandle, /^imgsrc_/u);
    const originalHandle = generated.value.editableHandle;
    assert.equal(generationRequestMetadata(turn.generationScope)[0].recentImages.length, 0, 'no late backfill');
    await finishTurn(agent, turn.documentScope, turn.generationScope);

    turn = startTurn(agent, [sourceRequest({ text: 'Describe the image you just generated.' })]);
    meta = generationRequestMetadata(turn.generationScope)[0];
    assert.equal(meta.recentImages[0].editableHandle, originalHandle);
    assert.equal(meta.recentImages[0].defaultSource, true);
    const oldRef = meta.recentImages[0].imageRef;
    const vision = await executeLook(ctx, { image: oldRef, prompt: 'Describe.' }, agent, 'look-generated');
    assert.equal(vision.isError, false, JSON.stringify(vision));
    assert.equal(visionCalls, 1);
    await finishTurn(agent, turn.documentScope, turn.generationScope);

    for (let n = 0; n < 2; n++) {
        turn = startTurn(agent, [sourceRequest()]);
        meta = generationRequestMetadata(turn.generationScope)[0];
        const base = meta.recentImages.find(image => image.editableHandle === originalHandle);
        assert.ok(base, 'looking and successful edits must not consume the original source');
        assert.notEqual(base.imageRef, oldRef);
        const edited = await nativeCall(ctx, { requestId: meta.requestId, prompt: 'Keep the pixel red.', imageAttachmentId: base.imageAttachmentId }, agent, 'edit-' + n);
        assert.equal(edited.value.status, 'sent', JSON.stringify(edited));
        assert.notEqual(edited.value.editableHandle, originalHandle);
        assert.deepEqual(calls.at(-1).imageBytes, png);
        await finishTurn(agent, turn.documentScope, turn.generationScope);
    }
    assert.equal(sends.imageSends.length, 3);
});

test('quoted sources stay lazy and can be analyzed then edited in a later request; mixed authors and document mode cannot borrow them', async t => {
    imageSources.clear();t.after(() => imageSources.clear());
    imageSources.captureQuote(identity, [{ url: IMAGE_URL, filename: 'quoted.png', contentType: 'image/png' }]);
    let downloads = 0;
    await withFixtureHttp(t, async () => { downloads++;return { response: new Response(png, { headers: { 'content-type': 'image/png' } }), close: async () => {} }; });
    const sends = senderHarness();
    let providerCalls = 0;
    const ctx = await makeNativeRuntime(t, { sender: sends.sender, imageService: {
        async generate(input) { providerCalls++;assert.deepEqual(input.imageBytes, png);return Buffer.from(png); },
    } });
    const agent = {};
    let turn = startTurn(agent, [sourceRequest()]);
    let meta = generationRequestMetadata(turn.generationScope)[0];
    const ref = meta.recentImages[0].imageRef;
    const exec = { agent, name: 'qqbot_describe_image', arguments: { image: ref }, signal: new AbortController().signal };
    bindDocumentExecution(exec);
    await runInDocumentExecution(exec, () => loadChatImageBytes(ref, 10485760, exec));
    assert.equal(downloads, 1);
    await finishTurn(agent, turn.documentScope, turn.generationScope);

    turn = startTurn(agent, [sourceRequest(), sourceRequest({ identity: { ownerId: 'other-user' } })]);
    const metas = generationRequestMetadata(turn.generationScope);
    assert.equal(metas[0].recentImages.length, 1);
    assert.equal(metas[1].recentImages.length, 0);
    let result = await nativeCall(ctx, { requestId: metas[1].requestId, prompt: 'Edit.', imageAttachmentId: metas[0].recentImages[0].imageAttachmentId }, agent, 'forged-source');
    assert.equal(result.isError, true);
    assert.equal(providerCalls, 0);
    result = await nativeCall(ctx, { requestId: metas[0].requestId, prompt: 'Edit.', imageAttachmentId: metas[0].recentImages[0].imageAttachmentId }, agent, 'quoted-edit');
    assert.equal(result.value.status, 'sent', JSON.stringify(result));
    assert.equal(downloads, 1, 'analysis cache is reused by the later edit');
    await finishTurn(agent, turn.documentScope, turn.generationScope);

    turn = startTurn(agent, [sourceRequest()]);
    turn.documentScope.documentMode = true;
    assert.equal(generationRequestMetadata(turn.generationScope)[0].recentImages.length, 0);
    await finishTurn(agent, turn.documentScope, turn.generationScope);
});

test('provider/QQ failures never publish generated sources or retry; an explicit new request can reuse its old base', async t => {
    imageSources.clear();t.after(() => imageSources.clear());
    const bootstrap = imageSources.snapshot(identity);
    imageSources.bind(bootstrap, identity, 'native-session-a');
    const original = imageSources.publish(bootstrap, png, 'native-session-a');
    let calls = 0;
    const ctx = await makeNativeRuntime(t, { sender: { async sendNotice() {}, async sendImage() { return { sent: false, reason: 'unknown' }; } },
        imageService: { async generate() { calls++;return Buffer.from(png); } } });
    const agent = {};
    for (let n = 0; n < 2; n++) {
        const turn = startTurn(agent, [sourceRequest()]);
        const meta = generationRequestMetadata(turn.generationScope)[0];
        const args = { requestId: meta.requestId, prompt: 'Edit.', imageAttachmentId: meta.recentImages[0].imageAttachmentId };
        const result = await nativeCall(ctx, args, agent, 'unknown-' + n);
        assert.equal(result.value.status, 'unknown');
        assert.equal(result.value.editableHandle, undefined);
        assert.equal((await nativeCall(ctx, args, agent, 'duplicate-' + n)).value.status, 'busy');
        await finishTurn(agent, turn.documentScope, turn.generationScope);
    }
    assert.equal(calls, 2);
    assert.equal(imageSources.listed((() => { const ticket = imageSources.snapshot(identity);imageSources.bind(ticket, identity, 'native-session-a');return ticket; })())[0].handle, original.editableHandle);
});

test('reset during an in-flight edit revokes source, suppresses late delivery and cannot publish a replacement', async t => {
    imageSources.clear();t.after(() => imageSources.clear());
    const ticket = imageSources.snapshot(identity);
    imageSources.bind(ticket, identity, 'native-session-a');
    imageSources.publish(ticket, png, 'native-session-a');
    let complete;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const sends = senderHarness();
    const ctx = await makeNativeRuntime(t, { sender: sends.sender, imageService: { async generate() {
        entered();return new Promise(resolve => { complete = resolve; });
    } } });
    const agent = {};
    const turn = startTurn(agent, [sourceRequest()]);
    const meta = generationRequestMetadata(turn.generationScope)[0];
    const running = nativeCall(ctx, { requestId: meta.requestId, prompt: 'Edit.',
        imageAttachmentId: meta.recentImages[0].imageAttachmentId }, agent, 'reset-in-flight');
    await started;
    imageSources.clearPeer(identity);
    complete(png);
    const result = await running;
    assert.equal(result.value.status, 'failed');
    assert.equal(result.value.reason, 'source-unavailable');
    assert.equal(sends.imageSends.length, 0);
    assert.equal(imageSources.stats().groups, 0);
    await finishTurn(agent, turn.documentScope, turn.generationScope);
});
