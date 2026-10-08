import { createHash } from 'node:crypto';
import {
    abortOnebotTurn,
    attachOnebotDirectFallback,
    beginOnebotTurn,
    onebotRequestMetadata,
} from './qqbot-onebot-scope.mjs';
import { captureOnebotGroupRole, captureCurrentLogSource, inspectSeaDiceCommand } from './qqbot-sealdice-policy.mjs';

const EVENT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_EVENT_CACHE = 50_000;
const MAX_MESSAGE_CHARS = 2000;
const MAX_SEND_CHUNKS = 4;
const SERVICE_DEADLINE_MS = 35_000;
const LOG_SERVICE_DEADLINE_MS = 145_000;
const SEND_DEADLINE_MS = 10_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const BACKEND_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const APP_ID_PATTERN = /^[0-9]{1,20}$/u;
const ROUTER_EVENT_BACKEND = '__router__';

const SEA_DICE_POLICY = Object.freeze({ family: 'sealdice', match: matchOnebotDirectCommand });

/** Policies apply only to configured aliases of a registered backend family. */
export const ONEBOT_DIRECT_BACKEND_POLICIES = new Map([['sealdice', SEA_DICE_POLICY]]);

export function registerOnebotDirectBackend(alias, policy = SEA_DICE_POLICY) {
    if (typeof alias !== 'string' || !BACKEND_PATTERN.test(alias)
        || !policy || typeof policy !== 'object' || typeof policy.family !== 'string'
        || typeof policy.match !== 'function') return false;
    ONEBOT_DIRECT_BACKEND_POLICIES.set(alias, Object.freeze({ ...policy }));
    return true;
}

const FAILURE_TEXT = Object.freeze({
    disabled: '骰子直连功能当前未启用。',
    config_invalid: '骰子后端配置无效，本次命令未执行。',
    backend_conflict: '骰子后端配置不明确，本次命令未执行。',
    backend_not_ready: '海豹骰后端暂未就绪，本次命令未执行。',
    service_stopped: '海豹骰服务已停止，本次命令未执行。',
    service_unavailable: '海豹骰服务当前不可用，本次命令未执行。',
    missing_message_id: '当前消息缺少可校验的消息编号，本次命令未执行。',
    invalid_identity: '当前消息身份信息不完整，本次命令未执行。',
    multiline: '骰子直连命令必须单独占一行。',
    unsupported_compact: '这条骰子指令写法不明确，请在命令与参数间加空格。',
    invalid_command: '这条骰子指令不在直连支持范围内。',
    queue_full: '海豹骰请求队列已满，本次命令未执行。',
    expired: '这条骰子命令已过期，本次未执行。',
    uncertain: '骰子结果未能确认，请勿重复发送同一条命令。',
    timeout: '骰子请求等待超时，结果未能确认，请勿重复发送同一条命令。',
    privacy_withheld: '私密骰子结果未能安全送达，本次已停止。',
    hidden_disabled: '当前平台不支持暗骰私聊投递，本次命令未执行。',
    private_unavailable: '当前无法安全投递私密结果，本次操作已停止。',
    backend_rejected: '海豹骰未能完成这条命令。',
    group_state_private: '群规则只能在群聊中修改。',
    group_role_unknown: '无法确认当前群的身份权限，群规则未修改。',
    group_role_denied: '只有当前群的群主或管理员可以修改群规则。',
    group_role_unsupported: 'OneBot 后端尚不支持群角色校验，群规则未修改。',
    group_state_source_mismatch: '混合消息批次修改群规则，需要该群主或管理员在自己的原消息中明确发送完整的原生命令。',
    log_disabled: '聊天记录功能当前未启用，本次命令未执行。',
    log_capability_unsupported: '当前海豹骰后端不支持群聊记录控制，本次命令未执行。',
    log_group_only: '聊天记录命令只能在群聊中使用。',
    log_exact_source_required: '请在群内 @机器人并完整发送 .log 命令，通过机器人转发。',
    log_role_denied: '只有当前群的群主或管理员可以修改聊天记录状态。',
    log_role_unknown: '无法确认当前群的身份权限，聊天记录状态未修改。',
    log_role_unsupported: '当前 OneBot 后端尚不支持群角色校验，聊天记录状态未修改。',
    log_capture_order_unavailable: '当前群的记录队列尚未确认接收之前的消息，本次控制命令未执行。',
    artifact_delivery_failed: '群聊文件发送失败，文件不会自动重试或转换为文本。',
    artifact_delivery_unknown: '群聊文件发送结果未能确认，请勿重复执行导出。',
    artifact_delivery_timeout: '群聊文件发送等待超时，文件不会自动重试或转换为文本。',
    artifact_delivery_expired: '当前 QQ 消息已过期，文件未发送。',
    artifact_capability_unsupported: '当前后端返回了未协商的文件回执，本次未领取文件。',
    artifact_receipt_invalid: '当前后端返回的文件回执不适用于本次群聊导出。',
    artifact_partial: '部分群聊文件未能发送；已发送的文件不会自动重试。',
    permission_denied: '管理命令需要配置的用户在私聊中明确发送原始命令，并完成后端权限协商；本次未执行。',
    send_failed: '骰子结果发送失败，请查看当前会话后再决定下一步。',
    no_output: '海豹骰没有返回可显示的结果。',
    result_too_large: '海豹骰返回内容过长，本次未发送完整结果。',
    cache_full: '骰子请求队列暂满，本次未执行，请稍后再试。',
});

