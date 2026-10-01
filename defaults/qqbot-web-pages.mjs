import { HttpFetchProvider } from '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-fetch-http/lib/index.js';
import {
    activateCurrentDocumentMode,
    assertProviderRequestUrl,
    authorizeDocumentProviderUrl,
    authorizeTurnProviderUrl,
    getDocumentExecutionContext,
    getTurnRequestSignal,
    runWithProviderAuthorization,
} from './qqbot-document-scope.mjs';
import {
    decodeTextDocumentBytes,
    normalizeTextMediaType,
    resolveTextDocumentType,
} from './qqbot-text-documents.mjs';

const MAX_CURRENT_IMAGE_BYTES = 10 * 1024 * 1024;
const CURRENT_IMAGE_TIMEOUT_MS = 120000;
const CURRENT_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function sniffCurrentImageMediaType(bytes) {
    if (bytes.length < 12) return null;
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
    return null;
}

/**
 * Return only the already validated DNS answers to Undici. The URL hostname
 * remains intact for Host and TLS SNI; this callback deliberately performs no
 * second DNS lookup.
 */
function createPinnedLookup(addresses) {
    return (hostname, options, callback) => {
        const family = typeof options.family === 'number'
            ? options.family
            : options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : 0;
        const eligible = family === 0 ? addresses : addresses.filter((address) => address.family === family);
        if (eligible.length === 0) {
            const error = Object.assign(new Error(`no validated address for ${hostname} in family ${family}`), {
                code: 'ENOTFOUND',
                hostname,
            });
            callback(error, options.all === true ? [] : '', family);
            return;
        }
        if (options.all === true) {
            callback(null, eligible.map((address) => ({ ...address })));
            return;
        }
        const selected = eligible[0];
        callback(null, selected.address, selected.family);
    };
}

/**
 * Public HTTP(S) transport with one validated DNS answer set pinned into an
 * isolated Undici dispatcher for each request.
 *
 * We intentionally do not call dsh's proxy routing here. Model-selected URLs
 * and QQ attachment URLs must connect to the address set validated locally;
 * an HTTP proxy would resolve the origin a second time and bypass that pin.
 */
export class PublicHttpProvider extends HttpFetchProvider {
    async fetch(request, signal) {
        const context = getDocumentExecutionContext();
        const authorization = context?.documentCapability
            ? authorizeDocumentProviderUrl(request?.url, context.documentCapability)
            : authorizeTurnProviderUrl(request?.url);
        const scopedSignal = context?.scope ? getTurnRequestSignal(context.scope, signal) : signal;
        return runWithProviderAuthorization(authorization, () => super.fetch(request, scopedSignal));
    }

