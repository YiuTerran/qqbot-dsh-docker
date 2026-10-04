const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_IMAGES = 8;
const DEFAULT_MAX_GROUPS = 200;
const IDENTITY = /^[A-Za-z0-9_-]{1,128}$/u;
const APP_ID = /^[0-9]{1,20}$/u;
const IMAGE_EXTENSION = /\.(?:apng|gif|jpe?g|png|webp)$/iu;
const SLASH_COMMAND = /^\s*\/[A-Za-z0-9_-]+(?:@[A-Za-z0-9_-]+)?(?:\s|$)/u;
const NEW_COMMAND = /^\s*\/new(?:@[A-Za-z0-9_-]+)?(?:\s|$)/iu;

function canonicalImageUrl(value) {
    if (typeof value !== 'string' || value.length > 8192) return undefined;
    try {
        const url = new URL(value.startsWith('//') ? `https:${value}` : value);
        if (url.protocol !== 'https:' || url.username || url.password) return undefined;
        url.hash = '';
        return url.href;
    }
    catch {
        return undefined;
    }
}

function safeFilename(value) {
    if (typeof value !== 'string') return '';
    return value.split(/[\\/]/u).at(-1)
        .replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').trim().slice(0, 120);
}

function imageAttachment(value) {
    if (!value || typeof value !== 'object') return undefined;
    const filename = safeFilename(value.filename);
    const type = typeof (value.content_type ?? value.contentType) === 'string'
        ? (value.content_type ?? value.contentType).split(';', 1)[0].trim().toLowerCase() : '';
    const extensionFallback = ['', 'file', 'application/octet-stream'].includes(type) && IMAGE_EXTENSION.test(filename);
    if (!(type === 'image' || type.startsWith('image/') || extensionFallback)) return undefined;
    const url = canonicalImageUrl(value.url);
    if (!url) return undefined;
    const size = Number(value.size);
    return Object.freeze({
        url,
        filename,
        content_type: (extensionFallback ? 'image' : type).slice(0, 128),
        ...(Number.isSafeInteger(size) && size >= 0 ? { size } : {}),
    });
}

function selfMentionPattern(appId) {
    const escaped = appId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(`<@!?${escaped}>|<qqbot-at-user\\s+id=["']${escaped}["']\\s*\\/>`, 'gu');
}

function visibleText(message, appId) {
    const content = typeof message?.content === 'string' ? message.content : '';
    if (typeof appId !== 'string' || !APP_ID.test(appId)) return content.trim();
    return content.replace(selfMentionPattern(appId), '').trim();
}

function identityFor(message, appId) {
    if (typeof appId !== 'string' || !APP_ID.test(appId) || !message
        || typeof message.senderId !== 'string' || !IDENTITY.test(message.senderId)) return undefined;
    if (message.kind === 'group' && typeof message.groupOpenid === 'string' && IDENTITY.test(message.groupOpenid)) {
        return JSON.stringify([appId, 'group', message.groupOpenid, message.senderId]);
    }
    if (message.kind === 'c2c') {
        return JSON.stringify([appId, 'c2c', message.senderId, message.senderId]);
    }
    return undefined;
}

function isImageOnly(message, appId) {
    const text = visibleText(message, appId);
    if (text) return false;
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    if (attachments.length === 0) return false;
    // Any non-image attachment (including voice and documents) keeps the
    // message on the regular middleware path.
    return attachments.every((attachment) => {
        const declared = attachment?.content_type ?? attachment?.contentType;
        const type = typeof declared === 'string' ? declared.split(';', 1)[0].trim().toLowerCase() : '';
        const filename = safeFilename(attachment?.filename);
        return type === 'image' || type.startsWith('image/')
            || (['', 'file', 'application/octet-stream'].includes(type) && IMAGE_EXTENSION.test(filename));
    });
}

function messageId(message) {
    const value = message?.messageId ?? message?.msgId ?? message?.id;
    return typeof value === 'string' && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)
        ? value : undefined;
}