function isLineBreak(value) {
    return /[\r\n\u2028\u2029]/u.test(value);
}

function onebotCommandCandidate(line) {
    const policy = inspectSeaDiceCommand(line, { direct: true });
    if (!policy) return undefined;
    // Unknown/ambiguous rule selection retains the existing LLM route.
    if (policy.kind === 'set' && !policy.allowed) return undefined;
    return policy.allowed ? { command: policy.command } : { issue: policy.reason };
}

/** Match one complete direct command. Unknown dot commands remain normal chat. */
export function matchOnebotDirectCommand(content) {
    if (typeof content !== 'string' || content.length > 4000) return undefined;
    if (isLineBreak(content)) return undefined;
    return onebotCommandCandidate(content);
}

function snapshotMessage(ctx, appId) {
    const message = ctx?.message;
    const target = message?.replyTarget ?? ctx?.replyTarget;
    if (!message || typeof message.content !== 'string' || typeof message.senderId !== 'string'
        || !target || typeof target !== 'object') return undefined;
    const scope = target.scope ?? target.kind ?? (target.kind === 'c2c' ? 'c2c' : undefined);
    if (!['group', 'c2c'].includes(scope) || typeof target.targetId !== 'string') return undefined;
    const replyTarget = Object.freeze({
        scope,
        targetId: target.targetId,
        ...(typeof target.msgId === 'string' && target.msgId.length > 0 && target.msgId.length <= 512 ? { msgId: target.msgId } : {}),
    });
    return Object.freeze({
        text: message.content,
        currentLogSource: captureCurrentLogSource(message, message.replyTarget ?? ctx?.replyTarget, appId),
        originalTextLength: message.content.length,
        hasQuote: Boolean(ctx?.state?.quote || message.refMsgIdx || message.raw?.message_reference || message.raw?.quote),
        groupRole: captureOnebotGroupRole(message, message.replyTarget ?? ctx?.replyTarget) ?? 'unknown',
        ownerId: message.senderId,
        replyTarget,
        currentAttachments: Array.isArray(message.attachments) ? message.attachments : [],
        quotedAttachments: Array.isArray(ctx?.state?.quote?.attachments) ? ctx.state.quote.attachments : [],
    });
}

function hasAttachments(snapshot) {
    return snapshot.currentAttachments.length > 0 || snapshot.quotedAttachments.length > 0;
}

function conversationKey(appId, source) {
    return JSON.stringify([appId, source.replyTarget.scope, source.replyTarget.targetId]);
}

function digestEvent(appId, source, backend) {
    return createHash('sha256').update(JSON.stringify([
        appId,
        source.ownerId,
        source.replyTarget.scope === 'group' ? 'group' : 'private',
        source.replyTarget.targetId,
        source.replyTarget.msgId ?? '',
        backend,
    ])).digest('base64url');
}

function configuredBackends(service, env) {
    const fromRuntime = service?.runtime?.config?.backendIds;
    const raw = Array.isArray(fromRuntime) ? fromRuntime : String(env.QQBOT_ONEBOT_BACKENDS ?? '').split(',');
    return [...new Set(raw.map((entry) => String(entry).trim()).filter((entry) => BACKEND_PATTERN.test(entry)))];
}

