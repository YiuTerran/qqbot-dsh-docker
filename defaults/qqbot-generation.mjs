import { createGenerationQuota } from './qqbot-generation-quotas.mjs';
import {
    generationScopeFailure,
    getBoundGenerationTurn,
    getGenerationImageAttachment,
    getGenerationRequest,
    getGenerationRequestSignal,
    trackGenerationOperation,
} from './qqbot-generation-scope.mjs';
import { resolvePublicHttpAddresses } from './qqbot-web-pages.mjs';

export { createGenerationSender } from './qqbot-generation-sender.mjs';

export const GENERATE_IMAGE_TOOL = 'qqbot_generate_image';
export const CREATE_MARKDOWN_TOOL = 'qqbot_create_markdown';

const MAX_PROMPT_CHARS = 4000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_API_JSON_BYTES = 16 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 128 * 1024;
const API_TIMEOUT_MS = 120000;
const TOOL_TIMEOUT_MS = 180000;
const IMAGE_USER_HOURLY_LIMIT = 10;
const MARKDOWN_USER_HOURLY_LIMIT = 30;
const IMAGE_CONCURRENCY = 2;
const MARKDOWN_CONCURRENCY = 4;
const MAX_GENERATION_REQUESTS = 20;

const notices = Object.freeze({
    sent: '主人，图片已经生成并发到对应消息啦。',
    markdown: '主人，Markdown 文件已经发到对应消息啦。',
    fallback: '主人，附件没能发送；我把可复制的原文发在下面了。',
    quota: '主人，这项功能的小时额度用完啦，过一会儿再试吧。',
    busy: '主人，本鱼这会儿正忙着处理同类任务，稍后再试吧。',
    state: '主人，这项功能的本地额度记录暂时不可用，稍后再试吧。',
    failed: '主人，这次图片或文件操作没有完成，稍后再试吧。',
    expired: '主人，这条消息已经过期，本鱼不能再替它发送结果啦。',
    'image-type': '主人，这张图不是受支持的 PNG/JPEG，请转换后重发吧。',
    'too-large': '主人，这张图或文档超出大小限制，请缩小后再试吧。',
    invalid: '主人，这次请求的格式不太对，请检查内容后再试吧。',
});

const MARKDOWN_FALLBACK_PREFIX = '附件没能发送，本鱼把转义后的可复制 Markdown 原文放在下面啦：\n\n';

function safeMarkdownFallbackText(content) {
    return MARKDOWN_FALLBACK_PREFIX + content
        .replace(/&/gu, '&amp;')
        .replace(/</gu, '&lt;')
        .replace(/@everyone/giu, '＠everyone');
}

function imageRouteError() {
    return new Error('QQ image route configuration is incomplete or invalid.');
}

function noControlCharacters(value) {
    return typeof value === 'string' && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function safePromptText(value) {
    return typeof value === 'string' && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value);
}

/** Read and strictly validate one independent image route; no chat-key fallback. */
export function readImageRouteConfig(env = process.env) {
    const raw = {
        apiKey: env.IMAGE_API_KEY,
        baseUrl: env.IMAGE_API_BASE_URL,
        model: env.IMAGE_MODEL,
        protocol: env.IMAGE_API_PROTOCOL,
    };
    const present = [raw.apiKey, raw.baseUrl, raw.model].map((value) => typeof value === 'string' && value.trim().length > 0);
    if (present.every((value) => !value) && (raw.protocol === undefined || raw.protocol === '')) return undefined;
    if (!present.every(Boolean)) throw imageRouteError();
    if (!noControlCharacters(raw.apiKey) || raw.apiKey.length > 4096
        || !noControlCharacters(raw.model) || raw.model.trim().length === 0 || raw.model.length > 256
        || !noControlCharacters(raw.baseUrl) || raw.baseUrl.length > 2048) throw imageRouteError();
    const protocol = raw.protocol === undefined || raw.protocol === '' ? 'openai-images' : raw.protocol;
    if (!['openai-images', 'xai-images'].includes(protocol)) throw imageRouteError();
    let url;
    try {
        url = new URL(raw.baseUrl);
    }
    catch {
        throw imageRouteError();
    }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash
        || url.pathname.split('/').some((segment) => segment === '.' || segment === '..')
        || url.pathname.includes('\\')) throw imageRouteError();
    url.pathname = url.pathname.replace(/\/+$/u, '');
    return Object.freeze({ apiKey: raw.apiKey, baseUrl: url.href.replace(/\/$/u, ''), model: raw.model.trim(), protocol });
}

