import { isRecentImageSnapshot } from './qqbot-pending-images.mjs';
import { getOnebotDirectFallback } from './qqbot-onebot-scope.mjs';
import { captureOnebotGroupRole, captureCurrentLogSource } from './qqbot-sealdice-policy.mjs';
import { transferOnebotLogHolds } from './qqbot-onebot-log.mjs';

const DEFAULT_MAX_QUEUE = 20;
const BUSY_NOTICE = '主人，本鱼太忙啦，请等一会儿再来找本鱼吧。';
const THINKING_NOTICE = '收到啦，主人，本鱼正在思考中…';
const OPEN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

const activeBatches = new WeakMap();
const everBoundRecords = new WeakSet();
const recordWatermarks = new WeakMap();
const generationRequestsByContext = new WeakMap();

function snapshotGenerationAttachment(attachment) {
    if (!attachment || typeof attachment !== 'object') return undefined;
    const url = attachment.url;
    if (typeof url !== 'string' || url.length > 8192) return undefined;
    return Object.freeze({
        url,
        filename: typeof attachment.filename === 'string' ? attachment.filename : '',
        content_type: typeof attachment.content_type === 'string' ? attachment.content_type
            : typeof attachment.contentType === 'string' ? attachment.contentType : '',
        size: attachment.size,
    });
}

function snapshotGenerationRequest(ctx) {
    const message = ctx?.message;
    const replyTarget = snapshotReplyTarget(message?.replyTarget ?? ctx?.replyTarget);
    if (!message || !replyTarget) return undefined;
    const recentImageSnapshot = ctx?.state?.qqbotRecentImages;
    const directFallback = getOnebotDirectFallback(ctx);
    return Object.freeze({
        ownerId: message.senderId,
        groupRole: captureOnebotGroupRole(message, message.replyTarget ?? ctx?.replyTarget) ?? 'unknown',
        replyTarget,
        currentLogSource: captureCurrentLogSource(message, message.replyTarget ?? ctx?.replyTarget, ctx?.bot?.appId),
        text: typeof message.content === 'string' ? message.content.slice(0, 4000) : '',
        originalTextLength: typeof message.content === 'string' ? message.content.length : 0,
        hasAttachments: (Array.isArray(message.attachments) && message.attachments.length > 0)
            || (Array.isArray(ctx?.state?.quote?.attachments) && ctx.state.quote.attachments.length > 0),
        hasQuote: Boolean(ctx?.state?.quote || message.refMsgIdx || message.raw?.message_reference || message.raw?.quote),
        ...(directFallback ? { onebotDirectFallback: directFallback } : {}),
        currentAttachments: Object.freeze((Array.isArray(message.attachments) ? message.attachments : [])
            .map(snapshotGenerationAttachment).filter(Boolean)),
        quotedAttachments: Object.freeze((Array.isArray(ctx?.state?.quote?.attachments) ? ctx.state.quote.attachments : [])
            .map(snapshotGenerationAttachment).filter(Boolean)),
        ...(isRecentImageSnapshot(recentImageSnapshot) ? { recentImageSnapshot } : {}),
    });
}

function captureGenerationRequests(entries, mergedCtx) {
    const requests = entries.map((entry) => entry.generationRequest ?? snapshotGenerationRequest(entry.ctx)).filter(Boolean);
    if (!mergedCtx || typeof mergedCtx !== 'object') return;
    generationRequestsByContext.set(mergedCtx, Object.freeze(requests));
    // Keep the extra quote set separate from state.quote so ordinary quoted
    // message text and document reading continue to use the first request.
    if (mergedCtx.state && typeof mergedCtx.state === 'object') {
        mergedCtx.state.qqbotGenerationQuoteAttachments = Object.freeze(requests.flatMap((request) => request.quotedAttachments));
    }
}

/** Return trusted original-message provenance captured before a merge mutates its first context. */
export function getMergedGenerationRequests(ctx) {
    return ctx && typeof ctx === 'object' ? generationRequestsByContext.get(ctx) ?? [] : [];
}

