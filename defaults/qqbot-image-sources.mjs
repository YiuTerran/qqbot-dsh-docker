import { createHash, randomBytes } from 'node:crypto';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const tickets = new WeakMap();
const id = () => `imgsrc_${randomBytes(24).toString('base64url')}`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const messageKey = value => typeof value === 'string' && /^[\x21-\x7e]{1,1024}$/u.test(value) ? value : undefined;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);

export function imageSourceIdentity(message, appId) {
    if (typeof appId !== 'string' || !/^\d{1,20}$/u.test(appId) || !validId(message?.senderId)) return;
    const scope = message.kind;
    const peerId = scope === 'c2c' ? message.senderId : scope === 'group' ? message.groupOpenid : undefined;
    if (!validId(peerId)) return;
    return Object.freeze({ appId, scope, peerId, ownerId: message.senderId });
}

function keys(identity) {
    if (!identity || typeof identity.appId !== 'string' || !/^\d{1,20}$/u.test(identity.appId)
        || !['c2c', 'group'].includes(identity.scope) || !validId(identity.peerId) || !validId(identity.ownerId)
        || identity.scope === 'c2c' && identity.peerId !== identity.ownerId) return;
    const peer = JSON.stringify([identity.appId, identity.scope, identity.peerId]);
    return { peer, owner: JSON.stringify([peer, identity.ownerId]) };
}

function attachment(value) {
    const type = String(value?.content_type ?? value?.contentType ?? '').split(';')[0].toLowerCase();
    const filename = String(value?.filename ?? '').split(/[\\/]/u).at(-1)
        .replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 120);
    if (!(type === 'image' || ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)
        || ['', 'file', 'application/octet-stream'].includes(type) && /\.(?:png|jpe?g|webp|gif)$/iu.test(filename))) return;
    try {
        const url = new URL(value.url.startsWith('//') ? `https:${value.url}` : value.url);
        if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 8192) return;
        url.hash = '';
        const size = Number(value.size);
        return { url: url.href, filename: filename || 'quoted-image',
            size: Number.isSafeInteger(size) && size >= 0 ? size : null };
    } catch { return; }
}

export function imageSourceError(reason = 'source-unavailable') {
    return Object.assign(new Error(reason === 'source-expired'
        ? 'The image source has expired. Ask for an explicit quote or a new attachment; do not substitute another image or retry automatically.'
        : 'This image source is unavailable for this original request. Ask for an explicit quote or a new attachment; do not substitute another image or retry automatically.'),
    { imageSourceReason: reason });
}

