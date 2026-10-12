import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import {
    getBoundGenerationTurn,
    getGenerationRequest,
    getGenerationRequestSignal,
    trackGenerationOperation,
} from './qqbot-generation-scope.mjs';
import { bindDocumentExecution } from './qqbot-document-scope.mjs';
import { bindMergeBatchQuestionReply } from './qqbot-concurrency.mjs';
import { getOnebotDirectFallback } from './qqbot-onebot-scope.mjs';
import { matchOnebotDirectCommand } from './qqbot-onebot-direct.mjs';

export const QQ_QUESTION_TOOL = 'ask_user_question';

const MAX_QUESTIONS = 3;
const MAX_OPTIONS = 6;
const MAX_QUESTION_CHARS = 2000;
const MAX_DETAIL_CHARS = 2000;
const MAX_OPTION_CHARS = 120;
const MAX_ANSWER_CHARS = 2000;
const MAX_CALLS_PER_TURN = 32;
const MAX_SEEN_INPUTS = 10_000;
const INPUT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_EVENT_SEQUENCES = 10_000;
const EVENT_SEQUENCE_TTL_MS = 5 * 60 * 1000;
const EVENT_PREFIX = 'INTERACTION_CREATE:';
const QUESTION_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const CALL_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const OPEN_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const MESSAGE_ID = /^[\x21-\x7e]{1,256}$/u;
const RAW_EVENT_ID = /^[A-Za-z0-9_:+./=-]{1,256}$/u;
const EVENT_ID = /^INTERACTION_CREATE:[A-Za-z0-9_:+./=-]{1,256}$/u;
const QUESTION_STATUSES = ['answered', 'busy', 'cancelled', 'timed-out', 'failed', 'unknown'];

const questionExecution = new AsyncLocalStorage();
const eventSequences = new Map();

function randomToken() {
    return randomBytes(18).toString('base64url');
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, required, optional = []) {
    return isPlainObject(value) && required.every((key) => Object.hasOwn(value, key))
        && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function boundedText(value, maximum) {
    return typeof value === 'string' && value.trim().length > 0
        && Array.from(value).length <= maximum
        && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value);
}

function normalizeQuestions(args) {
    if (!exactKeys(args, ['requestId', 'questions']) || typeof args.requestId !== 'string'
        || !/^[A-Za-z0-9_-]{1,64}$/u.test(args.requestId)
        || !Array.isArray(args.questions) || args.questions.length < 1 || args.questions.length > MAX_QUESTIONS) return undefined;
    const ids = new Set();
    const questions = [];
    for (const item of args.questions) {
        if (!exactKeys(item, ['id', 'question'], ['header', 'detail', 'options', 'multi_select'])
            || typeof item.id !== 'string' || !QUESTION_ID.test(item.id) || ids.has(item.id)
            || !boundedText(item.question, MAX_QUESTION_CHARS)
            || (item.header !== undefined && !boundedText(item.header, 80))
            || (item.detail !== undefined && !boundedText(item.detail, MAX_DETAIL_CHARS))
            || (item.multi_select !== undefined && typeof item.multi_select !== 'boolean')) return undefined;
        ids.add(item.id);
        const question = {
            id: item.id,
            question: item.question.trim(),
            ...(item.header !== undefined ? { header: item.header.trim() } : {}),
            ...(item.detail !== undefined ? { detail: item.detail.trim() } : {}),
            ...(item.multi_select !== undefined ? { multiSelect: item.multi_select } : {}),
        };
        if (item.options !== undefined) {
            if (!Array.isArray(item.options) || item.options.length > MAX_OPTIONS) return undefined;
            const options = [];
            for (const option of item.options) {
                if (!exactKeys(option, ['label'], ['description']) || !boundedText(option.label, MAX_OPTION_CHARS)
                    || (option.description !== undefined && !boundedText(option.description, MAX_DETAIL_CHARS))) return undefined;
                options.push({ label: option.label.trim(), ...(option.description !== undefined ? { description: option.description.trim() } : {}) });
            }
            question.options = options;
        }
        questions.push(question);
    }
    // Bound the aggregate rendered payload before any network operation. This
    // uses the group hint even for C2C so a later question cannot fail halfway
    // through a valid multi-question request.
    if (questions.some((question) => Array.from(renderQuestion(question, true)).length > MAX_QUESTION_CHARS)) return undefined;
    return { requestId: args.requestId, questions };
}

