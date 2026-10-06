import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { inspectSeaDiceCommand } from './qqbot-sealdice-policy.mjs';

const KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const MAX_PENDING_EVENTS = 500;
const MAX_TRACKED_GROUPS = 2048;
const MAX_STORED_GROUPS = 4096;
const MAX_GAP_MARKERS = 512;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_BYTES = 6 * 1024 * 1024;
const MAX_TEXT_CHARS = 8192;
const MAX_NICKNAME_CHARS = 80;
const MAX_NICKNAME_BYTES = 256;
const MAX_OWN_MESSAGE_IDS = 50_000;
const EVENT_TTL_MS = 24 * 60 * 60 * 1000;
const GAP_TEXT = '记录缺口：部分群消息未能保存。';
const RESTART_GAP_TEXT = '记录缺口：记录服务重启期间的消息可能不完整。';
const OWN_USER_SUFFIX = '__qqbot__';
const GAP_WARNING_REASONS = new Set(['raw_event_mismatch', 'raw_event_invalid', 'raw_text_invalid',
    'local_state_unavailable', 'local_queue_full', 'local_state_full', 'local_persist_failed',
    'bridge_queue_full', 'event_expired', 'bot_delivery_unknown', 'bot_output_too_large',
    'control_hold_timeout', 'capability_unavailable', 'tracked_group_limit', 'gap_marker_limit']);

function safeKey(value) {
    return typeof value === 'string' && KEY_PATTERN.test(value);
}

function boundedText(value, limit = MAX_TEXT_CHARS) {
    if (typeof value !== 'string' || value.length > limit
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) return undefined;
    return value;
}

function safeNickname(value) {
    if (typeof value !== 'string') return '';
    let result = '';
    for (const codePoint of Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').trim()).slice(0, MAX_NICKNAME_CHARS)) {
        if (Buffer.byteLength(result + codePoint, 'utf8') > MAX_NICKNAME_BYTES) break;
        result += codePoint;
    }
    return result;
}

function unixSeconds(value) {
    if (typeof value !== 'string' || value.length > 128) return undefined;
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && milliseconds > 0 ? Math.floor(milliseconds / 1000) : undefined;
}

function attachmentPlaceholder(attachment) {
    const type = typeof attachment?.content_type === 'string'
        ? attachment.content_type.split(';', 1)[0].trim().toLowerCase() : '';
    if (type.startsWith('image/')) return '[image attachment]';
    if (type.startsWith('audio/')) return '[audio attachment]';
    if (type.startsWith('video/')) return '[video attachment]';
    return '[file attachment]';
}

function stableEventId(appId, groupKey, messageId) {
    return createHash('sha256').update(`${appId}\u0000${groupKey}\u0000${messageId}`).digest('base64url');
}

function isLogEvent(event) {
    return event && typeof event === 'object'
        && safeKey(event.backend_id)
        && typeof event.event_id === 'string' && EVENT_ID_PATTERN.test(event.event_id)
        && typeof event.group_key === 'string' && /^\d{1,20}:[A-Za-z0-9_-]{1,128}$/u.test(event.group_key)
        && typeof event.user_key === 'string' && /^\d{1,20}:[A-Za-z0-9_-]{1,128}$/u.test(event.user_key)
        && Number.isSafeInteger(event.time) && event.time > 0
        && typeof event.nickname === 'string' && Array.from(event.nickname).length <= MAX_NICKNAME_CHARS
        && Buffer.byteLength(event.nickname, 'utf8') <= MAX_NICKNAME_BYTES
        && boundedText(event.text) !== undefined
        && typeof event.is_bot === 'boolean'
        && (event.kind === 'message' || event.kind === 'gap');
}

function groupKeyFromRaw(raw, appId) {
    if (!raw || !safeKey(raw.group_openid)) return undefined;
    return `${appId}:${raw.group_openid}`;
}

function makeGapEvent({ appId, backendId, groupKey, restart = false, time = Math.floor(Date.now() / 1000) }) {
    return {
        backend_id: backendId,
        event_id: randomBytes(24).toString('base64url'),
        group_key: groupKey,
        user_key: `${appId}:${OWN_USER_SUFFIX}`,
        time,
        nickname: '机器人',
        text: restart ? RESTART_GAP_TEXT : GAP_TEXT,
        is_bot: true,
        kind: 'gap',
    };
}

function groupQueueKey(backendId, groupKey) {
    return `${backendId}\u0000${groupKey}`;
}

function validStoredItem(item) {
    return item && typeof item === 'object' && isLogEvent(item.event)
        && item.backendId === item.event.backend_id;
}

/**
 * Create the opt-in, capture-only local queue. It has no model-tool surface.
 * Input and output events are persisted locally before they are sent to the
 * authenticated bridge endpoint; retries reuse their stable event IDs.
 */