/** Private, bounded source catalogue. Tickets are provenance, never bearer credentials. */
export function createImageSourceCache({ now = Date.now, maxGroups = 200, maxBytes = 64 * 1024 * 1024,
    generatedTtlMs = 600000, quotedTtlMs = 300000, cleanup = true } = {}) {
    for (const limit of [maxGroups, maxBytes, generatedTtlMs, quotedTtlMs]) {
        if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Invalid image source cache limit');
    }
    const groups = new Map();
    const owners = new Map();
    let retainedBytes = 0;
    let sequence = 0;

    function ownerFor(identity, create = false) {
        const key = keys(identity);
        if (!key) return;
        let owner = owners.get(key.owner);
        if (!owner && create) {
            owner = { ...key, identity, epoch: { active: true }, latest: undefined };
            owners.set(key.owner, owner);
        }
        return owner;
    }
    function drop(group) {
        if (!group || group.removed) return;
        group.removed = true;
        groups.delete(group.id);
        group.onEvict?.();
        if (!group.readers) {
            for (const entry of group.entries) {
                retainedBytes -= entry.data?.length ?? 0;
                entry.data = undefined;
            }
        }
    }
    function prune() {
        for (const group of groups.values()) if (now() >= group.expiresAt || !group.owner.epoch.active) drop(group);
        // A live ticket keeps its epoch object, not this map entry. Removing an
        // idle owner revokes old tickets rather than silently recreating authority.
        if (owners.size > maxGroups * 2) {
            for (const [key, owner] of owners) {
                if (![...groups.values()].some(group => group.owner === owner)) {
                    owner.epoch.active = false;
                    owners.delete(key);
                    if (owners.size <= maxGroups) break;
                }
            }
        }
    }
    function room(bytes, newGroup = false, exclude) {
        prune();
        while (retainedBytes + bytes > maxBytes || newGroup && groups.size >= maxGroups) {
            const victim = [...groups.values()].filter(group => !group.readers && !group.editing && group !== exclude)
                .filter(group => !group.pinned?.()).sort((a, b) => a.accessed - b.accessed)[0];
            if (!victim) return false;
            drop(victim);
        }
        return true;
    }
    function add(identity, source, values, ttl, extra = {}) {
        const owner = ownerFor(identity, true);
        if (!owner) return;
        owner.latest = ++sequence; // Even a failed admission is a newer source boundary.
        if (!room(0, true)) return;
        const group = { id: id(), owner, source, sequence: owner.latest, createdAt: now(),
            expiresAt: now() + ttl, accessed: ++sequence, readers: 0, editing: false,
            entries: values.slice(0, 8).map(value => ({ ...value, handle: id() })), ...extra };
        groups.set(group.id, group);
        return group;
    }
    function snapshot(identity, { currentQuoteGroupId } = {}) {
        prune();
        const owner = ownerFor(identity, true);
        if (!owner) return;
        const selected = [...groups.values()].filter(group => group.owner === owner)
            .sort((a, b) => b.sequence - a.sequence);
        const ticket = Object.freeze({});
        tickets.set(ticket, { cache: api, owner, epoch: owner.epoch, latest: owner.latest,
            groupIds: selected.map(group => group.id), currentQuoteGroupId, bound: false, closed: false });
        return ticket;
    }
    function info(ticket) {
        const state = tickets.get(ticket);
        if (!state || state.cache !== api || state.closed || !state.epoch.active || state.owner.epoch !== state.epoch) return;
        return state;
    }
    function bind(ticket, identity, sessionId) {
        const state = info(ticket);
        if (!state || keys(identity)?.owner !== state.owner.owner || typeof sessionId !== 'string' || !sessionId) return false;
        if (state.bound && state.sessionId !== sessionId) return false;
        state.bound = true;
        state.sessionId = sessionId;
        for (const groupId of state.groupIds) {
            const group = groups.get(groupId);
            if (group && !group.legacyDirect && group.sessionId === undefined) group.sessionId = sessionId;
        }
        return true;
    }
    function listed(ticket) {
        prune();
        const state = info(ticket);
        if (!state?.bound) return [];
        const result = [];
        for (const groupId of state.groupIds) {
            const group = groups.get(groupId);
            if (!group || group.owner !== state.owner || group.legacyDirect
                || group.sessionId !== state.sessionId || now() >= group.expiresAt) continue;
            for (const entry of group.entries) {
                result.push({ handle: entry.handle, source: group.source, filename: entry.filename,
                    defaultSource: group.sequence === state.latest, sourceGroup: group.id,
                    ...(entry.origin === 'bot-generated' && entry.originSessionId === state.sessionId
                        ? { origin: 'bot-generated' } : {}),
                    createdAt: new Date(group.createdAt).toISOString(),
                    expiresAt: new Date(group.expiresAt).toISOString() });
                if (result.length >= 8) return result;
            }
        }
        return result;
    }
    function resolve(ticket, handle) {
        const state = info(ticket);
        if (!state?.bound) throw imageSourceError();
        for (const groupId of state.groupIds) {
            const group = groups.get(groupId);
            if (!group || group.owner !== state.owner || group.sessionId !== state.sessionId) continue;
            const entry = group.entries.find(value => value.handle === handle);
            if (!entry) continue;
            if (now() >= group.expiresAt) throw imageSourceError('source-expired');
            group.accessed = ++sequence;
            return { group, entry };
        }
        throw imageSourceError();
    }
    async function read(ticket, handle, loader, signal) {
        const { group, entry } = resolve(ticket, handle);
        group.readers++;
        try {
            signal?.throwIfAborted();
            let loaded;
            if (!entry.data) {
                if (!entry.loading) entry.loading = (async () => {
                    if (entry.size !== null && entry.size > MAX_IMAGE_BYTES) throw imageSourceError();
                    const bytes = Buffer.from(await loader(entry.url, MAX_IMAGE_BYTES, signal));
                    resolve(ticket, handle);
                    signal?.throwIfAborted();
                    if (entry.data) return entry.data;
                    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw imageSourceError();
                    if (room(bytes.length, false, group)) {
                        entry.data = bytes;
                        entry.digest = hash(bytes);
                        retainedBytes += bytes.length;
                    }
                    return bytes;
                })().finally(() => { entry.loading = undefined; });
                loaded = await entry.loading;
            }
            resolve(ticket, handle);
            signal?.throwIfAborted();
            if (entry.data && hash(entry.data) !== entry.digest) throw imageSourceError();
            return Buffer.from(entry.data ?? loaded);
        } finally {
            group.readers--;
            if (group.removed && !group.readers) for (const value of group.entries) {
                retainedBytes -= value.data?.length ?? 0;
                value.data = undefined;
            }
        }
    }
    function lockEdit(ticket, handle) {
        const { group } = resolve(ticket, handle);
        if (group.editing) throw imageSourceError('source-busy');
        group.editing = true;
        group.readers++;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            group.editing = false;
            group.readers--;
            if (group.removed && !group.readers) for (const value of group.entries) {
                retainedBytes -= value.data?.length ?? 0;
                value.data = undefined;
            }
        };
    }
    function publish(ticket, bytes, sessionId, messageId, referenceId) {
        const state = info(ticket);
        if (!state?.bound || state.sessionId !== sessionId || !Buffer.isBuffer(bytes)
            || !bytes.length || bytes.length > MAX_IMAGE_BYTES) return;
        // The new picture was already delivered. If it cannot be retained,
        // earlier pictures must not silently become the default editing base.
        state.owner.latest = ++sequence;
        if (!room(bytes.length, true)) return;
        const group = add(state.owner.identity, 'generated', [{ filename: 'generated-image', size: bytes.length,
            origin: 'bot-generated', originSessionId: sessionId }], generatedTtlMs,
            { sessionId, messageKeys: [messageKey(messageId), messageKey(referenceId)].filter(Boolean) });
        if (!group) return;
        group.entries[0].data = Buffer.from(bytes);
        group.entries[0].digest = hash(bytes);
        retainedBytes += bytes.length;
        return { editableHandle: group.entries[0].handle, editableUntil: new Date(group.expiresAt).toISOString() };
    }
    function clearPeer(identity) {
        const peer = keys(identity)?.peer;
        if (!peer) return;
        for (const [key, owner] of owners) if (owner.peer === peer) {
            owner.epoch.active = false;
            owners.delete(key);
            for (const group of [...groups.values()]) if (group.owner === owner) drop(group);
        }
    }
    const api = Object.freeze({ snapshot, bind, listed, read, lockEdit, publish, clearPeer,
        rememberUrl(ticket, url, bytes) {
            const state = info(ticket);
            if (!state?.bound || !bytes?.length || bytes.length > MAX_IMAGE_BYTES) return;
            for (const groupId of state.groupIds) {
                const group = groups.get(groupId);
                if (!group || group.sessionId !== state.sessionId || now() >= group.expiresAt) continue;
                for (const entry of group.entries) if (entry.url === url && !entry.data && room(bytes.length, false, group)) {
                    entry.data = Buffer.from(bytes);
                    entry.digest = hash(bytes);
                    retainedBytes += bytes.length;
                }
            }
        },
        valid: ticket => Boolean(info(ticket)?.bound),
        available(ticket, handle) { try { resolve(ticket, handle); return true; } catch { return false; } },
        defaultIsDirect(ticket) {
            const state = info(ticket);
            return Boolean(state && [...groups.values()].some(group => group.owner === state.owner
                && group.legacyDirect && group.sequence === state.latest));
        },
        currentOrigin(ticket, url) {
            const state = info(ticket);
            if (!state?.bound) return;
            for (const groupId of state.groupIds.filter(value => value === state.currentQuoteGroupId)) {
                const group = groups.get(groupId);
                if (!group || group.owner !== state.owner || group.sessionId !== state.sessionId
                    || now() >= group.expiresAt) continue;
                const entry = group.entries.find(value => value.url === url);
                if (entry?.origin === 'bot-generated' && entry.originSessionId === state.sessionId) return 'bot-generated';
            }
        },
        captureQuote(identity, attachments, source = 'quoted', refKey) {
            const images = attachments.filter(value => /^image(?:\/|$)/iu.test(value?.content_type ?? value?.contentType ?? '')
                || /\.(?:png|jpe?g|webp|gif)$/iu.test(value?.filename ?? ''));
            if (!images.length) return;
            const values = images.map(attachment);
            const unique = values.every(Boolean) ? [...new Map(values.map(value => [value.url, value])).values()] : [];
            // Only an exact confirmed outbound message match can establish authorship.
            // Keep the quote's own URL grant; never borrow the generated byte grant.
            const owner = ownerFor(identity);
            const generated = source === 'quoted' && unique.length === 1 && messageKey(refKey)
                ? [...groups.values()].find(group => group.owner === owner && group.source === 'generated'
                    && group.messageKeys?.includes(refKey) && now() < group.expiresAt) : undefined;
            if (generated) Object.assign(unique[0], { origin: 'bot-generated', originSessionId: generated.sessionId });
            return add(identity, source, unique, quotedTtlMs);
        },
        noteDirect(identity, expiresAt, onEvict, pinned) {
            const group = add(identity, 'direct', [], Math.max(1, expiresAt - now()), { onEvict, pinned, legacyDirect: true });
            return group?.id;
        },
        remove(groupId) { drop(groups.get(groupId)); },
        close(ticket) { const state = tickets.get(ticket); if (state?.cache === api) state.closed = true; },
        stats() { prune(); return { groups: groups.size, bytes: retainedBytes }; },
        clear() {
            for (const owner of owners.values()) owner.epoch.active = false;
            owners.clear();
            for (const group of [...groups.values()]) drop(group);
        },
    });
    const timer = cleanup ? setInterval(prune, 60000) : undefined;
    timer?.unref?.();
    return api;
}

