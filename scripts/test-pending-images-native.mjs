// Run in the built image with the pinned SDK and adapter patches installed.
// QQ, remote image bytes, and the vision provider are replaced by fixtures.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pendingImagePrompts, recentImageSnapshotAvailable } from '/opt/qqbot-defaults/qqbot-pending-images.mjs';
import { PublicHttpProvider } from '/opt/qqbot-defaults/qqbot-web-pages.mjs';
import { getGenerationTurn } from '/opt/qqbot-defaults/qqbot-generation-scope.mjs';
import { installChatPolicy, QQ_MEDIA_ROOT } from '/opt/qqbot-defaults/qqbot-chat-policy.mjs';

const dshRoot = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/';
const profilePeers = '/data/profiles/qqbot/node_modules/@deepseek-ai';
const { mkdir, symlink } = await import('node:fs/promises');
await mkdir(join(profilePeers, '..'), { recursive: true });
try { await symlink(dshRoot, profilePeers, 'dir'); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
const { Context } = await import(`${dshRoot}cordis/lib/index.js`);
const { default: SystemPrompt } = await import(`${dshRoot}dsh-system-prompt/lib/index.js`);
const { default: ToolRuntime } = await import(`${dshRoot}dsh-tools/lib/index.js`);
const { default: WebRuntime } = await import(`${dshRoot}dsh-web/lib/index.js`);
const adapter = '/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/';
const { handleInbound } = await import(`${adapter}transport/inbound.js`);
const { setupMiddlewares } = await import(`${adapter}gateway/middleware-setup.js`);
const { registerDescribeImageTool } = await import(`${adapter}media/vision-tool.js`);
const { MEDIA_ROOT } = await import(`${adapter}media/media-cleaner.js`);
const logger = { info() {}, warn() {}, debug() {}, error() {} };
const APP = '123456789';
const sharp = createRequire(import.meta.url)('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/sharp');
const png = await sharp({ create: { width: 2, height: 1, channels: 4,
        background: { r: 32, g: 96, b: 160, alpha: 1 } } }).png().toBuffer();

assert.equal(QQ_MEDIA_ROOT, MEDIA_ROOT);

test('native QQ chain keeps image-only messages lazy and analyzes recent images through opaque in-memory refs', async (t) => {
    pendingImagePrompts.clear();
    t.after(() => pendingImagePrompts.clear());
    const mediaBefore = new Set(await readdir(QQ_MEDIA_ROOT).catch(() => []));
    const networkRequests = [];
    const bytesByUrl = new Map();
    const originalRequestOnce = PublicHttpProvider.prototype.requestOnce;
    PublicHttpProvider.prototype.requestOnce = async function (url) {
        networkRequests.push(url.href);
        const bytes = bytesByUrl.get(url.href) ?? png;
        return { response: new Response(bytes, { headers: { 'content-type': 'image/png' } }), close: async () => {} };
    };
    t.after(() => { PublicHttpProvider.prototype.requestOnce = originalRequestOnce; });

    const runtime = new Context();
    t.after(() => runtime.fiber.dispose());
    await runtime.plugin(SystemPrompt, {});
    await runtime.plugin(ToolRuntime, { mode: 'native' });
    await runtime.plugin(WebRuntime, { fetchProvider: 'qqbot-pages' });
    await runtime.plugin({ inject: ['tools', 'web', 'systemPrompt'], apply: installChatPolicy });

    const durableRefs = new Map();
    let saveCalls = 0;
    let nativeReadRequestCalls = 0;
    let nativeHostPathCalls = 0;
    const attachments = {
        async saveImage(input) {
            saveCalls++;
            throw new Error('Recent image analysis must not save durable attachments.');
        },
        async readImage(ref) {
            const data = durableRefs.get(ref?.attachmentId);
            if (!data) throw new Error('attachment ref is not authorized');
            return { ref, data };
        },
        async readImageRequest(ref, target) {
            nativeReadRequestCalls++;
            const data = durableRefs.get(ref?.attachmentId);
            if (!data) throw new Error('attachment ref is not authorized');
            const decoded = await sharp(data).metadata();
            return { attachment: ref, data, bytes: data.byteLength, width: decoded.width,
                height: decoded.height, mediaType: ref.mediaType, hasAlpha: decoded.hasAlpha,
                target };
        },
        imageHostPath(ref) {
            nativeHostPathCalls++;
            return durableRefs.has(ref?.attachmentId) ? `/fixture/${ref.attachmentId}` : undefined;
        },
    };
    const leakedMemoryRefs = [];
    const visionReads = [];
    let memoryReadRequestCalls = 0;
    let memoryHostPathChecks = 0;
    let expectedVisionColor;
    let visionCalls = 0;
    registerDescribeImageTool({
        get(name) {
            if (name === 'tools') return { register: (definition) => runtime.tools.register(definition) };
            if (name === 'attachments') return attachments;
            if (name === 'llm') return { async *stream(options) {
                const block = options.messages[0].content[0];
                assert.equal(block.type, 'image');
                assert.ok(block.attachment && typeof block.attachment === 'object',
                    'the SDK vision adapter receives a native attachment reference');
                const ref = block.attachment;
                leakedMemoryRefs.push({ ref, expected: expectedVisionColor });
                memoryHostPathChecks++;
                assert.equal(attachments.imageHostPath(ref), undefined,
                    'recent image references never resolve to durable host paths');
                memoryReadRequestCalls++;
                const request = await attachments.readImageRequest(ref,
                    { width: 2048, height: 2048, maxBytes: 4 * 1024 * 1024 }, options.signal);
                assert.ok(request.data.byteLength > 0);
                const decoded = await sharp(request.data).metadata();
                assert.equal(decoded.width, 2);
                assert.equal(decoded.height, 1);
                const pixels = await sharp(request.data).ensureAlpha().raw().toBuffer();
                for (let channel = 0; channel < 3; channel++) {
                    assert.ok(Math.abs(pixels[channel] - leakedMemoryRefs.at(-1).expected[channel]) <= 45,
                        'each original opaque ref resolves to the expected image bytes');
                }
                visionReads.push({ ref, bytes: request.data.byteLength });
                visionCalls++;
                yield { type: 'block-start', index: 0, blockType: 'text' };
                yield { type: 'text-delta', index: 0, text: 'fixture image read' };
                yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fixture image read' } };
                yield { type: 'finish', reason: { kind: 'stop' } };
            } };
        },
    }, { enabled: true, provider: 'fixture-vision', model: 'fixture-multimodal', maxBytes: 10 * 1024 * 1024,
        maxTokens: 256, timeoutMs: 120000 }, logger);

    const followups = [];
    let expected;
    const makeAgent = () => {
        const agent = {
            session: { seq: 0 },
            followup(body) {
                agent.inFlight = (async () => {
                    const scope = getGenerationTurn(agent);
                    assert.ok(scope?.active, 'the real inbound handler opens a generation scope');
                    const request = [...scope.requests.values()][0];
                    assert.ok(request, 'the prompt is preserved as an original generation request');
                    assert.equal(request.ownerId, expected.user);
                    assert.equal(request.replyTarget.msgId, expected.promptId);
                    assert.equal(request.text, expected.text);
                    assert.equal(request.images.length, 0, 'recent image candidates stay outside current attachments');
                    assert.equal(request.recentImages.length, expected.recentCount);
                    const serializedBody = JSON.stringify(body);
                    assert.match(serializedBody, /recentImages/u,
                        'the model receives a separate request-local recentImages field');
                    for (const candidate of request.recentImages) {
                        assert.match(candidate.imageRef, /^qqbot-image:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/u);
                        assert.equal(serializedBody.includes(candidate.imageAttachmentId), true,
                            'metadata exposes the plain generation ID and opaque vision reference');
                    }
                    assert.equal(expected.urls.some((url) => serializedBody.includes(url)), false,
                        'source URLs are never included in model-visible request metadata');

                    const observed = [];
                    for (const candidate of expected.useTools ? request.recentImages : []) {
                        expectedVisionColor = expected.colors[observed.length];
                        const result = await runtime.tools.execute({ name: 'qqbot_describe_image',
                            arguments: { image: candidate.imageRef, prompt: 'Read the supplied image.' }, agent,
                            callId: `recent-image-read-${request.requestId}-${observed.length}`,
                            signal: new AbortController().signal });
                        assert.equal(result.isError, false, JSON.stringify(result));
                        assert.match(result.content.map((part) => part.text).join('\n'), /fixture image read/u);
                        observed.push(candidate.imageRef);
                    }
                    if (!expected.useTools) {
                        assert.equal(recentImageSnapshotAvailable(request.recentImageSnapshot), true,
                            'ordinary chat leaves the pending recent-image capability available');
                    }
                    followups.push({ request, body: serializedBody, observed });
                })();
                agent.inFlight.catch((error) => { agent.asyncError = error; });
            },
            async whenIdle() { if (agent.inFlight) await agent.inFlight; },
        };
        return agent;
    };

    const records = new Map();
    const manager = {
        questionChannel: { tryAnswer() { return false; } },
        getSessionRecord(scope, peerId) { return records.get(`${scope}:${peerId}`); },
        async getOrCreate(scope, peerId, senderId, replyTarget) {
            const key = `${scope}:${peerId}`;
            if (!records.has(key)) records.set(key, { scope, peerId, senderId, replyTarget,
                sessionId: `recent-images-${scope}-${peerId}`, agent: makeAgent(), handle: { async dispose() {} } });
            const record = records.get(key);
            record.replyTarget = replyTarget;
            return record;
        },
    };
    const config = {
        appId: APP, debug: false,
        access: { c2cMode: 'open', c2cAllow: [], groupMode: 'open', groupAllow: [] },
        requireMention: true, historyLimit: 10, maxQueue: 4, processingTimeoutMs: 0,
        media: { enabled: true, maxMB: 10 }, textChunkLimit: 2000, streaming: false,
    };
    const layers = [];
    setupMiddlewares({ use: (middleware) => layers.push(middleware) }, config, manager, logger);
    layers.push((ctx) => handleInbound(ctx, manager, config, logger));
    const sent = [];
    const run = async ({ scope, user, peer, messageId, content, attachments: messageAttachments = [] }) => {
        const replyTarget = { scope, targetId: peer, msgId: messageId };
        const ctx = {
            message: { kind: scope === 'group' ? 'group' : 'c2c', senderId: user,
                groupOpenid: scope === 'group' ? peer : undefined,
                messageId, msgIdx: messageId, content, attachments: messageAttachments,
                timestamp: new Date().toISOString(), replyTarget },
            state: {}, log: logger,
            bot: {
                appId: APP,
                async sendMarkdown(target, text) { sent.push({ target, text }); },
                async sendText() {},
                async sendTyping() {},
            },
            replyTarget,
            stop(reason) { ctx.stopped = true; ctx.stopReason = reason; },
        };
        let index = 0;
        const next = async () => { const middleware = layers[index++]; if (middleware) await middleware(ctx, next); };
        await next();
        const record = records.get(`${scope}:${peer}`);
        if (record?.agent.inFlight) await record.agent.whenIdle();
        if (record?.agent.asyncError) throw record.agent.asyncError;
        return ctx;
    };

    const group = { scope: 'group', user: 'group-member', peer: 'recent-group' };
    const groupImages = [
        { url: 'https://cdn.example/group-first.png', filename: 'first.png', color: [240, 20, 20] },
        { url: 'https://cdn.example/group-second.png', filename: 'second.png', color: [20, 240, 20] },
    ];
    const privateTarget = { scope: 'c2c', user: 'private-member', peer: 'private-member' };
    const privateImage = { url: 'https://cdn.example/private-recent.png', filename: 'recent.png', color: [20, 20, 240] };
    const allSources = [...groupImages, privateImage];
    for (const source of allSources) {
        bytesByUrl.set(source.url, await sharp({ create: { width: 2, height: 1, channels: 4,
            background: { r: source.color[0], g: source.color[1], b: source.color[2], alpha: 1 } } }).png().toBuffer());
    }
    const networkBeforeCapture = networkRequests.length;
    for (const [index, source] of groupImages.entries()) {
        const captured = await run({ ...group, messageId: `group-image-${index}`, content: '', attachments: [
            { content_type: 'application/octet-stream', filename: source.filename, size: png.length, url: source.url },
        ] });
        assert.equal(captured.stopped, true, 'group image-only messages stop before model handling');
        assert.equal(captured.state.downloadedFiles, undefined);
    }
    const privateCaptured = await run({ ...privateTarget, messageId: 'private-image', content: '', attachments: [
        { content_type: 'image/png', filename: privateImage.filename, size: png.length, url: privateImage.url },
    ] });
    assert.equal(privateCaptured.stopped, true, 'private image-only messages stop before model handling');
    assert.equal(networkRequests.length, networkBeforeCapture,
        'capturing group and private image-only messages never downloads image bytes');
    assert.equal(followups.length, 0, 'image-only messages do not call the chat model');

    const ordinaryText = 'Hi, what can you help me with?';
    expected = { user: privateTarget.user, promptId: 'private-ordinary', text: ordinaryText,
        recentCount: 1, urls: [privateImage.url], colors: [privateImage.color], useTools: false };
    const ordinary = await run({ ...privateTarget, messageId: expected.promptId, content: ordinaryText });
    assert.equal(ordinary.stopped, undefined);
    assert.equal(followups.at(-1).observed.length, 0,
        'ordinary private chat sees no automatic image read and does not consume the batch');
    assert.equal(networkRequests.length, networkBeforeCapture);

    const groupText = `<@!${APP}> Please analyze the two earlier images.`;
    expected = { user: group.user, promptId: 'group-analysis', text: 'Please analyze the two earlier images.',
        recentCount: 2, urls: groupImages.map((image) => image.url),
        colors: groupImages.map((image) => image.color), useTools: true };
    const groupPrompt = await run({ ...group, messageId: expected.promptId, content: groupText });
    assert.equal(groupPrompt.stopped, undefined);
    assert.deepEqual(followups.at(-1).observed.length, 2,
        'one original group request can explicitly analyze all of its recent image candidates');
    assert.deepEqual(new Set(networkRequests.slice(networkBeforeCapture)), new Set(groupImages.map((image) => image.url)));

    const privateText = 'Please read the image I just sent.';
    expected = { user: privateTarget.user, promptId: 'private-analysis', text: privateText,
        recentCount: 1, urls: [privateImage.url], colors: [privateImage.color], useTools: true };
    const privatePrompt = await run({ ...privateTarget, messageId: expected.promptId, content: privateText });
    assert.equal(privatePrompt.stopped, undefined);
    assert.equal(followups.at(-1).observed.length, 1,
        'a private user can explicitly analyze a recent image without a group mention');
    assert.equal(visionCalls, 3);
    assert.equal(memoryReadRequestCalls, 3, 'each native image analysis resolves actual bytes through readImageRequest');
    assert.equal(nativeReadRequestCalls, 0, 'memory refs never fall through to native attachment reads');
    assert.equal(saveCalls, 0, 'recent refs bypass durable attachments.saveImage entirely');
    assert.equal(memoryHostPathChecks, 3);
    assert.equal(nativeHostPathCalls, 0, 'memory refs never resolve through durable imageHostPath');
    assert.deepEqual(networkRequests.slice(networkBeforeCapture).sort(), allSources.map((image) => image.url).sort());

    for (const { ref } of leakedMemoryRefs) {
        await assert.rejects(attachments.readImageRequest(ref, { width: 100, height: 100, maxBytes: 1024 }),
            /authorized|expired|memory image/u, 'the temporary SDK ref is revoked after each vision callback');
    }
    assert.deepEqual(new Set(await readdir(QQ_MEDIA_ROOT).catch(() => [])), mediaBefore,
        'recent image analysis leaves the QQ media directory unchanged');
    assert.equal(sent.some((entry) => entry.text.includes('Image prompt association')), false,
        'request metadata is supplied to the model, not sent as a QQ reply');
});
