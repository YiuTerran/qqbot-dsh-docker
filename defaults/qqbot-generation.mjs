import { createGenerationQuota } from './qqbot-generation-quotas.mjs';
import {
    generationScopeFailure,
    getBoundGenerationTurn,
    getGenerationImageAttachment,
    getGenerationRequest,
    getGenerationRequestSignal,
    getGenerationRecentImageAttachment,
    trackGenerationOperation,
} from './qqbot-generation-scope.mjs';
import { resolvePublicHttpAddresses } from './qqbot-web-pages.mjs';
import { logDownloadDiagnostics } from './qqbot-image-diagnostics.mjs';
import { normalizeEditImage } from './qqbot-image-input.mjs';
import { logToolFailure } from './qqbot-provider-errors.mjs';
import { isDayuAssetImagePath } from './qqbot-assets.mjs';
import { registerAssetImageDeliveryTool } from './qqbot-asset-delivery.mjs';

export { createGenerationSender } from './qqbot-generation-sender.mjs';

export const GENERATE_IMAGE_TOOL = 'qqbot_generate_image';
export const CREATE_MARKDOWN_TOOL = 'qqbot_create_markdown';

const MAX_PROMPT_CHARS = 4000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_API_JSON_BYTES = 16 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 128 * 1024;
const API_TIMEOUT_MS = 120000;
const TOOL_TIMEOUT_MS = 180000;
const IMAGE_OPERATION_TIMEOUT_MS = 165000;
const IMAGE_USER_HOURLY_LIMIT = 10;
const MARKDOWN_USER_HOURLY_LIMIT = 30;
const IMAGE_CONCURRENCY = 2;
const MARKDOWN_CONCURRENCY = 4;
const MAX_GENERATION_REQUESTS = 20;

const notices = Object.freeze({
    sent: '主人，图片已经生成并发到对应消息啦。',
    markdown: '主人，Markdown 文件已经发到对应消息啦。',
    fallback: '主人，附件没能发送；我把可复制的原文发在下面了。',
    text: '主人，附件没能发送；我已改为发送可复制的正文。',
    unknown: '主人，投递结果未知；为避免重复，本鱼没有再次发送。',
    quota: '主人，这项功能的小时额度用完啦，过一会儿再试吧。',
    busy: '主人，本鱼这会儿正忙着处理同类任务，稍后再试吧。',
    state: '主人，这项功能的本地额度记录暂时不可用，稍后再试吧。',
    failed: '主人，这次图片或文件操作没有完成，稍后再试吧。',
    timeout: '主人，这次图片处理超时了，稍后再试吧。',
    expired: '主人，这条消息已经过期，本鱼不能再替它发送结果啦。',
    'image-type': '主人，这张图没法解码成可编辑图片，请重新发送原图再试吧。',
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
function createPinnedRequest({ resolvePublic = resolvePublicHttpAddresses, fetchImpl } = {}) {
    if (typeof resolvePublic !== 'function' || (fetchImpl !== undefined && typeof fetchImpl !== 'function')) throw imageRouteError();
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
            // Keep fetch and its dispatcher on the same Undici handler protocol.
            // Node's bundled fetch can use a different Undici version from dsh.
            const { Agent, fetch: undiciFetch, FormData: UndiciFormData } = await import('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/undici/index.js');
            let requestBody = options.body;
            if (fetchImpl === undefined && requestBody instanceof globalThis.FormData) {
                // Undici versions also differ in their FormData brand checks.
                // Rebuild the native form so paired fetch serializes multipart.
                requestBody = new UndiciFormData();
                for (const [name, value] of options.body.entries()) {
                    if (typeof value === 'string') requestBody.append(name, value);
                    else requestBody.append(name, value, value.name);
                }
            }
            const dispatcher = new Agent({ autoSelectFamily: true, connect: { lookup: createPinnedLookup(addresses) } });
            let response;
            let body;
            let headers;
            try {
                if (typeof options.assertActive === 'function' && options.assertActive() !== true) throw new Error('expired');
                if (signal?.aborted) throw signal.reason ?? new Error('aborted');
                response = await (fetchImpl ?? undiciFetch)(current.href, {
                    method,
                    headers: options.headers,
                    body: requestBody,
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
        : createPinnedRequest({ resolvePublic: resolvePublic ?? resolvePublicHttpAddresses, fetchImpl });
    if (typeof requestImpl !== 'function') throw imageRouteError();
    const request = async (options) => {
        if (options.signal?.aborted) throw options.signal.reason ?? new Error('aborted');
        if (typeof options.assertActive === 'function' && options.assertActive() !== true) throw new Error('expired');
        let response;
        try {
            response = await requestImpl(options);
        }
        catch (error) {
            if (options.signal?.aborted) throw options.signal.reason ?? error;
            throw error;
        }
        if (options.signal?.aborted) throw options.signal.reason ?? new Error('aborted');
        if (typeof options.assertActive === 'function' && options.assertActive() !== true) throw new Error('expired');
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
            if (!response || response.status < 200 || response.status >= 300) {
                const error = new Error('provider-response');
                if (Number.isInteger(response?.status)) error.status = response.status;
                throw error;
            }
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
                    || !['image/png', 'image/jpeg'].includes(mediaType)) {
                    const error = new Error('provider-image-url');
                    if (Number.isInteger(downloaded?.status)) error.status = downloaded.status;
                    throw error;
                }
                result = downloaded.body;
            }
            if (signal?.aborted || (typeof assertActive === 'function' && assertActive() !== true) || !inspectImage(result)) throw new Error('provider-image');
            return Buffer.from(result);
        },
    });
}

function exactArguments(args, names, optionalNames = []) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
    const prototype = Object.getPrototypeOf(args);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(args);
    const keys = Reflect.ownKeys(descriptors);
    const allowedNames = new Set([...names, ...optionalNames]);
    return keys.every((key) => typeof key === 'string' && allowedNames.has(key)
        && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable)
        && names.every((name) => Object.hasOwn(descriptors, name) || optionalNames.includes(name));
}

