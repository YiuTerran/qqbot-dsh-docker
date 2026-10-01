// Offline Phase 2 image transport, tool, quota, and sender regressions.
// All provider and QQ SDK requests use deterministic injected adapters.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';

const generationUrl = process.env.QQBOT_GENERATION_MODULE
    ?? new URL('../defaults/qqbot-generation.mjs', import.meta.url).href;
const generation = await import(generationUrl);
const { createImageService, readImageRouteConfig, registerGenerationTools, GENERATE_IMAGE_TOOL, CREATE_MARKDOWN_TOOL, validateGenerationToolCall } = generation;
const generationPath = generationUrl.startsWith('file:') ? fileURLToPath(generationUrl) : generationUrl;
const generationDir = dirname(generationPath);
const generationScopeModule = await import(pathToFileURL(join(generationDir, 'qqbot-generation-scope.mjs')).href);
const documentScopeModule = await import(pathToFileURL(join(generationDir, 'qqbot-document-scope.mjs')).href);
const senderModule = await import(pathToFileURL(join(generationDir, 'qqbot-generation-sender.mjs')).href);
const chatPolicyModule = await import(pathToFileURL(join(generationDir, 'qqbot-chat-policy.mjs')).href);
const { beginGenerationTurn, endGenerationTurn, getGenerationRequest } = generationScopeModule;
const { beginDocumentTurn, endDocumentTurn, getDocumentTurn, runInDocumentExecution, bindDocumentExecution } = documentScopeModule;
const { setCurrentImages, clearCurrentImages } = chatPolicyModule;
const { createGenerationSender } = senderModule;

const dshRoot = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/';
const profilePeers = '/data/profiles/qqbot/node_modules/@deepseek-ai';
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

const png = createPngFixture();
const jpeg = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkI'
    + 'CQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
    + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
    'base64',
);
const route = (protocol = 'openai-images') => ({
    apiKey: 'fixture-image-secret',
    baseUrl: 'https://image-api.example.test/v1',
    model: 'fixture-image-model',
    protocol,
});

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function makeQuota({ reserve = { ok: true }, acquire = { ok: true } } = {}) {
    const events = [];
    return {
        events,
        async tryAcquire(input) {
            events.push(['acquire', input.ownerId, input.type]);
            return acquire.ok ? { ok: true, release() { events.push(['release', input.ownerId, input.type]); } } : acquire;
        },
        async reserve(input) {
            events.push(['reserve', input.ownerId, input.type]);
            return reserve;
        },
    };
}

function makeGenerationRequest(ownerId, targetId, msgId) {
    return {
        ownerId,
        replyTarget: { scope: 'group', targetId, msgId },
        text: 'Generate or export a file.',
        currentAttachments: [],
        quotedAttachments: [],
    };
}

async function nativeGenerationRuntime(t, options) {
    const ctx = new Context();
    t.after(() => ctx.fiber.dispose());
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime, { mode: 'native' });
    ctx.tools.guard((exec) => {
        bindDocumentExecution(exec);
        return validateGenerationToolCall(exec, options.route);
    });
    ctx.on('tools/execute', (exec, next) => runInDocumentExecution(exec, next));
    const registration = registerGenerationTools(ctx, options);
    return { ctx, registration };
}

function nativeCall(ctx, name, args, agent, callId, signal = new AbortController().signal) {
    return ctx.tools.execute({ name, arguments: args, agent, callId, signal });
}

