import { HttpFetchProvider } from '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-fetch-http/lib/index.js';

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
    async requestOnce(url, signal) {
        const headers = {
            'user-agent': this.limits.userAgent,
            accept: this.accept ?? 'text/html,application/xhtml+xml',
        };
        const addresses = await this.resolveAddresses(url.hostname, signal);
        const { Agent, fetch } = await import('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/undici/index.js');
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
        const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const disposition = response.headers.get('content-disposition') || '';
        if (!['text/html', 'application/xhtml+xml'].includes(mime) || /^\s*attachment\b/i.test(disposition)) {
            await response.body?.cancel();
            throw new Error('Only HTML webpages can be read; file downloads are disabled.');
        }
        // No filesystem write occurs: the bounded HTML stays in memory and
        // the stock web_fetch tool converts it to text without running scripts.
        return super.readBody(response, finalUrl, signal);
    }
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