function safeCallId(value) {
    return typeof value === 'string' && CALL_ID.test(value);
}

function sameRecord(record, scope, source) {
    return Boolean(record && scope?.active && source
        && record === scope.record && source.record === record
        && record.agent === scope.agent && record.agent === source.agent
        && record.sessionId === source.sessionId && record.sessionId === scope.recordSessionId
        && record.sessionKey && record.scope === source.replyTarget.scope
        && record.peerId === source.replyTarget.targetId
        && source.ownerId && OPEN_ID.test(source.ownerId));
}

function questionFailure(exec, normalized) {
    if (!safeCallId(exec?.callId)) return 'A valid question tool-call id is required.';
    if (!normalized || !isPlainObject(exec?.arguments)) {
        return 'Question tool arguments do not match the allowed schema.';
    }
    const executionArguments = normalizeQuestions(exec.arguments);
    if (!executionArguments || JSON.stringify(executionArguments) !== JSON.stringify(normalized)) {
        return 'Question tool arguments do not match the authorized execution payload.';
    }
    // Native tool pre-execution runs before the ordinary execution wrapper.
    // Bind its registry-minted execution object here so later dispatch cannot
    // adopt a different document/generation turn for the same call.
    bindDocumentExecution(exec);
    const scope = getBoundGenerationTurn(exec);
    const source = getGenerationRequest(scope, normalized.requestId, 'question');
    if (!source || !sameRecord(scope?.record, scope, source) || source.agent !== exec.agent) {
        return 'This requestId is not authorized for the current original QQ message.';
    }
    return undefined;
}

function escapeMarkdown(value) {
    return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
        .replace(/@everyone/giu, '＠everyone').replace(/@here/giu, '＠here');
}

function buttonLabel(value) {
    const safe = value.replace(/[\r\n\t]/gu, ' ').trim();
    return Array.from(safe).slice(0, 10).join('') || '选择';
}

function renderQuestion(question, requireMention, buttonsAvailable = true) {
    const lines = [];
    if (question.header) lines.push(`**${escapeMarkdown(question.header)}**`);
    lines.push(`${escapeMarkdown(question.question)}${question.multiSelect ? '（可多选）' : ''}`);
    if (question.detail) lines.push(escapeMarkdown(question.detail));
    const options = question.options ?? [];
    options.forEach((option, index) => {
        lines.push(`${index + 1}. ${escapeMarkdown(option.label)}${option.description ? ` · ${escapeMarkdown(option.description)}` : ''}`);
    });
    if (options.length > 0) {
        lines.push('');
        const gate = requireMention ? '（群聊需 @机器人）' : '';
        lines.push(question.multiSelect
            ? `> 回复选项编号，可多选并用逗号分隔（如 1,3）${gate}；也可以直接输入想法。`
            : `${buttonsAvailable ? '> 点击按钮选择，或回复选项编号' : '> 回复选项编号'}${gate}；也可以直接输入想法。`);
    }
    else if (requireMention) lines.push('> 群聊回答请先 @机器人。');
    return lines.join('\n');
}

function questionKeyboard(question, token, ownerId) {
    if (question.multiSelect || !question.options?.length) return undefined;
    const buttons = question.options.map((option, index) => ({
        id: `q-${token.slice(0, 16)}-${index}`,
        render_data: { label: buttonLabel(option.label), visited_label: '✓ 已选', style: 1 },
        action: {
            type: 1,
            permission: { type: 0, specify_user_ids: [ownerId] },
            data: JSON.stringify({ t: 'question', q: question.id, token, i: index }),
            unsupport_tips: '请回复题号和选项编号',
        },
    }));
    const rows = [];
    for (let index = 0; index < buttons.length; index += 5) rows.push({ buttons: buttons.slice(index, index + 5) });
    return { content: { rows } };
}