function makeSdkHarness({
    tokenManager = { async getAccessToken() { return 'fixture-access-token'; } },
    fetchImpl,
    limit = true,
    afterUpload,
    ordinaryQueue,
} = {}) {
    const requests = [];
    const limiterEvents = [];
    const events = [];
    const replyLimiter = {
        checkLimit(msgId) {
            limiterEvents.push(['check', msgId]);
            return { allowed: typeof limit === 'function' ? limit(msgId) : limit };
        },
        record(msgId) {
            limiterEvents.push(['record', msgId]);
        },
    };
    const transport = fetchImpl ?? (async (url) => {
        const path = new URL(String(url)).pathname;
        const value = path.endsWith('/files')
            ? { file_uuid: 'fixture-file-uuid', file_info: 'fixture-file-info', ttl: 60 }
            : { id: 'fixture-ack-id' };
        return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    class MediaApi {
        constructor(client, manager) {
            this.client = client;
            this.manager = manager;
        }

        async uploadMedia(scope, targetId, fileType, credentials, { buffer, srvSendMsg, fileName }) {
            events.push(['upload', scope, targetId, fileType, credentials, srvSendMsg, fileName]);
            const collection = scope === 'group' ? 'groups' : 'users';
            const result = await this.client.request(await this.manager.getAccessToken(), 'POST',
                `/v2/${collection}/${targetId}/files`, {
                    file_type: fileType,
                    file_data: buffer.toString('base64'),
                    srv_send_msg: false,
                    ...(fileType === 4 ? { file_name: fileName } : {}),
                }, { uploadRequest: true });
            if (afterUpload) await afterUpload();
            return result;
        }

        async sendMediaMessage(scope, targetId, fileInfo, credentials, { msgId }) {
            events.push(['send-media', scope, targetId, msgId]);
            const collection = scope === 'group' ? 'groups' : 'users';
            return this.client.request(await this.manager.getAccessToken(), 'POST',
                `/v2/${collection}/${targetId}/messages`, {
                    msg_type: 7, media: { file_info: fileInfo }, msg_id: msgId,
                }, {});
        }
    }
    class MessageApi {
        constructor(client, manager) {
            this.client = client;
            this.manager = manager;
        }

        async sendRaw(scope, targetId, credentials, { msg_type, content, msg_id }) {
            const collection = scope === 'group' ? 'groups' : 'users';
            return this.client.request(await this.manager.getAccessToken(), 'POST',
                `/v2/${collection}/${targetId}/messages`, { msg_type, content, msg_id }, {});
        }
    }
    let sendTail = Promise.resolve();
    const enqueueSend = ordinaryQueue ?? ((operation) => {
        const pending = sendTail.then(operation);
        sendTail = pending.catch(() => {});
        return pending;
    });
    const sender = createGenerationSender({
        bot: { tokenManager },
        replyLimiter,
        sdk: { MediaApi, MessageApi },
        credentials: { appId: 'fixture-app-id', clientSecret: 'fixture-app-secret' },
        fetchImpl: async (url, options) => {
            requests.push({ url: String(url), ...options });
            return transport(url, options);
        },
    });
    const request = {
        replyTarget: { scope: 'group', targetId: 'group-original', msgId: 'msg-original' },
        ownerId: 'owner-original',
        record: {},
        enqueueSend,
        isActive: () => true,
    };
    return { sender, request, requests, limiterEvents, events, replyLimiter, enqueueSend };
}

function responseImage(bytes = png) {
    return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: Buffer.from(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] })),
    };
}

function header(headers, name) {
    if (headers instanceof Headers) return headers.get(name);
    if (headers && typeof headers.get === 'function') return headers.get(name);
    const key = Object.keys(headers ?? {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : headers[key];
}

function bodyBuffer(body) {
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return Buffer.from(body);
    if (typeof body === 'string') return Buffer.from(body);
    return undefined;
}

function requestUrl(request) {
    return request.url instanceof URL ? request.url.href : String(request.url);
}

function makeImageService({ protocol = 'openai-images', onRequest, resolvePublic = async () => [{ address: '93.184.216.34', family: 4 }] }) {
    return createImageService({ route: route(protocol), transport: onRequest, resolvePublic });
}

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const typeBytes = Buffer.from(type, 'ascii');
    const crcInput = Buffer.concat([typeBytes, data]);
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    typeBytes.copy(chunk, 4);
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(crcInput), 8 + data.length);
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

function oversizedValidPng() {
    const chunks = [];
    let offset = 8;
    while (offset + 12 <= png.length) {
        const length = png.readUInt32BE(offset);
        const end = offset + 12 + length;
        const type = png.toString('ascii', offset + 4, offset + 8);
        if (end > png.length) throw new Error('fixture PNG is truncated');
        if (type !== 'IEND') chunks.push(png.subarray(offset, end));
        offset = end;
    }
    const filler = Buffer.alloc(10 * 1024 * 1024 + 1 - png.length, 0x20);
    const textData = Buffer.concat([Buffer.from('Fixture\0'), filler]);
    const insertion = pngChunk('tEXt', textData);
    return Buffer.concat([png.subarray(0, 8), ...chunks, insertion, png.subarray(png.length - 12)]);
}

test('image route config is independent, all-or-none, and defaults only a complete route to OpenAI images', () => {
    assert.equal(readImageRouteConfig({}), undefined);
    assert.throws(() => readImageRouteConfig({ IMAGE_API_PROTOCOL: 'openai-images' }),
        'protocol alone cannot activate the image feature');
    assert.throws(() => readImageRouteConfig({ IMAGE_API_KEY: 'fixture-key' }),
        'partial image credentials fail closed');

    const openAi = readImageRouteConfig({
        IMAGE_API_KEY: 'dedicated-image-key',
        IMAGE_API_BASE_URL: 'https://images.example.test/v1/',
        IMAGE_MODEL: 'image-model',
    });
    assert.deepEqual(openAi, {
        apiKey: 'dedicated-image-key', baseUrl: 'https://images.example.test/v1',
        model: 'image-model', protocol: 'openai-images',
    });
    const xai = readImageRouteConfig({
        IMAGE_API_KEY: 'dedicated-image-key',
        IMAGE_API_BASE_URL: 'https://images.example.test/v1',
        IMAGE_MODEL: 'image-model', IMAGE_API_PROTOCOL: 'xai-images',
    });
    assert.equal(xai.protocol, 'xai-images');

    for (const baseUrl of [
        'http://images.example.test/v1',
        'https://user:pass@images.example.test/v1',
        'https://images.example.test/v1?token=secret',
        'https://images.example.test/v1#fragment',
    ]) {
        assert.throws(() => readImageRouteConfig({
            IMAGE_API_KEY: 'dedicated-image-key', IMAGE_API_BASE_URL: baseUrl, IMAGE_MODEL: 'image-model',
        }));
    }
    assert.throws(() => readImageRouteConfig({
        IMAGE_API_KEY: 'dedicated-image-key', IMAGE_API_BASE_URL: 'https://images.example.test/v1',
        IMAGE_MODEL: 'image-model', IMAGE_API_PROTOCOL: 'unsupported',
    }));
    assert.throws(() => readImageRouteConfig({
        IMAGE_API_KEY: 'key\nwith-control', IMAGE_API_BASE_URL: 'https://images.example.test/v1', IMAGE_MODEL: 'image-model',
    }));
    assert.throws(() => readImageRouteConfig({
        IMAGE_API_KEY: 'x'.repeat(4097), IMAGE_API_BASE_URL: 'https://images.example.test/v1', IMAGE_MODEL: 'image-model',
    }));
});

test('OpenAI image generation uses only the fixed generation route, JSON contract, bearer key, and n=1', async () => {
    const requests = [];
    const service = makeImageService({ onRequest: async (request) => {
        requests.push(request);
        return responseImage();
    } });
    const controller = new AbortController();
    const result = await service.generate({ prompt: 'Draw a red fox in snow.', signal: controller.signal });

    assert.deepEqual(result, png);
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.method, 'POST');
    assert.equal(requestUrl(request), 'https://image-api.example.test/v1/images/generations');
    assert.equal(header(request.headers, 'authorization'), 'Bearer fixture-image-secret');
    assert.ok(request.signal instanceof AbortSignal);
    const body = bodyBuffer(request.body);
    assert.ok(body, 'generation request has a bounded JSON body');
    const payload = JSON.parse(body.toString('utf8'));
    assert.deepEqual(payload, { model: 'fixture-image-model', prompt: 'Draw a red fox in snow.', n: 1 });
    assert.ok(request.maxResponseBytes <= 16 * 1024 * 1024);
    controller.abort(new Error('fixture cancel'));
    assert.equal(request.signal.aborted, true, 'caller cancellation reaches the image API request');
});

