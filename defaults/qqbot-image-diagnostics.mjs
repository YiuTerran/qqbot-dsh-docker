import { createHmac, randomBytes } from 'node:crypto';

// Correlation lasts only for this process; never log identifiers or signed URLs.
const salt = randomBytes(32);
export const imageDiagnosticsEnabled = () => process.env.QQBOT_IMAGE_DEBUG === 'true';
const list = (value) => Array.isArray(value) ? value : [];
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const token = (value) => createHmac('sha256', salt).update(JSON.stringify(value)).digest('hex').slice(0, 16);
const trace = (target) => target ? token([target.scope, target.targetId, target.msgId]) : undefined;

function emit(event, fields) {
    // Fixed fields only. Diagnostics must not interrupt normal message handling.
    try { console.info('[qqbot-image-debug] ' + JSON.stringify({ event, ...fields })); } catch {}
}

function attachment(value) {
    const a = value && typeof value === 'object' ? value : {};
    const declared = a.content_type ?? a.contentType;
    const type = typeof declared === 'string' ? declared.trim().toLowerCase() : '';
    const mime = ['', 'image', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'file', 'application/octet-stream'].includes(type) ? type : 'other';
    let urlKind = 'missing';
    let asset;
    if (typeof a.url === 'string' && a.url.length > 0) {
        urlKind = 'invalid';
        if (a.url.length <= 8192) {
            try {
                const url = new URL(a.url.startsWith('//') ? `https:${a.url}` : a.url);
                url.hash = '';
                urlKind = url.username || url.password ? 'credentials' : url.protocol === 'https:' ? 'https' : 'other_protocol';
                asset = token(url.href);
            } catch {}
        }
    }
    return { asset, mime, urlKind, hasFilename: typeof a.filename === 'string' && a.filename.length > 0 };
}

function attachments(value) {
    const items = list(value);
    return { count: items.length, items: items.slice(0, 16).map(attachment), truncated: items.length > 16 };
}

export function logQuoteDiagnostics(ctx, cachedEntry) {
    if (!imageDiagnosticsEnabled()) return;
    const msg = ctx.message ?? {};
    const peer = msg.kind === 'group' ? msg.groupOpenid : msg.senderId;
    const key = (value) => value ? token([msg.kind, peer, value]) : undefined;
    const elements = list(msg.msgElements);
    const rawElements = list(msg.raw?.msg_elements);
    const summarizeElements = (items) => items.slice(0, 16).map((el) => ({
        hasText: typeof el?.content === 'string' && el.content.length > 0,
        attachments: attachments(el?.attachments),
    }));
    emit('quote', {
        trace: trace(msg.replyTarget ?? ctx.replyTarget),
        cacheKey: key(msg.msgIdx ?? msg.messageId), refKey: key(msg.refMsgIdx),
        scope: ['group', 'c2c'].includes(msg.kind) ? msg.kind : 'other',
        hasReference: Boolean(msg.refMsgIdx), cacheHit: Boolean(cachedEntry),
        current: attachments(msg.attachments),
        elementCount: elements.length, elements: summarizeElements(elements),
        rawElementCount: rawElements.length, rawElements: summarizeElements(rawElements),
        source: ['store', 'msg_elements', 'none'].includes(ctx.state?.quote?.source) ? ctx.state.quote.source : 'none',
        resolved: attachments(ctx.state?.quote?.attachments),
    });
}

function failure(error) {
    const message = typeof error?.message === 'string' ? error.message : '';
    const http = message.match(/HTTP(?:\s+error)?\s*[:=]?\s*([1-5]\d{2})\b/i);
    if (http) return { reason: 'http_error', httpStatus: Number(http[1]) };
    if (/exceed|too large/i.test(message)) return { reason: 'too_large' };
    if (/bytes do not match|signature/i.test(message)) return { reason: 'invalid_image_bytes' };
    if (/inline PNG|content.type|mime/i.test(message)) return { reason: 'response_type_rejected' };
    if (/redirect/i.test(message)) return { reason: 'redirect_rejected' };
    if (/non-public|private|reserved|SSRF/i.test(message)) return { reason: 'non_public_address' };
    if (/DNS|ENOTFOUND|EAI_AGAIN/i.test(message + ' ' + error?.cause?.code)) return { reason: 'dns_error' };
    if (/^(Only HTTPS allowed:|Credentials in QQ image URLs|Invalid URL)/i.test(message)) return { reason: 'url_rejected' };
    if (/timeout|timed out/i.test(message) || error?.name === 'TimeoutError') return { reason: 'timeout' };
    if (error?.name === 'AbortError') return { reason: 'aborted' };
    return { reason: 'other_error' };
}

export function logDownloadDiagnostics(value, status, error) {
    if (!imageDiagnosticsEnabled()) return;
    if (!['start', 'success', 'failed', 'too_large', 'media_disabled', 'metadata_skipped', 'processor_failed'].includes(status)) return;
    emit('download', { ...attachment(value), status, ...(error ? failure(error) : {}) });
}

export function logDownloadSelection(values, media) {
    if (!imageDiagnosticsEnabled()) return;
    for (const value of list(values).slice(0, 16)) {
        const type = value?.content_type;
        if (!media?.enabled) logDownloadDiagnostics(value, 'media_disabled');
        else if (!(type === 'image' || typeof type === 'string' && type.startsWith('image/')) || !value?.url) {
            logDownloadDiagnostics(value, 'metadata_skipped');
        }
    }
}

export function logGenerationDiagnostics(source, normalized, stats) {
    if (!imageDiagnosticsEnabled()) return;
    emit('generation', {
        trace: trace(source?.replyTarget), validRequest: Boolean(normalized),
        current: attachments(source?.currentAttachments), quoted: attachments(source?.quotedAttachments),
        normalizedCurrent: list(normalized?.currentAttachments).length,
        normalizedQuoted: list(normalized?.quotedAttachments).length,
        unsupportedType: count(stats?.unsupportedType), missingDownload: count(stats?.missingDownload),
        images: count(stats?.images),
    });
}

export function logGenerationBatch(sources, downloads) {
    if (!imageDiagnosticsEnabled()) return;
    emit('generation_batch', { requests: list(sources).length, downloads: list(downloads).length });
}