function answerFromText(question, rawText) {
    if (typeof rawText !== 'string') return { kind: 'invalid' };
    const text = rawText.trim();
    if (!text || Array.from(text).length > MAX_ANSWER_CHARS) return { kind: 'invalid' };
    const options = question.options ?? [];
    if (options.length > 0 && /^[\d\s,，、;；./]+$/u.test(text)) {
        const parts = text.split(/(?:\s*[,，、;；./]\s*|\s+)/u);
        if (parts.length === 0 || parts.some((part) => !/^\d{1,2}$/u.test(part))) return { kind: 'invalid' };
        const indices = parts.map(Number);
        if (indices.some((index) => index < 1 || index > options.length)) return { kind: 'invalid' };
        if (!question.multiSelect && indices.length !== 1) return { kind: 'invalid' };
        const selectedIndices = [...new Set(indices)];
        return { kind: 'answer', answer: { id: question.id, selected: selectedIndices.map((index) => options[index - 1].label) } };
    }
    if (options.length > 0) {
        const exact = options.find((option) => option.label.toLocaleLowerCase() === text.toLocaleLowerCase());
        if (exact) return { kind: 'answer', answer: { id: question.id, selected: [exact.label] } };
    }
    return { kind: 'answer', answer: { id: question.id, selected: [], custom: text } };
}

function answerFromButton(question, index) {
    const option = question.options?.[index];
    return option ? { id: question.id, selected: [option.label] } : undefined;
}

function eventIdentity(event) {
    if (!event || !RAW_EVENT_ID.test(event.id ?? '')) return undefined;
    const hasGroup = event.group_openid !== undefined || event.group_member_openid !== undefined;
    const hasC2c = event.user_openid !== undefined;
    if (event.scene === 'group' || (event.scene === undefined && hasGroup && !hasC2c)) {
        if ((event.chat_type !== undefined && event.chat_type !== 1) || hasC2c) return undefined;
        if (!OPEN_ID.test(event.group_openid ?? '') || !OPEN_ID.test(event.group_member_openid ?? '')) return undefined;
        return { scope: 'group', targetId: event.group_openid, senderId: event.group_member_openid,
            eventId: `${EVENT_PREFIX}${event.id}` };
    }
    if (event.scene === 'c2c' || (event.scene === undefined && hasC2c && !hasGroup)) {
        if ((event.chat_type !== undefined && event.chat_type !== 2) || hasGroup) return undefined;
        if (event.scene !== undefined && event.scene !== 'c2c') return undefined;
        if (!OPEN_ID.test(event.user_openid ?? '')) return undefined;
        return { scope: 'c2c', targetId: event.user_openid, senderId: event.user_openid,
            eventId: `${EVENT_PREFIX}${event.id}` };
    }
    return undefined;
}

function parseButtonData(value) {
    if (typeof value !== 'string' || value.length > 512) return undefined;
    try {
        const parsed = JSON.parse(value);
        if (!exactKeys(parsed, ['t', 'q', 'token', 'i']) || parsed.t !== 'question'
            || !QUESTION_ID.test(parsed.q ?? '') || typeof parsed.token !== 'string'
            || !/^[A-Za-z0-9_-]{16,64}$/u.test(parsed.token)
            || !Number.isSafeInteger(parsed.i) || parsed.i < 0 || parsed.i >= MAX_OPTIONS) return undefined;
        return parsed;
    }
    catch { return undefined; }
}

function inputDedupKey(appId, scope, targetId, kind, rawId) {
    return JSON.stringify([appId, scope, targetId, kind, rawId]);
}

function trimInputDedup(entries, now) {
    for (const [key, timestamp] of entries) {
        if (now - timestamp > INPUT_TTL_MS) entries.delete(key);
    }
    while (entries.size >= MAX_SEEN_INPUTS) entries.delete(entries.keys().next().value);
}

/** Allocate a distinct passive reply sequence for one authenticated interaction event. */
export function allocateQuestionEventSequence(target, now = Date.now()) {
    if (!target || target.questionEvent !== true || !['group', 'c2c'].includes(target.scope)
        || !OPEN_ID.test(target.targetId ?? '') || !EVENT_ID.test(target.eventId ?? '')) return undefined;
    for (const [key, entry] of eventSequences) if (now - entry.updatedAt > EVENT_SEQUENCE_TTL_MS) eventSequences.delete(key);
    const key = JSON.stringify([target.scope, target.targetId, target.eventId]);
    let entry = eventSequences.get(key);
    if (!entry) {
        if (eventSequences.size >= MAX_EVENT_SEQUENCES) eventSequences.delete(eventSequences.keys().next().value);
        entry = { next: 1, updatedAt: now };
        eventSequences.set(key, entry);
    }
    if (entry.next > 65535) return undefined;
    const sequence = entry.next++;
    entry.updatedAt = now;
    return sequence;
}

