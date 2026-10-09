// Offline Phase 2 image transport, tool, quota, and sender regressions.
// Provider and QQ SDK requests use injected adapters or a local trusted HTTPS fixture.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
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
const { beginGenerationTurn, endGenerationTurn, getGenerationRequest, getGenerationTurn, generationRequestMetadata } = generationScopeModule;
const { beginDocumentTurn, endDocumentTurn, getDocumentTurn, runInDocumentExecution, bindDocumentExecution } = documentScopeModule;
const { setCurrentImages, clearCurrentImages } = chatPolicyModule;
const { createGenerationSender } = senderModule;
const { DAYU_ASSET_ROOT } = await import(pathToFileURL(join(generationDir, 'qqbot-assets.mjs')).href);

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
const execute = promisify(execFile);
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

function assertRenderedMarkdownReceipt(output) {
    assert.deepEqual(output.content, [{ type: 'text', text: JSON.stringify(output.value) }],
        'the structured delivery receipt is returned to the model as tool content');
}

function assertRenderedImageReceipt(output) {
    assert.equal(output.isError, false, JSON.stringify(output));
    assert.deepEqual(output.content, [{ type: 'text', text: JSON.stringify(output.value) }],
        'the bounded image status and notice reach the model as tool content');
    assert.deepEqual(Object.keys(output.value), ['status', 'notice']);
}

function makeSdkHarness({
    tokenManager = { async getAccessToken() { return 'fixture-access-token'; } },
    fetchImpl,
    limit = true,
    afterUpload,
    ordinaryQueue,
    onDelivery,
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
        onDelivery,
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

test('image API HTTP failure retains diagnostic status without its response body', async () => {
    const service = makeImageService({ onRequest: async () => ({
        status: 401,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: Buffer.from('{"error":"sk-private-key private-image-prompt"}'),
    }) });
    await assert.rejects(service.generate({ prompt: 'Draw a fox.' }), (error) => {
        assert.equal(error.status, 401);
        assert.equal(error.message, 'provider-response');
        assert.doesNotMatch(JSON.stringify(error), /sk-private-key|private-image-prompt/u);
        return true;
    });
});

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

test('production image transport pairs Undici fetch and Agent and verifies HTTPS certificates', async (t) => {
    const fixtureDir = await mkdtemp(join(tmpdir(), 'qqbot-image-https-'));
    t.after(() => rm(fixtureDir, { recursive: true, force: true }));
    const keyPath = join(fixtureDir, 'key.pem');
    const certPath = join(fixtureDir, 'cert.pem');
    await execute('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-keyout', keyPath, '-out', certPath, '-subj', '/CN=image-api.example.test',
        '-addext', 'subjectAltName=DNS:image-api.example.test',
        '-addext', 'basicConstraints=critical,CA:TRUE',
    ], { timeout: 10_000 });
    const requests = [];
    const server = createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        requests.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks) });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
    }));
    const baseUrl = `https://image-api.example.test:${server.address().port}/v1`;
    const childSource = `
        import assert from 'node:assert/strict';
        const { createImageService } = await import(process.argv[1]);
        globalThis.fetch = () => { throw new Error('Node bundled fetch must not be used'); };
        const imageBytes = Buffer.from(process.argv[3], 'base64');
        const service = createImageService({
            route: { apiKey: 'fixture-image-secret', model: 'fixture-image-model', protocol: 'openai-images', baseUrl: process.argv[2] },
            resolvePublic: async (hostname) => {
                assert.equal(hostname, 'image-api.example.test');
                return [{ address: '127.0.0.1', family: 4 }];
            },
        });
        if (process.argv[4] === 'untrusted') {
            await assert.rejects(service.generate({ prompt: 'A lighthouse at night.' }), (error) =>
                ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(error.cause?.code));
        }
        else {
            assert.deepEqual(await service.generate({ prompt: 'A lighthouse at night.' }), imageBytes);
            assert.deepEqual(await service.generate({ prompt: 'Remove the sign.', imageBytes }), imageBytes);
        }
    `;
    const childEnv = { ...process.env };
    delete childEnv.NODE_EXTRA_CA_CERTS;
    delete childEnv.NODE_TLS_REJECT_UNAUTHORIZED;
    const childArgs = ['--input-type=module', '--eval', childSource, pathToFileURL(generationPath).href, baseUrl, png.toString('base64')];
    await execute(process.execPath, [...childArgs, 'untrusted'], { env: childEnv, timeout: 10_000 });
    assert.equal(requests.length, 0, 'an untrusted certificate is rejected before sending the request');
    await execute(process.execPath, childArgs, { env: { ...childEnv, NODE_EXTRA_CA_CERTS: certPath }, timeout: 10_000 });
    assert.deepEqual(requests.map(({ method, url }) => [method, url]), [
        ['POST', '/v1/images/generations'], ['POST', '/v1/images/edits'],
    ]);
    for (const request of requests) assert.equal(request.headers.authorization, 'Bearer fixture-image-secret');
    assert.deepEqual(JSON.parse(requests[0].body), { model: 'fixture-image-model', prompt: 'A lighthouse at night.', n: 1 });
    assert.match(requests[1].headers['content-type'], /^multipart\/form-data; boundary=/u);
    assert.ok(requests[1].body.includes(Buffer.from('name="image"; filename="input.png"')),
        'multipart retains the selected image filename');
    assert.ok(requests[1].body.includes(Buffer.from('fixture-image-model')));
    assert.ok(requests[1].body.includes(png), 'the real multipart request contains the input image bytes');
    assert.ok(requests[1].body.includes(Buffer.from('Remove the sign.')));
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

test('QQ sender preserves visible punctuation in opaque msgId for image and Markdown file replies', async () => {
    const harness = makeSdkHarness();
    const msgId = 'ROBOT1.0.AB+/cd==';
    harness.request.replyTarget.msgId = msgId;

    assert.deepEqual(await harness.sender.sendImage(harness.request, png, new AbortController().signal), { sent: true });
    assert.deepEqual(await harness.sender.sendMarkdownFile(
        harness.request, Buffer.from('# Whale edit result\n', 'utf8'), 'result.md', new AbortController().signal,
    ), { sent: true });

    const messageRequests = harness.requests.filter(({ url }) => new URL(url).pathname.endsWith('/messages'));
    assert.equal(messageRequests.length, 2);
    assert.deepEqual(messageRequests.map(({ url }) => new URL(url).pathname), [
        '/v2/groups/group-original/messages', '/v2/groups/group-original/messages',
    ], 'only targetId is used to construct the URL path');
    assert.deepEqual(messageRequests.map(({ body }) => JSON.parse(body).msg_id), [msgId, msgId],
        'image and Markdown reply bodies carry the original msgId unchanged');
    assert.ok(harness.requests.every(({ url }) => !new URL(url).pathname.includes(msgId)));
    assert.deepEqual(harness.limiterEvents.filter(([kind]) => kind === 'record'), [
        ['record', msgId], ['record', msgId],
    ]);
});

