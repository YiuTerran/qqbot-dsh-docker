// Run in the built image with the pinned SDK and adapter patches installed.
// QQ, the vision endpoint, and paid model services are replaced by fixtures.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdir, readFile, rm, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pendingImagePrompts } from '/opt/qqbot-defaults/qqbot-pending-images.mjs';
import { PublicHttpProvider } from '/opt/qqbot-defaults/qqbot-web-pages.mjs';
import { getGenerationTurn } from '/opt/qqbot-defaults/qqbot-generation-scope.mjs';
import { installChatPolicy, QQ_MEDIA_ROOT } from '/opt/qqbot-defaults/qqbot-chat-policy.mjs';

const dshRoot = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/';
const profilePeers = '/data/profiles/qqbot/node_modules/@deepseek-ai';
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
const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 32, g: 96, b: 160, alpha: 1 } } })
    .png().toBuffer();

assert.equal(QQ_MEDIA_ROOT, MEDIA_ROOT);

test('production SDK chain defers images and binds each promoted image to its real follow-up request', async (t) => {
    pendingImagePrompts.clear();
    t.after(() => pendingImagePrompts.clear());
    const mediaBefore = new Set(await readdir(QQ_MEDIA_ROOT).catch(() => []));
    const networkRequests = [];
    const responseBytesByUrl = new Map();
    const originalRequestOnce = PublicHttpProvider.prototype.requestOnce;
    PublicHttpProvider.prototype.requestOnce = async function (url) {
        networkRequests.push(url.href);
        const bytes = responseBytesByUrl.get(url.href) ?? png;
        return { response: new Response(bytes, { headers: { 'content-type': 'image/png' } }), close: async () => {} };
    };
    t.after(() => { PublicHttpProvider.prototype.requestOnce = originalRequestOnce; });

    const runtime = new Context();
    t.after(() => runtime.fiber.dispose());
    await runtime.plugin(SystemPrompt, {});
    await runtime.plugin(ToolRuntime, { mode: 'native' });
    await runtime.plugin(WebRuntime, { fetchProvider: 'qqbot-pages' });
    await runtime.plugin({ inject: ['tools', 'web', 'systemPrompt'], apply: installChatPolicy });
    let visionCalls = 0;
    registerDescribeImageTool({
        get(name) {
            if (name === 'tools') return { register: (definition) => runtime.tools.register(definition) };
            if (name === 'attachments') return { saveImage: async () => ({ id: `pending-fixture-${++visionCalls}`, mediaType: 'image/png' }) };
            if (name === 'llm') return { async *stream(options) {
                assert.equal(options.messages[0].content[0].type, 'image');
                yield { type: 'block-start', index: 0, blockType: 'text' };
                yield { type: 'text-delta', index: 0, text: 'fixture image read' };
                yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fixture image read' } };
                yield { type: 'finish', reason: { kind: 'stop' } };
            } };
        },
    }, { enabled: true, provider: 'fixture-vision', model: 'fixture-multimodal', maxBytes: 10 * 1024 * 1024,
        maxTokens: 256, timeoutMs: 120000 }, logger);

    const follows = [];
    const createdMediaPaths = new Set();
    let expectation;
    const makeAgent = () => {
        const agent = {
            session: { seq: 0 },
            followup(body) {
                agent.inFlight = (async () => {
                    const scope = getGenerationTurn(agent);
                    assert.ok(scope?.active, 'the real inbound handler opens a generation scope');
                    const request = [...scope.requests.values()][0];
                    assert.ok(request, 'the prompted source becomes an original generation request');
                    const grants = [...scope.imageAttachments.values()].filter((grant) => grant.requestId === request.requestId);
                    assert.equal(grants.length, expectation.images.length, 'all expected images reach this request’s generation grants');
                    assert.equal(request.ownerId, expectation.user);
                    assert.equal(request.replyTarget.msgId, expectation.promptId,
                        'the real prompt message supplies authorization and reply credentials');
                    assert.match(request.text, /caption/u);
                    assert.match(JSON.stringify(body), /Image prompt association/u,
                        'the model gets a provenance note without rewriting the user text');
                    const observedSources = [];
                    for (const grant of grants) {
                        const expectedImage = expectation.images.find((image) => image.url === grant.sourceUrl);
                        assert.ok(expectedImage, `grant source URL belongs to this request: ${grant.sourceUrl}`);
                        assert.equal(grant.filename, expectedImage.filename);
                        assert.equal(grant.quoted, false, 'delayed and current message images remain current input, not explicit quotes');
                        assert.deepEqual(await readFile(grant.localPath), expectedImage.bytes,
                            'the downloaded local bytes match the exact source URL despite a duplicate filename');
                        const result = await runtime.tools.execute({ name: 'qqbot_describe_image',
                            arguments: { image: grant.localPath, prompt: 'Read the supplied image.' }, agent,
                            callId: `pending-image-read-${request.requestId}-${observedSources.length}`, signal: new AbortController().signal });
                        assert.equal(result.isError, false, JSON.stringify(result));
                        assert.match(result.content.map((part) => part.text).join('\n'), /fixture image read/u);
                        observedSources.push(grant.sourceUrl);
                        createdMediaPaths.add(grant.localPath);
                    }
                    follows.push({ ownerId: request.ownerId, messageId: request.replyTarget.msgId,
                        sourceUrls: observedSources, body: JSON.stringify(body) });
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
                sessionId: `pending-images-${scope}-${peerId}`, agent: makeAgent(), handle: { async dispose() {} } });
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
    const typing = [];
    const run = async ({ scope, user, peer, messageId, content, attachments = [] }) => {
        const kind = scope === 'group' ? 'group' : 'c2c';
        const replyTarget = { scope, targetId: peer, msgId: messageId };
        const ctx = {
            message: { kind, senderId: user, groupOpenid: scope === 'group' ? peer : undefined,
                messageId, msgIdx: messageId, content, attachments, timestamp: new Date().toISOString(), replyTarget },
            state: {}, log: logger,
            bot: {
                appId: APP,
                async sendMarkdown(target, text) { sent.push({ target, text }); },
                async sendText() {},
                async sendTyping(target) { typing.push(target); },
            },
            replyTarget,
            stop(reason) { ctx.stopped = true; ctx.stopReason = reason; },
        };
        let index = 0;
        const next = async () => { const middleware = layers[index++]; if (middleware) await middleware(ctx, next); };
        await next();
        for (const file of ctx.state.downloadedFiles ?? []) t.after(() => rm(file.localPath, { force: true }));
        const currentRecord = records.get(`${scope}:${peer}`);
        if (currentRecord?.agent.asyncError) throw currentRecord.agent.asyncError;
        return ctx;
    };

    for (const target of [
        { scope: 'group', user: 'group-member', peer: 'deferred-group', sourceId: 'group-image', promptId: 'group-caption' },
        { scope: 'c2c', user: 'private-member', peer: 'private-member', sourceId: 'private-image', promptId: 'private-caption' },
    ]) {
        const sourceUrl = `https://cdn.example/${target.scope}-uncaptioned.png`;
        const thinkingBefore = sent.filter((entry) => entry.text.includes('正在思考中')).length;
        const typingBefore = typing.length;
        const followupsBefore = follows.length;
        const networkBefore = networkRequests.length;
        const captured = await run({ ...target, messageId: target.sourceId, content: '', attachments: [
            { content_type: 'application/octet-stream', filename: `${target.scope}-uncaptioned.png`, size: png.length, url: sourceUrl },
        ] });
        assert.equal(captured.stopped, true, 'the image-only receipt stops before downstream middleware');
        assert.equal(follows.length, followupsBefore, 'the image alone does not invoke a model');
        assert.equal(networkRequests.length, networkBefore, 'the image alone is not downloaded');
        assert.equal(sent.filter((entry) => entry.text.includes('正在思考中')).length, thinkingBefore,
            'the image alone produces no thinking acknowledgement');
        assert.equal(typing.length, typingBefore, 'the image alone does not activate typing middleware');
        assert.equal(captured.state.downloadedFiles, undefined);

        expectation = { images: [{ url: sourceUrl, filename: `${target.scope}-uncaptioned.png`, bytes: png }],
            user: target.user, promptId: target.promptId };
        const beforePrompt = follows.length;
        const prompted = await run({ ...target, messageId: target.promptId,
            content: target.scope === 'group' ? `<@!${APP}> caption: edit this old image` : 'caption: edit this old image' });
        assert.equal(prompted.stopped, undefined);
        assert.equal(prompted.state.qqbotDeferredImagePrompt.count, 1);
        const followup = follows.at(-1);
        assert.equal(follows.length, beforePrompt + 1);
        assert.equal(followup.ownerId, target.user);
        assert.equal(followup.messageId, target.promptId);
        assert.deepEqual(followup.sourceUrls, [sourceUrl]);
        assert.ok(networkRequests.slice(networkBefore).includes(sourceUrl), 'the prompt-triggered download uses the cached source URL');
    }

    const sharedFilename = 'same-name.png';
    const deferredUrl = 'https://cdn.example/deferred-same-name.png';
    const currentUrl = 'https://cdn.example/current-same-name.png';
    const deferredBytes = await sharp({ create: { width: 1, height: 1, channels: 4,
        background: { r: 240, g: 24, b: 24, alpha: 1 } } }).png().toBuffer();
    const currentBytes = await sharp({ create: { width: 1, height: 1, channels: 4,
        background: { r: 24, g: 240, b: 24, alpha: 1 } } }).png().toBuffer();
    responseBytesByUrl.set(deferredUrl, deferredBytes);
    responseBytesByUrl.set(currentUrl, currentBytes);
    const sameNameTarget = { scope: 'group', user: 'same-name-member', peer: 'same-name-group',
        sourceId: 'same-name-image', promptId: 'same-name-caption' };
    const beforeDuplicateNameCapture = networkRequests.length;
    const capturedSameNameImage = await run({ ...sameNameTarget, messageId: sameNameTarget.sourceId, content: '', attachments: [
        { content_type: 'image/png', filename: sharedFilename, size: deferredBytes.length, url: deferredUrl },
    ] });
    assert.equal(capturedSameNameImage.stopped, true);
    assert.equal(networkRequests.length, beforeDuplicateNameCapture, 'the deferred image remains lazy until a prompt arrives');

    expectation = {
        images: [
            { url: currentUrl, filename: sharedFilename, bytes: currentBytes },
            { url: deferredUrl, filename: sharedFilename, bytes: deferredBytes },
        ],
        user: sameNameTarget.user,
        promptId: sameNameTarget.promptId,
    };
    const beforeDuplicateNamePrompt = follows.length;
    const sameNamePrompt = await run({ ...sameNameTarget, messageId: sameNameTarget.promptId,
        content: `<@!${APP}> caption: compare both images`, attachments: [
            { content_type: 'image/png', filename: sharedFilename, size: currentBytes.length, url: currentUrl },
        ] });
    assert.equal(sameNamePrompt.state.qqbotDeferredImagePrompt.count, 1,
        'the prompt combines one cached image with its own direct image');
    assert.equal(follows.length, beforeDuplicateNamePrompt + 1);
    assert.deepEqual(new Set(follows.at(-1).sourceUrls), new Set([currentUrl, deferredUrl]));
    assert.ok(networkRequests.includes(currentUrl));
    assert.ok(networkRequests.includes(deferredUrl));
    assert.equal(visionCalls, 4, 'both same-name grants reach the real image-analysis tool with their own bytes');

    for (const path of createdMediaPaths) await rm(path, { force: true });
    const mediaAfter = await readdir(QQ_MEDIA_ROOT).catch(() => []);
    assert.deepEqual(mediaAfter.filter((name) => !mediaBefore.has(name)), [],
        'all files created by deferred-image validation are removed after the test');
});