export function createPendingImagePromptCache(options = {}) {
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const maxImagesPerGroup = options.maxImagesPerGroup ?? DEFAULT_MAX_IMAGES;
    const maxGroups = options.maxGroups ?? DEFAULT_MAX_GROUPS;
    const now = options.now ?? Date.now;
    const schedule = options.setTimeout ?? setTimeout;
    const unschedule = options.clearTimeout ?? clearTimeout;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new TypeError('ttlMs must be a positive integer');
    if (!Number.isSafeInteger(maxImagesPerGroup) || maxImagesPerGroup < 1) throw new TypeError('maxImagesPerGroup must be a positive integer');
    if (!Number.isSafeInteger(maxGroups) || maxGroups < 1) throw new TypeError('maxGroups must be a positive integer');

    const records = new Map();

    function remove(key, expected) {
        const record = records.get(key);
        if (!record || (expected && expected !== record)) return false;
        records.delete(key);
        if (record.timer) unschedule(record.timer);
        return true;
    }

    function pruneExpired() {
        const time = now();
        for (const [key, record] of records) {
            if (time - record.lastImageAt >= ttlMs) remove(key, record);
        }
    }

    function expireLater(key, record) {
        if (record.timer) unschedule(record.timer);
        const expire = () => {
            const remaining = ttlMs - (now() - record.lastImageAt);
            if (remaining > 0) {
                record.timer = schedule(expire, remaining);
                record.timer?.unref?.();
                return;
            }
            remove(key, record);
        };
        record.timer = schedule(expire, ttlMs);
        record.timer?.unref?.();
    }

    function capture(message, appId) {
        if (!isImageOnly(message, appId)) return false;
        const key = identityFor(message, appId);
        if (!key) return false;
        const attachments = (Array.isArray(message.attachments) ? message.attachments : [])
            .map(imageAttachment).filter(Boolean);
        if (attachments.length === 0) return false;
        const time = now();
        pruneExpired();
        let record = records.get(key);
        if (record && time - record.lastImageAt >= ttlMs) {
            remove(key, record);
            record = undefined;
        }
        if (record) records.delete(key);
        else record = { images: [], sourceMessageIds: [], timer: undefined };
        const sourceId = messageId(message);
        if (sourceId && !record.sourceMessageIds.includes(sourceId)) record.sourceMessageIds.push(sourceId);
        record.sourceMessageIds = record.sourceMessageIds.slice(-maxImagesPerGroup);
        record.images = [...record.images, ...attachments]
            .slice(-maxImagesPerGroup);
        record.lastImageAt = time;
        records.set(key, record);
        expireLater(key, record);
        while (records.size > maxGroups) remove(records.keys().next().value);
        return true;
    }

    function consume(message, appId, state = {}) {
        const key = identityFor(message, appId);
        const text = visibleText(message, appId);
        if (!key || !text || SLASH_COMMAND.test(text)) return undefined;
        if (message.kind === 'group' && state?.mention?.wasMentioned !== true) return undefined;
        pruneExpired();
        const record = records.get(key);
        if (!record) return undefined;
        // Remove synchronously before returning attachments so overlapping
        // inbound events cannot consume the same pending set twice.
        remove(key, record);
        return Object.freeze({
            attachments: Object.freeze(record.images.map((attachment) => Object.freeze({
                ...attachment,
                qqbotDeferredPromptSource: 'previous-image-only-message',
            }))),
            sourceMessageIds: Object.freeze([...record.sourceMessageIds]),
        });
    }

    function clearForMessage(message, appId) {
        const identity = identityFor(message, appId);
        if (!identity) return false;
        const parsed = JSON.parse(identity);
        // /new resets the conversation peer, so clear all waiting senders in
        // the same app and peer, regardless of who issued the command.
        const prefix = JSON.stringify(parsed.slice(0, 3)).slice(0, -1) + ',';
        let cleared = false;
        for (const key of [...records.keys()]) {
            if (key.startsWith(prefix)) cleared = remove(key) || cleared;
        }
        return cleared;
    }

    function size() {
        pruneExpired();
        return records.size;
    }

    function inspect(message, appId) {
        const key = identityFor(message, appId);
        if (!key) return undefined;
        pruneExpired();
        const record = records.get(key);
        return record ? Object.freeze({ count: record.images.length, lastImageAt: record.lastImageAt }) : undefined;
    }

    function clear() {
        for (const key of [...records.keys()]) remove(key);
    }

    return Object.freeze({ capture, consume, clearForMessage, clear, inspect, size });
}

export const pendingImagePrompts = createPendingImagePromptCache();

/** Render only the per-original-request image association, never cached metadata. */
export function renderDeferredImagePromptMetadata(requests) {
    if (!Array.isArray(requests)) return '';
    const lines = [];
    requests.slice(0, 20).forEach((request, index) => {
        const count = request?.deferredImagePrompt?.count;
        if (!Number.isSafeInteger(count) || count < 1 || count > DEFAULT_MAX_IMAGES) return;
        lines.push(`- Original request ${index + 1} includes ${count} image(s) from one or more earlier image-only messages by this sender in this chat within the last five minutes. Pair these images with this request's current text; the earlier image messages contained no prompt.`);
    });
    if (lines.length === 0) return '';
    return `[Image prompt association]\n${lines.join('\n')}`;
}

/** Capture unprompted images before the group mention gate and stop silently. */
export function createPendingImageCaptureMiddleware({ appId, cache = pendingImagePrompts } = {}) {
    if (!cache || typeof cache.capture !== 'function') throw new TypeError('pending image cache is required');
    return (ctx, next) => {
        if (ctx?.signal?.aborted) return next();
        if (cache.capture(ctx?.message, appId)) {
            if (!ctx.state || typeof ctx.state !== 'object') ctx.state = {};
            ctx.state.qqbotPendingImageCaptured = true;
            try { ctx.stop?.('qqbot:pending-image-prompt'); } catch { /* returning without next still stops the chain */ }
            return;
        }
        return next();
    };
}

/** Attach queued images to the next eligible prompt before merge snapshots are captured. */
export function createPendingImagePromptMiddleware({ appId, cache = pendingImagePrompts } = {}) {
    if (!cache || typeof cache.consume !== 'function') throw new TypeError('pending image cache is required');
    return (ctx, next) => {
        if (ctx?.signal?.aborted) return next();
        const pending = cache.consume(ctx?.message, appId, ctx?.state);
        if (pending) {
            const message = ctx.message;
            message.attachments = [
                ...(Array.isArray(message.attachments) ? message.attachments : []),
                ...pending.attachments,
            ];
            if (!ctx.state || typeof ctx.state !== 'object') ctx.state = {};
            ctx.state.qqbotDeferredImagePrompt = Object.freeze({
                count: pending.attachments.length,
                sourceMessageIds: pending.sourceMessageIds,
            });
        }
        return next();
    };
}

/** Clear a peer's queued images when /new is observed, then let slash handling run. */
export function createPendingImageNewCommandCleanup({ appId, cache = pendingImagePrompts } = {}) {
    if (!cache || typeof cache.clearForMessage !== 'function') throw new TypeError('pending image cache is required');
    return (ctx, next) => {
        if (identityFor(ctx?.message, appId) && NEW_COMMAND.test(visibleText(ctx.message, appId))) {
            cache.clearForMessage(ctx.message, appId);
        }
        return next();
    };
}