export function questionToolSchema() {
    return {
        type: 'object',
        properties: {
            requestId: { type: 'string', minLength: 1, maxLength: 64, description: 'Opaque requestId from the matching original QQ request metadata.' },
            questions: {
                type: 'array', minItems: 1, maxItems: MAX_QUESTIONS,
                description: 'Each individual rendered question must fit within 2000 Unicode code points, including its header, details, numbered options and instructions. Every question is validated before any send.',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' },
                        header: { type: 'string', minLength: 1, maxLength: 80 },
                        question: { type: 'string', minLength: 1, maxLength: MAX_QUESTION_CHARS },
                        detail: { type: 'string', minLength: 1, maxLength: MAX_DETAIL_CHARS },
                        options: {
                            type: 'array', maxItems: MAX_OPTIONS,
                            items: {
                                type: 'object',
                                properties: {
                                    label: { type: 'string', minLength: 1, maxLength: MAX_OPTION_CHARS },
                                    description: { type: 'string', minLength: 1, maxLength: MAX_DETAIL_CHARS },
                                },
                                required: ['label'], additionalProperties: false,
                            },
                        },
                        multi_select: { type: 'boolean' },
                    },
                    required: ['id', 'question'], additionalProperties: false,
                },
            },
        },
        required: ['requestId', 'questions'], additionalProperties: false,
    };
}

function outputSchema() {
    return {
        type: 'object',
        properties: {
            status: { type: 'string', enum: QUESTION_STATUSES },
            answers: {
                type: 'array',
                items: {
                    type: 'object', properties: {
                        id: { type: 'string' }, selected: { type: 'array', items: { type: 'string' } }, custom: { type: 'string' },
                    }, required: ['id', 'selected'], additionalProperties: false,
                },
            },
        },
        required: ['status', 'answers'], additionalProperties: false,
    };
}

function statusResult(status, answers = []) {
    return { status, answers };
}

function logQuestionOutcome(logger, stage, status) {
    if (!['provider', 'send', 'wait'].includes(stage)
        || !['busy', 'failed', 'timed-out', 'unknown'].includes(status)) return;
    try { logger?.warn?.(`[qqbot-question] ${JSON.stringify({ stage, status })}`); }
    catch { /* logging must not affect question handling */ }
}

function codedError(code) {
    const error = new Error('QQ question request ended.');
    error.name = 'UserQuestionError';
    error.code = code;
    return error;
}

function terminalStatus(error) {
    if (error?.code === 'QQ_QUESTION_BUSY') return 'busy';
    if (error?.code === 'QQ_QUESTION_TIMEOUT') return 'timed-out';
    if (error?.code === 'QQ_QUESTION_UNKNOWN') return 'unknown';
    if (error?.code === 'QQ_QUESTION_FAILED') return 'failed';
    if (error?.code === 'QQ_QUESTION_CANCELLED' || error?.code === 'ASK_ABORTED'
        || error?.name === 'AbortError') return 'cancelled';
    return 'failed';
}

export class QuestionChannel {
    pending = new Map();
    sessionClaims = new Map();
    seenInputs = new Map();
    manager;
    sender;
    config;
    logger;
    now;
    setTimeoutImpl;
    clearTimeoutImpl;
    service;
    provider;
    providerDisposer;
    disposed = false;

    constructor(manager, sender, config = {}, logger = {}, options = {}) {
        this.manager = manager;
        this.sender = sender;
        this.config = config;
        this.logger = logger;
        this.now = options.now ?? Date.now;
        this.setTimeoutImpl = options.setTimeout ?? setTimeout;
        this.clearTimeoutImpl = options.clearTimeout ?? clearTimeout;
    }