function validCallId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 256 && noControlCharacters(value);
}

function fingerprint(type, args) {
    return JSON.stringify(type === 'image'
        ? [type, args.requestId, args.prompt, args.imageAttachmentId ?? null, args.referenceImage ?? null]
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

function imageFailureStatus(error, exec) {
    if (exec.timeoutSignal?.aborted) return 'timeout';
    const timeoutCodes = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
    let cause = error;
    for (let depth = 0; depth < 4 && cause && typeof cause === 'object'; depth += 1) {
        if (cause.kind === 'timeout' || cause.name === 'TimeoutError' || timeoutCodes.has(cause.code)
            || cause.status === 408) return 'timeout';
        cause = cause.cause;
    }
    return error?.kind === 'image-type' ? 'image-type' : error?.kind === 'too-large' ? 'too-large' : 'failed';
}

function markdownReceipt(status, notice, filename, bytes, delivery = 'none', truncated = false) {
    return {
        ...result(status, notice),
        filename: filename ?? '',
        utf8Bytes: bytes?.length ?? 0,
        delivery,
        truncated,
    };
}

function executionFailure(exec, args, kind, route) {
    if (!validCallId(exec?.callId)) return 'A valid generation tool-call id is required.';
    const scope = getBoundGenerationTurn(exec);
    const reason = generationScopeFailure(scope, kind);
    if (reason) return reason === 'document-mode'
        ? 'Image generation and editing are disabled after a document or plain-text page enters this turn.'
        : 'This QQ generation tool call belongs to an expired or cancelled message.';
    if (kind === 'image' && !route) return 'Image generation is not configured.';
    const names = kind === 'image' ? ['requestId', 'prompt'] : ['requestId', 'filename', 'content'];
    const optionalNames = kind === 'image' ? ['imageAttachmentId', 'referenceImage'] : [];
    if (!exactArguments(args, names, optionalNames) || !exactArguments(exec?.arguments, names, optionalNames)
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
        if (args.imageAttachmentId !== undefined && args.referenceImage !== undefined) {
            return 'Choose either an authorized QQ imageAttachmentId or one bundled referenceImage, not both.';
        }
        if (args.referenceImage !== undefined && !isDayuAssetImagePath(args.referenceImage)) {
            return 'referenceImage must be an absolute image file inside the bundled Dayu asset directory.';
        }
        if (args.imageAttachmentId !== undefined
            && !getGenerationImageAttachment(scope, args.requestId, args.imageAttachmentId)
            && !getGenerationRecentImageAttachment(scope, args.requestId, args.imageAttachmentId)) {
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

function publishCallResult(recordValue, promise, failedValue = result('failed')) {
    recordValue.promise = Promise.resolve(promise).then(
        (value) => {
            recordValue.pending = false;
            recordValue.value = value;
            return value;
        },
        () => {
            recordValue.pending = false;
            recordValue.value = failedValue;
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
        const noticeSignal = kind === 'image'
            ? signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000)
            : signal;
        await sender.sendNotice(makeTrustedSenderRequest(scope, request, kind), notice, noticeSignal);
    }
    catch (error) {
        logToolFailure(kind === 'image' ? GENERATE_IMAGE_TOOL : CREATE_MARKDOWN_TOOL, 'send-notice', error);
        // Safe user-visible output is already represented in the tool result.
    }
}

async function performImageTask({ scope, request, args, exec, service, quota, sender }) {
    const operationSignal = getGenerationRequestSignal(scope, exec.signal, 'image');
    const noticeSignal = exec.noticeSignal ?? operationSignal;
    const assertActive = () => !operationSignal.aborted && generationScopeFailure(scope, 'image') === undefined;
    const interrupted = async () => {
        if (generationScopeFailure(scope, 'image') || exec.callerSignal?.aborted) return result('expired');
        if (!exec.timeoutSignal?.aborted) return undefined;
        await sendOperationalNotice(sender, scope, request, notices.timeout, 'image', noticeSignal);
        return result('timeout');
    };
    const imageGrant = args.imageAttachmentId
        ? getGenerationImageAttachment(scope, args.requestId, args.imageAttachmentId)
            ?? getGenerationRecentImageAttachment(scope, args.requestId, args.imageAttachmentId)
        : undefined;
    const isRecentImage = imageGrant?.recent === true;
    let acquired;
    try {
        acquired = await quota.tryAcquire({ ownerId: request.ownerId, type: 'image' });
    }
    catch (error) {
        logToolFailure(GENERATE_IMAGE_TOOL, 'quota-acquire', error);
        acquired = undefined;
    }
    if (!acquired?.ok) {
        const status = acquired?.reason === 'busy' ? 'busy' : 'state';
        const notice = notices[status];
        await sendOperationalNotice(sender, scope, request, notice, 'image', noticeSignal);
        return result(status, notice);
    }
    try {
        const afterAcquire = await interrupted();
        if (afterAcquire) return afterAcquire;
        let imageBytes;
        if (imageGrant || args.referenceImage) {
            const maxBytes = imageGrant?.maxBytes ?? MAX_IMAGE_BYTES;
            const remote = Boolean(imageGrant && !imageGrant.localPath);
            if (imageGrant && imageGrant.size !== null && imageGrant.size > maxBytes) {
                const notice = notices['too-large'];
                await sendOperationalNotice(sender, scope, request, notice, 'image', noticeSignal);
                return result('too-large', notice);
            }
            try {
                const { loadChatImageBytes } = await import('./qqbot-chat-policy.mjs');
                if (operationSignal.aborted) throw operationSignal.reason ?? new Error('cancelled');
                if (remote) logDownloadDiagnostics(imageGrant, 'start');
                // QQ sources come only from request-scoped grants. The sole
                // local-path exception is a bundled Dayu image validated by
                // qqbot-assets.mjs; its bytes, never its path, reach the API.
                const source = args.referenceImage ?? (isRecentImage
                    ? `qqbot-image:${args.requestId}:${imageGrant.imageAttachmentId}`
                    : imageGrant.localPath ?? imageGrant.sourceUrl);
                imageBytes = Buffer.from(await loadChatImageBytes(source, maxBytes,
                    exec.sourceExecution ?? exec, operationSignal));
                if (operationSignal.aborted) throw operationSignal.reason ?? new Error('cancelled');
                if (remote) logDownloadDiagnostics(imageGrant, 'success');
            }
            catch (error) {
                logToolFailure(GENERATE_IMAGE_TOOL, 'download', error);
                if (remote) logDownloadDiagnostics(imageGrant, 'failed', error);
                if (generationScopeFailure(scope, 'image') || exec.callerSignal?.aborted) return result('expired');
                const status = imageFailureStatus(error, exec);
                const notice = notices[status];
                await sendOperationalNotice(sender, scope, request, notice, 'image', noticeSignal);
                return result(status, notice);
            }
            try {
                imageBytes = await normalizeEditImage(imageBytes, { signal: operationSignal, inspectImage });
            }
            catch (error) {
                logToolFailure(GENERATE_IMAGE_TOOL, 'normalize-image', error);
                if (generationScopeFailure(scope, 'image') || exec.callerSignal?.aborted) return result('expired');
                const status = imageFailureStatus(error, exec);
                const notice = notices[status];
                await sendOperationalNotice(sender, scope, request, notice, 'image', noticeSignal);
                return result(status, notice);
            }
        }
        const afterInput = await interrupted();
        if (afterInput) return afterInput;
        let reserved;
        try {
            reserved = await quota.reserve({ ownerId: request.ownerId, type: 'image' });
        }
        catch (error) {
            logToolFailure(GENERATE_IMAGE_TOOL, 'quota-reserve', error);
            reserved = undefined;
        }
        if (!reserved?.ok) {
            const status = reserved?.reason === 'quota' ? 'quota' : 'state';
            const notice = notices[status];
            await sendOperationalNotice(sender, scope, request, notice, 'image', noticeSignal);
            return result(status, notice);
        }
        const afterReserve = await interrupted();
        if (afterReserve) return afterReserve;
        let generated;
        try {
            generated = await service.generate({ prompt: args.prompt, imageBytes, signal: operationSignal, assertActive });
        }
        catch (error) {
            logToolFailure(GENERATE_IMAGE_TOOL, 'provider', error);
            if (generationScopeFailure(scope, 'image') || exec.callerSignal?.aborted) return result('expired');
            const status = imageFailureStatus(error, exec);
            const notice = notices[status];
            await sendOperationalNotice(sender, scope, request, notice, 'image', noticeSignal);
            return result(status, notice);
        }
        const afterGeneration = await interrupted();
        if (afterGeneration) return afterGeneration;
        const sendRequest = makeTrustedSenderRequest(scope, request, 'image');
        let sent;
        let sendThrew = false;
        try {
            sent = await sender.sendImage(sendRequest, generated, operationSignal);
        }
        catch (error) {
            sendThrew = true;
            logToolFailure(GENERATE_IMAGE_TOOL, 'send-image', error);
            sent = { sent: false, reason: 'failed' };
        }
        if (sent?.sent) return result('sent');
        // The message may already be visible in QQ; do not follow an unknown
        // acknowledgement with a contradictory failure notice or another send.
        if (sent?.reason === 'unknown') {
            logToolFailure(GENERATE_IMAGE_TOOL, 'send-image', new Error('send-unknown'));
            return result('unknown');
        }
        if (!sendThrew) logToolFailure(GENERATE_IMAGE_TOOL, 'send-image', new Error(`send-${sent?.reason === 'limit' ? 'limit' : sent?.reason === 'expired' ? 'expired' : 'failed'}`));
        const status = exec.timeoutSignal?.aborted ? 'timeout'
            : sent?.reason === 'limit' ? 'quota' : sent?.reason === 'expired' ? 'expired' : 'failed';
        const notice = notices[status];
        await sendOperationalNotice(sender, scope, request, notice, 'image', noticeSignal);
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
    if (!filename || !bytes) return markdownReceipt('invalid', notices.invalid, filename, bytes);
    if (generationScopeFailure(scope, 'markdown')) return markdownReceipt('expired', notices.expired, filename, bytes);
    let acquired;
    try {
        acquired = await quota.tryAcquire({ ownerId: request.ownerId, type: 'markdown' });
    }
    catch (error) {
        logToolFailure(CREATE_MARKDOWN_TOOL, 'quota-acquire', error);
        acquired = undefined;
    }
    if (!acquired?.ok) {
        const status = acquired?.reason === 'busy' ? 'busy' : 'state';
        const notice = notices[status];
        await sendOperationalNotice(sender, scope, request, notice, 'markdown', noticeSignal);
        return markdownReceipt(status, notice, filename, bytes);
    }
    try {
        let reserved;
        try {
            reserved = await quota.reserve({ ownerId: request.ownerId, type: 'markdown' });
        }
        catch (error) {
            logToolFailure(CREATE_MARKDOWN_TOOL, 'quota-reserve', error);
            reserved = undefined;
        }
        if (!reserved?.ok) {
            const status = reserved?.reason === 'quota' ? 'quota' : 'state';
            const notice = notices[status];
            await sendOperationalNotice(sender, scope, request, notice, 'markdown', noticeSignal);
            return markdownReceipt(status, notice, filename, bytes);
        }
        if (generationScopeFailure(scope, 'markdown')) return markdownReceipt('expired', notices.expired, filename, bytes);
        const signal = getGenerationRequestSignal(scope, exec.signal, 'markdown');
        const sendRequest = makeTrustedSenderRequest(scope, request, 'markdown');
        let fileResult;
        let fileSendThrew = false;
        try {
            fileResult = await sender.sendMarkdownFile(sendRequest, bytes, filename, signal);
        }
        catch (error) {
            fileSendThrew = true;
            logToolFailure(CREATE_MARKDOWN_TOOL, 'send-markdown', error);
            fileResult = { sent: false, reason: 'unknown' };
        }
        if (fileResult?.sent) return markdownReceipt('markdown', notices.markdown, filename, bytes, 'attachment');
        if (!fileSendThrew) logToolFailure(CREATE_MARKDOWN_TOOL, 'send-markdown', new Error(`send-${fileResult?.reason === 'limit' ? 'limit' : fileResult?.reason === 'expired' ? 'expired' : 'failed'}`));
        if (fileResult?.reason === 'unknown') {
            return markdownReceipt('unknown', notices.unknown, filename, bytes, 'unknown');
        }
        if (fileResult?.reason === 'expired' || generationScopeFailure(scope, 'markdown')) {
            return markdownReceipt('expired', notices.expired, filename, bytes);
        }
        let fallbackResult;
        let fallbackSendThrew = false;
        try {
            fallbackResult = await sender.sendMarkdownFallback(sendRequest, safeMarkdownFallbackText(content), signal);
        }
        catch (error) {
            fallbackSendThrew = true;
            logToolFailure(CREATE_MARKDOWN_TOOL, 'send-markdown', error);
            fallbackResult = { sent: false, reason: 'unknown' };
        }
        if (fallbackResult?.sent) return markdownReceipt('fallback', notices.text, filename, bytes, 'text', fallbackResult.truncated === true);
        if (fallbackResult?.reason === 'unknown') {
            return markdownReceipt('unknown', notices.unknown, filename, bytes, 'unknown');
        }
        if (!fallbackSendThrew) logToolFailure(CREATE_MARKDOWN_TOOL, 'send-markdown', new Error(`fallback-${fallbackResult?.reason === 'limit' ? 'limit' : fallbackResult?.reason === 'expired' ? 'expired' : 'failed'}`));
        const status = fallbackResult?.reason === 'limit' || fileResult?.reason === 'limit' ? 'quota'
            : fallbackResult?.reason === 'expired' ? 'expired' : 'failed';
        const notice = notices[status];
        await sendOperationalNotice(sender, scope, request, notice, 'markdown', noticeSignal);
        return markdownReceipt(status, notice, filename, bytes);
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
    const markdownFailure = (status) => markdownReceipt(status, notices[status], validMarkdownFilename(args.filename), markdownBuffer(args.content));
    if (!scope.callRecords?.has(exec.callId) && (scope.callRecords?.size ?? 0) >= MAX_GENERATION_REQUESTS * 2) {
        return Promise.resolve(kind === 'markdown' ? markdownFailure('busy') : result('busy', notices.busy));
    }
    const argsFingerprint = fingerprint(kind, args);
    const cached = getCallRecord(scope, kind, exec.callId, argsFingerprint);
    if (cached.mismatch) throw new Error('This tool-call id was already used with different arguments.');
    if (cached.promise) return cached.promise;
    if (cached.value) return Promise.resolve(cached.value);
    const alreadyUsed = kind === 'image' ? request.imageCalls.size > 0 : request.markdownCalls.size > 0;
    if (alreadyUsed) {
        cached.pending = false;
        cached.value = kind === 'markdown' ? markdownFailure('busy') : result('busy', notices.busy);
        if (kind === 'markdown') return publishCallResult(cached, Promise.resolve(cached.value), cached.value);
        const busyNotice = sendOperationalNotice(context.sender, scope, request, cached.value.notice, kind, exec.signal)
            .then(() => cached.value);
        return publishCallResult(cached, trackGenerationOperation(scope, busyNotice));
    }
    const requestCalls = kind === 'image' ? request.imageCalls : request.markdownCalls;
    requestCalls.set(exec.callId, argsFingerprint);
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(new Error('generation-timeout')),
        kind === 'image' ? context.imageOperationTimeoutMs : TOOL_TIMEOUT_MS);
    timeout.unref?.();
    const signals = [timeoutController.signal];
    if (exec.signal) signals.push(exec.signal);
    const operationExec = {
        callId: exec.callId,
        arguments: args,
        signal: AbortSignal.any(signals),
        callerSignal: exec.signal,
        noticeSignal: kind === 'image' ? exec.signal : AbortSignal.any(signals),
        timeoutSignal: timeoutController.signal,
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
    return publishCallResult(cached, tracked, kind === 'markdown' ? markdownFailure('failed') : result('failed'));
}

function imageToolSchema() {
    return {
        type: 'object',
        properties: {
            requestId: { type: 'string', minLength: 1, maxLength: 64, description: 'Opaque requestId from the original QQ message metadata.' },
            prompt: {
                type: 'string',
                minLength: 1,
                maxLength: MAX_PROMPT_CHARS,
                description: 'Final image prompt (at most 4000 characters). Before calling, use the matched original QQ request and its explicit quote only: clarify short or vague visual descriptions with concise subject, composition, lighting, palette, and style details; preserve every explicit subject, style, text, quantity, and prohibition, add no unrequested theme or style, leave detailed prompts or requests to keep wording unchanged as written, and for edits describe only requested changes while preserving everything else. Prompt polishing alone does not authorize image generation.',
            },
            imageAttachmentId: { type: 'string', minLength: 1, maxLength: 64, description: 'For editing a QQ image, use the plain opaque imageAttachmentId from images or recentImages on that same original request. Do not combine with referenceImage. If multiple recent images could be the base, ask which one before calling.' },
            referenceImage: { type: 'string', minLength: 1, maxLength: 512, description: 'Optional local bundled reference image path. When the user explicitly asks for a self-portrait, use only /opt/qqbot-assets/dayu/portrait.png; the six-view character-standard.png is for checking appearance, not generation input. Do not combine with imageAttachmentId; the server reads and uploads the image bytes.' },
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

function registerStatusTool(ctx, definition, markdownReceiptOutput = false) {
    const tools = ctx.get('tools');
    if (typeof tools?.register !== 'function') throw new Error('Generation tools require the pinned dsh tools.register API.');
    tools.register({
        ...definition,
        output: {
            schema: {
                type: 'object',
                properties: {
                    status: markdownReceiptOutput ? { type: 'string' } : { type: 'string',
                        enum: ['sent', 'failed', 'timeout', 'busy', 'quota', 'state', 'image-type', 'too-large', 'expired', 'unknown'] },
                    notice: { type: 'string' },
                    ...(markdownReceiptOutput ? {
                        filename: { type: 'string' },
                        utf8Bytes: { type: 'integer' },
                        delivery: { type: 'string', enum: ['attachment', 'text', 'unknown', 'none'] },
                        truncated: { type: 'boolean' },
                    } : {}),
                },
                required: markdownReceiptOutput
                    ? ['status', 'notice', 'filename', 'utf8Bytes', 'delivery', 'truncated']
                    : ['status', 'notice'],
                additionalProperties: false,
            },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
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
    const imageOperationTimeoutMs = options.imageOperationTimeoutMs ?? IMAGE_OPERATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(imageOperationTimeoutMs) || imageOperationTimeoutMs < 1
        || imageOperationTimeoutMs > IMAGE_OPERATION_TIMEOUT_MS) throw new Error('Invalid image operation timeout.');
    const context = {
        route,
        sender,
        quota,
        imageOperationTimeoutMs,
        imageService: route ? (options.imageService ?? createImageService({
            route,
            transport: options.imageTransport,
            resolvePublic: options.resolvePublic,
            fetchImpl: options.fetchImpl,
        })) : undefined,
    };
    // Original setting images are fixed local files. Their delivery remains
    // available when image generation has no API credentials or quota.
    registerAssetImageDeliveryTool(ctx, {
        sender,
        operationTimeoutMs: options.assetOperationTimeoutMs,
    });
    if (route) {
        registerStatusTool(ctx, {
            name: GENERATE_IMAGE_TOOL,
            description: 'Generate one image from a prompt, edit one PNG/JPEG/GIF/WebP image explicitly attached to or quoted in the same original QQ request, or use the bundled Dayu portrait image as a reference when the user explicitly asks for a self-portrait. Always pass the matching opaque requestId. For QQ editing, also pass that request’s imageAttachmentId; for a Dayu self-portrait, pass /opt/qqbot-assets/dayu/portrait.png as referenceImage. Never combine these image inputs. Only the dedicated Dayu asset directory accepts a local reference path; the server reads and uploads image bytes. Unsupported input encodings are converted to PNG automatically; animated inputs use the first frame. Use only when that original user clearly asks for image generation or editing. Before calling, improve short or vague visual descriptions into concise, concrete prompts using only that original request and its explicit QQ quote: add moderate subject, composition, lighting, palette, and style detail while preserving explicit subject, style, text, quantity, and prohibitions; do not impose a style or add an unrequested theme. Keep detailed prompts and requests to preserve wording unchanged as written. For edits, state only the requested changes and preserve everything else. Keep the final prompt at or below 4000 characters. Prompt polishing is not authorization to generate. Never use another batch member’s or historical personal information, or pass arbitrary paths, URLs, user ids, or group ids.',
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
            description: 'Create and send one UTF-8 Markdown attachment to the original QQ message that explicitly requested a Markdown file. Pass its opaque requestId, a safe filename, and the complete Markdown text. Use this tool receipt to determine whether the attachment or fallback text was delivered; do not inspect paths or repeat an operation reported successful or unknown. This tool does not read links, render HTML, run code, or access files.',
            parameters: markdownToolSchema(),
            async execute(args, exec) {
                return executeGeneration(args, exec, 'markdown', context);
            },
            timeoutMs: TOOL_TIMEOUT_MS,
        }, true);
    }
    return Object.freeze({ imageEnabled: Boolean(route), markdownEnabled, assetImagesEnabled: true, context });
}

export function validateGenerationToolCall(exec, route) {
    if (exec?.name === GENERATE_IMAGE_TOOL) return executionFailure(exec, exec.arguments, 'image', route);
    if (exec?.name === CREATE_MARKDOWN_TOOL) return executionFailure(exec, exec.arguments, 'markdown', route);
    return undefined;
}