function readPositiveLimit(env, key, fallback) {
    const raw = env[key];
    if (raw === undefined || raw === '') return fallback;
    if (!/^[1-9][0-9]*$/u.test(raw)) throw new Error(`Invalid ${key}.`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${key}.`);
    return value;
}

function readConcurrency(env, key, fallback) {
    const value = readPositiveLimit(env, key, fallback);
    if (value < 1) throw new Error(`Invalid ${key}.`);
    return value;
}

function readGenerationLimits(env = process.env) {
    return Object.freeze({
        imageHourlyLimit: readPositiveLimit(env, 'QQBOT_IMAGE_USER_HOURLY_LIMIT', IMAGE_USER_HOURLY_LIMIT),
        markdownHourlyLimit: readPositiveLimit(env, 'QQBOT_MARKDOWN_USER_HOURLY_LIMIT', MARKDOWN_USER_HOURLY_LIMIT),
        imageConcurrent: readConcurrency(env, 'QQBOT_IMAGE_MAX_CONCURRENT', IMAGE_CONCURRENCY),
        markdownConcurrent: readConcurrency(env, 'QQBOT_MARKDOWN_MAX_CONCURRENT', MARKDOWN_CONCURRENCY),
    });
}

function safePublicHttpsUrl(value) {
    if (typeof value !== 'string' || value.length > 8192) return undefined;
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return undefined;
        url.hash = '';
        return url;
    }
    catch {
        return undefined;
    }
}

function createPinnedLookup(addresses) {
    return (hostname, options, callback) => {
        const family = typeof options.family === 'number'
            ? options.family
            : options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : 0;
        const eligible = family === 0 ? addresses : addresses.filter((address) => address.family === family);
        if (eligible.length === 0) {
            const error = Object.assign(new Error('no validated public address'), { code: 'ENOTFOUND', hostname });
            callback(error, options.all === true ? [] : '', family);
            return;
        }
        if (options.all === true) {
            callback(null, eligible.map(({ address, family: addressFamily }) => ({ address, family: addressFamily })));
            return;
        }
        callback(null, eligible[0].address, eligible[0].family);
    };
}

async function readBoundedResponse(response, maxBytes, signal) {
    const declaredLength = response.headers?.get?.('content-length');
    if (declaredLength && /^\d+$/u.test(declaredLength) && Number(declaredLength) > maxBytes) {
        await response.body?.cancel?.();
        throw new Error('response-too-large');
    }
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            if (signal?.aborted) throw signal.reason ?? new Error('aborted');
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            total += chunk.length;
            if (total > maxBytes) throw new Error('response-too-large');
            chunks.push(chunk);
        }
    }
    catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
    }
    return Buffer.concat(chunks, total);
}

/** Production transport: validate and pin public DNS answers for every hop. */
function createPinnedRequest({ resolvePublic = resolvePublicHttpAddresses, fetchImpl = globalThis.fetch } = {}) {
    if (typeof resolvePublic !== 'function' || typeof fetchImpl !== 'function') throw imageRouteError();
    return async function request(options) {
        const initial = safePublicHttpsUrl(options?.url);
        const method = options?.method ?? 'GET';
        const signal = options?.signal;
        const maxBytes = options?.maxResponseBytes;
        const maxRedirects = options?.maxRedirects ?? 0;
        if (!initial || !['GET', 'POST'].includes(method) || !Number.isSafeInteger(maxBytes) || maxBytes < 1
            || !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 3) {
            throw new Error('invalid-request');
        }
        const firstOrigin = initial.origin;
        let current = initial;
        for (let redirectCount = 0; ; redirectCount += 1) {
            if (signal?.aborted) throw signal.reason ?? new Error('aborted');
            if (current.origin !== firstOrigin) throw new Error('cross-origin-redirect');
            const addresses = await resolvePublic(current.hostname, signal);
            if (!Array.isArray(addresses) || addresses.length === 0) throw new Error('no-public-address');
            if (signal?.aborted) throw signal.reason ?? new Error('aborted');
            const { Agent } = await import('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/undici/index.js');
            const dispatcher = new Agent({ autoSelectFamily: true, connect: { lookup: createPinnedLookup(addresses) } });
            let response;
            let body;
            let headers;
            try {
                if (typeof options.assertActive === 'function' && options.assertActive() !== true) throw new Error('expired');
                if (signal?.aborted) throw signal.reason ?? new Error('aborted');
                response = await fetchImpl(current.href, {
                    method,
                    headers: options.headers,
                    body: options.body,
                    signal,
                    redirect: 'manual',
                    dispatcher,
                });
                const location = response.headers?.get?.('location');
                if (response.status >= 300 && response.status < 400 && location) {
                    await response.body?.cancel?.();
                    if (redirectCount >= maxRedirects) throw new Error('redirect-limit');
                    const next = safePublicHttpsUrl(new URL(location, current).href);
                    if (!next || next.origin !== firstOrigin) throw new Error('cross-origin-redirect');
                    current = next;
                    if (method !== 'GET') throw new Error('api-redirect-denied');
                    continue;
                }
                body = await readBoundedResponse(response, maxBytes, signal);
                headers = response.headers;
            }
            finally {
                await dispatcher.close().catch(() => {});
            }
            return { status: response.status, headers, body };
        }
    };
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
        table[index] = value >>> 0;
    }
    return table;
})();

function pngCrc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function validDimensions(width, height) {
    return Number.isSafeInteger(width) && Number.isSafeInteger(height)
        && width > 0 && height > 0 && width <= 30000 && height <= 30000 && width * height <= 100_000_000;
}

function inspectPng(bytes) {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < 45 || !signature.every((byte, index) => bytes[index] === byte)) return false;
    let offset = 8;
    let chunks = 0;
    let sawHeader = false;
    let sawPalette = false;
    let sawData = false;
    let ended = false;
    while (offset + 12 <= bytes.length && chunks < 100000) {
        chunks += 1;
        const length = bytes.readUInt32BE(offset);
        if (length > MAX_IMAGE_BYTES || offset + 12 + length > bytes.length) return false;
        const typeBytes = bytes.subarray(offset + 4, offset + 8);
        if (!/^[A-Za-z]{4}$/u.test(typeBytes.toString('ascii'))) return false;
        const type = typeBytes.toString('ascii');
        const data = bytes.subarray(offset + 8, offset + 8 + length);
        const storedCrc = bytes.readUInt32BE(offset + 8 + length);
        if (pngCrc32(bytes.subarray(offset + 4, offset + 8 + length)) !== storedCrc) return false;
        if (!sawHeader) {
            if (type !== 'IHDR' || length !== 13) return false;
            const width = data.readUInt32BE(0);
            const height = data.readUInt32BE(4);
            const depth = data[8];
            const color = data[9];
            const allowedDepths = color === 0 ? [1, 2, 4, 8, 16]
                : color === 2 ? [8, 16]
                    : color === 3 ? [1, 2, 4, 8]
                        : color === 4 || color === 6 ? [8, 16] : [];
            if (!validDimensions(width, height) || !allowedDepths.includes(depth)
                || data[10] !== 0 || data[11] !== 0 || ![0, 1].includes(data[12])) return false;
            sawHeader = true;
        }
        else if (type === 'IHDR') return false;
        if (type === 'PLTE') {
            if (sawData || length === 0 || length > 768 || length % 3 !== 0) return false;
            sawPalette = true;
        }
        if (type === 'IDAT') sawData = true;
        const critical = typeBytes[0] >= 65 && typeBytes[0] <= 90;
        if (critical && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) return false;
        if (type === 'IEND') {
            if (length !== 0 || !sawData || bytes[25] === 3 && !sawPalette) return false;
            offset += 12;
            ended = true;
            break;
        }
        offset += 12 + length;
    }
    return ended && offset === bytes.length;
}

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function inspectJpeg(bytes) {
    if (bytes.length < 16 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
    let offset = 2;
    let segments = 0;
    let sawFrame = false;
    let sawScan = false;
    while (offset < bytes.length && segments < 100000) {
        if (bytes[offset] !== 0xff) return false;
        while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
        if (offset >= bytes.length) return false;
        const marker = bytes[offset++];
        segments += 1;
        if (marker === 0xd9) return sawFrame && sawScan && offset === bytes.length;
        if (marker === 0x00 || marker === 0xd8 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) return false;
        if (offset + 2 > bytes.length) return false;
        const length = bytes.readUInt16BE(offset);
        if (length < 2 || offset + length > bytes.length) return false;
        const dataStart = offset + 2;
        const dataEnd = offset + length;
        if (JPEG_SOF.has(marker)) {
            if (length < 11) return false;
            const height = bytes.readUInt16BE(dataStart + 1);
            const width = bytes.readUInt16BE(dataStart + 3);
            const components = bytes[dataStart + 5];
            if (!validDimensions(width, height) || components < 1 || components > 4 || length !== 8 + components * 3) return false;
            sawFrame = true;
        }
        offset = dataEnd;
        if (marker !== 0xda) continue;
        if (length < 8) return false;
        sawScan = true;
        let markerOffset = -1;
        while (offset < bytes.length) {
            if (bytes[offset] !== 0xff) {
                offset += 1;
                continue;
            }
            const start = offset;
            while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
            if (offset >= bytes.length) return false;
            const scanMarker = bytes[offset];
            if (scanMarker === 0x00 || scanMarker >= 0xd0 && scanMarker <= 0xd7) {
                offset += 1;
                continue;
            }
            markerOffset = start;
            offset = markerOffset;
            break;
        }
        if (markerOffset < 0) return false;
    }
    return false;
}

function inspectImage(bytes) {
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) return undefined;
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return undefined;
    if (inspectPng(buffer)) return 'image/png';
    if (inspectJpeg(buffer)) return 'image/jpeg';
    return undefined;
}

function parseImageResponse(body) {
    if (!Buffer.isBuffer(body) || body.length === 0 || body.length > MAX_API_JSON_BYTES) throw new Error('provider-response');
    let payload;
    try {
        payload = JSON.parse(body.toString('utf8'));
    }
    catch {
        throw new Error('provider-response');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.data) || payload.data.length !== 1) {
        throw new Error('provider-response');
    }
    const image = payload.data[0];
    if (!image || typeof image !== 'object' || Array.isArray(image)) throw new Error('provider-response');
    if (typeof image.b64_json === 'string') {
        if (image.b64_json.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(image.b64_json)) {
            throw new Error('provider-response');
        }
        const bytes = Buffer.from(image.b64_json, 'base64');
        if (bytes.toString('base64') !== image.b64_json || bytes.length > MAX_IMAGE_BYTES || !inspectImage(bytes)) {
            throw new Error('provider-response');
        }
        return { bytes };
    }
    if (typeof image.url === 'string') {
        const url = safePublicHttpsUrl(image.url);
        if (!url) throw new Error('provider-response');
        return { url: url.href };
    }
    throw new Error('provider-response');
}

function imageExtension(mime) {
    return mime === 'image/png' ? 'png' : 'jpg';
}

/** Test seam is constructor-only; tool arguments never select transport or resolver. */
export function createImageService({ route, transport, resolvePublic, fetchImpl } = {}) {
    const validatedRoute = readImageRouteConfig({
        IMAGE_API_KEY: route?.apiKey,
        IMAGE_API_BASE_URL: route?.baseUrl,
        IMAGE_MODEL: route?.model,
        IMAGE_API_PROTOCOL: route?.protocol,
    });
    if (!validatedRoute) throw imageRouteError();
    route = validatedRoute;
    const requestImpl = transport
        ? (typeof transport === 'function' ? transport : transport.request?.bind(transport))
        : createPinnedRequest({ resolvePublic: resolvePublic ?? resolvePublicHttpAddresses, fetchImpl: fetchImpl ?? globalThis.fetch });
    if (typeof requestImpl !== 'function') throw imageRouteError();
    const request = async (options) => {
        if (options.signal?.aborted || (typeof options.assertActive === 'function' && options.assertActive() !== true)) {
            throw new Error('expired');
        }
        const response = await requestImpl(options);
        if (options.signal?.aborted || (typeof options.assertActive === 'function' && options.assertActive() !== true)) {
            throw new Error('expired');
        }
        return response;
    };
    const base = new URL(route.baseUrl);
    const endpoint = (kind) => {
        const url = new URL(base.href);
        url.pathname = `${url.pathname.replace(/\/+$/u, '')}/images/${kind}`;
        return url.href;
    };
    return Object.freeze({
        async generate({ prompt, imageBytes, signal, assertActive } = {}) {
            if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > MAX_PROMPT_CHARS
                || !safePromptText(prompt)) throw new Error('invalid-request');
            if (signal?.aborted || (typeof assertActive === 'function' && assertActive() !== true)) throw new Error('aborted');
            let inputMime;
            let inputBuffer;
            if (imageBytes !== undefined) {
                inputBuffer = Buffer.from(imageBytes);
                inputMime = inspectImage(inputBuffer);
                if (!inputMime) throw Object.assign(new Error('invalid-image'), { kind: 'image-type' });
                if (inputBuffer.length > MAX_IMAGE_BYTES) throw Object.assign(new Error('image-too-large'), { kind: 'too-large' });
            }

            const url = endpoint(inputBuffer ? 'edits' : 'generations');
            const requestSignal = signal
                ? AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)])
                : AbortSignal.timeout(API_TIMEOUT_MS);
            let body;
            const headers = {
                authorization: `Bearer ${route.apiKey}`,
                accept: 'application/json',
            };
            if (inputBuffer && route.protocol === 'openai-images') {
                body = new FormData();
                body.set('model', route.model);
                body.set('prompt', prompt);
                body.set('n', '1');
                body.set('image', new Blob([inputBuffer], { type: inputMime }), `input.${imageExtension(inputMime)}`);
            }
            else {
                headers['content-type'] = 'application/json';
                const payload = { model: route.model, prompt, n: 1 };
                if (inputBuffer) {
                    payload.image = { url: `data:${inputMime};base64,${inputBuffer.toString('base64')}` };
                }
                body = JSON.stringify(payload);
            }
            const response = await request({
                url,
                method: 'POST',
                headers,
                body,
                signal: requestSignal,
                maxResponseBytes: MAX_API_JSON_BYTES,
                maxRedirects: 0,
                assertActive,
            });
            if (!response || response.status < 200 || response.status >= 300) throw new Error('provider-response');
            const parsed = parseImageResponse(response.body);
            let result = parsed.bytes;
            if (!result) {
                if (signal?.aborted || (typeof assertActive === 'function' && assertActive() !== true)) throw new Error('aborted');
                const imageUrl = new URL(parsed.url);
                const downloadSignal = signal
                    ? AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)])
                    : AbortSignal.timeout(API_TIMEOUT_MS);
                const downloaded = await request({
                    url: imageUrl.href,
                    method: 'GET',
                    headers: { accept: 'image/png,image/jpeg' },
                    signal: downloadSignal,
                    maxResponseBytes: MAX_IMAGE_BYTES,
                    maxRedirects: 3,
                    sameOrigin: true,
                    assertActive,
                });
                const mediaType = downloaded?.headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase();
                if (!downloaded || downloaded.status < 200 || downloaded.status >= 300
                    || !['image/png', 'image/jpeg'].includes(mediaType)) throw new Error('provider-image-url');
                result = downloaded.body;
            }
            if (signal?.aborted || (typeof assertActive === 'function' && assertActive() !== true) || !inspectImage(result)) throw new Error('provider-image');
            return Buffer.from(result);
        },
    });
}

function exactArguments(args, names) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
    const prototype = Object.getPrototypeOf(args);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(args);
    const keys = Reflect.ownKeys(descriptors);
    return keys.every((key) => typeof key === 'string' && names.includes(key)
        && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable)
        && names.every((name) => Object.hasOwn(descriptors, name) || name === 'imageAttachmentId');
}

function validCallId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 256 && noControlCharacters(value);
}

function fingerprint(type, args) {
    return JSON.stringify(type === 'image'
        ? [type, args.requestId, args.prompt, args.imageAttachmentId ?? null]
        : [type, args.requestId, args.filename, args.content]);
}

function validMarkdownFilename(value) {
    if (typeof value !== 'string' || value.length > 512 || !noControlCharacters(value)) return undefined;
    const basename = value.trim().split(/[\\/]/u).at(-1) ?? '';
    const stem = basename.replace(/\.(?:md|markdown)$/iu, '');
    const safe = stem.replace(/[^\p{L}\p{N}._ -]/gu, '-').replace(/\s+/gu, ' ').trim().replace(/^[. ]+|[. ]+$/gu, '').slice(0, 100);
    if (!safe || safe === '.' || safe === '..') return undefined;
    return `${safe}.md`;
}

function markdownBuffer(content) {
    if (typeof content !== 'string' || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(content)) return undefined;
    const buffer = Buffer.from(content, 'utf8');
    return buffer.length > 0 && buffer.length <= MAX_MARKDOWN_BYTES ? buffer : undefined;
}

function result(status, notice = notices[status] ?? notices.failed) {
    return { status, notice };
}

function executionFailure(exec, args, kind, route) {
    if (!validCallId(exec?.callId)) return 'A valid generation tool-call id is required.';
    const scope = getBoundGenerationTurn(exec);
    const reason = generationScopeFailure(scope, kind);
    if (reason) return reason === 'document-mode'
        ? 'Image generation and editing are disabled after a document or plain-text page enters this turn.'
        : 'This QQ generation tool call belongs to an expired or cancelled message.';
    if (kind === 'image' && !route) return 'Image generation is not configured.';
    const names = kind === 'image' ? ['requestId', 'prompt', 'imageAttachmentId'] : ['requestId', 'filename', 'content'];
    if (!exactArguments(args, names) || !exactArguments(exec?.arguments, names)
        || JSON.stringify(args) !== JSON.stringify(exec.arguments)) {
        return 'Generation tool arguments do not match the allowed schema.';
    }
    if (typeof args.requestId !== 'string' || !getGenerationRequest(scope, args.requestId, kind)) {
        return 'This requestId is not authorized for the current original QQ message.';
    }
    if (kind === 'image') {
        if (typeof args.prompt !== 'string' || args.prompt.trim().length === 0 || args.prompt.length > MAX_PROMPT_CHARS || !safePromptText(args.prompt)) {
            return 'Image prompts must be non-empty text of at most 4000 characters.';
        }
        if (args.imageAttachmentId !== undefined
            && !getGenerationImageAttachment(scope, args.requestId, args.imageAttachmentId)) {
            return 'This imageAttachmentId is not authorized for that original QQ message.';
        }
    }
    else if (!validMarkdownFilename(args.filename) || !markdownBuffer(args.content)) {
        return 'Markdown filename or UTF-8 content is invalid or exceeds 128 KiB.';
    }
    return undefined;
}

function getCallRecord(scope, type, callId, fingerprintValue) {
    const key = callId;
    const existing = scope.callRecords?.get(key);
    if (existing) return existing.fingerprint === fingerprintValue ? existing : { mismatch: true };
    scope.callRecords ??= new Map();
    const record = { fingerprint: fingerprintValue, pending: true };
    scope.callRecords.set(key, record);
    return record;
}

function publishCallResult(recordValue, promise) {
    recordValue.promise = Promise.resolve(promise).then(
        (value) => {
            recordValue.pending = false;
            recordValue.value = value;
            return value;
        },
        () => {
            recordValue.pending = false;
            recordValue.value = result('failed');
            return recordValue.value;
        },
    );
    return recordValue.promise;
}

function makeTrustedSenderRequest(scope, request, kind) {
    return Object.freeze({
        replyTarget: request.replyTarget,
        ownerId: request.ownerId,
        record: request.record,
        enqueueSend: request.enqueueSend,
        isActive: (requestedKind = kind) => generationScopeFailure(scope, requestedKind) === undefined,
    });
}

async function sendOperationalNotice(sender, scope, request, notice, kind, signal) {
    // A fixed failure notice is a Markdown reply even when image egress has
    // been disabled by document mode; scope/record expiry still blocks it.
    if (!request || generationScopeFailure(scope, 'markdown')) return;
    try {
        await sender.sendNotice(makeTrustedSenderRequest(scope, request, kind), notice, signal);
    }
    catch {
        // Safe user-visible output is already represented in the tool result.
    }
}

async function performImageTask({ scope, request, args, exec, service, quota, sender }) {
    const operationSignal = getGenerationRequestSignal(scope, exec.signal, 'image');
    const noticeSignal = exec.noticeSignal ?? operationSignal;
    const assertActive = () => generationScopeFailure(scope, 'image') === undefined;
    const imageGrant = args.imageAttachmentId
        ? getGenerationImageAttachment(scope, args.requestId, args.imageAttachmentId)
        : undefined;
    let imageBytes;
    if (imageGrant) {
        if (imageGrant.size !== null && imageGrant.size > MAX_IMAGE_BYTES) {
            const notice = notices['too-large'];
            await sendOperationalNotice(sender, scope, request, notice, 'image', noticeSignal);
            return result('too-large', notice);
        }
        try {
            const { loadChatImageBytes } = await import('./qqbot-chat-policy.mjs');
            if (operationSignal.aborted) throw operationSignal.reason ?? new Error('cancelled');
            imageBytes = Buffer.from(await loadChatImageBytes(imageGrant.localPath, MAX_IMAGE_BYTES, exec.sourceExecution ?? exec));
            if (operationSignal.aborted) throw operationSignal.reason ?? new Error('cancelled');
        }
        catch {
            if (generationScopeFailure(scope, 'image')) return result('expired');
            const notice = notices.failed;
            await sendOperationalNotice(sender, scope, request, notice, 'image', noticeSignal);
            return result('failed', notice);
        }
        const mime = inspectImage(imageBytes);
        if (!mime) {
            const status = imageBytes.length > MAX_IMAGE_BYTES ? 'too-large' : 'image-type';
            const notice = notices[status];
            await sendOperationalNotice(sender, scope, request, notice, 'image', noticeSignal);
            return result(status, notice);
        }
        if (imageGrant.contentType && ['image/png', 'image/jpeg'].includes(imageGrant.contentType) && imageGrant.contentType !== mime) {
            const notice = notices['image-type'];
            await sendOperationalNotice(sender, scope, request, notice, 'image', noticeSignal);
            return result('image-type', notice);
        }
    }
    if (generationScopeFailure(scope, 'image')) return result('expired');
    let acquired;
    try {
        acquired = await quota.tryAcquire({ ownerId: request.ownerId, type: 'image' });
    }
    catch {
        acquired = undefined;
    }
    if (!acquired?.ok) {
        const status = acquired?.reason === 'busy' ? 'busy' : 'state';
        const notice = notices[status];
        await sendOperationalNotice(sender, scope, request, notice, 'image', noticeSignal);
        return result(status, notice);
    }
    try {
        let reserved;
        try {
            reserved = await quota.reserve({ ownerId: request.ownerId, type: 'image' });
        }
        catch {
            reserved = undefined;
        }
        if (!reserved?.ok) {
            const status = reserved?.reason === 'quota' ? 'quota' : 'state';
            const notice = notices[status];
            await sendOperationalNotice(sender, scope, request, notice, 'image', noticeSignal);
            return result(status, notice);
        }
        if (generationScopeFailure(scope, 'image')) return result('expired');
        let generated;
        try {
            generated = await service.generate({ prompt: args.prompt, imageBytes, signal: operationSignal, assertActive });
        }
        catch (error) {
            if (generationScopeFailure(scope, 'image')) return result('expired');
            const status = error?.kind === 'image-type' ? 'image-type' : error?.kind === 'too-large' ? 'too-large' : 'failed';
            const notice = notices[status];
            await sendOperationalNotice(sender, scope, request, notice, 'image', noticeSignal);
            return result(status, notice);
        }
        if (generationScopeFailure(scope, 'image')) return result('expired');
        const sendRequest = makeTrustedSenderRequest(scope, request, 'image');
        let sent;
        try {
            sent = await sender.sendImage(sendRequest, generated, operationSignal);
        }
        catch {
            sent = { sent: false, reason: 'failed' };
        }
        if (sent?.sent) return result('sent');
        const status = sent?.reason === 'limit' ? 'quota' : sent?.reason === 'expired' ? 'expired' : 'failed';
        const notice = notices[status];
        await sendOperationalNotice(sender, scope, request, notice, 'image', operationSignal);
        return result(status, notice);
    }
    finally {
        acquired.release?.();
    }
}

async function performMarkdownTask({ scope, request, args, exec, quota, sender }) {
    const noticeSignal = exec.noticeSignal ?? exec.signal;
    const content = args.content;
    const filename = validMarkdownFilename(args.filename);
    const bytes = markdownBuffer(content);
    if (!filename || !bytes) return result('invalid');
    if (generationScopeFailure(scope, 'markdown')) return result('expired');
    let acquired;
    try {
        acquired = await quota.tryAcquire({ ownerId: request.ownerId, type: 'markdown' });
    }
    catch {
        acquired = undefined;
    }
    if (!acquired?.ok) {
        const status = acquired?.reason === 'busy' ? 'busy' : 'state';
        const notice = notices[status];
        await sendOperationalNotice(sender, scope, request, notice, 'markdown', noticeSignal);
        return result(status, notice);
    }
    try {
        let reserved;
        try {
            reserved = await quota.reserve({ ownerId: request.ownerId, type: 'markdown' });
        }
        catch {
            reserved = undefined;
        }
        if (!reserved?.ok) {
            const status = reserved?.reason === 'quota' ? 'quota' : 'state';
            const notice = notices[status];
            await sendOperationalNotice(sender, scope, request, notice, 'markdown', noticeSignal);
            return result(status, notice);
        }
        if (generationScopeFailure(scope, 'markdown')) return result('expired');
        const signal = getGenerationRequestSignal(scope, exec.signal, 'markdown');
        const sendRequest = makeTrustedSenderRequest(scope, request, 'markdown');
        let fileResult;
        try {
            fileResult = await sender.sendMarkdownFile(sendRequest, bytes, filename, signal);
        }
        catch {
            fileResult = { sent: false, reason: 'failed' };
        }
        if (fileResult?.sent) return result('markdown', notices.markdown);
        let fallbackResult;
        try {
            fallbackResult = await sender.sendMarkdownFallback(sendRequest, safeMarkdownFallbackText(content), signal);
        }
        catch {
            fallbackResult = { sent: false, reason: 'failed' };
        }
        if (fallbackResult?.sent) return result('fallback');
        const status = fallbackResult?.reason === 'limit' || fileResult?.reason === 'limit' ? 'quota'
            : fallbackResult?.reason === 'expired' ? 'expired' : 'failed';
        const notice = notices[status];
        await sendOperationalNotice(sender, scope, request, notice, 'markdown', noticeSignal);
        return result(status, notice);
    }
    finally {
        acquired.release?.();
    }
}

function executeGeneration(args, exec, kind, context) {
    const failure = executionFailure(exec, args, kind, context.route);
    if (failure) throw new Error(failure);
    const scope = getBoundGenerationTurn(exec);
    const request = getGenerationRequest(scope, args.requestId, kind);
    if (!scope.callRecords?.has(exec.callId) && (scope.callRecords?.size ?? 0) >= MAX_GENERATION_REQUESTS * 2) {
        return Promise.resolve(result('busy', notices.busy));
    }
    const argsFingerprint = fingerprint(kind, args);
    const cached = getCallRecord(scope, kind, exec.callId, argsFingerprint);
    if (cached.mismatch) throw new Error('This tool-call id was already used with different arguments.');
    if (cached.promise) return cached.promise;
    if (cached.value) return Promise.resolve(cached.value);
    const alreadyUsed = kind === 'image' ? request.imageCalls.size > 0 : request.markdownCalls.size > 0;
    if (alreadyUsed) {
        cached.pending = false;
        cached.value = result('busy', notices.busy);
        const busyNotice = sendOperationalNotice(context.sender, scope, request, cached.value.notice, kind, exec.signal)
            .then(() => cached.value);
        return publishCallResult(cached, trackGenerationOperation(scope, busyNotice));
    }
    const requestCalls = kind === 'image' ? request.imageCalls : request.markdownCalls;
    requestCalls.set(exec.callId, argsFingerprint);
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(new Error('generation-timeout')), TOOL_TIMEOUT_MS);
    timeout.unref?.();
    const signals = [timeoutController.signal];
    if (exec.signal) signals.push(exec.signal);
    const operationExec = {
        callId: exec.callId,
        arguments: args,
        signal: AbortSignal.any(signals),
        noticeSignal: AbortSignal.any(signals),
        sourceExecution: exec,
    };
    const operation = (async () => {
        try {
            return kind === 'image'
                ? await performImageTask({ scope, request, args, exec: operationExec, service: context.imageService, quota: context.quota, sender: context.sender })
                : await performMarkdownTask({ scope, request, args, exec: operationExec, quota: context.quota, sender: context.sender });
        }
        finally {
            clearTimeout(timeout);
        }
    })();
    const tracked = trackGenerationOperation(scope, operation);
    return publishCallResult(cached, tracked);
}

function imageToolSchema() {
    return {
        type: 'object',
        properties: {
            requestId: { type: 'string', minLength: 1, maxLength: 64, description: 'Opaque requestId from the original QQ message metadata.' },
            prompt: { type: 'string', minLength: 1, maxLength: MAX_PROMPT_CHARS },
            imageAttachmentId: { type: 'string', minLength: 1, maxLength: 64, description: 'Optional opaque imageAttachmentId from that same original request.' },
        },
        required: ['requestId', 'prompt'],
        additionalProperties: false,
    };
}

function markdownToolSchema() {
    return {
        type: 'object',
        properties: {
            requestId: { type: 'string', minLength: 1, maxLength: 64, description: 'Opaque requestId from the original QQ message metadata.' },
            filename: { type: 'string', minLength: 1, maxLength: 512 },
            content: { type: 'string', minLength: 1, maxLength: MAX_MARKDOWN_BYTES },
        },
        required: ['requestId', 'filename', 'content'],
        additionalProperties: false,
    };
}

function registerStatusTool(ctx, definition) {
    const tools = ctx.get('tools');
    if (typeof tools?.register !== 'function') throw new Error('Generation tools require the pinned dsh tools.register API.');
    tools.register({
        ...definition,
        output: {
            schema: {
                type: 'object',
                properties: {
                    status: { type: 'string' },
                    notice: { type: 'string' },
                },
                required: ['status', 'notice'],
                additionalProperties: false,
            },
            // The QQ sender is the user-visible result. Returning no rendered
            // tool text prevents the native runtime from emitting a duplicate
            // generic reply after an attachment has already been delivered.
            render: () => [],
        },
    });
}

/** Register only the explicitly scoped tools; no generic file sender is added. */
export function registerGenerationTools(ctx, options = {}) {
    const tools = ctx.get('tools');
    if (typeof tools?.register !== 'function') throw new Error('Generation tools require the pinned dsh tools.register API.');
    const route = options.route === undefined ? readImageRouteConfig() : options.route;
    const markdownEnabled = options.markdownEnabled ?? process.env.QQBOT_MARKDOWN_ENABLED !== 'false';
    if (typeof markdownEnabled !== 'boolean') throw new Error('Invalid QQBOT_MARKDOWN_ENABLED.');
    const limits = options.limits ?? readGenerationLimits();
    const quota = options.quota ?? createGenerationQuota({
        path: '/data/qqbot-generation-quota.json',
        appId: options.appId ?? process.env.QQBOT_APP_ID ?? '',
        limits,
        now: options.now,
    });
    const sender = options.sender;
    if (!sender || typeof sender.sendNotice !== 'function') throw new Error('Generation sender is unavailable.');
    const context = {
        route,
        sender,
        quota,
        imageService: route ? (options.imageService ?? createImageService({
            route,
            transport: options.imageTransport,
            resolvePublic: options.resolvePublic,
            fetchImpl: options.fetchImpl,
        })) : undefined,
    };
    if (route) {
        registerStatusTool(ctx, {
            name: GENERATE_IMAGE_TOOL,
            description: 'Generate one image from a prompt, or edit one PNG/JPEG image explicitly attached to or quoted in the same original QQ request. Use only when that original user clearly asks for image generation or editing. Pass its opaque requestId and, for editing, an imageAttachmentId listed under that same request. Never pass a URL, path, user id, or group id.',
            parameters: imageToolSchema(),
            async execute(args, exec) {
                return executeGeneration(args, exec, 'image', context);
            },
            timeoutMs: TOOL_TIMEOUT_MS,
        });
    }
    if (markdownEnabled) {
        registerStatusTool(ctx, {
            name: CREATE_MARKDOWN_TOOL,
            description: 'Create and send one UTF-8 Markdown attachment to the original QQ message that explicitly requested a Markdown file. Pass its opaque requestId, a safe filename, and the complete Markdown text. This tool does not read links, render HTML, run code, or access files.',
            parameters: markdownToolSchema(),
            async execute(args, exec) {
                return executeGeneration(args, exec, 'markdown', context);
            },
            timeoutMs: TOOL_TIMEOUT_MS,
        });
    }
    return Object.freeze({ imageEnabled: Boolean(route), markdownEnabled, context });
}

export function validateGenerationToolCall(exec, route) {
    if (exec?.name === GENERATE_IMAGE_TOOL) return executionFailure(exec, exec.arguments, 'image', route);
    if (exec?.name === CREATE_MARKDOWN_TOOL) return executionFailure(exec, exec.arguments, 'markdown', route);
    return undefined;
}