    async requestOnce(url, signal) {
        assertProviderRequestUrl(url);
        const headers = {
            'user-agent': this.limits.userAgent,
            accept: this.accept ?? 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8,application/*+json;q=0.7,application/yaml,application/x-yaml,application/xml,application/*+xml;q=0.6',
        };
        const addresses = await this.resolveAddresses(url.hostname, signal);
        // The turn may end or enter restricted document mode while DNS resolves.
        // Recheck the captured scope immediately before opening the connection.
        assertProviderRequestUrl(url);
        const { Agent, fetch } = await import('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/undici/index.js');
        assertProviderRequestUrl(url);
        if (signal?.aborted) throw signal.reason ?? new Error('HTTP request was aborted.');
        const dispatcher = new Agent({
            autoSelectFamily: true,
            connect: { lookup: createPinnedLookup(addresses) },
        });
        try {
            return {
                response: await fetch(url, {
                    method: 'GET',
                    redirect: 'manual',
                    headers,
                    signal,
                    dispatcher,
                }),
                close: async () => {
                    await dispatcher.close();
                },
            };
        }
        catch (error) {
            await dispatcher.close();
            throw error;
        }
    }
}

/** Resolve once through the same public-address validator used by page reads. */
export async function resolvePublicHttpAddresses(hostname, signal) {
    const provider = new PublicHttpProvider({
        timeoutMs: 120000,
        maxResponseBytes: 1,
        maxBodyChars: 1,
        maxRedirects: 0,
        userAgent: 'qqbot-dsh (bounded image transport)',
    });
    return provider.resolveAddresses(hostname, signal);
}

// Reuse dsh's public-IP validation, DNS connection pinning, bounded reads,
// cancellation, and same-origin redirect policy; add a webpage-only boundary.
export class WebPageProvider extends PublicHttpProvider {
    id = 'qqbot-pages';

    constructor() {
        super({
            timeoutMs: 30000,
            maxResponseBytes: 2 * 1024 * 1024,
            maxBodyChars: 100000,
            maxRedirects: 3,
            userAgent: 'qqbot-dsh (webpage reader)',
        });
    }

    async readBody(response, finalUrl, signal) {
        const declaredContentType = response.headers.get('content-type') || '';
        const mediaType = normalizeTextMediaType(declaredContentType);
        const textType = resolveTextDocumentType(declaredContentType, '', { allowExtensionFallback: false });
        if (!textType.accepted) {
            await response.body?.cancel();
            throw new Error('Only validated text webpages can be read.');
        }
        // Attachment disposition does not save a file. The response remains
        // in memory and is accepted only after MIME, signature, charset, and
        // decoded-control validation all succeed.
        const { bytes, truncatedByBytes } = await this.readCapped(response, signal);
        const decoded = decodeTextDocumentBytes(bytes, declaredContentType, { truncatedByBytes });
        const truncatedByChars = decoded.text.length > this.limits.maxBodyChars;
        let content = truncatedByChars ? decoded.text.slice(0, this.limits.maxBodyChars) : decoded.text;
        if (content.length > 0 && /[\uD800-\uDBFF]/u.test(content.at(-1))) content = content.slice(0, -1);
        const html = mediaType === 'text/html' || mediaType === 'application/xhtml+xml';
        if (!html) activateCurrentDocumentMode();
        return {
            url: finalUrl.toString(),
            statusCode: response.status,
            body: { kind: html ? 'html' : 'text', content },
            truncated: truncatedByBytes || truncatedByChars,
        };
    }
}

const MAX_QQ_DOCUMENT_BYTES = 512 * 1024;
const MAX_QQ_DOCUMENT_TIMEOUT_MS = 30000;

class QQTextDocumentProvider extends PublicHttpProvider {
    accept = 'text/*,application/xhtml+xml,application/json,application/*+json,application/yaml,application/x-yaml,application/xml,application/*+xml';

    constructor(filename) {
        super({
            timeoutMs: MAX_QQ_DOCUMENT_TIMEOUT_MS,
            maxResponseBytes: MAX_QQ_DOCUMENT_BYTES,
            maxBodyChars: 50000,
            maxRedirects: 0,
            userAgent: 'qqbot-dsh (QQ text document)',
        });
        this.filename = filename;
    }

    async readBody(response, _finalUrl, signal) {
        if (response.status < 200 || response.status >= 300) {
            await response.body?.cancel();
            throw new Error('QQ document request failed.');
        }
        const declaredContentType = response.headers.get('content-type') || '';
        const type = resolveTextDocumentType(declaredContentType, this.filename, { allowExtensionFallback: true });
        if (!type.accepted) {
            await response.body?.cancel();
            throw Object.assign(new Error('QQ attachment response is not an allowed text document.'), { code: 'TEXT_UNSUPPORTED_TYPE' });
        }
        const { bytes, truncatedByBytes } = await this.readCapped(response, signal);
        if (truncatedByBytes) throw Object.assign(new Error('QQ document exceeds the 512 KiB limit.'), { code: 'QQ_DOCUMENT_TOO_LARGE' });
        const decoded = decodeTextDocumentBytes(bytes, declaredContentType, { truncatedByBytes: false });
        return {
            text: decoded.text,
            contentType: type.contentType,
            size: bytes.length,
            truncated: false,
        };
    }
}

/** Fetch one registered QQ document in memory with no redirect or URL exposure. */
export async function downloadQQTextDocument(url, filename, attachmentId, signal) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
        throw new Error('QQ document source is not an anonymous HTTPS URL.');
    }
    const provider = new QQTextDocumentProvider(filename);
    return provider.fetch({ url: parsed.href, attachmentId }, signal);
}

class CurrentQQImageProvider extends PublicHttpProvider {
    accept = 'image/png,image/jpeg,image/gif,image/webp';

    constructor(maxBytes) {
        super({
            timeoutMs: CURRENT_IMAGE_TIMEOUT_MS,
            maxResponseBytes: maxBytes,
            maxBodyChars: 1,
            maxRedirects: 0,
            userAgent: 'qqbot-dsh (current QQ image)',
        });
    }

    async readBody(response, _finalUrl, signal) {
        const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const disposition = response.headers.get('content-disposition') || '';
        if (response.status < 200 || response.status >= 300) {
            await response.body?.cancel();
            throw new Error(`QQ image download failed (HTTP ${response.status})`);
        }
        if (!CURRENT_IMAGE_MIME_TYPES.has(mime) || /^\s*attachment\b/i.test(disposition)) {
            await response.body?.cancel();
            throw new Error('Only inline PNG/JPEG/GIF/WEBP QQ images are accepted.');
        }
        const { bytes, truncatedByBytes } = await this.readCapped(response, signal);
        if (truncatedByBytes) {
            throw new Error(`QQ image download exceeds ${this.limits.maxResponseBytes} bytes`);
        }
        const detectedMime = sniffCurrentImageMediaType(bytes);
        if (detectedMime === null || detectedMime !== mime) {
            throw new Error('QQ image bytes do not match the declared PNG/JPEG/GIF/WEBP type.');
        }
        return Buffer.from(bytes);
    }
}

/** Download a bounded public HTTPS image into memory without writing it to disk. */
export async function downloadCurrentQQImage(url, maxBytes, signal) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
        throw new Error('QQ image size limit must be a positive finite number');
    }
    const limit = Math.min(Math.floor(maxBytes), MAX_CURRENT_IMAGE_BYTES);
    if (limit <= 0) {
        throw new Error('QQ image size limit must be at least one byte');
    }
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
        throw new Error(`Only HTTPS allowed: ${parsed.protocol}`);
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
        throw new Error('Credentials in QQ image URLs are not allowed');
    }
    if (signal?.aborted) throw signal.reason ?? new Error('QQ image download was aborted');
    const provider = new CurrentQQImageProvider(limit);
    return provider.fetch({ url: parsed.href }, signal);
}