    install(ctx) {
        if (this.provider) return;
        const service = ctx?.get?.('userQuestions');
        if (!service || typeof service.ask !== 'function' || typeof ctx?.on !== 'function') {
            throw new Error('QQ questions require the pinned userQuestions.ask service and waterfall provider API.');
        }
        this.service = service;
        this.disposed = false;
        this.provider = async (request, next) => {
            const trusted = questionExecution.getStore();
            if (!trusted || request?.agent !== trusted.agent || request?.signal !== trusted.signal
                || request?.questions !== trusted.questions || trusted.channel !== this) return next();
            return this.askViaQQ(trusted);
        };
        const disposer = ctx.on('user-questions/request', this.provider, { prepend: true });
        this.providerDisposer = typeof disposer === 'function' ? disposer : undefined;
        this.logger?.info?.('[qqbot-question] controlled QQ question provider installed');
    }

    uninstall() {
        this.disposed = true;
        for (const entry of [...this.pending.values()]) this.finish(entry, 'cancelled');
        this.pending.clear();
        this.sessionClaims.clear();
        if (typeof this.providerDisposer === 'function') {
            try { this.providerDisposer(); } catch { /* shutdown must stay best-effort */ }
        }
        this.providerDisposer = undefined;
        this.service = undefined;
        this.provider = undefined;
        this.seenInputs.clear();
    }

    cancelPending(sessionKey) {
        const entry = this.pending.get(sessionKey);
        if (entry) this.finish(entry, 'cancelled');
    }

    cancelGeneration(scope, requestId, reason = 'cancelled') {
        for (const entry of this.pending.values()) {
            if (entry.scope === scope && entry.requestId === requestId) {
                this.finish(entry, reason === 'unknown' ? 'unknown' : 'cancelled');
                return true;
            }
        }
        return false;
    }

    executeTool(args, exec) {
        const normalized = normalizeQuestions(args);
        const failure = questionFailure(exec, normalized);
        if (failure) return Promise.resolve(statusResult('failed'));
        const scope = getBoundGenerationTurn(exec);
        const source = getGenerationRequest(scope, normalized.requestId, 'question');
        const callId = exec.callId;
        scope.questionCalls ??= new Map();
        scope.questionPayloadCalls ??= new Map();
        const fingerprint = JSON.stringify(normalized);
        const cached = scope.questionCalls.get(callId);
        if (cached) return cached.fingerprint === fingerprint ? cached.promise : Promise.resolve(statusResult('failed'));
        if (scope.questionCalls.size >= MAX_CALLS_PER_TURN) return Promise.resolve(statusResult('failed'));
        const payloadKey = JSON.stringify([normalized.requestId, fingerprint]);
        const payloadCached = scope.questionPayloadCalls.get(payloadKey);
        if (payloadCached) {
            scope.questionCalls.set(callId, { fingerprint, promise: payloadCached });
            return payloadCached;
        }
        const record = source?.record;
        if (!record || this.disposed) {
            return Promise.resolve(statusResult('cancelled'));
        }
        const oldPending = this.pending.get(record.sessionKey);
        if (oldPending && !this.isCurrent(oldPending)) this.finish(oldPending, 'cancelled');
        if (this.pending.has(record.sessionKey) || this.sessionClaims.has(record.sessionKey)) {
            const busy = Promise.resolve(statusResult('busy'));
            scope.questionCalls.set(callId, { fingerprint, promise: busy });
            return busy;
        }
        let signal;
        try { signal = getGenerationRequestSignal(scope, exec.signal, 'question'); }
        catch { return Promise.resolve(statusResult('cancelled')); }
        const renewFinalReply = bindMergeBatchQuestionReply(record, exec.agent, record.sessionId, source.replyTarget);
        if (typeof renewFinalReply !== 'function') return Promise.resolve(statusResult('cancelled'));
        const claim = Object.freeze({ record, callId, token: randomToken() });
        this.sessionClaims.set(record.sessionKey, claim);
        const trusted = Object.freeze({
            channel: this,
            scope,
            source,
            requestId: normalized.requestId,
            record,
            agent: exec.agent,
            signal,
            questions: normalized.questions,
            renewFinalReply,
            claim,
        });
        let operation;
        try {
            operation = questionExecution.run(trusted, () => this.service.ask({
                questions: trusted.questions,
                agent: trusted.agent,
                signal: trusted.signal,
            }));
        }
        catch (error) {
            if (this.sessionClaims.get(record.sessionKey) === claim) this.sessionClaims.delete(record.sessionKey);
            const status = terminalStatus(error);
            logQuestionOutcome(this.logger, 'provider', status);
            const failed = Promise.resolve(statusResult(status));
            scope.questionCalls.set(callId, { fingerprint, promise: failed });
            if (scope.questionPayloadCalls.size < MAX_CALLS_PER_TURN) scope.questionPayloadCalls.set(payloadKey, failed);
            return failed;
        }
        const tracked = trackGenerationOperation(scope, Promise.resolve(operation).then(
            (result) => statusResult('answered', Array.isArray(result?.answers) ? result.answers : []),
            (error) => {
                const status = terminalStatus(error);
                const stage = error?.stage ?? (status === 'timed-out' ? 'wait' : 'provider');
                logQuestionOutcome(this.logger, stage, status);
                return statusResult(status);
            },
        ).finally(() => {
            if (this.sessionClaims.get(record.sessionKey) === claim) this.sessionClaims.delete(record.sessionKey);
        }));
        scope.questionCalls.set(callId, { fingerprint, promise: tracked });
        if (scope.questionPayloadCalls.size < MAX_CALLS_PER_TURN) scope.questionPayloadCalls.set(payloadKey, tracked);
        void tracked.then((result) => {
            if (result?.status === 'busy' && scope.questionPayloadCalls.get(payloadKey) === tracked) {
                scope.questionPayloadCalls.delete(payloadKey);
            }
        });
        return tracked;
    }

