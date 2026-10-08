import { normalizeOwnMentionText } from './qqbot-mention-text.mjs';

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_IMAGES = 8;
const DEFAULT_MAX_GROUPS = 200;
const IDENTITY = /^[A-Za-z0-9_-]{1,128}$/u;
const APP_ID = /^[0-9]{1,20}$/u;
const IMAGE_EXTENSION = /\.(?:apng|gif|jpe?g|png|webp)$/iu;
const SLASH_COMMAND = /^\s*\/[A-Za-z0-9_-]+(?:@[A-Za-z0-9_-]+)?(?:\s|$)/u;
const NEW_COMMAND = /^\s*\/new(?:@[A-Za-z0-9_-]+)?(?:\s|$)/iu;

// Snapshot identity is an internal capability. Public attachment metadata is
// useful to the normal request pipeline, while this WeakMap keeps its source,
// expiry and one-request claim state out of model-visible data.
const snapshotRecords = new WeakMap();

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

function attachmentType(value) {
    const declared = value?.content_type ?? value?.contentType;
    return typeof declared === 'string' ? declared.split(';', 1)[0].trim().toLowerCase() : '';
}

function isDeclaredImageAttachment(value) {
    if (!value || typeof value !== 'object') return false;
    const type = attachmentType(value);
    const filename = safeFilename(value.filename);
    const extensionFallback = ['', 'file', 'application/octet-stream'].includes(type) && IMAGE_EXTENSION.test(filename);
    return type === 'image' || type.startsWith('image/') || extensionFallback;
}

function imageAttachment(value) {
    if (!isDeclaredImageAttachment(value)) return undefined;
    const filename = safeFilename(value.filename);
    const type = attachmentType(value);
    const extensionFallback = ['', 'file', 'application/octet-stream'].includes(type) && IMAGE_EXTENSION.test(filename);
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
    return new RegExp(`<qqbot-at-user\\s+id=["']${escaped}["']\\s*\\/>`, 'gu');
}

function visibleText(message, appId) {
    const content = typeof message?.content === 'string' ? message.content : '';
    const normalized = normalizeOwnMentionText(content, message, appId);
    if (typeof appId !== 'string' || !APP_ID.test(appId)) return normalized.trim();
    return normalized.replace(selfMentionPattern(appId), '').trim();
}

function identityFor(message, appId) {
    if (typeof appId !== 'string' || !APP_ID.test(appId) || !message
        || typeof message.senderId !== 'string' || !IDENTITY.test(message.senderId)) return undefined;
    if (message.kind === 'group' && typeof message.groupOpenid === 'string' && IDENTITY.test(message.groupOpenid)) {
        return {
            key: JSON.stringify([appId, 'group', message.groupOpenid, message.senderId]),
            peerKey: JSON.stringify([appId, 'group', message.groupOpenid]),
        };
    }
    if (message.kind === 'c2c') {
        return {
            key: JSON.stringify([appId, 'c2c', message.senderId, message.senderId]),
            peerKey: JSON.stringify([appId, 'c2c', message.senderId]),
        };
    }
    return undefined;
}

function isPureImageMessage(message, appId) {
    if (visibleText(message, appId)) return false;
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    return attachments.length > 0 && attachments.every(isDeclaredImageAttachment);
}

function messageId(message) {
    const value = message?.messageId ?? message?.msgId ?? message?.id;
    return typeof value === 'string' && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)
        ? value : undefined;
}

/** True only for an object minted by the private recent-image snapshot cache. */
export function isRecentImageSnapshot(snapshot) {
    return snapshot !== null && (typeof snapshot === 'object' || typeof snapshot === 'function')
        && snapshotRecords.has(snapshot);
}

/** Check expiry, reset revocation, and whether another request already claimed this batch. */
export function recentImageSnapshotAvailable(snapshot) {
    if (!isRecentImageSnapshot(snapshot)) return false;
    const metadata = snapshotRecords.get(snapshot);
    const { record } = metadata;
    if (metadata.released || record.invalidated || record.now() >= record.expiresAt) return false;
    return !record.claimedSnapshot || record.claimedSnapshot === snapshot;
}

/**
 * Claim one frozen snapshot for one original request. The same capability can
 * be checked repeatedly by that request, while sibling snapshots fail.
 */
export function claimRecentImageSnapshot(snapshot) {
    if (!isRecentImageSnapshot(snapshot)) return false;
    const metadata = snapshotRecords.get(snapshot);
    const { record } = metadata;
    if (metadata.released || record.invalidated || record.now() >= record.expiresAt) return false;
    if (record.claimedSnapshot) return record.claimedSnapshot === snapshot;
    record.claimedSnapshot = snapshot;
    if (record.pendingByKey.get(record.key) === record) record.pendingByKey.delete(record.key);
    record.status = 'claimed';
    return true;
}