function validObject(value) {
    return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function snapshotReplyTarget(target) {
    if (!target || typeof target !== 'object') return undefined;
    const { scope, targetId, msgId } = target;
    if (!['group', 'c2c'].includes(scope) || typeof targetId !== 'string' || !targetId) return undefined;
    return Object.freeze({ scope, targetId, ...(typeof msgId === 'string' && msgId ? { msgId } : {}) });
}

/** Send one overflow notice using the dropped message's own reply target. */
export async function sendMergeQueueFullNotice(sender, ctx) {
    const replyTarget = snapshotReplyTarget(ctx?.message?.replyTarget ?? ctx?.replyTarget);
    if (!replyTarget) return;
    const adapter = sender && typeof sender.sendMarkdown === 'function' ? sender : ctx?.bot;
    if (!adapter || typeof adapter.sendMarkdown !== 'function') return;
    await adapter.sendMarkdown(replyTarget, formatQueueFullNotice(ctx?.message));
}

/** Send one fixed, unmentioned acknowledgement for an admitted group message. */
export async function sendMergeThinkingNotice(sender, ctx) {
    const replyTarget = snapshotReplyTarget(ctx?.message?.replyTarget ?? ctx?.replyTarget);
    if (ctx?.message?.kind !== 'group' || replyTarget?.scope !== 'group') return;
    const adapter = sender && typeof sender.sendMarkdown === 'function' ? sender : ctx?.bot;
    if (!adapter || typeof adapter.sendMarkdown !== 'function') return;
    await adapter.sendMarkdown(replyTarget, THINKING_NOTICE);
}

/** Build the fixed busy response. Only an SDK senderId can populate the QQ mention tag. */
export function formatQueueFullNotice(message) {
    const senderId = message?.senderId;
    if (message?.kind === 'group' && typeof senderId === 'string' && OPEN_ID_PATTERN.test(senderId)) {
        return `<qqbot-at-user id="${senderId}" /> ${BUSY_NOTICE}`;
    }
    return BUSY_NOTICE;
}

/**
 * A per-target merge guard which keeps the owner lock until every merged
 * survivor has completed its downstream middleware chain.
 */
export function createMergeConcurrencyGuard(options = {}) {
    const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
    const maxProcessingMs = options.maxProcessingMs ?? 0;
    const onDrop = options.onDrop;
    const onStart = options.onStart;
    if (!Number.isSafeInteger(maxQueue) || maxQueue < 0) throw new TypeError('maxQueue must be a non-negative integer');
    if (!Number.isFinite(maxProcessingMs) || maxProcessingMs < 0) throw new TypeError('maxProcessingMs must be non-negative');
    if (onDrop !== undefined && typeof onDrop !== 'function') throw new TypeError('onDrop must be a function');
    if (onStart !== undefined && typeof onStart !== 'function') throw new TypeError('onStart must be a function');

    const locks = new Map();

    function keyFor(ctx) {
        const target = ctx?.message?.replyTarget ?? ctx?.replyTarget;
        return `${target?.scope}:${target?.targetId}`;
    }

    function defaultMerge(entries) {
        const first = entries[0].ctx;
        if (entries.length === 1) return first;
        for (const { ctx } of entries) transferOnebotLogHolds(ctx, first);
        const contentBearing = entries.map(({ ctx }) => ctx).filter((ctx) => (ctx.message.content ?? '') !== '');
        const contents = contentBearing.map((ctx) => ctx.message.content);
        if (contents.length > 0) first.message.content = contents.join('\n');
        const envelopes = contentBearing.map((ctx) => ctx.state.envelope).filter(Boolean);
        if (envelopes.length > 0) first.state.envelope = envelopes.join('\n\n');
        const attachments = contentBearing.flatMap((ctx) => ctx.message.attachments ?? []);
        if (attachments.length > 0) first.message.attachments = attachments;
        return first;
    }

    async function runEntry(entry, isIdleOwner = false) {
        if (entry.ctx?.signal?.aborted) return { skipped: true };
        let timer;
        if (maxProcessingMs > 0) {
            timer = setTimeout(() => {
                try {
                    entry.ctx.log?.warn?.('[concurrency:merge] active batch exceeded processing timeout');
                }
                catch { /* logging must not disrupt the owner */ }
                try {
                    entry.ctx.abort('concurrency:processing-timeout');
                }
                catch { /* downstream still settles through the normal chain */ }
            }, maxProcessingMs);
            timer.unref?.();
        }
        try {
            const target = snapshotReplyTarget(entry.ctx?.message?.replyTarget ?? entry.ctx?.replyTarget);
            if (isIdleOwner && onStart && entry.ctx?.message?.kind === 'group' && target?.scope === 'group') {
                try {
                    await onStart(entry.ctx);
                }
                catch {
                    try { entry.ctx.log?.warn?.('[concurrency:merge] thinking notice failed'); }
                    catch { /* logging must not disrupt the owner */ }
                }
                if (entry.ctx?.signal?.aborted) return { skipped: true };
            }
            await entry.next();
        }
        catch (error) {
            return { failed: true, error };
        }
        finally {
            if (timer) clearTimeout(timer);
        }
        return {};
    }

    async function notifyDropped(ctx) {
        try {
            await onDrop?.(ctx);
        }
        catch {
            try { ctx.log?.warn?.('[concurrency:merge] busy notice failed'); }
            catch { /* logging must not disrupt the inbound chain */ }
        }
    }

    async function drainOwner(firstEntry, state) {
        state.activeCtx = firstEntry.ctx;
        captureGenerationRequests([firstEntry], firstEntry.ctx);
        const firstResult = await runEntry(firstEntry, true);
        while (state.mergeBuffer.length > 0) {
            const entries = state.mergeBuffer.splice(0);
            const available = entries.filter((entry) => {
                if (!entry.ctx?.signal?.aborted) return true;
                entry.resolve();
                return false;
            });
            if (available.length === 0) continue;
            let survivorCtx;
            try {
                // Capture sender, target and per-message quote grants before
                // defaultMerge folds text and attachments into the first ctx.
                captureGenerationRequests(available, available[0]?.ctx);
                survivorCtx = defaultMerge(available);
            }
            catch {
                // A malformed context must not strand already accepted work.
                for (const entry of available) {
                    const result = await runEntry(entry);
                    if (result.failed) entry.reject(result.error);
                    else entry.resolve();
                }
                continue;
            }
            const survivor = available.find((entry) => entry.ctx === survivorCtx) ?? available[0];
            for (const entry of available) {
                if (entry !== survivor) entry.resolve();
            }
            state.activeCtx = survivor.ctx;
            const result = await runEntry(survivor);
            if (result.failed) survivor.reject(result.error);
            else survivor.resolve();
        }
        return firstResult;
    }

    return async function mergeConcurrencyGuard(ctx, next) {
        const key = keyFor(ctx);
        let state = locks.get(key);
        if (!state) {
            state = { busy: false, mergeBuffer: [] };
            locks.set(key, state);
        }
        // Freeze per-original identity and role before this entry can wait in
        // mergeBuffer or be folded into another sender's surviving context.
        const entry = { ctx, next, generationRequest: snapshotGenerationRequest(ctx) };
        if (!state.busy) {
            state.busy = true;
            state.activeCtx = ctx;
            let result;
            try {
                result = await drainOwner(entry, state);
            }
            catch (error) {
                result = { failed: true, error };
            }
            finally {
                // If merge bookkeeping fails, settle every accepted context
                // in order before exposing the target again.
                while (state.mergeBuffer.length > 0) {
                    const queued = state.mergeBuffer.shift();
                    if (queued.ctx?.signal?.aborted) {
                        queued.resolve();
                        continue;
                    }
                    const fallback = await runEntry(queued);
                    if (fallback.failed) queued.reject(fallback.error);
                    else queued.resolve();
                }
                state.busy = false;
                state.activeCtx = undefined;
                if (locks.get(key) === state && state.mergeBuffer.length === 0) locks.delete(key);
            }
            if (result?.failed) throw result.error;
            return;
        }

        if (state.mergeBuffer.length >= maxQueue) {
            try { ctx.stop('concurrency:merge-full'); }
            catch { /* chain will still be stopped by returning without next() */ }
            await notifyDropped(ctx);
            return;
        }

        let resolve;
        let reject;
        const completion = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        state.mergeBuffer.push({ ...entry, resolve, reject });
        await completion;
    };
}

/** Bind outbound delivery for one active inbound batch to its immutable QQ target. */
export function beginMergeBatch(record, replyTarget) {
    if (!validObject(record)) return undefined;
    const target = snapshotReplyTarget(replyTarget);
    if (!target) return undefined;
    const previous = activeBatches.get(record);
    if (previous && (!previous.closed || (previous.closing && !previous.drained))) {
        throw new Error('An inbound reply batch is already active for this session.');
    }
    let watermark = recordWatermarks.get(record);
    if (!watermark || watermark.agent !== record.agent || watermark.sessionId !== record.sessionId) {
        watermark = { agent: record.agent, sessionId: record.sessionId, lastSequence: undefined, lastTurn: undefined, requiresTurnStart: false };
    }
    const batch = {
        record,
        agent: record.agent,
        sessionId: record.sessionId,
        replyTarget: target,
        pending: new Set(),
        sendQueue: Promise.resolve(),
        closed: false,
        closing: undefined,
        lastSequence: watermark.lastSequence,
        lastTurn: watermark.lastTurn,
        requiresTurnStart: watermark.requiresTurnStart,
        nativeTurnId: undefined,
    };
    activeBatches.set(record, batch);
    everBoundRecords.add(record);
    return batch;
}

/** Capture a per-event record view; closed production records suppress late events. */
export function captureMergeBatchReply(record, event) {
    if (!validObject(record)) return undefined;
    const batch = activeBatches.get(record);
    if (batch && !batch.closed) {
        if (!acceptMergeBatchEvent(record, event)) return undefined;
        return { record, batch, replyRecord: { ...record, replyTarget: batch.replyTarget } };
    }
    if (everBoundRecords.has(record)) return undefined;
    const target = snapshotReplyTarget(record.replyTarget);
    return { record, batch: undefined, replyRecord: target ? { ...record, replyTarget: target } : record };
}

/** Bind native session sequence numbers to the currently active inbound batch. */
export function noteMergeBatchTurnStart(record, { sessionId, turnId, seq } = {}) {
    if (!validObject(record)) return false;
    const batch = activeBatches.get(record);
    if (!batch || batch.closed) return !everBoundRecords.has(record);
    if (record.agent !== batch.agent || record.sessionId !== batch.sessionId) return false;
    if (sessionId !== undefined && sessionId !== batch.sessionId) return false;
    if (!Number.isSafeInteger(turnId) || turnId < 1) return false;
    if (Number.isSafeInteger(seq) && batch.lastSequence !== undefined && seq <= batch.lastSequence) return false;
    if (Number.isSafeInteger(turnId) && turnId > 0 && batch.lastTurn !== undefined && turnId <= batch.lastTurn) return false;
    if (Number.isSafeInteger(seq)) {
        batch.lastSequence = seq;
        updateRecordWatermark(record, batch);
    }
    if (Number.isSafeInteger(turnId) && turnId > 0) {
        batch.lastTurn = turnId;
        batch.requiresTurnStart = true;
        updateRecordWatermark(record, batch);
    }
    batch.startSequence = Number.isSafeInteger(seq) ? seq : batch.startSequence;
    if (Number.isSafeInteger(turnId) && turnId > 0) batch.nativeTurnId = turnId;
    return true;
}

/** Reject replayed and out-of-order native events while a newer batch is active. */
export function acceptMergeBatchEvent(record, { sessionId, turnId, seq } = {}) {
    if (!validObject(record)) return false;
    if (turnId !== undefined && (!Number.isSafeInteger(turnId) || turnId < 1)) return false;
    const batch = activeBatches.get(record);
    if (!batch || batch.closed) return !everBoundRecords.has(record);
    if (record.agent !== batch.agent || record.sessionId !== batch.sessionId) return false;
    if (sessionId !== undefined && sessionId !== batch.sessionId) return false;
    if ((batch.requiresTurnStart || Number.isSafeInteger(seq)) && batch.nativeTurnId === undefined) return false;
    if (Number.isSafeInteger(turnId) && batch.nativeTurnId !== undefined && turnId !== batch.nativeTurnId) return false;
    if (Number.isSafeInteger(seq)) {
        if (batch.lastSequence !== undefined && seq <= batch.lastSequence) return false;
        batch.lastSequence = seq;
        updateRecordWatermark(record, batch);
    }
    return true;
}

function updateRecordWatermark(record, batch) {
    recordWatermarks.set(record, {
        agent: record.agent,
        sessionId: record.sessionId,
        lastSequence: batch.lastSequence,
        lastTurn: batch.lastTurn,
        requiresTurnStart: batch.requiresTurnStart,
    });
}

/** Track an event-driven send/flush so the inbound merge owner can await it. */
export function trackMergeBatchSend(record, promise) {
    const batch = validObject(record) ? activeBatches.get(record) : undefined;
    if (!batch || batch.closed) return Promise.resolve(promise).catch(() => {});
    const pending = Promise.resolve(promise).catch(() => {});
    batch.pending.add(pending);
    void pending.finally(() => batch.pending.delete(pending));
    return pending;
}

/** Queue one actual outbound operation in arrival order and keep batch close waiting for it. */
export function enqueueMergeBatchSend(record, operation) {
    if (typeof operation !== 'function') throw new TypeError('A queued outbound operation is required.');
    const batch = validObject(record) ? activeBatches.get(record) : undefined;
    // Standalone adapter probes and non-merged native events have no batch
    // binding. Preserve the adapter's ordinary send behavior for records that
    // have never been bound; once a record was bound, late events remain
    // suppressed after its batch closes.
    if (!batch) {
        if (validObject(record) && everBoundRecords.has(record)) return Promise.resolve(undefined);
        return Promise.resolve().then(operation).catch(() => {});
    }
    if (batch.closed) return Promise.resolve(undefined);
    const pending = batch.sendQueue.catch(() => {}).then(() => operation());
    batch.sendQueue = pending.then(() => undefined, () => undefined);
    batch.pending.add(pending);
    void pending.then(
        () => batch.pending.delete(pending),
        () => batch.pending.delete(pending),
    );
    return pending;
}

export async function closeMergeBatch(batch) {
    if (!batch) return;
    if (!batch.closing) {
        batch.closed = true;
        batch.closing = (async () => {
            while (batch.pending.size > 0) await Promise.allSettled([...batch.pending]);
            await batch.sendQueue;
            batch.drained = true;
            if (activeBatches.get(batch.record) === batch) activeBatches.delete(batch.record);
        })();
    }
    await batch.closing;
}