export const imageSources = createImageSourceCache();
export const isImageSourceTicket = ticket => Boolean(ticket && tickets.has(ticket));
export function redactImageSourceHandles(text) {
    return typeof text === 'string' ? text.replace(/imgsrc_[A-Za-z0-9_-]{32}/gu, '[图片引用]') : text;
}

/** Hold incomplete handle prefixes across chunks so a streaming writer cannot leak them. */
export function createImageSourceRedactor() {
    let pending = '';
    const prefix = 'imgsrc_';
    function drain(final = false) {
        let output = '';
        while (pending) {
            const start = pending.indexOf(prefix);
            if (start >= 0) {
                output += pending.slice(0, start);
                pending = pending.slice(start);
                const token = /^[A-Za-z0-9_-]*/u.exec(pending.slice(prefix.length))[0];
                if (token.length < 32 && pending.length === prefix.length + token.length && !final) return output;
                output += '[图片引用]';
                pending = pending.slice(prefix.length + Math.min(token.length, 32));
            } else {
                let held = 0;
                if (!final) for (let length = 1; length < prefix.length; length++) {
                    if (pending.endsWith(prefix.slice(0, length))) held = length;
                }
                output += held ? pending.slice(0, -held) : pending;
                pending = held ? pending.slice(-held) : '';
                break;
            }
        }
        return output;
    }
    return Object.freeze({ push(text) { pending += text; return drain(); }, finish() { return drain(true); } });
}

/** Runs after the existing scoped quote parser, access/mention gates and question handler. */
export function createImageSourceMiddleware({ appId, cache = imageSources } = {}) {
    return (ctx, next) => {
        const identity = imageSourceIdentity(ctx?.message, appId);
        if (!identity || ctx.signal?.aborted) return next();
        ctx.state ??= {};
        const quote = ctx.state?.quote;
        let currentQuoteGroup;
        if (ctx.message.refMsgIdx && quote?.refKey === ctx.message.refMsgIdx && Array.isArray(quote.attachments)) {
            currentQuoteGroup = cache.captureQuote(identity, quote.attachments, 'quoted', quote.refKey);
        }
        if (Array.isArray(ctx.message.attachments)) cache.captureQuote(identity, ctx.message.attachments, 'direct');
        ctx.state.qqbotImageSources = cache.snapshot(identity, { currentQuoteGroupId: currentQuoteGroup?.id });
        return next();
    };
}