test('QQ sender rejects malformed msgIds before upload or message delivery', async () => {
    const invalidMsgIds = [
        '',
        null,
        42,
        'message with spaces',
        'message\nwith-control',
        `x${'x'.repeat(256)}`,
        '消息',
    ];
    for (const msgId of invalidMsgIds) {
        const harness = makeSdkHarness();
        harness.request.replyTarget.msgId = msgId;
        assert.deepEqual(await harness.sender.sendImage(harness.request, png, new AbortController().signal), {
            sent: false, reason: 'expired',
        }, `invalid msgId ${String(msgId)} fails closed`);
        assert.deepEqual(harness.requests, [], 'invalid msgIds cannot reach QQ upload or message routes');
    }
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

test('QQ artifact sender validates UTF-8 and type, then reports only the final message ACK', async () => {
    const deliveries = [];
    const harness = makeSdkHarness({ onDelivery: (event) => deliveries.push(event) });
    const bytes = Buffer.from('会话记录\n', 'utf8');
    assert.deepEqual(await harness.sender.sendArtifactFile(
        harness.request, bytes, '会话记录.txt', 'text/plain', new AbortController().signal,
    ), { sent: true });
    assert.equal(harness.requests.length, 2);
    assert.deepEqual(JSON.parse(harness.requests[0].body).file_name, '会话记录.txt');
    assert.deepEqual(deliveries, [{
        target: { scope: 'group', targetId: 'group-original' },
        status: 'sent', messageId: 'fixture-ack-id', mediaType: 'file',
    }]);

    for (const [content, filename, mime] of [
        [bytes, '../escape.txt', 'text/plain'],
        [bytes, 'record.md', 'text/plain'],
        [Buffer.from([0xff]), 'record.txt', 'text/plain'],
        [Buffer.alloc(10 * 1024 * 1024 + 1), 'record.txt', 'text/plain'],
    ]) {
        assert.deepEqual(await harness.sender.sendArtifactFile(
            harness.request, content, filename, mime, new AbortController().signal,
        ), { sent: false, reason: 'failed' });
    }
    assert.equal(harness.requests.length, 2, 'invalid artifacts cannot reach QQ');
});

test('QQ artifact final message uncertainty reports a gap signal without retry or fallback', async () => {
    const deliveries = [];
    const harness = makeSdkHarness({
        onDelivery: (event) => deliveries.push(event),
        fetchImpl: async (url) => {
            if (new URL(String(url)).pathname.endsWith('/files')) {
                return new Response(JSON.stringify({ file_info: 'fixture-file-info' }), { status: 200 });
            }
            throw new Error('message POST outcome unknown');
        },
    });
    const result = await harness.sender.sendArtifactFile(
        harness.request, Buffer.from('record'), 'record.txt', 'text/plain', new AbortController().signal,
    );
    assert.deepEqual(result, { sent: false, reason: 'unknown' });
    assert.equal(harness.requests.length, 2);
    assert.deepEqual(deliveries, [{
        target: { scope: 'group', targetId: 'group-original' }, status: 'unknown', mediaType: 'file',
    }]);
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

test('QQ Markdown sender stops after a cancelled upload and skips the attachment POST', async () => {
    const uploadStarted = deferred();
    const finishUpload = deferred();
    const harness = makeSdkHarness({ afterUpload: async () => {
        uploadStarted.resolve();
        await finishUpload.promise;
    } });
    const controller = new AbortController();
    const pending = harness.sender.sendMarkdownFile(
        harness.request, Buffer.from('# report', 'utf8'), 'report.md', controller.signal,
    );
    await uploadStarted.promise;
    controller.abort(new Error('fixture Markdown cancellation'));
    finishUpload.resolve();
    assert.deepEqual(await pending, { sent: false, reason: 'expired' });
    assert.equal(harness.requests.length, 1, 'cancelled upload cannot trigger an attachment POST');
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
        sent: false, reason: 'unknown',
    });
    assert.equal(malformedAck.requests.length, 2, 'HTTP 200 without a valid QQ message id is not treated as delivered');
});

test('QQ Markdown sender reports uncertain message POSTs without retrying or using text fallback', async () => {
    const uncertain = makeSdkHarness({ fetchImpl: async (url) => {
        if (new URL(String(url)).pathname.endsWith('/files')) {
            return new Response(JSON.stringify({ file_info: 'fixture-file-info' }), { status: 200 });
        }
        throw new Error('connection lost after request write');
    } });
    const fileResult = await uncertain.sender.sendMarkdownFile(
        uncertain.request, Buffer.from('# report', 'utf8'), 'report.md', new AbortController().signal,
    );
    assert.deepEqual(fileResult, { sent: false, reason: 'unknown' });
    assert.equal(uncertain.requests.length, 2, 'the uploaded file has one message POST and no automatic text retry');
});

test('QQ Markdown fallback neutralizes QQ mention tags and is code-point bounded with one truncation marker', async () => {
    const harness = makeSdkHarness();
    const source = '<qqbot-at-user id="42"/> @everyone\n' + '鱼'.repeat(2600);
    assert.deepEqual(await harness.sender.sendMarkdownFallback(harness.request, source, new AbortController().signal), { sent: true, truncated: true });
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
    const imageTool = (await ctx.systemPrompt.assemble()).tools.find(({ name }) => name === GENERATE_IMAGE_TOOL);
    const modelFacingSchema = JSON.stringify(imageTool);
    assert.match(modelFacingSchema, /matched original QQ request/u, 'the model-facing image tool explains request-scoped prompt optimization');
    assert.match(modelFacingSchema, /another batch member/u, 'the model-facing image tool forbids cross-request context');
    assert.match(modelFacingSchema, /4000 characters/u, 'the model-facing image tool states the final prompt limit');
    assert.match(modelFacingSchema, /opaque requestId/u, 'the model-facing image tool preserves the opaque requestId requirement');
    assert.match(modelFacingSchema, /"maxLength":4000/u, 'the real Cordis tool schema bounds the prompt field at 4000 characters');
    assert.match(modelFacingSchema, /referenceImage/u, 'the image tool exposes the dedicated bundled portrait reference');
    assert.match(modelFacingSchema, /portrait\.png/u, 'the model-facing instructions select the single front portrait');

    const agent = {};
    beginDocumentTurn(agent, { content: 'Edit the attached picture.' });
    const documentScope = getDocumentTurn(agent);
    setCurrentImages(agent, [{ localPath: localImage, contentType: 'image' }], documentScope);
    t.after(() => clearCurrentImages(agent, documentScope));
    const first = makeGenerationRequest('owner-first', 'group-first', 'message-first');
    const sourceUrl = 'https://cdn.example.test/quoted/same-name.png';
    const punctuationId = 'ROBOT1.0.AB+/cd==';
    const second = {
        ...makeGenerationRequest('owner-second', 'group-second', punctuationId),
        quotedAttachments: [{ url: sourceUrl, filename: 'same-name.png', content_type: 'image/png' }],
    };
    const scope = beginGenerationTurn(agent, [first, second], [{ sourceUrl, localPath: localImage, contentType: 'image/png' }], {
        documentScope,
    });
    const [firstId, secondId] = [...scope.requests.keys()];
    const secondRequest = getGenerationRequest(scope, secondId, 'image');
    const selected = secondRequest.images[0].imageAttachmentId;

    const finalPrompt = 'Remove the reflected glare, preserve the original person and background, and keep the composition unchanged.';
    const output = await nativeCall(ctx, GENERATE_IMAGE_TOOL,
        { requestId: secondId, imageAttachmentId: selected, prompt: finalPrompt },
        agent, 'image-original-source-call');
    assert.equal(output.isError, false, JSON.stringify(output));
    assert.equal(output.value.status, 'sent');
    assertRenderedImageReceipt(output);
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0].prompt, finalPrompt, 'image execution forwards the model-prepared prompt unchanged without transport-side rewriting');
    assert.deepEqual(providerCalls[0].imageBytes, png);
    assert.deepEqual(quota.events.filter(([kind]) => kind === 'reserve'), [['reserve', 'owner-second', 'image']],
        'the second original user owns the reservation; a merged first user is not charged');
    assert.equal(imageSends.length, 1);
    assert.equal(imageSends[0].request.ownerId, 'owner-second');
    assert.deepEqual(imageSends[0].request.replyTarget, { scope: 'group', targetId: 'group-second', msgId: punctuationId });
    assert.equal(imageSends[0].request.isActive('image'), true);

    const repeat = await nativeCall(ctx, GENERATE_IMAGE_TOOL,
        { requestId: secondId, imageAttachmentId: selected, prompt: finalPrompt },
        agent, 'image-original-source-call');
    assert.equal(repeat.value.status, 'sent');
    assertRenderedImageReceipt(repeat);
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

test('native self portrait uploads the bundled portrait bytes through the existing image edit route', async (t) => {
    const portraitPath = join(DAYU_ASSET_ROOT, 'portrait.png');
    const portraitBytes = await readFile(portraitPath);
    const apiRequests = [];
    const imageSends = [];
    const notices = [];
    const quota = makeQuota();
    const sender = {
        async sendNotice(request, text) { notices.push({ request, text }); return { sent: true }; },
        async sendImage(request, bytes) { imageSends.push({ request, bytes }); return { sent: true }; },
        async sendMarkdownFile() { return { sent: true }; },
        async sendMarkdownFallback() { return { sent: true }; },
    };
    const service = makeImageService({ onRequest: async (request) => {
        apiRequests.push(request);
        return responseImage();
    } });
    const { ctx } = await nativeGenerationRuntime(t, {
        route: route(), sender, quota, imageService: service, markdownEnabled: true,
    });
    const agent = {};
    beginDocumentTurn(agent, { content: 'Draw a portrait of yourself in a moonlit garden.' });
    const documentScope = getDocumentTurn(agent);
    const request = makeGenerationRequest('owner-dayu', 'group-dayu', 'message-dayu');
    const scope = beginGenerationTurn(agent, [request], [], { documentScope });
    const [requestId] = [...scope.requests.keys()];
    const args = {
        requestId,
        prompt: 'A friendly self portrait of the blue whale mascot in a moonlit garden.',
        referenceImage: portraitPath,
    };

    const first = await nativeCall(ctx, GENERATE_IMAGE_TOOL, args, agent, 'dayu-self-portrait');
    assert.equal(first.isError, false, JSON.stringify(first));
    assert.equal(first.value.status, 'sent');
    assertRenderedImageReceipt(first);
    assert.equal(apiRequests.length, 1);
    assert.equal(requestUrl(apiRequests[0]), 'https://image-api.example.test/v1/images/edits',
        'a bundled reference uses the existing image edit endpoint');
    assert.ok(apiRequests[0].body instanceof FormData);
    assert.equal(apiRequests[0].body.get('prompt'), args.prompt);
    assert.equal(apiRequests[0].body.get('model'), 'fixture-image-model');
    const uploaded = apiRequests[0].body.get('image');
    assert.ok(uploaded instanceof Blob);
    assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()), portraitBytes,
        'the API receives the actual bundled PNG bytes, never a filesystem path');
    assert.equal(imageSends.length, 1);
    assert.deepEqual(imageSends[0].request.replyTarget, request.replyTarget);

    const duplicate = await nativeCall(ctx, GENERATE_IMAGE_TOOL, args, agent, 'dayu-self-portrait');
    assert.equal(duplicate.value.status, 'sent');
    assert.equal(apiRequests.length, 1, 'same call ID does not upload or generate twice');
    assert.equal(imageSends.length, 1, 'same call ID does not send a duplicate QQ image');

    const changedReference = await nativeCall(ctx, GENERATE_IMAGE_TOOL,
        { ...args, referenceImage: join(DAYU_ASSET_ROOT, 'character-standard.png') },
        agent, 'dayu-self-portrait');
    assert.equal(changedReference.isError, true, 'reusing a call ID with a different reference path is rejected');

    const arbitraryPath = await nativeCall(ctx, GENERATE_IMAGE_TOOL,
        { requestId, prompt: args.prompt, referenceImage: '/tmp/portrait.png' }, agent, 'dayu-arbitrary-path');
    assert.equal(arbitraryPath.isError, true, 'paths outside the dedicated bundled directory are denied');
    const bothInputs = await nativeCall(ctx, GENERATE_IMAGE_TOOL,
        { ...args, imageAttachmentId: 'not-authorized' }, agent, 'dayu-two-image-inputs');
    assert.equal(bothInputs.isError, true, 'a bundled reference cannot be combined with a QQ attachment grant');
    assert.equal(apiRequests.length, 1);
    assert.equal(imageSends.length, 1);
    assert.equal(notices.length, 0, 'pre-dispatch argument refusals do not send misleading completion notices');

    await endGenerationTurn(agent, scope);
    endDocumentTurn(agent, documentScope);
    const expiredTurn = await nativeCall(ctx, GENERATE_IMAGE_TOOL, args, agent, 'dayu-expired-turn');
    assert.equal(expiredTurn.isError, true, 'an expired or cancelled document turn cannot reuse the bundled portrait');
    assert.equal(apiRequests.length, 1, 'an expired call cannot reach the image API');
});

