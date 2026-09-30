const MAX_FAILURE_MESSAGE_BYTES = 16 * 1024;
const CONTENT_RISK_PREFIX = 'Content Exists Risk';
const historySnapshots = new WeakMap();
const historyEpochs = new WeakMap();
const suppressedHistoryKeys = new WeakMap();
const contextsByDocumentTurn = new WeakMap();
const contextsByRecord = new WeakMap();

export const SUCCESS_NOTICE = '主人，刚才这轮没能通过服务商的内容审核，本鱼已经开好新对话啦。之前聊的内容不会带过来，需要的话记得补一下背景。我们从这里重新开始吧。';
export const RESET_FAILURE_NOTICE = '主人，刚才这轮没能通过服务商的内容审核，新对话也没开成功。麻烦发一下 `/new`，再重新提问，本鱼在这儿等你。';

function objectLike(value) {
    return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function validHistoryKey(key) {
    return typeof key === 'string' && key.length > 2 && key.includes(':');
}

function getEpochMap(store) {
    if (!objectLike(store)) return undefined;
    let epochs = historyEpochs.get(store);
    if (!epochs) {
        epochs = new Map();
        historyEpochs.set(store, epochs);
    }
    return epochs;
}

function getSuppressedMap(store) {
    if (!objectLike(store)) return undefined;
    let keys = suppressedHistoryKeys.get(store);
    if (!keys) {
        keys = new Set();
        suppressedHistoryKeys.set(store, keys);
    }
    return keys;
}

/** Capture the current group-history generation before an async store read. */
export function getHistorySnapshotEpoch(store, key) {
    if (!objectLike(store) || !validHistoryKey(key)) return undefined;
    const epochs = getEpochMap(store);
    if (!epochs.has(key)) epochs.set(key, Symbol('qqbot-history-epoch'));
    return epochs.get(key);
}

/** Attach the generation captured before list() started to its returned array. */
export function markHistorySnapshot(history, store, key, epoch = getHistorySnapshotEpoch(store, key)) {
    if (!Array.isArray(history) || !objectLike(store) || !validHistoryKey(key) || epoch === undefined) return history;
    historySnapshots.set(history, { store, key, epoch });
    return history;
}

export function getHistorySnapshot(history) {
    return Array.isArray(history) ? historySnapshots.get(history) : undefined;
}

export function isHistorySnapshotCurrent(history) {
    const snapshot = getHistorySnapshot(history);
    if (!snapshot) return true;
    return getHistorySnapshotEpoch(snapshot.store, snapshot.key) === snapshot.epoch;
}

/** Invalidate prior snapshots for exactly this store key. */
export function advanceHistorySnapshotEpoch(store, key) {
    if (!objectLike(store) || !validHistoryKey(key)) return undefined;
    const epochs = getEpochMap(store);
    const next = Symbol('qqbot-history-epoch');
    epochs.set(key, next);
    return next;
}

export function isHistoryStoreSuppressed(store, key) {
    return Boolean(objectLike(store) && validHistoryKey(key) && getSuppressedMap(store)?.has(key));
}

function setHistoryStoreSuppressed(store, key, suppressed) {
    if (!objectLike(store) || !validHistoryKey(key)) return;
    const keys = getSuppressedMap(store);
    if (suppressed) keys.add(key);
    else keys.delete(key);
}

/**
 * Match only the pinned OpenAI-compatible 400 error envelope. Chat text and
 * other event fields are deliberately not accepted by this classifier.
 */
export function isContentRiskFailure(failure) {
    if (!failure || failure.code !== 'INVALID_REQUEST' || typeof failure.message !== 'string') return false;
    if (Buffer.byteLength(failure.message, 'utf8') > MAX_FAILURE_MESSAGE_BYTES) return false;
    const match = /^OpenAI API error \(400\): (\{[\s\S]*\})$/u.exec(failure.message);
    if (!match || Buffer.byteLength(match[1], 'utf8') > MAX_FAILURE_MESSAGE_BYTES) return false;
    let payload;
    try {
        payload = JSON.parse(match[1]);
    }
    catch {
        return false;
    }
    if (!payload || Array.isArray(payload) || typeof payload !== 'object' || typeof payload.message !== 'string') return false;
    if (!payload.message.startsWith(CONTENT_RISK_PREFIX)) return false;
    const next = payload.message[CONTENT_RISK_PREFIX.length];
    return next === undefined || !/[A-Za-z0-9_]/u.test(next);
}

/** Bind one inbound document turn to the exact session record it may reset. */
export function registerRecoveryContext(documentTurn, details) {
    if (!objectLike(documentTurn) || !details || !objectLike(details.record) || !objectLike(details.agent)) return undefined;
    const previous = contextsByRecord.get(details.record);
    if (previous && previous !== contextsByDocumentTurn.get(documentTurn)) previous.finished = true;
    const historySnapshot = details.scope === 'group'
        && typeof details.appId === 'string'
        && typeof details.peerId === 'string'
        && details.historySnapshot?.key === `${details.appId}:${details.peerId}`
        && objectLike(details.historySnapshot.store)
        ? details.historySnapshot
        : undefined;
    const context = {
        ...details,
        historySnapshot,
        nativeTurnId: undefined,
        pending: false,
        finished: false,
        notify: undefined,
    };
    contextsByDocumentTurn.set(documentTurn, context);
    contextsByRecord.set(details.record, context);
    return context;
}

/** Record the native session's turn number emitted immediately before execution. */
export function noteRecoveryTurnStart({ record, sessionId, turnId } = {}) {
    if (!objectLike(record) || !Number.isSafeInteger(turnId) || turnId < 1) return false;
    const context = contextsByRecord.get(record);
    if (!context || context.finished || context.record !== record || context.sessionId !== sessionId
        || record.agent !== context.agent || record.sessionId !== context.sessionId) return false;
    context.nativeTurnId = turnId;
    return true;
}

/** Mark an eligible turn/end. This never resets a session or sends a message. */
export function markContentRiskFailure({ record, sessionId, turnId, failure, notify } = {}) {
    if (!isContentRiskFailure(failure) || !objectLike(record)) return false;
    const context = contextsByRecord.get(record);
    if (!context || context.finished || context.record !== record) return false;
    if (context.sessionId !== sessionId || context.nativeTurnId === undefined || context.nativeTurnId !== turnId) return false;
    if (record.agent !== context.agent || record.sessionId !== context.sessionId) return false;
    if (context.pending) return true;
    context.pending = true;
    context.notify = typeof notify === 'function' ? notify : undefined;
    return true;
}

function notifySafely(context, message) {
    if (typeof context.notify !== 'function') return Promise.resolve();
    try {
        return Promise.resolve(context.notify(message, context.replyTarget)).catch(() => {
            context.logger?.warn?.('content-risk recovery notification failed');
        });
    }
    catch {
        context.logger?.warn?.('content-risk recovery notification failed');
        return Promise.resolve();
    }
}

function clearContext(documentTurn, context) {
    if (contextsByDocumentTurn.get(documentTurn) === context) contextsByDocumentTurn.delete(documentTurn);
    if (contextsByRecord.get(context.record) === context) contextsByRecord.delete(context.record);
}

function commitGroupHistoryReset(context) {
    const snapshot = context.historySnapshot;
    if (context.scope !== 'group'
        || !snapshot
        || snapshot.key !== `${context.appId}:${context.peerId}`
        || !objectLike(snapshot.store)
        || !validHistoryKey(snapshot.key)) return;
    advanceHistorySnapshotEpoch(snapshot.store, snapshot.key);
    // If the SDK store ever changes to an asynchronous or failing clear, hide
    // this one group's old entries until the clear is known to have completed.
    setHistoryStoreSuppressed(snapshot.store, snapshot.key, true);
    try {
        if (typeof snapshot.store.clear !== 'function') return;
        const result = snapshot.store.clear(snapshot.key);
        if (result && typeof result.then === 'function') {
            Promise.resolve(result).then(
                () => setHistoryStoreSuppressed(snapshot.store, snapshot.key, false),
                () => {},
            );
            return;
        }
        setHistoryStoreSuppressed(snapshot.store, snapshot.key, false);
    }
    catch {
        // Keep this exact group hidden if its history cannot be cleared.
    }
}

/** Finish recovery only after inbound has revoked image/document/dice grants. */
export async function finishContentRiskRecovery(documentTurn) {
    if (!objectLike(documentTurn)) return 'not-pending';
    const context = contextsByDocumentTurn.get(documentTurn);
    if (!context || context.finished) return 'not-pending';
    if (documentTurn.active !== false) return 'not-ready';
    if (contextsByRecord.get(context.record) !== context) return 'stale';
    context.finished = true;
    clearContext(documentTurn, context);
    if (!context.pending) return 'not-pending';

    const { manager, scope, peerId, record, agent, sessionId } = context;
    if (manager?.getSessionRecord(scope, peerId) !== record
        || record.agent !== agent
        || record.sessionId !== sessionId) {
        return 'stale';
    }

    try {
        // remove() performs its expected-record check and durable sessionId
        // write synchronously before its first await. No event-loop gap exists
        // between the identity check above and this invocation.
        const result = await manager.remove(scope, peerId, {
            expectedRecord: record,
            expectedAgent: agent,
            expectedSessionId: sessionId,
            requirePersisted: true,
            onCommitted: () => commitGroupHistoryReset(context),
        });
        if (result !== true) return 'stale';
        await notifySafely(context, SUCCESS_NOTICE);
        return 'reset';
    }
    catch {
        context.logger?.warn?.('content-risk recovery failed; manual /new may be required');
        await notifySafely(context, RESET_FAILURE_NOTICE);
        return 'failed';
    }
}