/** End the one-request scope without ever restoring a claimed batch to pending. */
export function releaseRecentImageSnapshot(snapshot) {
    if (!isRecentImageSnapshot(snapshot)) return false;
    const metadata = snapshotRecords.get(snapshot);
    if (metadata.released) return false;
    metadata.released = true;
    const { record } = metadata;
    record.snapshotCount = Math.max(0, record.snapshotCount - 1);
    if (record.snapshotCount === 0 && record.pendingByKey.get(record.key) !== record) {
        record.invalidated = true;
        record.status = 'released';
        record.stopTimer();
        record.liveRecords.delete(record.id);
        return true;
    }
    return true;
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

    // pending records are eligible for new snapshots. liveRecords also retains
    // superseded, evicted, or claimed batches that already have queued snapshots.
    const pending = new Map();
    const liveRecords = new Map();
    let nextRecordId = 0;

    function stopTimer(record) {
        if (record.timer) unschedule(record.timer);
        record.timer = undefined;
    }

    function invalidate(record, status) {
        if (!record || record.invalidated) return false;
        record.invalidated = true;
        record.status = status;
        if (pending.get(record.key) === record) pending.delete(record.key);
        liveRecords.delete(record.id);
        stopTimer(record);
        return true;
    }

    function expireLater(record) {
        stopTimer(record);
        const expire = () => {
            const remaining = record.expiresAt - now();
            if (remaining > 0 && !record.invalidated) {
                record.timer = schedule(expire, remaining);
                record.timer?.unref?.();
                return;
            }
            invalidate(record, 'expired');
        };
        record.timer = schedule(expire, Math.max(0, record.expiresAt - now()));
        record.timer?.unref?.();
    }

    function pruneExpired() {
        const time = now();
        for (const record of liveRecords.values()) {
            if (time >= record.expiresAt) invalidate(record, 'expired');
        }
    }

    function preserveOrDiscard(record, status) {
        if (!record) return;
        if (pending.get(record.key) === record) pending.delete(record.key);
        record.status = status;
        // A queued snapshot owns this old batch until its original expiry. If no
        // request has a snapshot, release it now and cancel its timer.
        if (record.snapshotCount === 0) invalidate(record, status);
    }

    function closeCurrent(key) {
        const record = pending.get(key);
        if (record && record.status === 'open') record.status = 'closed';
    }

    function appendTo(record, attachments, message, time) {
        const sourceId = messageId(message);
        const tagged = attachments.map((attachment) => ({
            attachment,
            ...(sourceId ? { sourceMessageId: sourceId } : {}),
        }));
        record.images = [...record.images, ...tagged].slice(-maxImagesPerGroup);
        record.lastImageAt = time;
        record.expiresAt = time + ttlMs;
        record.status = 'open';
        expireLater(record);
    }

    function makeRecord(identity, attachments, message, time) {
        const record = {
            id: ++nextRecordId,
            key: identity.key,
            peerKey: identity.peerKey,
            pendingByKey: pending,
            liveRecords,
            stopTimer: undefined,
            now,
            images: [],
            lastImageAt: time,
            expiresAt: time + ttlMs,
            snapshotCount: 0,
            claimedSnapshot: undefined,
            invalidated: false,
            status: 'open',
            timer: undefined,
        };
        record.stopTimer = () => stopTimer(record);
        liveRecords.set(record.id, record);
        appendTo(record, attachments, message, time);
        pending.set(record.key, record);
        return record;
    }

    function evictExcessPending() {
        while (pending.size > maxGroups) {
            let oldest;
            for (const record of pending.values()) {
                if (!oldest || record.lastImageAt < oldest.lastImageAt) oldest = record;
            }
            if (!oldest) return;
            preserveOrDiscard(oldest, 'evicted');
        }
    }

    function capture(message, appId) {
        const identity = identityFor(message, appId);
        if (!identity) return false;
        pruneExpired();
        if (!isPureImageMessage(message, appId)) {
            closeCurrent(identity.key);
            return false;
        }

        const rawAttachments = Array.isArray(message.attachments) ? message.attachments : [];
        const attachments = rawAttachments.map(imageAttachment);
        // A declared pure-image message with any unsafe or malformed image is
        // a boundary. Never append only a partial set to an older valid batch.
        if (attachments.length === 0 || attachments.some((attachment) => !attachment)) {
            closeCurrent(identity.key);
            return false;
        }

        const time = now();
        let record = pending.get(identity.key);
        if (record && record.status === 'open') {
            appendTo(record, attachments, message, time);
        }
        else {
            if (record) preserveOrDiscard(record, 'superseded');
            record = makeRecord(identity, attachments, message, time);
        }
        evictExcessPending();
        return true;
    }

    function snapshot(message, appId, state = {}) {
        const identity = identityFor(message, appId);
        if (!identity) return undefined;
        pruneExpired();

        // This request is a non-image boundary even if a caller bypassed the
        // capture middleware. Later images then start a distinct fixed-lifetime batch.
        if (!isPureImageMessage(message, appId)) closeCurrent(identity.key);

        const text = visibleText(message, appId);
        if (!text || SLASH_COMMAND.test(text) || /https?:\/\//iu.test(text)) return undefined;
        if (message.kind === 'group' && state?.mention?.wasMentioned !== true) return undefined;

        const currentAttachments = Array.isArray(message.attachments) ? message.attachments : [];
        const quotedAttachments = Array.isArray(state?.quote?.attachments) ? state.quote.attachments : [];
        if (currentAttachments.some(isDeclaredImageAttachment)
            || quotedAttachments.some(isDeclaredImageAttachment)) return undefined;

        const record = pending.get(identity.key);
        if (!record || record.invalidated || record.claimedSnapshot
            || now() >= record.expiresAt) return undefined;

        const attachments = Object.freeze(record.images.map(({ attachment }) => attachment));
        if (attachments.length === 0) return undefined;
        const sourceMessageIds = Object.freeze([...new Set(record.images
            .map(({ sourceMessageId }) => sourceMessageId).filter(Boolean))]);
        const result = Object.freeze({ attachments, sourceMessageIds });
        record.snapshotCount++;
        snapshotRecords.set(result, { record, released: false });
        return result;
    }

    function clearForMessage(message, appId) {
        const identity = identityFor(message, appId);
        if (!identity) return false;
        pruneExpired();
        let cleared = false;
        for (const record of [...liveRecords.values()]) {
            if (record.peerKey === identity.peerKey) cleared = invalidate(record, 'revoked') || cleared;
        }
        return cleared;
    }

    function size() {
        pruneExpired();
        return pending.size;
    }

    function inspect(message, appId) {
        const identity = identityFor(message, appId);
        if (!identity) return undefined;
        pruneExpired();
        const record = pending.get(identity.key);
        return record ? Object.freeze({ count: record.images.length, lastImageAt: record.lastImageAt }) : undefined;
    }

    function clear() {
        for (const record of [...liveRecords.values()]) invalidate(record, 'revoked');
    }

    return Object.freeze({ capture, snapshot, clearForMessage, clear, inspect, size });
}

export const pendingImagePrompts = createPendingImagePromptCache();

/** Render only request-local counts. Image URLs and peer/source IDs stay private. */
export function renderRecentImagePromptMetadata(requests) {
    if (!Array.isArray(requests)) return '';
    const lines = [];
    requests.slice(0, 20).forEach((request, index) => {
        const snapshot = request?.recentImageSnapshot;
        if (!recentImageSnapshotAvailable(snapshot)) return;
        const count = snapshot.attachments.length;
        if (!Number.isSafeInteger(count) || count < 1 || count > DEFAULT_MAX_IMAGES) return;
        lines.push(`- Original request ${index + 1} has ${count} optional recent-image candidate(s) from this sender's consecutive image-only messages in this chat within the last five minutes. The candidates are separate from the current attachments. Use them only when the request explicitly asks to analyze, read, discuss, or edit a recent image, and only when there is no current-message image, quoted image, or explicit image URL. Ignore them for ordinary chat and text-to-image requests.`);
    });
    if (lines.length === 0) return '';
    return `[Recent image prompt association]\n${lines.join('\n')}`;
}

// Retain the established export name for upgrade compatibility.
export const renderDeferredImagePromptMetadata = renderRecentImagePromptMetadata;

/** Capture same-sender boundaries before mention handling; pure images stop silently. */
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

/** Attach a frozen per-request capability without changing message attachments. */
export function createPendingImagePromptMiddleware({ appId, cache = pendingImagePrompts } = {}) {
    if (!cache || typeof cache.snapshot !== 'function') throw new TypeError('pending image cache is required');
    return (ctx, next) => {
        if (ctx?.signal?.aborted) return next();
        if (!ctx.state || typeof ctx.state !== 'object') ctx.state = {};
        const snapshot = cache.snapshot(ctx?.message, appId, ctx.state);
        if (snapshot) ctx.state.qqbotRecentImages = snapshot;
        else delete ctx.state.qqbotRecentImages;
        return next();
    };
}

/** Clear all pending and queued image snapshots for a peer when /new is observed. */
export function createPendingImageNewCommandCleanup({ appId, cache = pendingImagePrompts } = {}) {
    if (!cache || typeof cache.clearForMessage !== 'function') throw new TypeError('pending image cache is required');
    return (ctx, next) => {
        if (identityFor(ctx?.message, appId) && NEW_COMMAND.test(visibleText(ctx.message, appId))) {
            cache.clearForMessage(ctx.message, appId);
        }
        return next();
    };
}