    askViaQQ(trusted) {
        const { scope, source, record, requestId, signal, questions, claim } = trusted;
        if (this.disposed || signal?.aborted || !sameRecord(record, scope, source)
            || this.manager?.findBySessionId?.(record.sessionId) !== record
            || this.sessionClaims.get(record.sessionKey) !== claim) {
            return Promise.reject(codedError('QQ_QUESTION_CANCELLED'));
        }
        if (this.pending.has(record.sessionKey)) return Promise.reject(codedError('QQ_QUESTION_BUSY'));
        return new Promise((resolve, reject) => {
            const entry = {
                scope, source, record, requestId, questions, index: 0, collected: [],
                phase: 'sending-initial', token: randomToken(), credential: source.replyTarget,
                pendingAnswer: undefined, resolve, reject, signal, renewFinalReply: trusted.renewFinalReply,
                timer: undefined, onAbort: undefined,
            };
            this.pending.set(record.sessionKey, entry);
            entry.onAbort = () => this.finish(entry, 'cancelled');
            signal.addEventListener('abort', entry.onAbort, { once: true });
            void this.deliverQuestion(entry, true);
        });
    }

    async deliverQuestion(entry, initial) {
        if (!this.isCurrent(entry)) return;
        const question = entry.questions[entry.index];
        if (!question) return this.finish(entry, 'failed');
        const token = entry.token;
        const keyboard = questionKeyboard(question, token, entry.source.ownerId);
        const content = renderQuestion(question, entry.record.scope === 'group');
        let result;
        try {
            result = await this.send(entry, content, keyboard, token);
            if (result?.reason === 'keyboard-unsupported' && keyboard) {
                if (!this.isCurrent(entry) || entry.signal.aborted) return;
                result = await this.send(entry,
                    renderQuestion(question, entry.record.scope === 'group', false), undefined, token);
            }
        }
        catch {
            this.finish(entry, 'failed');
            return;
        }
        if (!this.isCurrent(entry)) return;
        if (entry.signal.aborted) return this.finish(entry, 'cancelled');
        if (!result?.sent || typeof result.messageId !== 'string' || !MESSAGE_ID.test(result.messageId)) {
            return this.finish(entry, result?.reason === 'unknown' ? 'unknown' : 'failed');
        }
        entry.deliveredMessageId = result.messageId;
        entry.phase = 'active';
        entry.timer = this.setTimeoutImpl(() => this.finish(entry, 'timed-out'), this.timeoutMs());
        entry.timer?.unref?.();
        if (initial && entry.pendingAnswer) {
            const pending = entry.pendingAnswer;
            entry.pendingAnswer = undefined;
            this.acceptAnswer(entry, pending.answer, pending.credential);
        }
    }