function readPolicy(alias, overrides) {
    const override = overrides instanceof Map ? overrides.get(alias) : overrides?.[alias];
    return override ?? ONEBOT_DIRECT_BACKEND_POLICIES.get(alias) ?? SEA_DICE_POLICY;
}

function inspectDirectService(service, env) {
    const runtime = service?.runtime;
    if (env.QQBOT_ONEBOT_ENABLED === 'false') return { disabled: true };
    if (runtime?.config?.enabled === false && env.QQBOT_ONEBOT_ENABLED !== 'true') return { disabled: true };
    if (runtime?.config?.enabled !== true && env.QQBOT_ONEBOT_ENABLED !== 'true') return { disabled: true };
    const backends = configuredBackends(service, env);
    const defaultBackend = String(env.QQBOT_ONEBOT_DEFAULT_BACKEND ?? '').trim();
    let reason;
    if (runtime?.stopped) reason = 'service_stopped';
    else if (runtime?.config?.enabled === false || env.QQBOT_ONEBOT_ENABLED === 'true' && !runtime) {
        const diagnostic = service?.diagnostics?.();
        reason = diagnostic?.reason === 'config-invalid' ? 'config_invalid' : 'service_unavailable';
    }
    return { runtime, backends, defaultBackend, reason };
}

function matchConfiguredBackend(serviceState, content, policyOverrides, logger, startedAt) {
    const wholeMessage = typeof content === 'string' ? content.trim() : '';
    if (!wholeMessage.startsWith('.') || content.length > 4000 || isLineBreak(content)) return undefined;
    const matches = [];
    for (const backend of serviceState.backends) {
        const policy = readPolicy(backend, policyOverrides);
        try {
            const match = policy.match(content);
            if (match) matches.push({ backend, policy, match });
        }
        catch {
            logStage(logger, 'match', 'failed', startedAt);
        }
    }
    if (matches.length === 0 && serviceState.backends.length === 0) {
        const match = matchOnebotDirectCommand(content);
        if (match) matches.push({ backend: undefined, policy: SEA_DICE_POLICY, match });
    }
    if (matches.length === 0) return undefined;
    if (serviceState.reason) return { reason: serviceState.reason, matches };

    if (serviceState.defaultBackend) {
        if (!BACKEND_PATTERN.test(serviceState.defaultBackend)
            || !serviceState.backends.includes(serviceState.defaultBackend)) return { reason: 'backend_conflict', matches };
        const selected = matches.find((entry) => entry.backend === serviceState.defaultBackend);
        return selected ?? { reason: 'backend_conflict', matches };
    }
    if (matches.length !== 1) return { reason: 'backend_conflict', matches };
    return matches[0];
}

function logStage(logger, stage, reason, startedAt) {
    const durationMs = Math.max(0, Date.now() - startedAt);
    const line = `[onebot-direct] stage=${stage} reason=${reason} durationMs=${durationMs}`;
    try { console.info(line); } catch { /* diagnostics are best effort */ }
    try {
        if (typeof logger?.info === 'function') logger.info(line);
        else if (typeof logger?.log === 'function') logger.log(line);
    }
    catch { /* diagnostics must not affect command safety */ }
}

function chunkText(text) {
    if (text.length === 0) return [];
    if (text.length > MAX_MESSAGE_CHARS * MAX_SEND_CHUNKS) return undefined;
    const chunks = [];
    let chunk = '';
    let chunkLength = 0;
    // QQ's SDK chunker measures UTF-16 code units. Iterate by Unicode code
    // point so a surrogate pair is never split across messages.
    for (const character of text) {
        if (chunkLength + character.length > MAX_MESSAGE_CHARS) {
            chunks.push(chunk);
            chunk = '';
            chunkLength = 0;
        }
        chunk += character;
        chunkLength += character.length;
    }
    if (chunk) chunks.push(chunk);
    return chunks;
}