test('native editing converts WebP, GIF and decoder-valid JPEG inputs to PNG only when the edit runs', async (t) => {
    const { default: sharp } = await import('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/sharp/dist/index.cjs');
    const { PublicHttpProvider } = await import(pathToFileURL(join(generationDir, 'qqbot-web-pages.mjs')).href);
    const originalRequestOnce = PublicHttpProvider.prototype.requestOnce;
    t.after(() => { PublicHttpProvider.prototype.requestOnce = originalRequestOnce; });
    const red = Buffer.from([255, 0, 0, 255, 255, 0, 0, 0]);
    const raw = { raw: { width: 2, height: 1, channels: 4 } };
    const webp = await sharp(red, raw).webp({ lossless: true }).toBuffer();
    const gif = await sharp(red, raw).gif().toBuffer();
    const redFrame = await sharp({ create: { width: 1, height: 1, channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    const blueFrame = await sharp({ create: { width: 1, height: 1, channels: 4,
        background: { r: 0, g: 0, b: 255, alpha: 1 } } }).png().toBuffer();
    const animatedGif = await sharp([redFrame, blueFrame], { join: { animated: true } }).gif({ delay: [100, 100] }).toBuffer();
    assert.equal((await sharp(animatedGif).metadata()).pages, 2);
    const trailingJpeg = Buffer.concat([await sharp(red, raw).jpeg().toBuffer(), Buffer.from([0, 0, 0])]);
    const sources = [
        { name: 'mislabeled-webp', bytes: webp, declared: 'image/jpeg', httpType: 'image/webp', quote: true },
        { name: 'gif', bytes: gif, declared: 'image/gif', httpType: 'image/gif', quote: true },
        { name: 'animated-gif', bytes: animatedGif, declared: 'image/gif', httpType: 'image/gif', quote: true, width: 1 },
        { name: 'trailing-jpeg', bytes: trailingJpeg, declared: 'image/jpeg', quote: false },
        { name: 'corrupt-gif', bytes: Buffer.from('GIF89a\x01\x00\x01\x00broken', 'binary'),
            declared: 'image/gif', httpType: 'image/gif', quote: true, invalid: true },
    ];
    let downloadCount = 0;
    const byUrl = new Map(sources.filter((source) => source.quote)
        .map((source) => [`https://example.com/${source.name}`, source]));
    PublicHttpProvider.prototype.requestOnce = async function (url) {
        downloadCount++;
        const source = byUrl.get(String(url));
        assert.ok(source);
        return { response: new Response(source.bytes, { headers: { 'content-type': source.httpType } }), close: async () => {} };
    };
    const providerCalls = [];
    const quota = makeQuota();
    const { ctx } = await nativeGenerationRuntime(t, {
        route: route(), quota, markdownEnabled: false,
        imageService: makeImageService({ onRequest: async (request) => {
            providerCalls.push(request);
            return responseImage();
        } }),
        sender: { async sendImage() { return { sent: true }; }, async sendNotice() { return { sent: true }; } },
    });
    const mediaDir = await mkdtemp('/data/qqbot-media/normalize-edit-');
    t.after(() => rm(mediaDir, { recursive: true, force: true }));
    for (const source of sources) {
        const agent = {};
        beginDocumentTurn(agent, { content: `Edit ${source.name}` });
        const documentScope = getDocumentTurn(agent);
        const url = `https://example.com/${source.name}`;
        const attachment = { url, filename: `${source.name}.jpg`, content_type: source.declared };
        let downloads = [];
        if (!source.quote) {
            const localPath = join(mediaDir, `${source.name}.jpg`);
            await writeFile(localPath, source.bytes);
            setCurrentImages(agent, [{ localPath, contentType: 'image' }], documentScope);
            downloads = [{ sourceUrl: url, localPath, contentType: source.declared }];
        }
        const request = { ...makeGenerationRequest('normalize-owner', 'normalize-group', `message-${source.name}`),
            [source.quote ? 'quotedAttachments' : 'currentAttachments']: [attachment] };
        const scope = beginGenerationTurn(agent, [request], downloads,
            { documentScope, media: { enabled: true, maxMB: 10 } });
        const [metadata] = generationRequestMetadata(scope);
        assert.equal(metadata.images.length, 1, `${source.name} has a scoped image ID`);
        const before = downloadCount;
        const beforeProvider = providerCalls.length;
        const beforeQuota = quota.events.filter(([kind]) => kind === 'reserve').length;
        const result = await nativeCall(ctx, GENERATE_IMAGE_TOOL, {
            requestId: metadata.requestId, imageAttachmentId: metadata.images[0].imageAttachmentId,
            prompt: 'Preserve all pixels and add a small label.',
        }, agent, `normalize-${source.name}`);
        assert.equal(result.value.status, source.invalid ? 'image-type' : 'sent', `${source.name}: ${JSON.stringify(result)}`);
        assert.equal(downloadCount - before, source.quote ? 1 : 0, 'only the chosen remote quote is fetched');
        if (source.invalid) {
            assert.equal(providerCalls.length, beforeProvider, 'corrupt images never reach the provider');
            assert.equal(quota.events.filter(([kind]) => kind === 'reserve').length, beforeQuota,
                'corrupt images do not consume user quota');
            await endGenerationTurn(agent, scope);
            clearCurrentImages(agent, documentScope);
            endDocumentTurn(agent, documentScope);
            continue;
        }
        const requestBody = providerCalls.at(-1).body;
        const imageFile = requestBody.get('image');
        assert.equal(imageFile.type, 'image/png');
        assert.equal(imageFile.name, 'input.png');
        const converted = Buffer.from(await imageFile.arrayBuffer());
        const metadataOut = await sharp(converted).metadata();
        assert.equal(metadataOut.width, source.width ?? 2);
        assert.equal(metadataOut.height, 1);
        const originalMetadata = await sharp(source.bytes).metadata();
        assert.equal(metadataOut.hasAlpha, originalMetadata.hasAlpha);
        const rgba = await sharp(converted).ensureAlpha().raw().toBuffer();
        const originalRgba = await sharp(source.bytes, { page: 0, pages: 1 }).ensureAlpha().raw().toBuffer();
        assert.deepEqual([...rgba.subarray(0, 4)], [...originalRgba.subarray(0, 4)]);
        await endGenerationTurn(agent, scope);
        clearCurrentImages(agent, documentScope);
        endDocumentTurn(agent, documentScope);
    }
    assert.equal(quota.events.filter(([kind]) => kind === 'reserve').length, sources.length - 1);
    assert.equal((await readdir(mediaDir)).length, 1, 'quoted conversions leave no cache file');
});

test('image conversion enforces pixel bounds and drains its worker before cancellation or deadline settles', async () => {
    const { normalizeEditImage } = await import(pathToFileURL(join(generationDir, 'qqbot-image-input.mjs')).href);
    const header = Buffer.from(png.subarray(16, 29));
    header.writeUInt32BE(30000, 0);
    header.writeUInt32BE(2000, 4);
    const giantHeader = Buffer.concat([png.subarray(0, 8), pngChunk('IHDR', header),
        png.subarray(33)]);
    await assert.rejects(normalizeEditImage(giantHeader, { inspectImage: () => undefined }),
        (error) => error.kind === 'too-large');

    const source = Buffer.from('GIF89a\x01\x00\x01\x00placeholder', 'binary');
    for (const mode of ['cancel', 'timeout']) {
        const controller = new AbortController();
        const stopped = deferred();
        const releaseTermination = deferred();
        let worker;
        class SuspendedWorker extends EventEmitter {
            postMessage() {}
            terminate() { stopped.resolve(); return releaseTermination.promise; }
        }
        const operation = normalizeEditImage(source, {
            signal: controller.signal,
            inspectImage: () => undefined,
            createWorker: () => { worker = new SuspendedWorker(); return worker; },
            timeoutMs: mode === 'timeout' ? 5 : 10_000,
        });
        if (mode === 'cancel') controller.abort();
        let settled = false;
        void operation.finally(() => { settled = true; }).catch(() => {});
        await stopped.promise;
        assert.equal(settled, false, 'concurrency remains owned while worker termination is pending');
        releaseTermination.resolve(0);
        await assert.rejects(operation, (error) => error.kind === (mode === 'cancel' ? 'cancelled' : 'timeout'));
        assert.equal(worker.listenerCount('message'), 0);
        assert.equal(worker.listenerCount('error'), 0);
        assert.equal(worker.listenerCount('exit'), 0);
    }
});

for (const quoteMode of ['store', 'rendered-text']) test(`group quote (${quoteMode}) passes the original image bytes through inbound and the native editing tool`, async (t) => {
    const adapter = '/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/';
    const { setupMiddlewares } = await import(`${adapter}gateway/middleware-setup.js`);
    const { handleInbound } = await import(`${adapter}transport/inbound.js`);
    const { PublicHttpProvider } = await import(pathToFileURL(join(generationDir, 'qqbot-web-pages.mjs')).href);
    const originalRequestOnce = PublicHttpProvider.prototype.requestOnce;
    let quoteDownloads = 0;
    PublicHttpProvider.prototype.requestOnce = async function () {
        quoteDownloads++;
        return { response: new Response(png, { headers: { 'content-type': 'image/png' } }), close: async () => {} };
    };
    t.after(() => { PublicHttpProvider.prototype.requestOnce = originalRequestOnce; });
    const providerCalls = [];
    const sent = [];
    const service = makeImageService({ onRequest: async (request) => {
        providerCalls.push(request);
        return responseImage(png);
    } });
    const { ctx } = await nativeGenerationRuntime(t, {
        route: route(), quota: makeQuota(), markdownEnabled: false,
        imageService: service,
        sender: {
            async sendImage(request, bytes) { sent.push({ target: request.replyTarget, bytes }); return { sent: true }; },
            async sendNotice() { return { sent: true }; },
        },
    });
    let pending;
    let calls = 0;
    const agent = {
        session: { seq: 0 },
        followup() {
            calls++;
            if (quoteMode === 'store' && calls === 1) return;
            const [request] = generationRequestMetadata(getGenerationTurn(agent));
            assert.equal(request.images.length, 1, 'quote metadata produces an imageAttachmentId before downloading');
            assert.equal(quoteDownloads, quoteMode === 'store' ? 1 : 0, 'only the current source message may have downloaded before the edit call');
            pending = nativeCall(ctx, GENERATE_IMAGE_TOOL, {
                requestId: request.requestId, imageAttachmentId: request.images[0].imageAttachmentId,
                prompt: 'Add a blue whale in the river; preserve the original scene.',
            }, agent, 'cached-quote-edit');
        },
        async whenIdle() {
            if (pending) {
                const result = await pending;
                assert.equal(result.isError, false, JSON.stringify(result));
                assert.equal(result.value.status, 'sent');
            }
        },
    };
    let record;
    const manager = {
        questionChannel: { tryAnswer() { return false; } },
        getSessionRecord(scope, peerId) { return record?.scope === scope && record.peerId === peerId ? record : undefined; },
        async getOrCreate(scope, peerId, senderId, replyTarget) {
            record ??= { scope, peerId, senderId, agent, sessionId: 'native-cached-quote', handle: { async dispose() {} } };
            record.replyTarget = replyTarget;
            return record;
        },
    };
    const config = {
        appId: 'native-quote-bot', debug: false, requireMention: true,
        access: { c2cMode: 'open', c2cAllow: [], groupMode: 'open', groupAllow: [] },
        historyLimit: 10, maxQueue: 4, processingTimeoutMs: 0, media: { enabled: true, maxMB: 10 },
        textChunkLimit: 2000, streaming: false,
    };
    const logger = { info() {}, debug() {}, warn() {}, error() {} };
    const layers = [];
    setupMiddlewares({ use(layer) { layers.push(layer); } }, config, manager, logger);
    layers.push((mwCtx) => handleInbound(mwCtx, manager, config, logger));
    const run = async (message) => {
        const mwCtx = {
            message: { kind: 'group', groupOpenid: 'native-quote-group', senderId: 'native-quote-member',
                attachments: [], timestamp: new Date().toISOString(), ...message,
                replyTarget: { scope: 'group', targetId: 'native-quote-group', msgId: message.messageId } },
            state: {}, log: logger, bot: { appId: config.appId, async sendMarkdown() {} },
            replyTarget: { scope: 'group', targetId: 'native-quote-group', msgId: message.messageId },
            stop() {},
        };
        let index = 0;
        const next = async () => { const layer = layers[index++]; if (layer) await layer(mwCtx, next); };
        await next();
        for (const file of [...(mwCtx.state.downloadedFiles ?? []), ...(mwCtx.state.downloadedQuoteFiles ?? []), ...(mwCtx.state.downloadedGenerationQuoteFiles ?? [])]) {
            t.after(() => rm(file.localPath, { force: true }));
        }
    };
    if (quoteMode === 'store') {
        await run({ messageId: 'native-original', msgIdx: 'native-original-ref', content: `<@!${config.appId}> 看图`,
            attachments: [{ content_type: 'image/png', filename: 'original.png', url: 'https://example.com/native-original.png' }] });
    }
    await mkdir('/data/qqbot-media', { recursive: true });
    const beforeEditFiles = (await readdir('/data/qqbot-media')).sort();
    await run({ messageId: 'ROBOT1.0.AB+/cd==', refMsgIdx: 'native-original-ref', content: `<@!${config.appId}> 在江里加一条蓝色鲸鱼`,
        ...(quoteMode === 'rendered-text' ? { msgElements: [{
            content: '[消息类型] 引用消息\n[附件1] 类型:图片 文件名:original.png 尺寸:1920x1080 大小:160.7KB URL:https://example.com/native-original.png',
        }] } : {}),
    });
    assert.equal(calls, quoteMode === 'store' ? 2 : 1);
    assert.equal(quoteDownloads, quoteMode === 'store' ? 2 : 1, 'the edit tool fetches the selected quote exactly once');
    assert.deepEqual((await readdir('/data/qqbot-media')).sort(), beforeEditFiles, 'quoted editing creates no persistent media files');
    assert.equal(providerCalls.length, 1);
    assert.equal(requestUrl(providerCalls[0]), 'https://image-api.example.test/v1/images/edits', 'the request uses editing, not new generation');
    assert.deepEqual(Buffer.from(await providerCalls[0].body.get('image').arrayBuffer()), png,
        'the actual edit request contains the exact original bytes');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].target.msgId, 'ROBOT1.0.AB+/cd==');
    assert.equal(getGenerationTurn(agent), undefined, 'edit grants are revoked at turn completion');
});

test('lazy quoted image failures, limits and cancellation never reach the generation provider', async (t) => {
    const { PublicHttpProvider } = await import(pathToFileURL(join(generationDir, 'qqbot-web-pages.mjs')).href);
    const originalRequestOnce = PublicHttpProvider.prototype.requestOnce;
    t.after(() => { PublicHttpProvider.prototype.requestOnce = originalRequestOnce; });
    let fetchCount = 0;
    let fetchImpl;
    PublicHttpProvider.prototype.requestOnce = async function (url, signal) {
        fetchCount++;
        return fetchImpl(url, signal);
    };
    const providerCalls = [];
    const imageSends = [];
    const acquire = { ok: true };
    const quota = makeQuota({ acquire });
    const { ctx } = await nativeGenerationRuntime(t, {
        route: route(), quota, markdownEnabled: false,
        imageService: { async generate(input) { providerCalls.push(input); return png; } },
        sender: {
            async sendImage() { imageSends.push(true); return { sent: true }; },
            async sendNotice() { return { sent: true }; },
        },
    });
    const agent = {};
    const source = { ...makeGenerationRequest('lazy-owner', 'lazy-group', 'lazy-message'),
        quotedAttachments: [{ content_type: 'image/png', filename: 'base.png', url: 'https://example.com/lazy-base.png' }] };
    const start = (media = { enabled: true, maxMB: 10 }) => {
        beginDocumentTurn(agent, { content: 'Edit the explicitly quoted picture.' });
        const documentScope = getDocumentTurn(agent);
        const scope = beginGenerationTurn(agent, [source, makeGenerationRequest('other-owner', 'lazy-group', 'other-message')], [], { documentScope, media });
        const [metadata] = generationRequestMetadata(scope);
        return { scope, documentScope, metadata };
    };
    const finish = async ({ scope, documentScope }) => {
        await endGenerationTurn(agent, scope);
        endDocumentTurn(agent, documentScope);
    };
    const args = (metadata) => ({ requestId: metadata.requestId,
        imageAttachmentId: metadata.images[0].imageAttachmentId, prompt: 'Add a blue whale, preserve the scene.' });

    const disabled = start({ enabled: false, maxMB: 10 });
    assert.deepEqual(disabled.metadata.images, []);
    await finish(disabled);
    const scopeOnly = start();
    assert.equal(fetchCount, 0, 'registration itself never downloads');
    const foreign = generationRequestMetadata(scopeOnly.scope)[1];
    assert.equal((await nativeCall(ctx, GENERATE_IMAGE_TOOL, { ...args(scopeOnly.metadata), requestId: foreign.requestId }, agent, 'lazy-foreign')).isError, true);
    await finish(scopeOnly);
    assert.equal((await nativeCall(ctx, GENERATE_IMAGE_TOOL, args(scopeOnly.metadata), agent, 'lazy-expired')).isError, true);
    assert.equal(fetchCount, 0, 'foreign and expired IDs cannot download');

    const busy = start();
    acquire.ok = false;
    acquire.reason = 'busy';
    assert.equal((await nativeCall(ctx, GENERATE_IMAGE_TOOL, args(busy.metadata), agent, 'lazy-busy')).value.status, 'busy');
    assert.equal(fetchCount, 0, 'a refused concurrency slot prevents even a base-image download');
    acquire.ok = true;
    await finish(busy);

    const failed = start();
    fetchImpl = async () => ({ response: new Response('denied', { status: 403 }), close: async () => {} });
    const failedOutput = await nativeCall(ctx, GENERATE_IMAGE_TOOL, args(failed.metadata), agent, 'lazy-failed');
    assert.equal(failedOutput.value.status, 'failed');
    assertRenderedImageReceipt(failedOutput);
    await finish(failed);

    const timedOut = start();
    fetchImpl = async () => { throw new DOMException('private source URL', 'TimeoutError'); };
    const timeoutOutput = await nativeCall(ctx, GENERATE_IMAGE_TOOL, args(timedOut.metadata), agent, 'lazy-timeout');
    assert.equal(timeoutOutput.value.status, 'timeout');
    assertRenderedImageReceipt(timeoutOutput);
    assert.doesNotMatch(JSON.stringify(timeoutOutput.content), /private source URL/u);
    await finish(timedOut);

    const bounded = start({ enabled: true, maxMB: 1 / (1024 * 1024) });
    fetchImpl = async () => ({ response: new Response(png, { headers: { 'content-type': 'image/png' } }), close: async () => {} });
    assert.equal((await nativeCall(ctx, GENERATE_IMAGE_TOOL, args(bounded.metadata), agent, 'lazy-size')).value.status, 'failed');
    await finish(bounded);

    const cancelled = start();
    const started = deferred();
    fetchImpl = async (_url, signal) => {
        started.resolve(signal);
        await new Promise((resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
    };
    const pending = nativeCall(ctx, GENERATE_IMAGE_TOOL, args(cancelled.metadata), agent, 'lazy-cancelled');
    const signal = await started.promise;
    const ending = endGenerationTurn(agent, cancelled.scope);
    assert.equal(signal.aborted, true, 'turn revocation aborts the ongoing base-image request');
    await Promise.all([ending, pending]);
    endDocumentTurn(agent, cancelled.documentScope);
    assert.equal(providerCalls.length, 0);
    assert.equal(imageSends.length, 0);
    assert.equal(quota.events.filter(([name]) => name === 'release').length, 4, 'failed, timed out and cancelled downloads release concurrency slots');
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
        { requestId: secondId, prompt: 'Draw a self portrait.', referenceImage: join(DAYU_ASSET_ROOT, 'portrait.png') },
        agent, 'doc-mode-image-call');
    assert.equal(imageResult.isError, true, 'native image execution is denied in document mode');
    assert.equal(quota.events.length, 0, 'the image guard runs before quota or provider work');

    const content = '# 正文\n<qqbot-at-user id="42"/> @everyone **保留原文**';
    const markdownResult = await nativeCall(ctx, CREATE_MARKDOWN_TOOL,
        { requestId: secondId, filename: '../../ 周报 2026.md', content }, agent, 'doc-mode-markdown-call');
    assert.equal(markdownResult.isError, false, JSON.stringify(markdownResult));
    assert.equal(markdownResult.value.status, 'fallback');
    assert.deepEqual(markdownResult.value, {
        status: 'fallback', notice: '主人，附件没能发送；我已改为发送可复制的正文。',
        filename: '周报 2026.md', utf8Bytes: Buffer.byteLength(content, 'utf8'), delivery: 'text', truncated: false,
    });
    assertRenderedMarkdownReceipt(markdownResult);
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

test('native Markdown receipt marks final QQ attachment ACK success and prevents duplicate execution', async (t) => {
    const sends = [];
    const notices = [];
    const sender = {
        async sendNotice(request, text) { notices.push(text); return { sent: true }; },
        async sendImage() { return { sent: true }; },
        async sendMarkdownFile(request, bytes, filename) {
            sends.push({ request, bytes, filename });
            return { sent: true };
        },
        async sendMarkdownFallback() { assert.fail('fallback must not run after confirmed attachment delivery'); },
    };
    const { ctx } = await nativeGenerationRuntime(t, {
        route: route(), sender, quota: makeQuota(), imageService: { async generate() { return png; } }, markdownEnabled: true,
    });
    const agent = {};
    beginDocumentTurn(agent, { content: '' });
    const documentScope = getDocumentTurn(agent);
    const request = makeGenerationRequest('owner-md-ack', 'group-md-ack', 'message-md-ack');
    const scope = beginGenerationTurn(agent, [request], [], { documentScope });
    const [requestId] = [...scope.requests.keys()];
    const args = { requestId, filename: 'report.md', content: '# confirmed ✓' };
    const first = await nativeCall(ctx, CREATE_MARKDOWN_TOOL, args, agent, 'markdown-ack-call');
    const repeated = await nativeCall(ctx, CREATE_MARKDOWN_TOOL, args, agent, 'markdown-ack-call');
    const secondCallId = await nativeCall(ctx, CREATE_MARKDOWN_TOOL, args, agent, 'markdown-ack-call-2');
    assert.equal(first.isError, false);
    assert.deepEqual(first.value, {
        status: 'markdown', notice: '主人，Markdown 文件已经发到对应消息啦。',
        filename: 'report.md', utf8Bytes: Buffer.byteLength(args.content, 'utf8'), delivery: 'attachment', truncated: false,
    });
    assert.deepEqual(repeated.value, first.value);
    assert.deepEqual(secondCallId.value, {
        status: 'busy', notice: '主人，本鱼这会儿正忙着处理同类任务，稍后再试吧。',
        filename: 'report.md', utf8Bytes: Buffer.byteLength(args.content, 'utf8'), delivery: 'none', truncated: false,
    });
    assertRenderedMarkdownReceipt(first);
    assertRenderedMarkdownReceipt(secondCallId);
    assert.equal(sends.length, 1, 'same and different call ids cannot trigger a second Markdown delivery');
    assert.deepEqual(notices, [], 'a different call id for the same Markdown request does not send a second QQ busy notice');
    await endGenerationTurn(agent, scope);
    endDocumentTurn(agent, documentScope);
});

test('native Markdown tool returns unknown without a text replay after uncertain final attachment POST', async (t) => {
    const harness = makeSdkHarness({ fetchImpl: async (url) => {
        if (new URL(String(url)).pathname.endsWith('/files')) {
            return new Response(JSON.stringify({ file_info: 'fixture-file-info' }), { status: 200 });
        }
        throw new Error('fixture connection lost');
    } });
    const notices = [];
    const sender = {
        ...harness.sender,
        async sendNotice(request, text) { notices.push(text); return { sent: true }; },
    };
    const { ctx } = await nativeGenerationRuntime(t, {
        route: route(), sender, quota: makeQuota(), imageService: { async generate() { return png; } }, markdownEnabled: true,
    });
    const agent = {};
    beginDocumentTurn(agent, { content: '' });
    const documentScope = getDocumentTurn(agent);
    const request = makeGenerationRequest('owner-md-unknown', 'group-md-unknown', 'message-md-unknown');
    const scope = beginGenerationTurn(agent, [request], [], { documentScope, enqueueSend: harness.enqueueSend });
    const [requestId] = [...scope.requests.keys()];
    const output = await nativeCall(ctx, CREATE_MARKDOWN_TOOL,
        { requestId, filename: 'uncertain.md', content: 'body' }, agent, 'markdown-unknown-call');
    assert.equal(output.isError, false, JSON.stringify(output));
    assert.deepEqual(output.value, {
        status: 'unknown', notice: '主人，投递结果未知；为避免重复，本鱼没有再次发送。',
        filename: 'uncertain.md', utf8Bytes: 4, delivery: 'unknown', truncated: false,
    });
    assert.equal(harness.requests.length, 2, 'only upload and one final message POST occurred');
    assert.equal(notices.length, 0, 'no second status message follows an uncertain delivery');
    assertRenderedMarkdownReceipt(output);
    await endGenerationTurn(agent, scope);
    endDocumentTurn(agent, documentScope);
});

test('native Markdown fallback follows a definite attachment rejection and reports truncation', async (t) => {
    let messageAttempts = 0;
    const harness = makeSdkHarness({ fetchImpl: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('/files')) {
            return new Response(JSON.stringify({ file_info: 'fixture-file-info' }), { status: 200 });
        }
        messageAttempts += 1;
        if (messageAttempts === 1) return new Response(JSON.stringify({ code: 400, message: 'fixture rejected' }), { status: 200 });
        return new Response(JSON.stringify({ id: 'fixture-fallback-ack' }), { status: 200 });
    } });
    const sender = {
        ...harness.sender,
        async sendNotice() { assert.fail('successful fallback suppresses an additional notice'); },
    };
    const { ctx } = await nativeGenerationRuntime(t, {
        route: route(), sender, quota: makeQuota(), imageService: { async generate() { return png; } }, markdownEnabled: true,
    });
    const agent = {};
    beginDocumentTurn(agent, { content: '' });
    const documentScope = getDocumentTurn(agent);
    const request = makeGenerationRequest('owner-md-fallback', 'group-md-fallback', 'message-md-fallback');
    const scope = beginGenerationTurn(agent, [request], [], { documentScope, enqueueSend: harness.enqueueSend });
    const [requestId] = [...scope.requests.keys()];
    const content = '# report\n' + '鱼'.repeat(2500);
    const output = await nativeCall(ctx, CREATE_MARKDOWN_TOOL,
        { requestId, filename: 'report.md', content }, agent, 'markdown-fallback-truncate-call');
    assert.equal(output.isError, false, JSON.stringify(output));
    assert.deepEqual(output.value, {
        status: 'fallback', notice: '主人，附件没能发送；我已改为发送可复制的正文。',
        filename: 'report.md', utf8Bytes: Buffer.byteLength(content, 'utf8'), delivery: 'text', truncated: true,
    });
    assert.equal(harness.requests.length, 3, 'definite rejection permits exactly one bounded text fallback');
    const fallback = JSON.parse(harness.requests[2].body);
    assert.match(fallback.content, /\[正文已截断\]/u);
    assertRenderedMarkdownReceipt(output);
    await endGenerationTurn(agent, scope);
    endDocumentTurn(agent, documentScope);
});

test('native image unknown acknowledgement does not trigger a contradictory failure notice', async (t) => {
    const notices = [];
    const sent = [];
    const sender = {
        async sendNotice(request, text) { notices.push(text); return { sent: true }; },
        async sendImage(request, bytes) { sent.push(bytes); return { sent: false, reason: 'unknown' }; },
        async sendMarkdownFile() { return { sent: false, reason: 'failed' }; },
        async sendMarkdownFallback() { return { sent: false, reason: 'failed' }; },
    };
    const { ctx } = await nativeGenerationRuntime(t, {
        route: route(), sender, quota: makeQuota(), imageService: { async generate() { return png; } }, markdownEnabled: true,
    });
    const agent = {};
    beginDocumentTurn(agent, { content: '' });
    const documentScope = getDocumentTurn(agent);
    const request = makeGenerationRequest('owner-image-unknown', 'group-image-unknown', 'message-image-unknown');
    const scope = beginGenerationTurn(agent, [request], [], { documentScope });
    const [requestId] = [...scope.requests.keys()];
    const output = await nativeCall(ctx, GENERATE_IMAGE_TOOL,
        { requestId, prompt: 'Draw one whale.' }, agent, 'image-unknown-call');
    assert.equal(output.isError, false, JSON.stringify(output));
    assert.deepEqual(output.value, {
        status: 'unknown', notice: '主人，投递结果未知；为避免重复，本鱼没有再次发送。',
    });
    assert.equal(sent.length, 1);
    assert.deepEqual(notices, [], 'unknown delivery does not send a contradictory QQ failure notice');
    assertRenderedImageReceipt(output);
    await endGenerationTurn(agent, scope);
    endDocumentTurn(agent, documentScope);
});

for (const scenario of [
    { name: 'provider failure', status: 'failed', notice: '主人，这次图片或文件操作没有完成，稍后再试吧。' },
    { name: 'provider timeout', status: 'timeout', notice: '主人，这次图片处理超时了，稍后再试吧。' },
    { name: 'nested Undici connect timeout', code: 'UND_ERR_CONNECT_TIMEOUT', status: 'timeout', notice: '主人，这次图片处理超时了，稍后再试吧。' },
    { name: 'nested Undici headers timeout', code: 'UND_ERR_HEADERS_TIMEOUT', status: 'timeout', notice: '主人，这次图片处理超时了，稍后再试吧。' },
    { name: 'nested Undici body timeout', code: 'UND_ERR_BODY_TIMEOUT', status: 'timeout', notice: '主人，这次图片处理超时了，稍后再试吧。' },
    { name: 'HTTP 408', httpStatus: 408, status: 'timeout', notice: '主人，这次图片处理超时了，稍后再试吧。' },
    { name: 'HTTP 503', httpStatus: 503, status: 'failed', notice: '主人，这次图片或文件操作没有完成，稍后再试吧。' },
    { name: 'internal deadline', status: 'timeout', notice: '主人，这次图片处理超时了，稍后再试吧。' },
    { name: 'late provider result', status: 'timeout', notice: '主人，这次图片处理超时了，稍后再试吧。' },
]) test(`native image ${scenario.name} returns one safe model receipt and one QQ notice`, async (t) => {
    let providerCalls = 0;
    let imageSends = 0;
    const notices = [];
    const service = {
        async generate({ signal }) {
            providerCalls += 1;
            if (scenario.name === 'provider failure') throw new Error('private-image-prompt secret-provider-body');
            if (scenario.name === 'provider timeout') throw new DOMException('secret-provider-body', 'TimeoutError');
            if (scenario.code) {
                throw new TypeError('secret-provider-body', {
                    cause: new Error('private-image-prompt', {
                        cause: Object.assign(new Error('secret nested timeout'), { code: scenario.code }),
                    }),
                });
            }
            if (scenario.httpStatus) {
                throw Object.assign(new Error('secret-provider-body'), { status: scenario.httpStatus });
            }
            if (scenario.name === 'late provider result') {
                await new Promise((resolve) => setTimeout(resolve, 40));
                return png;
            }
            await new Promise((resolve, reject) => {
                if (signal.aborted) reject(signal.reason);
                else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
            assert.fail('the deadline must cancel the provider operation');
        },
    };
    const { ctx } = await nativeGenerationRuntime(t, {
        route: route(), quota: makeQuota(), markdownEnabled: false, imageService: service,
        imageOperationTimeoutMs: 20,
        sender: {
            async sendImage() { imageSends += 1; return { sent: true }; },
            async sendNotice(_request, notice, signal) {
                assert.equal(signal.aborted, false, 'internal timeout must leave a window for the QQ notice');
                notices.push(notice);
                return { sent: true };
            },
        },
    });
    const agent = {};
    beginDocumentTurn(agent, { content: 'Draw an image.' });
    const documentScope = getDocumentTurn(agent);
    const scope = beginGenerationTurn(agent,
        [makeGenerationRequest('owner-failure', 'group-failure', 'message-failure')], [], { documentScope });
    const [requestId] = [...scope.requests.keys()];
    const args = { requestId, prompt: 'private-image-prompt' };
    const first = await nativeCall(ctx, GENERATE_IMAGE_TOOL, args, agent, `image-${scenario.status}-call`);
    assert.deepEqual(first.value, { status: scenario.status, notice: scenario.notice });
    assertRenderedImageReceipt(first);
    assert.doesNotMatch(JSON.stringify(first.content), /private-image-prompt|secret-provider-body|requestId/u);
    const repeat = await nativeCall(ctx, GENERATE_IMAGE_TOOL, args, agent, `image-${scenario.status}-call`);
    assert.deepEqual(repeat.value, first.value);
    assertRenderedImageReceipt(repeat);
    assert.equal(providerCalls, 1, 'cached call does not start another provider request');
    assert.equal(imageSends, 0);
    assert.deepEqual(notices, [scenario.notice], 'cached call does not repeat the QQ notice');
    await endGenerationTurn(agent, scope);
    endDocumentTurn(agent, documentScope);
});

test('native image deadline returns a timeout receipt after a slow QQ notice is cancelled', { timeout: 15_000 }, async (t) => {
    let providerCalls = 0;
    let imageSends = 0;
    let noticeAttempts = 0;
    let deliveredNotices = 0;
    let noticeCancelled = false;
    const { ctx } = await nativeGenerationRuntime(t, {
        route: route(), quota: makeQuota(), markdownEnabled: false, imageOperationTimeoutMs: 20,
        imageService: {
            async generate({ signal }) {
                providerCalls += 1;
                await new Promise((resolve, reject) => {
                    if (signal.aborted) reject(signal.reason);
                    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                });
            },
        },
        sender: {
            async sendImage() { imageSends += 1; return { sent: true }; },
            async sendNotice(_request, _notice, signal) {
                noticeAttempts += 1;
                assert.equal(signal.aborted, false);
                await new Promise((resolve, reject) => {
                    signal.addEventListener('abort', () => {
                        noticeCancelled = signal.reason?.name === 'TimeoutError';
                        reject(signal.reason);
                    }, { once: true });
                });
                deliveredNotices += 1;
                return { sent: true };
            },
        },
    });
    const agent = {};
    beginDocumentTurn(agent, { content: 'Draw an image.' });
    const documentScope = getDocumentTurn(agent);
    const scope = beginGenerationTurn(agent,
        [makeGenerationRequest('owner-slow-notice', 'group-slow-notice', 'message-slow-notice')], [], { documentScope });
    const [requestId] = [...scope.requests.keys()];
    const args = { requestId, prompt: 'Draw one image.' };
    const output = await nativeCall(ctx, GENERATE_IMAGE_TOOL, args, agent, 'image-slow-notice-call');
    assert.deepEqual(output.value, { status: 'timeout', notice: '主人，这次图片处理超时了，稍后再试吧。' });
    assertRenderedImageReceipt(output);
    assert.equal(noticeCancelled, true, 'the image notice receives its own ten-second deadline');
    const repeat = await nativeCall(ctx, GENERATE_IMAGE_TOOL, args, agent, 'image-slow-notice-call');
    assertRenderedImageReceipt(repeat);
    assert.equal(providerCalls, 1);
    assert.equal(imageSends, 0);
    assert.equal(noticeAttempts, 1);
    assert.equal(deliveredNotices, 0, 'an aborted notice cannot be sent later');
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
        assertRenderedImageReceipt(output);
        assert.equal(output.value.status, 'expired');
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
        assertRenderedImageReceipt(output);
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