    async send(entry, content, keyboard, token) {
        if (typeof this.sender?.sendQuestionMarkdown !== 'function') return { sent: false, reason: 'failed' };
        const credential = entry.credential;
        const replySequence = credential?.eventId
            ? allocateQuestionEventSequence({ ...credential, questionEvent: true, scope: entry.source.replyTarget.scope,
                targetId: entry.source.replyTarget.targetId }, this.now())
            : undefined;
        if (credential?.eventId && !replySequence) return { sent: false, reason: 'limit' };
        const senderRequest = Object.freeze({
            ownerId: entry.source.ownerId,
            replyTarget: Object.freeze({ ...credential }),
            ...(replySequence ? { replySequence } : {}),
            enqueueSend: entry.source.enqueueSend,
            isActive: () => this.isCurrent(entry) && entry.token === token && !entry.signal.aborted,
        });
        try {
            return await this.sender.sendQuestionMarkdown(senderRequest, content, keyboard, entry.signal);
        }
        catch {
            return { sent: false, reason: 'failed' };
        }
    }

    timeoutMs() {
        const configured = this.config.askTimeoutMs;
        return Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
    }

    tryAnswer(scope, targetId, senderId, text, rawMessageId, mentioned = false) {
        const record = this.manager?.getSessionRecord?.(scope, targetId);
        if (!record) return false;
        const entry = this.pending.get(record.sessionKey);
        if (!entry || entry.record !== record) return false;
        if (!this.isCurrent(entry)) {
            this.finish(entry, 'cancelled');
            return false;
        }
        if (!OPEN_ID.test(senderId ?? '') || senderId !== entry.source.ownerId
            || (scope === 'group' && mentioned !== true)) return false;
        if (typeof text !== 'string' || text.trim().length === 0) return false;
        const dedupe = this.markInput(scope, targetId, 'message', rawMessageId);
        if (dedupe !== 'new') return true;
        const question = entry.questions[entry.index];
        if (!question) return true;
        const parsed = answerFromText(question, text);
        if (entry.phase === 'sending-initial') {
            if (parsed.kind === 'answer' && !entry.pendingAnswer) {
                entry.pendingAnswer = { answer: parsed.answer, credential: { scope, targetId, msgId: rawMessageId } };
            }
            return true;
        }
        if (entry.phase !== 'active') return true;
        if (parsed.kind !== 'answer') return true;
        this.acceptAnswer(entry, parsed.answer, { scope, targetId, msgId: rawMessageId });
        return true;
    }

    handleInteraction(event) {
        const identity = eventIdentity(event);
        if (!identity) return false;
        const record = this.manager?.getSessionRecord?.(identity.scope, identity.targetId);
        if (!record) return false;
        const entry = this.pending.get(record.sessionKey);
        if (!entry || entry.record !== record || identity.senderId !== entry.source.ownerId) return false;
        if (!this.isCurrent(entry)) {
            this.finish(entry, 'cancelled');
            return false;
        }
        const button = parseButtonData(event.data?.resolved?.button_data);
        const question = entry.questions[entry.index];
        if (!button || !question || button.q !== question.id || button.token !== entry.token) return false;
        const answer = answerFromButton(question, button.i);
        if (!answer) return false;
        const dedupe = this.markInput(identity.scope, identity.targetId, 'interaction', event.id);
        if (dedupe !== 'new') return true;
        const credential = { scope: identity.scope, targetId: identity.targetId, eventId: identity.eventId };
        if (entry.phase === 'sending-initial') {
            if (!entry.pendingAnswer) entry.pendingAnswer = { answer, credential };
            return true;
        }
        if (entry.phase !== 'active') return true;
        this.acceptAnswer(entry, answer, credential);
        return true;
    }

    markInput(scope, targetId, kind, rawId) {
        if (typeof rawId !== 'string' || !(kind === 'message' ? MESSAGE_ID : RAW_EVENT_ID).test(rawId)) return 'invalid';
        const now = this.now();
        trimInputDedup(this.seenInputs, now);
        const key = inputDedupKey(this.config.appId ?? '', scope, targetId, kind, rawId);
        if (this.seenInputs.has(key)) return 'duplicate';
        this.seenInputs.set(key, now);
        return 'new';
    }

    acceptAnswer(entry, answer, credential) {
        if (!this.isCurrent(entry) || entry.phase !== 'active') return;
        if (!entry.renewFinalReply(credential)) return this.finish(entry, 'cancelled');
        this.clearTimer(entry);
        entry.collected.push(answer);
        entry.index += 1;
        if (entry.index >= entry.questions.length) {
            this.finish(entry, 'answered', entry.collected);
            return;
        }
        entry.credential = Object.freeze({ ...credential, ...(credential.eventId ? { questionEvent: true } : {}) });
        entry.index = Math.min(entry.index, entry.questions.length - 1);
        entry.token = randomToken();
        entry.phase = 'sending-next';
        void this.deliverQuestion(entry, false);
    }