test('OpenAI image edits use multipart fields and include only the selected image bytes', async () => {
    const requests = [];
    const service = makeImageService({ onRequest: async (request) => {
        requests.push(request);
        return responseImage(jpeg);
    } });
    const controller = new AbortController();
    const result = await service.generate({ prompt: 'Make the sky blue.', imageBytes: png, signal: controller.signal });

    assert.deepEqual(result, jpeg);
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.method, 'POST');
    assert.equal(requestUrl(request), 'https://image-api.example.test/v1/images/edits');
    assert.ok(request.signal instanceof AbortSignal);
    assert.ok(request.body instanceof FormData, 'OpenAI edit request uses multipart form data');
    assert.equal(request.body.get('model'), 'fixture-image-model');
    assert.equal(request.body.get('prompt'), 'Make the sky blue.');
    assert.equal(request.body.get('n'), '1');
    const imageFile = request.body.get('image');
    assert.ok(imageFile instanceof Blob);
    assert.equal(imageFile.name, 'input.png');
    assert.equal(imageFile.type, 'image/png');
    assert.deepEqual(Buffer.from(await imageFile.arrayBuffer()), png,
        'the selected QQ image bytes reach the edit route unchanged');
    const wireRequest = new Request(requestUrl(request), {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: request.signal,
    });
    assert.match(wireRequest.headers.get('content-type') ?? '', /^multipart\/form-data; boundary=/iu,
        'the actual HTTP Request serializes multipart data with a boundary');
    const wireBody = Buffer.from(await wireRequest.arrayBuffer());
    assert.ok(wireBody.includes(Buffer.from('filename="input.png"')));
    assert.ok(wireBody.includes(Buffer.from('Content-Type: image/png')));
    assert.ok(wireBody.includes(png), 'multipart wire body contains only the selected image bytes');
});

test('xAI image edits use JSON with an embedded data image and fixed one-image request', async () => {
    const requests = [];
    const service = makeImageService({ protocol: 'xai-images', onRequest: async (request) => {
        requests.push(request);
        return responseImage();
    } });
    const result = await service.generate({ prompt: 'Remove the sign.', imageBytes: png, signal: new AbortController().signal });

    assert.deepEqual(result, png);
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(requestUrl(request), 'https://image-api.example.test/v1/images/edits');
    assert.match(header(request.headers, 'content-type') ?? '', /application\/json/iu);
    const body = bodyBuffer(request.body);
    assert.ok(body, 'xAI edit payload is JSON rather than multipart');
    const payload = JSON.parse(body.toString('utf8'));
    assert.equal(payload.model, 'fixture-image-model');
    assert.equal(payload.prompt, 'Remove the sign.');
    assert.equal(payload.n, 1);
    assert.deepEqual(payload.image, { url: `data:image/png;base64,${png.toString('base64')}` },
        'the xAI edit image is embedded as a data URI');
});