export function createOnebotLogCapture({ config, appId, options = {} } = {}) {
    const enabled = config?.enabled === true && config?.logEnabled === true
        && /^\d{1,20}$/u.test(appId ?? '') && typeof config.url?.origin === 'string'
        && typeof config.internalToken === 'string' && typeof (options.fetchImpl ?? globalThis.fetch) === 'function';
    if (!enabled) {
        return Object.freeze({
            enabled: false,
            setBackends() {},
            setUnavailable() {},
            captureRaw() { return Promise.resolve(false); },
            recordBotDelivery() { return Promise.resolve(false); },
            rememberOwnMessageId() {},
            isOwnEcho() { return false; },
            barrier() { return Promise.resolve(false); },
            holdControlForContext() {},
            releaseControlSource() {},
            stop() {},
            diagnostics() { return Object.freeze({ enabled: false, pending: 0, gaps: 0 }); },
        });
    }

    const filePath = options.filePath ?? '/data/qqbot-onebot-log-pending.json';
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const clock = options.now ?? (() => Date.now());
    const pending = [];
    const gaps = new Map();
    const knownGroups = new Map();
    const restartGapNeeded = new Set();
    const ownMessageIds = new Map();
    const captureBackendIds = new Set(config.backendIds);
    const readyBackendIds = new Set();
    const unsupportedBackendIds = new Set();
    const missingCapabilityGaps = new Set();
    const captureTasks = new Map();
    const controlHolds = new Map();
    let backendSetKnown = false;
    const busyKeys = new Set();
    const activeRuns = new Set();
    const waiters = new Map();
    const retryTimers = new Map();
    let stopped = false;
    let writeChain = Promise.resolve();
    let initError = false;
    let retryDelayMs = 250;
    let trackingSaturated = false;
    const warnedAt = new Map();

    function warnGap(reason) {
        if (!GAP_WARNING_REASONS.has(reason)) return;
        const now = clock();
        if (now - (warnedAt.get(reason) ?? -Infinity) < 60_000) return;
        warnedAt.set(reason, now);
        try { options.logger?.warn?.(`[qqbot-onebot-log] capture-gap reason=${reason}`); }
        catch { /* diagnostics never change capture behavior */ }
    }

    const queueSize = () => pending.length;
    const keyForEvent = (event) => groupQueueKey(event.backend_id, event.group_key);
    const eventMatchesKey = (event, key) => keyForEvent(event) === key;
    const hasWork = (key) => pending.some((item) => eventMatchesKey(item.event, key)) || (gaps.get(key)?.length ?? 0) > 0;
    const gapCount = () => [...gaps.values()].reduce((total, entries) => total + entries.length, 0);

    function stateSnapshot() {
        return {
            version: 1,
            appId,
            pending: pending.map((item) => ({ backendId: item.backendId, event: { ...item.event } })),
            gaps: [...gaps.entries()].flatMap(([key, entries]) => entries.map((value) =>
                [key, { ...value, event: { ...value.event } }])),
            groups: [...knownGroups.entries()],
            incomplete: trackingSaturated,
        };
    }

    const stateFits = () => Buffer.byteLength(JSON.stringify(stateSnapshot()), 'utf8') < MAX_STATE_BYTES;
    const pendingFits = () => Buffer.byteLength(JSON.stringify(pending), 'utf8') <= MAX_PENDING_BYTES;

    function persist() {
        const serialized = JSON.stringify(stateSnapshot());
        const temporary = `${filePath}.${process.pid}.tmp`;
        writeChain = writeChain.catch(() => {}).then(async () => {
            if (Buffer.byteLength(serialized, 'utf8') >= MAX_STATE_BYTES) throw new Error('queue state too large');
            await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
            await writeFile(temporary, serialized, { mode: 0o600 });
            await rename(temporary, filePath);
            initError = false;
        });
        return writeChain;
    }

    function parseStoredState(data) {
        if (!data || data.version !== 1 || data.appId !== appId || !Array.isArray(data.pending)
            || !Array.isArray(data.gaps) || !Array.isArray(data.groups)
            || data.pending.length > MAX_PENDING_EVENTS || data.gaps.length > MAX_STORED_GROUPS
            || data.groups.length > MAX_STORED_GROUPS
            || data.pending.length + data.gaps.length + data.groups.length > MAX_PENDING_EVENTS + (2 * MAX_STORED_GROUPS)) {
            throw new Error('invalid capture queue state');
        }
        const storedItems = data.pending.filter(validStoredItem);
        if (storedItems.length !== data.pending.length) throw new Error('invalid pending capture items');
        for (const item of storedItems) pending.push({ backendId: item.backendId, event: item.event });
        trackingSaturated = data.incomplete === true;
        for (const item of pending) knownGroups.set(keyForEvent(item.event), item.event.group_key);
        for (const entry of data.gaps) {
            const gap = entry?.[1];
            if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !gap
                || !isLogEvent(gap.event) || gap.event.kind !== 'gap'
                || groupQueueKey(gap.event.backend_id, gap.event.group_key) !== entry[0]
                || !Number.isSafeInteger(gap.count) || gap.count < 1 || gap.count > 1_000_000) continue;
            if (gap.beforeEventId !== undefined && gap.beforeEventId !== null
                && (typeof gap.beforeEventId !== 'string' || !EVENT_ID_PATTERN.test(gap.beforeEventId))) continue;
            if (gapCount() >= MAX_GAP_MARKERS || (!knownGroups.has(entry[0]) && knownGroups.size >= MAX_TRACKED_GROUPS)) {
                trackingSaturated = true;
                continue;
            }
            knownGroups.set(entry[0], gap.event.group_key);
            const entries = gaps.get(entry[0]) ?? [];
            entries.push({ event: gap.event, count: gap.count,
                reason: typeof gap.reason === 'string' ? gap.reason : undefined,
                beforeEventId: gap.beforeEventId === undefined
                    ? pending.find((item) => eventMatchesKey(item.event, entry[0]))?.event.event_id ?? null
                    : gap.beforeEventId });
            gaps.set(entry[0], entries);
        }
        for (const entry of data.groups) {
            if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'
                || !/^[A-Za-z0-9_-]{1,128}\u0000\d{1,20}:[A-Za-z0-9_-]{1,128}$/u.test(entry[0])
                || typeof entry[1] !== 'string' || !/^\d{1,20}:[A-Za-z0-9_-]{1,128}$/u.test(entry[1])
                || entry[0].slice(entry[0].indexOf('\u0000') + 1) !== entry[1]) continue;
            if (knownGroups.size >= MAX_TRACKED_GROUPS && !knownGroups.has(entry[0])) {
                trackingSaturated = true;
                continue;
            }
            knownGroups.set(entry[0], entry[1]);
        }
        if (data.groups.length > MAX_TRACKED_GROUPS || data.gaps.length > MAX_GAP_MARKERS) trackingSaturated = true;
    }

    const initialized = (async () => {
        try {
            const info = await stat(filePath);
            if (info.size > MAX_STATE_BYTES) throw new Error('capture queue state too large');
            const data = JSON.parse(await readFile(filePath, 'utf8'));
            parseStoredState(data);
            const now = Math.floor(clock() / 1000);
            for (const key of knownGroups.keys()) restartGapNeeded.add(key);
            for (const [key, groupKey] of knownGroups) {
                if (gapCount() >= MAX_GAP_MARKERS) {
                    trackingSaturated = true;
                    break;
                }
                const backendId = key.slice(0, key.indexOf('\u0000'));
                const entries = gaps.get(key) ?? [];
                entries.unshift({ event: makeGapEvent({ appId, backendId, groupKey, restart: true, time: now }),
                    count: 1, reason: 'restart', beforeEventId: pending.find((item) => eventMatchesKey(item.event, key))?.event.event_id ?? null });
                gaps.set(key, entries);
                if (!stateFits()) {
                    entries.shift();
                    if (entries.length === 0) gaps.delete(key);
                    trackingSaturated = true;
                    break;
                }
                restartGapNeeded.delete(key);
            }
            expirePending(now);
            await persist();
        }
        catch (error) {
            if (error?.code !== 'ENOENT') {
                initError = true;
                try { options.logger?.warn?.('[qqbot-onebot-log] local capture state could not be loaded'); } catch { /* ignore */ }
            }
        }
    })();

    function ownMessageKey(groupKey, messageId) {
        return `${groupKey}\u0000${messageId}`;
    }

    function rememberOwnMessageId(groupKey, messageId) {
        if (typeof groupKey !== 'string' || !/^\d{1,20}:[A-Za-z0-9_-]{1,128}$/u.test(groupKey)) return;
        if (typeof messageId !== 'string' || messageId.length < 1 || messageId.length > 256
            || /[\u0000-\u001f\u007f-\u009f]/u.test(messageId)) return;
        const now = clock();
        for (const [id, timestamp] of ownMessageIds) if (now - timestamp > EVENT_TTL_MS) ownMessageIds.delete(id);
        const key = ownMessageKey(groupKey, messageId);
        if (ownMessageIds.has(key)) ownMessageIds.delete(key);
        ownMessageIds.set(key, now);
        while (ownMessageIds.size > MAX_OWN_MESSAGE_IDS) ownMessageIds.delete(ownMessageIds.keys().next().value);
    }

    function isOwnEcho(raw, groupKey) {
        const id = raw?.id;
        if (typeof id !== 'string' || typeof groupKey !== 'string') return false;
        const key = ownMessageKey(groupKey, id);
        const timestamp = ownMessageIds.get(key);
        if (timestamp === undefined) return false;
        if (clock() - timestamp > EVENT_TTL_MS) {
            ownMessageIds.delete(key);
            return false;
        }
        return true;
    }

    function rememberGroup(key, groupKey) {
        if (knownGroups.has(key)) return true;
        if (knownGroups.size >= MAX_TRACKED_GROUPS) {
            trackingSaturated = true;
            warnGap('tracked_group_limit');
            void persist().catch(() => { initError = true; });
            return false;
        }
        knownGroups.set(key, groupKey);
        if (!stateFits()) {
            knownGroups.delete(key);
            trackingSaturated = true;
            warnGap('tracked_group_limit');
            void persist().catch(() => { initError = true; });
            return false;
        }
        return true;
    }

    function nextEventId(key, index) {
        return pending.slice(index).find((item) => eventMatchesKey(item.event, key))?.event.event_id ?? null;
    }

    function retargetGaps(key, oldEventId, replacementEventId) {
        for (const gap of gaps.get(key) ?? []) {
            if (gap.beforeEventId === oldEventId) gap.beforeEventId = replacementEventId;
        }
    }

    function expirePending(nowSeconds = Math.floor(clock() / 1000)) {
        const cutoff = nowSeconds - Math.floor(EVENT_TTL_MS / 1000);
        const expired = pending.filter((item) => item.event.kind === 'message' && item.event.time < cutoff);
        if (expired.length === 0) return;
        for (const item of expired) {
            const index = pending.indexOf(item);
            if (index >= 0) {
                pending.splice(index, 1);
                const key = keyForEvent(item.event);
                const beforeEventId = nextEventId(key, index);
                retargetGaps(key, item.event.event_id, beforeEventId);
                noteGap(item.backendId, item.event.group_key, 'event_expired', nowSeconds, false, beforeEventId);
            }
        }
        void persist().catch(() => { initError = true; });
        pump();
    }

    function noteGap(backendId, groupKey, reason, time = Math.floor(clock() / 1000), save = true, beforeEventId = null) {
        const key = groupQueueKey(backendId, groupKey);
        if (!rememberGroup(key, groupKey)) return false;
        const entries = gaps.get(key) ?? [];
        const existing = entries.find((gap) => gap.beforeEventId === beforeEventId);
        let marked = true;
        if (existing) {
            const previousCount = existing.count;
            existing.count = Math.min(1_000_000, existing.count + 1);
            if (!stateFits()) {
                existing.count = previousCount;
                trackingSaturated = true;
            }
        }
        else if (gapCount() < MAX_GAP_MARKERS) {
            const marker = { event: makeGapEvent({ appId, backendId, groupKey, time }), count: 1, reason, beforeEventId };
            entries.push(marker);
            gaps.set(key, entries);
            if (!stateFits()) {
                entries.pop();
                if (entries.length === 0) gaps.delete(key);
                trackingSaturated = true;
                marked = false;
            }
        }
        else {
            trackingSaturated = true;
            marked = false;
        }
        warnGap(reason);
        if (!marked) warnGap('gap_marker_limit');
        if (marked) missingCapabilityGaps.delete(key);
        else missingCapabilityGaps.add(key);
        if (save) {
            void persist().catch(() => { initError = true; });
            pump();
        }
        return marked;
    }

    async function ensureGapQueued(key) {
        const entries = gaps.get(key);
        if (!entries?.length || pending.length >= MAX_PENDING_EVENTS) return false;
        const placement = (gap) => gap.beforeEventId === null ? pending.length
            : pending.findIndex((item) => eventMatchesKey(item.event, key)
                && item.event.event_id === gap.beforeEventId);
        const gap = [...entries].sort((a, b) => {
            const left = placement(a);
            const right = placement(b);
            return (left < 0 ? pending.length : left) - (right < 0 ? pending.length : right);
        })[0];
        const item = { backendId: gap.event.backend_id, event: gap.event };
        const targetIndex = placement(gap);
        const insertIndex = targetIndex < 0 ? pending.length : targetIndex;
        pending.splice(insertIndex, 0, item);
        entries.splice(entries.indexOf(gap), 1);
        if (entries.length === 0) gaps.delete(key);
        try { await persist(); }
        catch {
            const index = pending.indexOf(item);
            if (index >= 0) pending.splice(index, 1);
            const restored = gaps.get(key) ?? [];
            restored.push(gap);
            gaps.set(key, restored);
            initError = true;
            return false;
        }
        return true;
    }

    async function enqueue(event) {
        await initialized;
        if (stopped || !isLogEvent(event) || !config.backendIds?.includes(event.backend_id)) return false;
        if (backendSetKnown && !captureBackendIds.has(event.backend_id)) {
            if (unsupportedBackendIds.has(event.backend_id)) {
                noteGap(event.backend_id, event.group_key, 'capability_unavailable', event.time);
            }
            return false;
        }
        const key = keyForEvent(event);
        if (!rememberGroup(key, event.group_key)) return false;
        if (missingCapabilityGaps.has(key)) {
            if (!noteGap(event.backend_id, event.group_key, 'capability_unavailable', event.time, false)) return false;
            missingCapabilityGaps.delete(key);
            try { await persist(); }
            catch { initError = true; return false; }
        }
        if (restartGapNeeded.has(key)) {
            if (gapCount() >= MAX_GAP_MARKERS) return false;
            const entries = gaps.get(key) ?? [];
            const marker = { event: makeGapEvent({ appId, backendId: event.backend_id,
                groupKey: event.group_key, restart: true, time: Math.floor(clock() / 1000) }),
            count: 1, reason: 'restart', beforeEventId: null };
            entries.unshift(marker);
            gaps.set(key, entries);
            if (!stateFits()) {
                entries.shift();
                if (entries.length === 0) gaps.delete(key);
                trackingSaturated = true;
                return false;
            }
            restartGapNeeded.delete(key);
            await persist().catch(() => { initError = true; });
        }
        if (initError) {
            noteGap(event.backend_id, event.group_key, 'local_state_unavailable', event.time);
            return false;
        }
        if (gaps.get(key)?.length) await ensureGapQueued(key);
        if (gaps.get(key)?.length || pending.length >= MAX_PENDING_EVENTS) {
            noteGap(event.backend_id, event.group_key, 'local_queue_full', event.time);
            return false;
        }
        const item = { backendId: event.backend_id, event };
        pending.push(item);
        if (!pendingFits() || !stateFits()) {
            pending.pop();
            noteGap(event.backend_id, event.group_key, 'local_state_full', event.time);
            return false;
        }
        try { await persist(); }
        catch {
            const index = pending.indexOf(item);
            if (index >= 0) pending.splice(index, 1);
            noteGap(event.backend_id, event.group_key, 'local_persist_failed', event.time);
            initError = true;
            return false;
        }
        pump();
        return true;
    }

    async function enqueueEventForActive(event) {
        if (stopped || !event) return Promise.resolve(false);
        const unsupportedTargets = [...unsupportedBackendIds];
        const targets = backendSetKnown ? [...captureBackendIds] : (config.backendIds ?? []);
        await initialized;
        for (const backendId of unsupportedTargets) {
            noteGap(backendId, event.group_key, 'capability_unavailable', event.time);
        }
        if (targets.length === 0) return Promise.resolve(false);
        const tasks = targets.map((backendId) => {
            const targeted = { ...event, backend_id: backendId };
            const key = keyForEvent(targeted);
            const task = enqueue(targeted);
            const entries = captureTasks.get(key) ?? new Set();
            captureTasks.set(key, entries);
            entries.add(task);
            const cleanup = () => {
                entries.delete(task);
                if (entries.size === 0) captureTasks.delete(key);
            };
            void task.then(cleanup, cleanup);
            return task;
        });
        return Promise.all(tasks).then((results) => results.every(Boolean));
    }

    async function postEvent(item) {
        const url = new URL('/internal/log/events', config.url.origin);
        const response = await fetchImpl(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${config.internalToken}`,
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(item.event),
            signal: AbortSignal.timeout(options.requestTimeoutMs ?? 5000),
            redirect: 'error',
        });
        let body;
        try { body = JSON.parse(await readBoundedResponseText(response, 4096)); }
        catch { return { kind: response.status === 429 ? 'queue_full' : 'retry' }; }
        if (response.status === 429 && body?.error === 'queue_full') return { kind: 'queue_full' };
        if (response.ok && body?.accepted === true) return { kind: 'accepted' };
        return { kind: 'retry' };
    }

    async function readBoundedResponseText(response, maxBytes) {
        const reader = response?.body?.getReader?.();
        if (!reader) {
            const text = await response.text();
            if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('response too large');
            return text;
        }
        const decoder = new TextDecoder();
        let byteCount = 0;
        let text = '';
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            byteCount += value?.byteLength ?? 0;
            if (byteCount > maxBytes) {
                await reader.cancel().catch(() => {});
                throw new Error('response too large');
            }
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        return text;
    }

    function resolveWaiters(key, value) {
        if (hasWork(key)) return;
        const entries = waiters.get(key);
        if (!entries) return;
        waiters.delete(key);
        for (const resolve of entries) resolve(value);
    }

    function scheduleRetry(key) {
        if (stopped || retryTimers.has(key)) return;
        const timer = setTimeout(() => {
            retryTimers.delete(key);
            retryDelayMs = Math.min(10_000, retryDelayMs * 2);
            pumpKey(key);
        }, retryDelayMs);
        timer.unref?.();
        retryTimers.set(key, timer);
    }

    function releaseControlHold(hold, expired = false) {
        if (!hold || hold.released) return;
        hold.released = true;
        clearTimeout(hold.timer);
        const entries = controlHolds.get(hold.key);
        if (entries) {
            const index = entries.indexOf(hold);
            if (index >= 0) entries.splice(index, 1);
            if (entries.length === 0) controlHolds.delete(hold.key);
        }
        if (expired) {
            const beforeEventId = nextEventId(hold.key, 0);
            noteGap(hold.backendId, hold.groupKey, 'control_hold_timeout', Math.floor(clock() / 1000), true, beforeEventId);
        }
        for (const resolve of hold.waiters) resolve(false);
        hold.waiters.clear();
        pumpKey(hold.key);
    }

    function holdControlSource(raw, groupKey) {
        if (!safeKey(raw?.group_openid) || !safeKey(raw?.author?.member_openid)
            || typeof raw?.id !== 'string' || raw.id.length < 1 || raw.id.length > 256
            || !groupKey || !Number.isSafeInteger(unixSeconds(raw.timestamp))) return undefined;
        const eventId = stableEventId(appId, groupKey, raw.id);
        const holds = [];
        for (const backendId of captureBackendIds) {
            const key = groupQueueKey(backendId, groupKey);
            const hold = { backendId, groupKey, key, eventId, reached: false, released: false, waiters: new Set() };
            hold.timer = setTimeout(() => releaseControlHold(hold, true), 150_000);
            hold.timer.unref?.();
            const entries = controlHolds.get(key) ?? [];
            entries.push(hold);
            controlHolds.set(key, entries);
            holds.push(hold);
        }
        return { holds, release() { for (const hold of holds) releaseControlHold(hold); } };
    }

    function holdControlForContext(ctx) {
        const message = ctx?.message;
        const raw = message?.raw;
        const groupKey = groupKeyFromRaw(raw, appId);
        if (!groupKey || message.kind !== 'group' || message.groupOpenid !== raw.group_openid
            || message.messageId !== raw.id || message.senderId !== raw.author?.member_openid
            || isOwnEcho(raw, groupKey) || typeof raw.content !== 'string'
            || (Array.isArray(raw.attachments) && raw.attachments.length > 0)
            || ctx.state?.quote || raw.message_reference || raw.quote) return undefined;
        const source = raw.content.replace(new RegExp(`<@!?${appId}>\\s*`, 'gu'), '').trim();
        const policy = inspectSeaDiceCommand(source, { direct: true });
        if (!policy?.allowed || policy.kind !== 'log') return undefined;
        return holdControlSource(raw, groupKey);
    }

    function releaseControlSource(groupKey, messageId, backendId) {
        if (typeof messageId !== 'string' || messageId.length < 1 || messageId.length > 256) return;
        const key = groupQueueKey(backendId, groupKey);
        const eventId = stableEventId(appId, groupKey, messageId);
        const hold = controlHolds.get(key)?.find((entry) => entry.eventId === eventId);
        releaseControlHold(hold);
    }

    async function waitForControlSource(key, eventId, timeoutMs) {
        const hold = controlHolds.get(key)?.find((entry) => entry.eventId === eventId);
        if (!hold || hold.released) return false;
        if (hold.reached) return true;
        return await new Promise((resolve) => {
            let done = false;
            const finish = (value) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                hold.waiters.delete(finish);
                resolve(value);
            };
            hold.waiters.add(finish);
            const timer = setTimeout(() => finish(false), Math.max(1, Math.min(timeoutMs, 10_000)));
            timer.unref?.();
            if (hold.reached) finish(true);
        });
    }

    async function runKey(key) {
        if (busyKeys.has(key) || stopped) return;
        busyKeys.add(key);
        let blockedByHold = false;
        try {
            while (!stopped) {
                const keyBackend = key.slice(0, key.indexOf('\u0000'));
                if (!captureBackendIds.has(keyBackend) || !readyBackendIds.has(keyBackend)) break;
                expirePending();
                if (gaps.get(key)?.length && pending.length < MAX_PENDING_EVENTS) {
                    if (!await ensureGapQueued(key)) break;
                }
                const held = controlHolds.get(key)?.[0];
                if (held?.reached && !held.released) { blockedByHold = true; break; }
                const index = pending.findIndex((item) => eventMatchesKey(item.event, key));
                if (index < 0) {
                    resolveWaiters(key, true);
                    break;
                }
                const item = pending[index];
                if (held && !held.released && !held.reached
                    && !pending.some((candidate) => eventMatchesKey(candidate.event, key)
                        && candidate.event.event_id === held.eventId)) { blockedByHold = true; break; }
                let outcome;
                try { outcome = await postEvent(item); }
                catch { outcome = { kind: 'retry' }; }
                if (outcome.kind === 'accepted') {
                    const currentIndex = pending.indexOf(item);
                    if (currentIndex >= 0) pending.splice(currentIndex, 1);
                    retryDelayMs = 250;
                    try { await persist(); }
                    catch { initError = true; break; }
                    if (held?.eventId === item.event.event_id) {
                        held.reached = true;
                        for (const resolve of held.waiters) resolve(true);
                        held.waiters.clear();
                    }
                    continue;
                }
                if (outcome.kind === 'queue_full') {
                    const currentIndex = pending.indexOf(item);
                    if (currentIndex >= 0) pending.splice(currentIndex, 1);
                    const beforeEventId = nextEventId(key, Math.max(currentIndex, 0));
                    retargetGaps(key, item.event.event_id, beforeEventId);
                    noteGap(item.backendId, item.event.group_key, 'bridge_queue_full', item.event.time, false, beforeEventId);
                    try { await persist(); }
                    catch { initError = true; break; }
                    scheduleRetry(key);
                    break;
                }
                scheduleRetry(key);
                break;
            }
        }
        finally {
            busyKeys.delete(key);
            if (hasWork(key) && !blockedByHold && !retryTimers.has(key)
                && readyBackendIds.has(key.slice(0, key.indexOf('\u0000')))) {
                if (initError) scheduleRetry(key);
                else queueMicrotask(() => pumpKey(key));
            }
            else if (!hasWork(key)) resolveWaiters(key, true);
        }
    }

    function pumpKey(key) {
        if (stopped || busyKeys.has(key)) return;
        if (!hasWork(key)) {
            resolveWaiters(key, true);
            return;
        }
        const backendId = key.slice(0, key.indexOf('\u0000'));
        if (!captureBackendIds.has(backendId) || !readyBackendIds.has(backendId)) return;
        const task = runKey(key);
        activeRuns.add(task);
        void task.finally(() => activeRuns.delete(task));
    }

    function pump() {
        if (stopped) return;
        const keys = new Set([...pending.map((item) => keyForEvent(item.event)), ...gaps.keys()]);
        for (const key of keys) pumpKey(key);
    }

    function setBackends(backends) {
        backendSetKnown = true;
        readyBackendIds.clear();
        for (const backend of Array.isArray(backends) ? backends : []) {
            if (!backend || !safeKey(backend.id) || !config.backendIds?.includes(backend.id)) continue;
            if (backend.ready !== true) continue;
            if (Array.isArray(backend.capabilities) && backend.capabilities.includes('log-capture-v1')) {
                captureBackendIds.add(backend.id);
                readyBackendIds.add(backend.id);
                unsupportedBackendIds.delete(backend.id);
            }
            else {
                captureBackendIds.delete(backend.id);
                if (!unsupportedBackendIds.has(backend.id)) {
                    unsupportedBackendIds.add(backend.id);
                    let affectedGroup = false;
                    for (const [key, groupKey] of knownGroups) {
                        if (!key.startsWith(`${backend.id}\u0000`)) continue;
                        affectedGroup = true;
                        noteGap(backend.id, groupKey, 'capability_unavailable', Math.floor(clock() / 1000), false);
                    }
                    if (affectedGroup) void persist().catch(() => { initError = true; });
                }
            }
        }
        pump();
    }

    function setUnavailable() {
        readyBackendIds.clear();
    }

    async function captureRaw(ctx) {
        const message = ctx?.message;
        if (!message || message.kind !== 'group') return false;
        const raw = message.raw;
        const groupKey = groupKeyFromRaw(raw, appId);
        if (!groupKey) return false;
        if (isOwnEcho(raw, groupKey)) return false;

        const expectedGroup = safeKey(message.groupOpenid) ? `${appId}:${message.groupOpenid}` : undefined;
        const expectedUser = safeKey(message.senderId) ? `${appId}:${message.senderId}` : undefined;
        const rawUser = safeKey(raw?.author?.member_openid) ? `${appId}:${raw.author.member_openid}` : undefined;
        const rawTime = unixSeconds(raw?.timestamp);
        const timestampMatches = rawTime !== undefined && rawTime === unixSeconds(message.timestamp);
        if (!expectedGroup || expectedGroup !== groupKey || !expectedUser || expectedUser !== rawUser
            || typeof raw.id !== 'string' || raw.id.length < 1 || raw.id.length > 256
            || raw.id !== message.messageId || !timestampMatches) {
            for (const backendId of (backendSetKnown ? captureBackendIds : (config.backendIds ?? []))) noteGap(backendId, groupKey, 'raw_event_mismatch');
            return false;
        }
        if ((raw.content !== undefined && typeof raw.content !== 'string')
            || (raw.attachments !== undefined && !Array.isArray(raw.attachments))
            || (raw.content === undefined && (!Array.isArray(raw.attachments) || raw.attachments.length === 0))
            || (typeof raw.content === 'string' && raw.content.length > MAX_TEXT_CHARS)) {
            for (const backendId of (backendSetKnown ? captureBackendIds : (config.backendIds ?? []))) noteGap(backendId, groupKey, 'raw_event_invalid');
            return false;
        }
        const parts = [typeof raw.content === 'string' ? raw.content : '', ...(raw.attachments ?? []).map(attachmentPlaceholder)];
        const text = parts.filter(Boolean).join('\n');
        const cleanText = boundedText(text);
        if (cleanText === undefined) {
            for (const backendId of (backendSetKnown ? captureBackendIds : (config.backendIds ?? []))) noteGap(backendId, groupKey, 'raw_text_invalid', rawTime);
            return false;
        }
        const userKey = rawUser;
        const event = {
            event_id: stableEventId(appId, groupKey, raw.id),
            group_key: groupKey,
            user_key: userKey,
            time: rawTime,
            nickname: safeNickname(raw.author?.username),
            text: cleanText,
            is_bot: raw.author?.bot === true,
            kind: 'message',
        };
        return await enqueueEventForActive(event);
    }

    async function recordBotDelivery({ target, status, messageId, text, mediaType } = {}) {
        if (!target || target.scope !== 'group' || !safeKey(target.targetId)) return false;
        const groupKey = `${appId}:${target.targetId}`;
        if (status !== 'sent') {
            if (status === 'unknown' || status === 'timeout') {
                for (const backendId of (backendSetKnown ? captureBackendIds : (config.backendIds ?? []))) noteGap(backendId, groupKey, 'bot_delivery_unknown');
            }
            return false;
        }
        if (typeof messageId === 'string') rememberOwnMessageId(groupKey, messageId);
        const output = typeof text === 'string' ? text : mediaType === 'image' ? '[image attachment]' : '[file attachment]';
        if (boundedText(output) === undefined) {
            for (const backendId of (backendSetKnown ? captureBackendIds : (config.backendIds ?? []))) noteGap(backendId, groupKey, 'bot_output_too_large');
            return false;
        }
        const event = {
            event_id: typeof messageId === 'string' && messageId.length > 0
                ? stableEventId(appId, groupKey, `bot:${messageId}`) : randomBytes(24).toString('base64url'),
            group_key: groupKey,
            user_key: `${appId}:${OWN_USER_SUFFIX}`,
            time: Math.floor(clock() / 1000),
            nickname: '机器人',
            text: output,
            is_bot: true,
            kind: 'message',
        };
        return await enqueueEventForActive(event);
    }

    async function barrier({ backendId, groupKey, sourceMessageId, timeoutMs = 3000 } = {}) {
        await initialized;
        if (stopped || !captureBackendIds.has(backendId)
            || !/^\d{1,20}:[A-Za-z0-9_-]{1,128}$/u.test(groupKey ?? '')) return false;
        const key = groupQueueKey(backendId, groupKey);
        if (sourceMessageId !== undefined) {
            if (typeof sourceMessageId !== 'string' || sourceMessageId.length < 1 || sourceMessageId.length > 256) return false;
            pumpKey(key);
            return await waitForControlSource(key, stableEventId(appId, groupKey, sourceMessageId), timeoutMs);
        }
        const captures = [...(captureTasks.get(key) ?? [])];
        if (captures.length > 0) {
            let timer;
            const captureResult = await Promise.race([
                Promise.all(captures).then((values) => values.every(Boolean)),
                new Promise((resolve) => { timer = setTimeout(() => resolve(false), Math.max(1, Math.min(timeoutMs, 10_000))); }),
            ]);
            clearTimeout(timer);
            if (captureResult !== true) return false;
        }
        if (!hasWork(key)) return true;
        pumpKey(key);
        return await new Promise((resolve) => {
            const entries = waiters.get(key) ?? new Set();
            waiters.set(key, entries);
            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                entries.delete(finish);
                if (entries.size === 0) waiters.delete(key);
                resolve(value);
            };
            entries.delete(finish);
            entries.add(finish);
            const timer = setTimeout(() => finish(false), Math.max(1, Math.min(timeoutMs, 10_000)));
            timer.unref?.();
            if (!hasWork(key)) finish(true);
        });
    }

    async function stop() {
        stopped = true;
        for (const entries of [...controlHolds.values()]) for (const hold of [...entries]) releaseControlHold(hold);
        clearInterval(ttlTimer);
        for (const timer of retryTimers.values()) clearTimeout(timer);
        retryTimers.clear();
        for (const entries of waiters.values()) for (const resolve of entries) resolve(false);
        waiters.clear();
        await Promise.allSettled([...captureTasks.values()].flatMap((tasks) => [...tasks]));
        await Promise.allSettled([...activeRuns]);
        await writeChain.catch(() => {});
    }

    const ttlTimer = setInterval(() => {
        if (!stopped) expirePending();
    }, 10 * 60 * 1000);
    ttlTimer.unref?.();

    void initialized.then(() => { pump(); }).catch(() => {});
    return Object.freeze({
        enabled: true,
        setBackends,
        setUnavailable,
        captureRaw,
        recordBotDelivery,
        rememberOwnMessageId,
        isOwnEcho,
        barrier,
        holdControlSource,
        holdControlForContext,
        releaseControlSource,
        stop,
        diagnostics() { return Object.freeze({ enabled: true, pending: queueSize(), gaps: gapCount(), initError, incomplete: trackingSaturated }); },
    });
}

/** Must be mounted after accessPolicy and before mentionGate. */
export function createOnebotLogCaptureMiddleware(service) {
    return async (ctx, next) => {
        const capture = service?.runtime?.logCapture;
        if (!capture?.enabled) return await next?.();
        void capture.captureRaw(ctx).catch(() => {});
        const hold = capture.holdControlForContext(ctx);
        if (hold) {
            ctx.state ??= {};
            (ctx.state.qqbotLogHolds ??= []).push(hold);
        }
        try { await next?.(); }
        finally {
            for (const token of ctx.state?.qqbotLogHolds ?? []) token.release();
            if (ctx.state) ctx.state.qqbotLogHolds = [];
        }
    };
}

export function transferOnebotLogHolds(from, to) {
    if (from === to || !from?.state?.qqbotLogHolds?.length) return;
    to.state ??= {};
    (to.state.qqbotLogHolds ??= []).push(...from.state.qqbotLogHolds);
    from.state.qqbotLogHolds = [];
}

/** Observe the pinned SDK's final message send, including sendMarkdown and eventId replies. */
export function attachOnebotDeliveryObserver(bot, service) {
    if (!bot || typeof bot.send !== 'function') throw new TypeError('QQ bot send method is required.');
    const original = bot.send;
    const observed = async function (options) {
        const target = options?.target;
        const text = typeof options?.markdown?.content === 'string' ? options.markdown.content
            : typeof options?.content === 'string' ? options.content : undefined;
        const mediaType = options?.media && typeof options.media === 'object' ? 'file' : undefined;
        const report = (status, messageId) => {
            if (target?.scope !== 'group' || !safeKey(target.targetId)
                || (text === undefined && mediaType === undefined)) return;
            try {
                Promise.resolve(service?.observeBotDelivery?.({
                    target: { scope: 'group', targetId: target.targetId }, status,
                    ...(typeof messageId === 'string' ? { messageId } : {}),
                    ...(text !== undefined ? { text } : { mediaType }),
                })).catch(() => {});
            }
            catch { /* capture diagnostics cannot change QQ delivery */ }
        };
        try {
            const result = await original.call(this, options);
            report(typeof result?.id === 'string' && result.id.length > 0 ? 'sent' : 'unknown', result?.id);
            return result;
        }
        catch (error) {
            const httpStatus = error?.httpStatus ?? error?.status;
            const status = Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus < 500
                ? 'failed' : 'unknown';
            report(status);
            throw error;
        }
    };
    bot.send = observed;
    return () => { if (bot.send === observed) bot.send = original; };
}