    isCurrent(entry) {
        return !this.disposed && this.pending.get(entry.record.sessionKey) === entry
            && entry.scope?.active && !entry.signal?.aborted
            && sameRecord(entry.record, entry.scope, entry.source)
            && this.manager?.findBySessionId?.(entry.record.sessionId) === entry.record;
    }

    finish(entry, status, answers = []) {
        if (this.pending.get(entry.record.sessionKey) !== entry) return;
        this.pending.delete(entry.record.sessionKey);
        this.clearTimer(entry);
        if (entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
        entry.phase = 'finished';
        if (status === 'answered') entry.resolve({ answers });
        else {
            const code = status === 'timed-out' ? 'QQ_QUESTION_TIMEOUT'
                : status === 'unknown' ? 'QQ_QUESTION_UNKNOWN'
                    : status === 'busy' ? 'QQ_QUESTION_BUSY'
                        : status === 'failed' ? 'QQ_QUESTION_FAILED' : 'QQ_QUESTION_CANCELLED';
            const stage = status === 'timed-out' ? 'wait'
                : status === 'failed' || status === 'unknown' ? 'send'
                    : 'provider';
            const error = codedError(code);
            error.stage = stage;
            entry.reject(error);
        }
    }

    clearTimer(entry) {
        if (entry.timer !== undefined) this.clearTimeoutImpl(entry.timer);
        entry.timer = undefined;
    }
}

export function validateQuestionToolCall(exec) {
    const normalized = normalizeQuestions(exec?.arguments);
    return questionFailure(exec, normalized);
}

export function registerQuestionTool(ctx, channel) {
    const tools = ctx?.get?.('tools');
    if (typeof tools?.register !== 'function' || !(channel instanceof QuestionChannel)) {
        throw new Error('The controlled QQ question tool requires tools.register and QuestionChannel.');
    }
    tools.register({
        name: QQ_QUESTION_TOOL,
        description: 'Ask up to three sequential clarifying questions only when necessary to complete the matching original QQ request. Use its opaque requestId. Each complete rendered question including options and instructions is limited to 2000 Unicode code points. Single-choice options show owner-only buttons; multi-select uses numbered replies. Wait for each answer or terminal status; never repeat a completed or uncertain request.',
        parameters: questionToolSchema(),
        output: {
            schema: outputSchema(),
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
            return channel.executeTool(args, exec);
        },
    });
}

export function questionAnswerMiddleware(manager) {
    return async (ctx, next) => {
        const channel = manager?.questionChannel;
        if (!channel) return next();
        const text = typeof ctx?.message?.content === 'string' ? ctx.message.content.trim() : '';
        if (!text) return next();
        if (getOnebotDirectFallback(ctx) || matchOnebotDirectCommand(text)
            || /^\/[A-Za-z][A-Za-z0-9_-]*(?:\s|$)/u.test(text)) return next();
        const message = ctx.message;
        const raw = message.raw;
        const target = message.replyTarget ?? ctx.replyTarget;
        if (!raw || typeof raw.id !== 'string' || raw.id !== message.messageId
            || !target || !['group', 'c2c'].includes(target.scope)
            || message.kind !== target.scope
            || target.targetId !== (target.scope === 'group' ? raw.group_openid : raw.author?.user_openid)
            || (target.scope === 'group' ? raw.author?.member_openid : raw.author?.user_openid) !== message.senderId
            || (target.scope === 'group' && raw.user_openid !== undefined)
            || (target.scope === 'c2c' && raw.group_openid !== undefined)
            || (channel.config?.appId && ctx?.bot?.appId && channel.config.appId !== ctx.bot.appId)) {
            return next();
        }
        const messageId = raw.id;
        const handled = channel.tryAnswer(target.scope, target.targetId,
            ctx?.message?.senderId, text, messageId, ctx?.state?.mention?.wasMentioned === true);
        if (handled) {
            ctx.stop('question-answer');
            return;
        }
        await next();
    };
}