function raceWithAbortAndDeadline(operation, signal, deadlineMs) {
    let timer;
    let onAbort;
    const stopped = new Promise((_, reject) => {
        onAbort = () => reject(signal?.reason ?? new Error('aborted'));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        timer = setTimeout(() => {
            const error = new Error('deadline');
            error.name = 'TimeoutError';
            reject(error);
        }, deadlineMs);
        timer.unref?.();
    });
    const work = Promise.resolve().then(() => {
        if (signal?.aborted) throw signal.reason ?? new Error('aborted');
        return operation();
    });
    void work.catch(() => {});
    return Promise.race([work, stopped]).finally(() => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    });
}

function failureReason(result) {
    if (Object.hasOwn(FAILURE_TEXT, result?.failureReason ?? '')) return result.failureReason;
    if (result?.status === 'unknown') return 'uncertain';
    return 'backend_rejected';
}

function scrubPublicErrors(result, env) {
    if (result?.status !== 'failed' || ['privacy_withheld', 'private_unavailable'].includes(failureReason(result))) return [];
    const secrets = Object.entries(env).filter(([name, value]) => /(?:KEY|TOKEN|SECRET|PASSWORD)/iu.test(name)
        && typeof value === 'string' && value.length >= 4).map(([, value]) => value);
    const errors = [];
    let remaining = 1600;
    for (const value of Array.isArray(result.outputs) ? result.outputs.slice(0, 4) : []) {
        if (typeof value !== 'string') continue;
        let text = value;
        for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
        text = text.replace(/https?:\/\/[^\s<>"']+/giu, '[URL]')
            .replace(/(?:Bearer\s+|(?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/giu, '[REDACTED]')
            .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '');
        text = text.slice(0, Math.min(512, remaining));
        if (text) { errors.push(text); remaining -= text.length; }
        if (remaining <= 0) break;
    }
    return errors;
}

/** Deterministic single-message OneBot command router. */
export function createOnebotDirectRouter({
    service,
    appId,
    sender,
    env = process.env,
    logger,
    policies = {},
    maxEventCache = MAX_EVENT_CACHE,
} = {}) {
    const eventCache = new Map();
    const activeConversations = new Map();
    const activeEntries = new Set();
    const eventCacheLimit = Number.isSafeInteger(maxEventCache) && maxEventCache > 0
        ? Math.min(MAX_EVENT_CACHE, maxEventCache) : MAX_EVENT_CACHE;
    let stopped = false;

    function configuredPolicies() {
        const values = policies instanceof Map ? [...policies.values()] : Object.values(policies ?? {});
        return [...ONEBOT_DIRECT_BACKEND_POLICIES.values(), ...values.filter((policy) => typeof policy?.match === 'function')];
    }

    function pruneEvents(now = Date.now()) {
        for (const [key, entry] of eventCache) {
            if (!entry.pending && entry.expiresAt <= now) eventCache.delete(key);
        }
    }

    function reserveEvent(source, backend, startedAt) {
        pruneEvents(startedAt);
        const key = digestEvent(appId, source, backend);
        if (eventCache.has(key)) return { duplicate: true, key };
        if (eventCache.size >= eventCacheLimit) return { saturated: true, key };
        eventCache.set(key, { expiresAt: startedAt + EVENT_TTL_MS, pending: true });
        return { key };
    }

    function finishEvent(key) {
        const entry = eventCache.get(key);
        if (!entry) return;
        entry.pending = false;
    }

    function removeActive(entry) {
        activeEntries.delete(entry);
        entry.externalSignal?.removeEventListener?.('abort', entry.abortExternal);
        const current = activeConversations.get(entry.conversationKey);
        if (!current) return;
        current.delete(entry);
        if (current.size === 0) activeConversations.delete(entry.conversationKey);
    }

    function abortEntry(entry, reason) {
        if (entry.cancelled) return;
        entry.cancelled = true;
        if (entry.handoffContext) {
            try { entry.handoffContext.abort?.('onebot:direct-fallback-cancelled'); } catch { /* continue cancellation */ }
        }
        try { entry.controller.abort(new Error(reason)); }
        catch { entry.controller.abort(); }
        if (entry.holder && entry.scope) abortOnebotTurn(entry.holder, entry.scope);
        removeActive(entry);
    }

    function addActive(entry) {
        activeEntries.add(entry);
        const entries = activeConversations.get(entry.conversationKey) ?? new Set();
        entries.add(entry);
        activeConversations.set(entry.conversationKey, entries);
        entry.abortExternal = () => abortEntry(entry, 'external-cancel');
        if (entry.externalSignal?.aborted) entry.abortExternal();
        else entry.externalSignal?.addEventListener?.('abort', entry.abortExternal, { once: true });
    }

    async function sendText(replyTarget, text, signal, startedAt, callLimit = MAX_SEND_CHUNKS) {
        if (!sender || typeof sender.sendMarkdown !== 'function') return { ok: false, used: 0, reason: 'failed' };
        const chunks = chunkText(text);
        if (!chunks || chunks.length > callLimit) return { ok: false, used: 0, reason: 'too_large' };
        let used = 0;
        for (const chunk of chunks) {
            if (signal.aborted || stopped) return { ok: false, used, reason: 'cancelled' };
            used++;
            try {
                await raceWithAbortAndDeadline(
                    () => sender.sendMarkdown(replyTarget, chunk, { signal }),
                    signal,
                    SEND_DEADLINE_MS,
                );
            }
            catch {
                logStage(logger, 'send', signal.aborted || stopped ? 'cancelled' : 'send_failed', startedAt);
                return { ok: false, used, reason: signal.aborted || stopped ? 'cancelled' : 'failed' };
            }
        }
        return { ok: chunks.length > 0, used, reason: chunks.length > 0 ? undefined : 'failed' };
    }

    async function sendUncachedFailure(source, reason, startedAt, ctx) {
        if (!ID_PATTERN.test(source.replyTarget.targetId)) {
            logStage(logger, 'reject', 'invalid_target', startedAt);
            return;
        }
        const entry = {
            controller: new AbortController(),
            externalSignal: ctx?.signal,
            conversationKey: conversationKey(appId, source),
            cancelled: false,
        };
        addActive(entry);
        try {
            if (!entry.cancelled && !stopped) {
                await sendText(source.replyTarget, FAILURE_TEXT[reason] ?? FAILURE_TEXT.backend_rejected, entry.controller.signal, startedAt, 1);
            }
        }
        finally { removeActive(entry); }
    }

    async function reportFailure(source, backend, reason, startedAt, ctx, options = {}) {
        if (!ID_PATTERN.test(source.replyTarget.targetId)) {
            logStage(logger, 'reject', 'invalid_target', startedAt);
            return;
        }
        const reserved = options.deduplicate === false ? undefined
            : reserveEvent(source, backend ?? ROUTER_EVENT_BACKEND, startedAt);
        if (reserved?.duplicate) {
            logStage(logger, 'reject', 'duplicate', startedAt);
            return;
        }
        if (reserved?.saturated) {
            logStage(logger, 'reject', 'cache_full', startedAt);
            await sendUncachedFailure(source, 'cache_full', startedAt, ctx);
            return;
        }
        const controller = new AbortController();
        const entry = { controller, externalSignal: ctx?.signal, conversationKey: conversationKey(appId, source), cancelled: false };
        addActive(entry);
        try {
            if (!entry.cancelled && !stopped) {
                if (options.next && ['config_invalid', 'backend_conflict', 'backend_not_ready', 'service_unavailable'].includes(reason)) {
                    await handoff(ctx, entry, reason, undefined, options.next, startedAt);
                    return;
                }
                await sendText(source.replyTarget, FAILURE_TEXT[reason] ?? FAILURE_TEXT.backend_rejected, controller.signal, startedAt, 1);
                logStage(logger, 'reject', reason, startedAt);
            }
        }
        finally {
            removeActive(entry);
            if (reserved) finishEvent(reserved.key);
        }
    }

    async function handoff(ctx, entry, reason, result, next, startedAt) {
        if (entry.cancelled || stopped || ctx?.signal?.aborted) return;
        if (entry.holder && entry.scope) abortOnebotTurn(entry.holder, entry.scope);
        // The native SDK exposes a read-only signal getter and an abort method.
        // Synthetic contexts without abort receive an equivalent signal here.
        entry.handoffContext = ctx;
        if (typeof ctx.abort !== 'function') {
            const descriptor = Object.getOwnPropertyDescriptor(ctx, 'signal');
            if (!descriptor || descriptor.writable) {
                ctx.signal = ctx.signal ? AbortSignal.any([ctx.signal, entry.controller.signal]) : entry.controller.signal;
            }
        }
        if (!attachOnebotDirectFallback(ctx, { reason, publicErrors: scrubPublicErrors(result, env) })) return;
        logStage(logger, 'fallback', reason, startedAt);
        if (!entry.cancelled && !stopped && !ctx.signal?.aborted) await next?.();
    }

    async function middleware(ctx, next) {
        const startedAt = Date.now();
        const source = snapshotMessage(ctx, appId);
        if (!source) return await next?.();
        if (hasAttachments(source)) return await next?.();
        if (env.QQBOT_ONEBOT_DIRECT_ENABLED === 'false') return await next?.();
        if (stopped) {
            const knownDirect = configuredPolicies().some((policy) => {
                try { return Boolean(policy.match(source.text)); }
                catch { return false; }
            });
            if (knownDirect) logStage(logger, 'route', 'stopped', startedAt);
            return knownDirect ? undefined : await next?.();
        }

        const serviceState = inspectDirectService(service, env);
        if (serviceState.disabled) return await next?.();
        const backendChoice = matchConfiguredBackend(serviceState, source.text, policies, logger, startedAt);
        if (!backendChoice) return await next?.();
        const backend = backendChoice.backend;
        const match = backendChoice.match ?? backendChoice.matches?.[0]?.match;

        if (!APP_ID_PATTERN.test(appId ?? '') || !ID_PATTERN.test(source.ownerId)
            || !ID_PATTERN.test(source.replyTarget.targetId)
            || source.replyTarget.scope === 'c2c' && source.ownerId !== source.replyTarget.targetId) {
            await reportFailure(source, backend, 'invalid_identity', startedAt, ctx);
            return;
        }
        if (match.issue) {
            await reportFailure(source, backend, match.issue, startedAt, ctx);
            return;
        }
        if (typeof match.command !== 'string' || match.command.length < 1 || match.command.length > 4000
            || /[\r\n\u2028\u2029\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(match.command)) {
            await reportFailure(source, backend, 'invalid_command', startedAt, ctx);
            return;
        }
        if (!source.replyTarget.msgId) {
            await reportFailure(source, backend, 'missing_message_id', startedAt, ctx, { deduplicate: false });
            return;
        }
        if (backendChoice.reason) {
            await reportFailure(source, backend, backendChoice.reason, startedAt, ctx, { next });
            return;
        }
        if (!backend || !serviceState.runtime) {
            await reportFailure(source, undefined, 'service_unavailable', startedAt, ctx, { next });
            return;
        }
        if (serviceState.runtime.stopped) {
            await reportFailure(source, backend, 'service_stopped', startedAt, ctx);
            return;
        }
        if (!serviceState.runtime.readyBackends?.has(backend)) {
            const diagnostic = service?.diagnostics?.();
            await reportFailure(source, backend, diagnostic?.reason === 'config-invalid' ? 'config_invalid' : 'backend_not_ready', startedAt, ctx, { next });
            return;
        }

        const reserved = reserveEvent(source, backend, startedAt);
        if (reserved.duplicate) {
            logStage(logger, 'route', 'duplicate', startedAt);
            return;
        }
        if (reserved.saturated) {
            logStage(logger, 'route', 'cache_full', startedAt);
            await sendUncachedFailure(source, 'cache_full', startedAt, ctx);
            return;
        }

        const holder = {};
        const serviceDeadlineMs = inspectSeaDiceCommand(match.command)?.kind === 'log'
            ? LOG_SERVICE_DEADLINE_MS : SERVICE_DEADLINE_MS;
        const controller = new AbortController();
        const externalSignal = ctx?.signal;
        const scopeSignal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
        const scope = beginOnebotTurn(holder, [{
            ownerId: source.ownerId,
            groupRole: source.groupRole,
            replyTarget: source.replyTarget,
            text: source.text,
            currentLogSource: source.currentLogSource,
        }], {
            appId,
            direct: true,
            directAuthorization: { backend, command: match.command },
            signal: scopeSignal,
            turnTtlMs: serviceDeadlineMs + MAX_SEND_CHUNKS * SEND_DEADLINE_MS + 1000,
        });
        const metadata = onebotRequestMetadata(scope)[0];
        if (!metadata) {
            abortOnebotTurn(holder, scope);
            finishEvent(reserved.key);
            await reportFailure(source, backend, 'invalid_identity', startedAt, ctx);
            return;
        }

        const conversation = conversationKey(appId, source);
        const entry = { holder, controller, scope, externalSignal, conversationKey: conversation, cancelled: false };
        addActive(entry);

        try {
            const signal = scope.controller.signal;
            if (entry.cancelled || stopped) return;
            const command = match.command;
            const args = Object.freeze({ requestId: metadata.requestId, backend, command });
            let result;
            try {
                result = await raceWithAbortAndDeadline(
                    () => service.execute(args, { agent: holder, signal, name: 'qqbot_onebot_command' }),
                    signal,
                    serviceDeadlineMs,
                );
            }
            catch (error) {
                if (entry.cancelled || stopped || signal.aborted) return;
                result = { status: 'unknown', outputs: [], failureReason: error?.name === 'TimeoutError' ? 'timeout' : 'uncertain' };
            }
            if (entry.cancelled || stopped || signal.aborted) return;

            if (Array.isArray(result?.artifactDelivery) && result.artifactDelivery.length > 0) {
                const deliveryStatuses = result.artifactDelivery.map((delivery) => delivery?.status);
                const allSent = deliveryStatuses.every((status) => status === 'sent');
                if (allSent) {
                    logStage(logger, 'route', 'artifact_sent', startedAt);
                    return;
                }
                const someSent = deliveryStatuses.some((status) => status === 'sent');
                const reason = someSent ? 'artifact_partial'
                    : result?.failureReason ?? (deliveryStatuses.includes('unknown') ? 'artifact_delivery_unknown'
                        : deliveryStatuses.includes('timeout') ? 'artifact_delivery_timeout'
                            : deliveryStatuses.includes('expired') ? 'artifact_delivery_expired' : 'artifact_delivery_failed');
                await sendText(source.replyTarget, FAILURE_TEXT[reason] ?? FAILURE_TEXT.artifact_delivery_failed,
                    signal, startedAt, 1);
                logStage(logger, 'route', reason, startedAt);
                return;
            }

            if (result?.status !== 'ok') {
                await handoff(ctx, entry, failureReason(result), result, next, startedAt);
                return;
            }

            let response;
            let resultTooLarge = false;
            if (result?.status === 'ok') {
                const outputs = Array.isArray(result.outputs) ? result.outputs.filter((output) => typeof output === 'string') : [];
                response = outputs.length > 0 ? outputs.join('\n') : FAILURE_TEXT.no_output;
            }

            if (entry.cancelled || stopped || signal.aborted) return;
            const responseChunks = chunkText(response);
            if (!responseChunks || responseChunks.length > MAX_SEND_CHUNKS) {
                response = FAILURE_TEXT.result_too_large;
                resultTooLarge = true;
            }
            const sent = await sendText(source.replyTarget, response, signal, startedAt);
            if (!sent.ok && sent.reason === 'failed' && sent.used < MAX_SEND_CHUNKS
                && !entry.cancelled && !stopped && !signal.aborted) {
                await sendText(source.replyTarget, FAILURE_TEXT.send_failed, signal, startedAt, 1);
            }
            const routeReason = resultTooLarge ? 'result_too_large'
                : sent.ok ? (result?.failureReason ?? result?.status ?? 'failed')
                    : sent.reason === 'failed' ? 'send_failed' : sent.reason ?? 'send_failed';
            logStage(logger, 'route', routeReason, startedAt);
        }
        finally {
            abortOnebotTurn(holder, scope);
            removeActive(entry);
            finishEvent(reserved.key);
        }
    }

    function cancelConversation(ctx) {
        const source = snapshotMessage(ctx, appId);
        if (!source || !APP_ID_PATTERN.test(appId ?? '')) return 0;
        const key = conversationKey(appId, source);
        const entries = [...(activeConversations.get(key) ?? [])];
        for (const entry of entries) abortEntry(entry, 'conversation-cancel');
        return entries.length;
    }

    function stop() {
        if (stopped) return;
        stopped = true;
        for (const entry of [...activeEntries]) abortEntry(entry, 'router-stopped');
    }

    return Object.freeze({ middleware, cancelConversation, stop });
}