test('image response URLs are downloaded without credentials and reject unsafe hosts or redirects', async (t) => {
    const signed = 'https://cdn.example.test/generated.png?sig=fixture-signed-value';
    const requests = [];
    const resolved = [];
    const service = createImageService({
        route: route(),
        resolvePublic: async (hostname) => {
            resolved.push(hostname);
            return [{ address: '93.184.216.34', family: 4 }];
        },
        fetchImpl: async (url, options) => {
            requests.push({ url: String(url), ...options });
            if (options.method === 'POST') {
                return new Response(JSON.stringify({ data: [{ url: signed }] }), {
                    status: 200, headers: { 'content-type': 'application/json' },
                });
            }
            return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
        },
    });
    t.after(() => { requests.length = 0; });
    assert.deepEqual(await service.generate({ prompt: 'A lighthouse at night.' }), png);
    assert.deepEqual(requests.map((request) => request.method), ['POST', 'GET']);
    assert.deepEqual(resolved, ['image-api.example.test', 'cdn.example.test']);
    assert.equal(header(requests[1].headers, 'authorization'), undefined,
        'the API credential is never sent to the response image host');
    assert.ok(!JSON.stringify(requests[1]).includes('fixture-image-secret'));

    let transportCalls = 0;
    const privateHost = createImageService({
        route: route(),
        resolvePublic: async () => [],
        fetchImpl: async () => { transportCalls++; return new Response('unexpected'); },
    });
    await assert.rejects(privateHost.generate({ prompt: 'No internal access.' }));
    assert.equal(transportCalls, 0, 'private DNS answers are rejected before any HTTP request');

    const redirectCalls = [];
    const redirecting = createImageService({
        route: route(),
        resolvePublic: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: async (url, options) => {
            redirectCalls.push({ url: String(url), ...options });
            if (options.method === 'POST') return new Response(JSON.stringify({ data: [{ url: signed }] }), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
            return new Response(null, { status: 302, headers: { location: 'https://other.example.test/escape.png' } });
        },
    });
    await assert.rejects(redirecting.generate({ prompt: 'No redirect escape.' }));
    assert.equal(redirectCalls.length, 2, 'a cross-origin redirect is not followed');
});

test('provider protocol and response bounds reject unsafe, malformed, and oversized image results', async () => {
    let called = 0;
    for (const unsafe of [
        { ...route(), baseUrl: 'http://image-api.example.test/v1' },
        { ...route(), baseUrl: 'https://user:pass@image-api.example.test/v1' },
        { ...route(), baseUrl: 'https://image-api.example.test/v1?token=secret' },
        { ...route(), protocol: 'unsupported' },
    ]) {
        assert.throws(() => createImageService({ route: unsafe, transport: async () => { called++; } }));
    }
    assert.equal(called, 0);

    const oversizedJson = createImageService({
        route: route(),
        resolvePublic: async () => [{ address: '93.184.216.34', family: 4 }],
        transport: async (request) => {
            assert.ok(request.maxResponseBytes <= 16 * 1024 * 1024);
            return {
                status: 200,
                headers: new Headers({ 'content-type': 'application/json' }),
                body: Buffer.alloc(16 * 1024 * 1024 + 1, 0x20),
            };
        },
    });
    await assert.rejects(oversizedJson.generate({ prompt: 'Bound the API response.' }));

    const oversizedDecoded = oversizedValidPng();
    assert.ok(oversizedDecoded.length > 10 * 1024 * 1024);
    const tooLargeImage = createImageService({
        route: route(),
        resolvePublic: async () => [{ address: '93.184.216.34', family: 4 }],
        transport: async () => responseImage(oversizedDecoded),
    });
    await assert.rejects(tooLargeImage.generate({ prompt: 'Bound decoded image bytes.' }));

    const invalidBytes = createImageService({
        route: route(),
        resolvePublic: async () => [{ address: '93.184.216.34', family: 4 }],
        transport: async () => responseImage(Buffer.from('not an image')),
    });
    await assert.rejects(invalidBytes.generate({ prompt: 'Only PNG and JPEG are accepted.' }));
    assert.deepEqual(jpeg.subarray(0, 2), Buffer.from([0xff, 0xd8]));
});

test('QQ sender uses only the fixed upload/message routes, original reply target, and one reply-limit charge', async () => {
    const harness = makeSdkHarness();
    const result = await harness.sender.sendImage(harness.request, png, new AbortController().signal);

    assert.deepEqual(result, { sent: true });
    assert.equal(harness.requests.length, 2);
    assert.deepEqual(harness.requests.map((request) => new URL(request.url).pathname), [
        '/v2/groups/group-original/files', '/v2/groups/group-original/messages',
    ]);
    assert.ok(harness.requests.every((request) => request.url.startsWith('https://api.sgroup.qq.com/')));
    assert.ok(harness.requests.every((request) => request.redirect === 'error'));
    assert.deepEqual(harness.limiterEvents.filter(([kind]) => kind === 'record'), [['record', 'msg-original']],
        'the upload is not charged and the message is charged once against its original msgId');
    const upload = JSON.parse(harness.requests[0].body);
    assert.deepEqual(Object.keys(upload).sort(), ['file_data', 'file_type', 'srv_send_msg']);
    assert.equal(upload.file_type, 1);
    assert.equal(upload.srv_send_msg, false);
    assert.equal(Buffer.from(upload.file_data, 'base64').compare(png), 0);
    const message = JSON.parse(harness.requests[1].body);
    assert.deepEqual(message, { msg_type: 7, media: { file_info: 'fixture-file-info' }, msg_id: 'msg-original' });
    assert.equal(harness.requests[1].headers.Authorization, 'QQBot fixture-access-token');
});

test('QQ sender serializes attachment delivery with an ordinary reply on the same per-request queue', async () => {
    const harness = makeSdkHarness();
    const resultPromise = harness.sender.sendImage(harness.request, png, new AbortController().signal);
    let requestCountAtOrdinarySend = -1;
    const ordinaryPromise = harness.enqueueSend(async () => { requestCountAtOrdinarySend = harness.requests.length; });
    assert.deepEqual(await resultPromise, { sent: true });
    await ordinaryPromise;
    assert.equal(requestCountAtOrdinarySend, 2, 'the ordinary reply starts after upload and attachment send finish');
    assert.equal(harness.requests.length, 2, 'ordinary queue entries do not become extra generation HTTP requests');
});

test('QQ sender accepts safe Unicode Markdown filenames and sends file type 4 with no path', async () => {
    const harness = makeSdkHarness();
    const result = await harness.sender.sendMarkdownFile(
        harness.request, Buffer.from('# 报告\n', 'utf8'), ' 周报 2026.md', new AbortController().signal,
    );

    assert.deepEqual(result, { sent: true });
    assert.equal(harness.requests.length, 2);
    const upload = JSON.parse(harness.requests[0].body);
    assert.deepEqual(Object.keys(upload).sort(), ['file_data', 'file_name', 'file_type', 'srv_send_msg']);
    assert.equal(upload.file_type, 4);
    assert.equal(upload.file_name, ' 周报 2026.md');
    assert.equal(upload.srv_send_msg, false);
    assert.equal(harness.requests[0].url, 'https://api.sgroup.qq.com/v2/groups/group-original/files');
});

test('QQ sender refuses fallback when the original reply slot is unavailable and never targets another id', async () => {
    const harness = makeSdkHarness({ limit: false });
    const result = await harness.sender.sendImage(harness.request, png, new AbortController().signal);

    assert.deepEqual(result, { sent: false, reason: 'limit' });
    assert.equal(harness.requests.length, 0, 'a refused original msgId does not upload, send proactively, or try a different target');
    assert.ok(harness.limiterEvents.every(([, msgId]) => msgId === 'msg-original'));
});

test('QQ sender waits for a delayed token after cancellation, keeps the queue locked, and performs no late POST', async () => {
    const tokenRequested = deferred();
    const tokenResult = deferred();
    let settled = false;
    const harness = makeSdkHarness({
        tokenManager: {
            getAccessToken() {
                tokenRequested.resolve();
                return tokenResult.promise;
            },
        },
    });
    const controller = new AbortController();
    const pending = harness.sender.sendImage(harness.request, png, controller.signal).finally(() => { settled = true; });
    await tokenRequested.promise;
    controller.abort(new Error('fixture cancellation'));
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(settled, false, 'cancellation does not release an outstanding SDK/token operation early');
    assert.deepEqual(harness.requests, [], 'no request has reached the transport while the token is pending');

    tokenResult.resolve('fixture-access-token');
    assert.deepEqual(await pending, { sent: false, reason: 'expired' });
    assert.deepEqual(harness.requests, [], 'the post-token active check blocks a late POST');
});

test('QQ sender drains a blocked upload response after cancellation and skips the second message call', async () => {
    const uploadStarted = deferred();
    const finishUpload = deferred();
    const harness = makeSdkHarness({ afterUpload: async () => {
        uploadStarted.resolve();
        await finishUpload.promise;
    } });
    const controller = new AbortController();
    let settled = false;
    const pending = harness.sender.sendImage(harness.request, png, controller.signal).finally(() => { settled = true; });
    await uploadStarted.promise;
    assert.equal(harness.requests.length, 1, 'the upload completed before cancellation');
    controller.abort(new Error('fixture cancellation after upload'));
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(settled, false, 'the sending slot remains held until the SDK upload promise drains');
    finishUpload.resolve();
    assert.deepEqual(await pending, { sent: false, reason: 'expired' });
    assert.equal(harness.requests.length, 1, 'an upload finishing after cancellation never triggers a messages POST');
});

test('QQ sender turns transport and malformed-ACK failures into one bounded failure without retry', async () => {
    let attempts = 0;
    const failing = makeSdkHarness({ fetchImpl: async () => {
        attempts++;
        throw new Error('fixture-secret-provider-stack');
    } });
    assert.deepEqual(await failing.sender.sendImage(failing.request, png, new AbortController().signal), {
        sent: false, reason: 'failed',
    });
    assert.equal(attempts, 1, 'the SDK sees the fixed Timeout failure and cannot retry an upload');

    const malformedAck = makeSdkHarness({ fetchImpl: async (url) => {
        const isFile = new URL(String(url)).pathname.endsWith('/files');
        return new Response(JSON.stringify(isFile
            ? { file_uuid: 'fixture-file-uuid', file_info: 'fixture-file-info', ttl: 60 }
            : { status: 'ok' }), { status: 200 });
    } });
    assert.deepEqual(await malformedAck.sender.sendImage(malformedAck.request, png, new AbortController().signal), {
        sent: false, reason: 'failed',
    });
    assert.equal(malformedAck.requests.length, 2, 'HTTP 200 without a valid QQ message id is not treated as delivered');
});

test('QQ Markdown fallback neutralizes QQ mention tags and is code-point bounded with one truncation marker', async () => {
    const harness = makeSdkHarness();
    const source = '<qqbot-at-user id="42"/> @everyone\n' + '鱼'.repeat(2600);
    assert.deepEqual(await harness.sender.sendMarkdownFallback(harness.request, source, new AbortController().signal), { sent: true });
    assert.equal(harness.requests.length, 1);
    const payload = JSON.parse(harness.requests[0].body);
    assert.ok(Array.from(payload.content).length <= 2000);
    assert.ok(payload.content.includes('&lt;qqbot-at-user id="42"/>'));
    assert.ok(payload.content.includes('＠everyone'));
    assert.equal((payload.content.match(/\[正文已截断\]/gu) ?? []).length, 1);
    assert.equal(payload.msg_id, 'msg-original');
});

test('registered native image tool uses same-source attachment bytes, user quota, and immutable reply target', async (t) => {
    const mediaDir = await mkdtemp('/data/qqbot-media/generation-native-');
    t.after(() => rm(mediaDir, { recursive: true, force: true }));
    const localImage = join(mediaDir, 'same-name.png');
    await writeFile(localImage, png);

    const providerCalls = [];
    const imageSends = [];
    const notices = [];
    const quota = makeQuota();
    const sender = {
        async sendNotice(request, text) { notices.push({ request, text }); return { sent: true }; },
        async sendImage(request, bytes) { imageSends.push({ request, bytes }); return { sent: true }; },
        async sendMarkdownFile() { return { sent: true }; },
        async sendMarkdownFallback() { return { sent: true }; },
    };
    const service = { async generate(input) { providerCalls.push(input); return Buffer.from(png); } };
    const { ctx, registration } = await nativeGenerationRuntime(t, {
        route: route(), sender, quota, imageService: service, markdownEnabled: true,
    });
    assert.equal(registration.imageEnabled, true);
    assert.equal(registration.markdownEnabled, true);
    const visibleTools = (await ctx.systemPrompt.assemble()).tools.map(({ name }) => name).sort();
    assert.deepEqual(visibleTools, [CREATE_MARKDOWN_TOOL, GENERATE_IMAGE_TOOL]);

    const agent = {};
    beginDocumentTurn(agent, { content: 'Edit the attached picture.' });
    const documentScope = getDocumentTurn(agent);
    setCurrentImages(agent, [{ localPath: localImage, contentType: 'image' }], documentScope);
    t.after(() => clearCurrentImages(agent, documentScope));
    const first = makeGenerationRequest('owner-first', 'group-first', 'message-first');
    const sourceUrl = 'https://cdn.example.test/quoted/same-name.png';
    const second = {
        ...makeGenerationRequest('owner-second', 'group-second', 'message-second'),
        quotedAttachments: [{ url: sourceUrl, filename: 'same-name.png', content_type: 'image/png' }],
    };
    const scope = beginGenerationTurn(agent, [first, second], [{ sourceUrl, localPath: localImage, contentType: 'image/png' }], {
        documentScope,
    });
    const [firstId, secondId] = [...scope.requests.keys()];
    const secondRequest = getGenerationRequest(scope, secondId, 'image');
    const selected = secondRequest.images[0].imageAttachmentId;

    const output = await nativeCall(ctx, GENERATE_IMAGE_TOOL,
        { requestId: secondId, imageAttachmentId: selected, prompt: 'Remove the reflected glare.' },
        agent, 'image-original-source-call');
    assert.equal(output.isError, false, JSON.stringify(output));
    assert.equal(output.value.status, 'sent');
    assert.equal(output.content?.length ?? 0, 0, 'native output does not send a duplicate generic tool reply');
    assert.equal(providerCalls.length, 1);
    assert.deepEqual(providerCalls[0].imageBytes, png);
    assert.deepEqual(quota.events.filter(([kind]) => kind === 'reserve'), [['reserve', 'owner-second', 'image']],
        'the second original user owns the reservation; a merged first user is not charged');
    assert.equal(imageSends.length, 1);
    assert.equal(imageSends[0].request.ownerId, 'owner-second');
    assert.deepEqual(imageSends[0].request.replyTarget, { scope: 'group', targetId: 'group-second', msgId: 'message-second' });
    assert.equal(imageSends[0].request.isActive('image'), true);

    const repeat = await nativeCall(ctx, GENERATE_IMAGE_TOOL,
        { requestId: secondId, imageAttachmentId: selected, prompt: 'Remove the reflected glare.' },
        agent, 'image-original-source-call');
    assert.equal(repeat.value.status, 'sent');
    assert.equal(providerCalls.length, 1, 'a duplicate callId returns the cached success without another provider call');
    assert.equal(imageSends.length, 1, 'cached success does not duplicate QQ delivery');

    const changed = await nativeCall(ctx, GENERATE_IMAGE_TOOL,
        { requestId: secondId, imageAttachmentId: selected, prompt: 'Change the person.' },
        agent, 'image-original-source-call');
    assert.equal(changed.isError, true, 'reusing a callId with changed arguments is rejected');
    const foreignAttachment = await nativeCall(ctx, GENERATE_IMAGE_TOOL,
        { requestId: firstId, imageAttachmentId: selected, prompt: 'Use another message image.' },
        agent, 'image-foreign-attachment-call');
    assert.equal(foreignAttachment.isError, true, 'one original request cannot borrow a merged peer image grant');
    assert.equal(providerCalls.length, 1);
    assert.equal(notices.length, 0);
    await endGenerationTurn(agent, scope);
    endDocumentTurn(agent, documentScope);
});

test('native Markdown remains available in document mode, validates UTF-8, and falls back once on the same request', async (t) => {
    const quota = makeQuota();
    const files = [];
    const fallbacks = [];
    const notices = [];
    const sender = {
        async sendNotice(request, text) { notices.push({ request, text }); return { sent: true }; },
        async sendImage() { return { sent: true }; },
        async sendMarkdownFile(request, bytes, filename) {
            files.push({ request, bytes, filename });
            return { sent: false, reason: 'failed' };
        },
        async sendMarkdownFallback(request, content) {
            fallbacks.push({ request, content });
            return { sent: true };
        },
    };
    const { ctx } = await nativeGenerationRuntime(t, {
        route: route(), sender, quota, imageService: { async generate() { return png; } }, markdownEnabled: true,
    });
    const agent = {};
    beginDocumentTurn(agent, { content: '' });
    const documentScope = getDocumentTurn(agent);
    const first = makeGenerationRequest('owner-a', 'group-a', 'message-a');
    const second = {
        ...makeGenerationRequest('owner-b', 'group-b', 'message-b'),
        quotedAttachments: [{ url: 'https://docs.example.test/report.txt', filename: 'report.txt', content_type: 'text/plain' }],
    };
    const scope = beginGenerationTurn(agent, [first, second], [], { documentScope });
    const [firstId, secondId] = [...scope.requests.keys()];
    assert.equal(documentScope.documentMode, true, 'a quoted document from a non-first merged request protects the whole turn');

    const imageResult = await nativeCall(ctx, GENERATE_IMAGE_TOOL,
        { requestId: secondId, prompt: 'Make an image.' }, agent, 'doc-mode-image-call');
    assert.equal(imageResult.isError, true, 'native image execution is denied in document mode');
    assert.equal(quota.events.length, 0, 'the image guard runs before quota or provider work');

    const content = '# 正文\n<qqbot-at-user id="42"/> @everyone **保留原文**';
    const markdownResult = await nativeCall(ctx, CREATE_MARKDOWN_TOOL,
        { requestId: secondId, filename: '../../ 周报 2026.md', content }, agent, 'doc-mode-markdown-call');
    assert.equal(markdownResult.isError, false, JSON.stringify(markdownResult));
    assert.equal(markdownResult.value.status, 'fallback');
    assert.equal(files.length, 1);
    assert.equal(files[0].filename, '周报 2026.md', 'path components are discarded before SDK upload');
    assert.deepEqual(files[0].bytes, Buffer.from(content, 'utf8'));
    assert.equal(files[0].request.ownerId, 'owner-b');
    assert.deepEqual(files[0].request.replyTarget, { scope: 'group', targetId: 'group-b', msgId: 'message-b' });
    assert.equal(fallbacks.length, 1, 'a failed attachment produces exactly one bounded copyable-text fallback');
    assert.ok(fallbacks[0].content.startsWith('附件没能发送'));
    assert.ok(!fallbacks[0].content.includes('<qqbot-at-user'));
    assert.ok(!fallbacks[0].content.includes('@everyone'));
    assert.ok(fallbacks[0].content.includes('保留原文'));
    assert.equal(notices.length, 0, 'successful fallback suppresses a second operational notice');
    assert.deepEqual(quota.events.filter(([kind]) => kind === 'reserve'), [['reserve', 'owner-b', 'markdown']]);

    const invalidControl = await nativeCall(ctx, CREATE_MARKDOWN_TOOL,
        { requestId: firstId, filename: 'unsafe\nname.md', content: 'text' }, agent, 'markdown-control-call');
    assert.equal(invalidControl.isError, true, 'control characters in filenames are rejected before sender calls');
    const oversize = await nativeCall(ctx, CREATE_MARKDOWN_TOOL,
        { requestId: firstId, filename: 'large.md', content: '鱼'.repeat(43691) }, agent, 'markdown-oversize-call');
    assert.equal(oversize.isError, true, 'the Markdown cap is enforced by UTF-8 bytes, not JS characters');
    const extraArgument = await nativeCall(ctx, CREATE_MARKDOWN_TOOL,
        { requestId: firstId, filename: 'valid.md', content: 'ok', path: '/tmp/nope' }, agent, 'markdown-extra-call');
    assert.equal(extraArgument.isError, true, 'extra tool arguments are denied');
    assert.equal(files.length, 1);
    await endGenerationTurn(agent, scope);
    endDocumentTurn(agent, documentScope);
});

test('native image call rechecks document mode after public DNS and before making the provider request', async (t) => {
    const dnsStarted = deferred();
    const releaseDns = deferred();
    const providerRequests = [];
    const service = createImageService({
        route: route(),
        resolvePublic: async () => {
            dnsStarted.resolve();
            await releaseDns.promise;
            return [{ address: '93.184.216.34', family: 4 }];
        },
        fetchImpl: async (url, options) => {
            providerRequests.push({ url: String(url), options });
            return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        },
    });
    const sent = [];
    const quota = makeQuota();
    const sender = {
        async sendNotice(request, text) { sent.push(['notice', request, text]); return { sent: true }; },
        async sendImage(request, bytes) { sent.push(['image', request, bytes]); return { sent: true }; },
        async sendMarkdownFile() { return { sent: true }; },
        async sendMarkdownFallback() { return { sent: true }; },
    };
    const { ctx } = await nativeGenerationRuntime(t, { route: route(), sender, quota, imageService: service, markdownEnabled: true });
    const agent = {};
    beginDocumentTurn(agent, { content: 'A text-only request starts out outside document mode.' });
    const documentScope = getDocumentTurn(agent);
    const scope = beginGenerationTurn(agent, [makeGenerationRequest('owner-race', 'group-race', 'message-race')], [], { documentScope });
    const requestId = [...scope.requests.keys()][0];
    const pending = nativeCall(ctx, GENERATE_IMAGE_TOOL,
        { requestId, prompt: 'Draw an image.' }, agent, 'image-document-race-call');
    try {
        await Promise.race([
            dnsStarted.promise,
            pending.then((output) => { throw new Error(`image call completed before provider DNS: ${JSON.stringify(output)}`); }),
        ]);
        documentScope.documentMode = true;
        releaseDns.resolve();
        const output = await pending;

        assert.equal(providerRequests.length, 0, 'a mode change while resolving DNS blocks the API fetch itself');
        assert.equal(sent.length, 0, 'no QQ result or generic failure is emitted after the turn becomes document protected');
        assert.equal(output.content?.length ?? 0, 0);
    }
    finally {
        releaseDns.resolve();
        await pending.catch(() => {});
        await endGenerationTurn(agent, scope);
        endDocumentTurn(agent, documentScope);
    }
});

test('native generation cancellation drains the call but cannot send after the QQ turn is replaced', async (t) => {
    const serviceStarted = deferred();
    const finishProvider = deferred();
    const quota = makeQuota();
    const sends = [];
    const sender = {
        async sendNotice(request, text) { sends.push(['notice', request, text]); return { sent: true }; },
        async sendImage(request, bytes) { sends.push(['image', request, bytes]); return { sent: true }; },
        async sendMarkdownFile() { return { sent: true }; },
        async sendMarkdownFallback() { return { sent: true }; },
    };
    const service = { async generate() { serviceStarted.resolve(); await finishProvider.promise; return png; } };
    const { ctx } = await nativeGenerationRuntime(t, { route: route(), sender, quota, imageService: service, markdownEnabled: true });
    const agent = {};
    beginDocumentTurn(agent, { content: 'First request.' });
    const firstDocument = getDocumentTurn(agent);
    const firstScope = beginGenerationTurn(agent, [makeGenerationRequest('owner-old', 'group-old', 'message-old')], [], { documentScope: firstDocument });
    const oldId = [...firstScope.requests.keys()][0];
    const pending = nativeCall(ctx, GENERATE_IMAGE_TOOL,
        { requestId: oldId, prompt: 'Slow image.' }, agent, 'cancelled-image-call');
    let replacementScope;
    let replacementDocument;
    try {
        await Promise.race([
            serviceStarted.promise,
            pending.then((output) => { throw new Error(`image call completed before service gate: ${JSON.stringify(output)}`); }),
        ]);
        beginDocumentTurn(agent, { content: 'Replacement request.' });
        replacementDocument = getDocumentTurn(agent);
        replacementScope = beginGenerationTurn(agent, [makeGenerationRequest('owner-new', 'group-new', 'message-new')], [], { documentScope: replacementDocument });
        let drained = false;
        const ending = endGenerationTurn(agent, firstScope).then(() => { drained = true; });
        await new Promise((resolve) => setTimeout(resolve, 15));
        assert.equal(drained, false, 'end waits for the real provider operation to settle');
        finishProvider.resolve();
        const output = await pending;
        await ending;
        assert.equal(output.value.status, 'expired');
        assert.deepEqual(sends, [], 'old work cannot send to either the old or replacement target');
        assert.equal(replacementScope.active, true, 'draining a retired scope leaves the new turn installed');
    }
    finally {
        finishProvider.resolve();
        await pending.catch(() => {});
        await endGenerationTurn(agent, firstScope);
        if (replacementScope) await endGenerationTurn(agent, replacementScope);
        if (replacementDocument) endDocumentTurn(agent, replacementDocument);
        endDocumentTurn(agent, firstDocument);
    }
});
