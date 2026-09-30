import { randomInt as cryptoRandomInt } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import {
    documentExecutionFailure,
    getBoundDocumentExecution,
    getTurnRequestSignal,
    isBoundDocumentExecutionActive,
} from './qqbot-document-scope.mjs';
import {
    getHistorySnapshotEpoch,
    isHistoryStoreSuppressed,
    markHistorySnapshot,
} from './qqbot-session-recovery.mjs';

export const DICE_TOOL_NAME = 'qqbot_roll_dice';

const MAX_EXPRESSION_LENGTH = 128;
const MAX_TERMS = 8;
const MAX_SIDES = 1_000_000;
const MAX_MODIFIER = 1_000_000;
const MAX_REPEAT = 20;
const MAX_DICE_PER_CALL = 100;
const MAX_TURN_CALLS = 8;
const MAX_TURN_DICE = 200;
const DIRECT_RATE_WINDOW_MS = 10_000;
const MAX_DIRECT_SENDER_ATTEMPTS = 10;
const MAX_DIRECT_GROUP_ATTEMPTS = 30;
const DICE_TERM_PATTERN = /^([0-9]*)d([0-9]+)(?:(kh|kl)([0-9]+))?/i;

function safeInteger(value, minimum, maximum, label) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${label}须为 ${minimum}～${maximum} 的整数。`);
    }
    return value;
}

function parseDiceTerm(input, offset) {
    const match = DICE_TERM_PATTERN.exec(input.slice(offset));
    if (!match) return undefined;
    const count = match[1] === '' ? 1 : Number(match[1]);
    const sides = Number(match[2]);
    safeInteger(count, 1, MAX_DICE_PER_CALL, '骰子数量');
    safeInteger(sides, 1, MAX_SIDES, '面数');
    const keepMode = match[3]?.toLowerCase();
    const keepCount = keepMode ? Number(match[4]) : undefined;
    if (keepMode) safeInteger(keepCount, 1, count, '保留数量');
    return {
        term: { kind: 'dice', count, sides, keepMode, keepCount },
        length: match[0].length,
    };
}

/** Parse a bounded dice expression without interpreting it as program text. */
export function parseDiceExpression(expression) {
    if (typeof expression !== 'string' || expression.length === 0 || expression.length > MAX_EXPRESSION_LENGTH) {
        throw new Error(`骰式长度须为 1～${MAX_EXPRESSION_LENGTH} 个字符。`);
    }
    const input = expression.replaceAll(' ', '');
    if (input.length === 0) throw new Error('请提供骰式，例如 d20 或 2d6+3。');

    const terms = [];
    let offset = 0;
    let totalDice = 0;
    const first = parseDiceTerm(input, offset);
    if (!first) throw new Error('骰式必须以骰子开头，例如 d20。');
    terms.push({ sign: 1, ...first.term });
    offset += first.length;
    totalDice += first.term.count;

    while (offset < input.length) {
        if (terms.length >= MAX_TERMS) throw new Error(`骰式最多包含 ${MAX_TERMS} 项。`);
        const operator = input[offset];
        if (operator !== '+' && operator !== '-') throw new Error('骰子与整数修正值之间只能使用 + 或 -。');
        offset++;
        if (offset >= input.length) throw new Error('骰式不能以 + 或 - 结尾。');

        const dice = parseDiceTerm(input, offset);
        if (dice) {
            terms.push({ sign: operator === '+' ? 1 : -1, ...dice.term });
            offset += dice.length;
            totalDice += dice.term.count;
            continue;
        }

        const integer = /^[0-9]+/.exec(input.slice(offset));
        if (!integer) throw new Error('+ 或 - 后应为骰组或整数修正值。');
        const value = Number(integer[0]);
        safeInteger(value, 0, MAX_MODIFIER, '整数修正值');
        terms.push({ kind: 'modifier', sign: operator === '+' ? 1 : -1, value });
        offset += integer[0].length;
    }

    if (terms.length > MAX_TERMS) throw new Error(`骰式最多包含 ${MAX_TERMS} 项。`);
    return { terms, totalDice, canonical: terms.map(formatTerm).join('') };
}

function formatTerm(term, index) {
    const sign = index === 0 ? '' : (term.sign > 0 ? '+' : '-');
    if (term.kind === 'modifier') return `${sign}${term.value}`;
    const count = term.count === 1 ? '' : term.count;
    const keep = term.keepMode ? `${term.keepMode}${term.keepCount}` : '';
    return `${sign}${count}d${term.sides}${keep}`;
}

function formatRoll(parsed, rolledTerms, total) {
    const parts = rolledTerms.map(({ term, rolls, kept }, termIndex) => {
        if (term.kind === 'modifier') return `${term.sign > 0 ? '+' : '-'}${term.value}`;
        const count = term.count === 1 ? '' : term.count;
        const keep = term.keepMode ? `${term.keepMode}${term.keepCount}` : '';
        const dice = rolls.map((value, index) => kept.has(index) ? String(value) : `${value}×`).join(',');
        const sign = term.sign < 0 ? '-' : (termIndex > 0 ? '+' : '');
        return `${sign}${count}d${term.sides}${keep}[${dice}]`;
    });
    return `${parsed.canonical}: ${parts.join(' ')} = ${total}`;
}

/** Generate rolls after the complete expression and request bounds validate. */
export function rollDice(expression, repeat = 1, randomInt = cryptoRandomInt) {
    const parsed = parseDiceExpression(expression);
    safeInteger(repeat, 1, MAX_REPEAT, '重复次数');
    if (parsed.totalDice * repeat > MAX_DICE_PER_CALL) {
        throw new Error(`单次请求最多掷 ${MAX_DICE_PER_CALL} 颗骰子。`);
    }
    if (typeof randomInt !== 'function') throw new TypeError('A secure random integer source is required.');

    const results = [];
    for (let iteration = 0; iteration < repeat; iteration++) {
        let total = 0;
        const rolledTerms = [];
        for (const term of parsed.terms) {
            if (term.kind === 'modifier') {
                total += term.sign * term.value;
                rolledTerms.push({ term, kept: new Set() });
                continue;
            }
            const rolls = Array.from({ length: term.count }, () => {
                let value;
                try {
                    value = randomInt(1, term.sides + 1);
                }
                catch {
                    throw new Error('安全随机数生成失败。');
                }
                if (!Number.isSafeInteger(value) || value < 1 || value > term.sides) {
                    throw new Error('安全随机数生成失败。');
                }
                return value;
            });
            let kept = new Set(rolls.map((_value, index) => index));
            if (term.keepMode) {
                const sorted = rolls.map((value, index) => ({ value, index })).sort((left, right) =>
                    term.keepMode === 'kh' ? right.value - left.value || left.index - right.index
                        : left.value - right.value || left.index - right.index);
                kept = new Set(sorted.slice(0, term.keepCount).map(({ index }) => index));
            }
            const subtotal = rolls.reduce((sum, value, index) => sum + (kept.has(index) ? value : 0), 0);
            total += term.sign * subtotal;
            rolledTerms.push({ term, rolls, kept });
        }
        results.push({ total, text: formatRoll(parsed, rolledTerms, total) });
    }
    const text = repeat === 1
        ? results[0].text
        : results.map((result, index) => `${index + 1}) ${result.text}`).join('\n');
    return { expression: parsed.canonical, results, text, totalDice: parsed.totalDice * repeat };
}

function exactArgumentsFingerprint(args) {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('骰子参数必须是对象。');
    }
    if (Object.getPrototypeOf(args) !== Object.prototype && Object.getPrototypeOf(args) !== null) {
        throw new Error('骰子参数必须是普通对象。');
    }
    const keys = Reflect.ownKeys(args);
    if (keys.some((key) => typeof key !== 'string') || keys.some((key) => !['expression', 'repeat'].includes(key))) {
        throw new Error('骰子参数只接受 expression 和 repeat。');
    }
    const descriptors = Object.getOwnPropertyDescriptors(args);
    for (const key of keys) {
        if (!Object.hasOwn(descriptors[key], 'value')) throw new Error('骰子参数必须是普通值。');
    }
    if (!Object.hasOwn(descriptors, 'expression')) throw new Error('必须提供 expression。');
    if (Object.hasOwn(descriptors, 'repeat') && descriptors.repeat.value === undefined) {
        throw new Error('repeat 须为 1～20 的整数。');
    }
    if (typeof descriptors.expression.value !== 'string') throw new Error('expression 必须是字符串。');
    if (descriptors.expression.value.length === 0 || descriptors.expression.value.length > MAX_EXPRESSION_LENGTH) {
        throw new Error(`骰式长度须为 1～${MAX_EXPRESSION_LENGTH} 个字符。`);
    }
    const repeatPresent = Object.hasOwn(descriptors, 'repeat');
    const repeat = repeatPresent ? descriptors.repeat.value : 1;
    safeInteger(repeat, 1, MAX_REPEAT, '重复次数');
    // Include property presence and the exact expression. Replays must not turn
    // into a new roll just because an SDK retries or mutates a call id.
    return {
        expression: descriptors.expression.value,
        repeat,
        fingerprint: JSON.stringify([descriptors.expression.value, repeatPresent, repeat]),
    };
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw new Error('本轮骰子请求已取消。');
}

function diceScopeFailure(exec) {
    const reason = documentExecutionFailure(exec);
    if (reason === 'No active QQ message authorizes this tool call.') return '没有有效的 QQ 消息回合授权本次掷骰。';
    if (reason === 'This tool call belongs to an expired QQ message.') return '此骰子调用所属的 QQ 消息已过期。';
    if (reason) return '当前 QQ 消息回合不允许掷骰。';
    const scope = getBoundDocumentExecution(exec);
    if (!scope || !scope.diceCalls || !(scope.diceCalls instanceof Map)) {
        return '掷骰需要有效的 QQ 消息回合。';
    }
    return undefined;
}

/** Validate authorization, retry identity, and quotas again at tool execution. */
export function executeDiceTool(args, exec) {
    const scopeFailure = diceScopeFailure(exec);
    if (scopeFailure) throw new Error(scopeFailure);
    const scope = getBoundDocumentExecution(exec);
    const callId = exec?.callId;
    if (typeof callId !== 'string' || callId.length === 0 || callId.length > 256) {
        throw new Error('骰子调用缺少有效的调用 ID。');
    }
    const signal = getTurnRequestSignal(scope, exec?.signal);
    throwIfAborted(signal);

    const normalized = exactArgumentsFingerprint(args);
    let parseError;
    try {
        const parsed = parseDiceExpression(normalized.expression);
        if (parsed.totalDice * normalized.repeat > MAX_DICE_PER_CALL) {
            throw new Error(`单次请求最多掷 ${MAX_DICE_PER_CALL} 颗骰子。`);
        }
    }
    catch (error) {
        parseError = error instanceof Error ? error.message : '骰子参数无效。';
    }

    const existing = scope.diceCalls.get(callId);
    if (existing) {
        if (existing.fingerprint !== normalized.fingerprint) {
            throw new Error('此骰子调用 ID 已用于不同参数。');
        }
        if (existing.error) throw new Error(existing.error);
        throwIfAborted(signal);
        if (!isBoundDocumentExecutionActive(exec)) throw new Error('此骰子调用所属的 QQ 消息已过期。');
        return cloneDiceResult(existing.result);
    }
    if (scope.diceCalls.size >= MAX_TURN_CALLS) throw new Error(`每轮 QQ 消息最多独立掷骰 ${MAX_TURN_CALLS} 次。`);

    let requestedDice = 0;
    if (!parseError) {
        const parsed = parseDiceExpression(normalized.expression);
        requestedDice = parsed.totalDice * normalized.repeat;
        if (scope.diceCount + requestedDice > MAX_TURN_DICE) {
            parseError = `每轮 QQ 消息最多生成 ${MAX_TURN_DICE} 颗骰子。`;
            requestedDice = 0;
        }
    }

    // Store a record before rolling so concurrent retries with one call ID
    // share one result and cannot charge quota or consume extra random values.
    const record = { fingerprint: normalized.fingerprint, pending: true };
    scope.diceCalls.set(callId, record);
    scope.diceCount += requestedDice;
    try {
        throwIfAborted(signal);
        if (parseError) throw new Error(parseError);
        const result = rollDice(normalized.expression, normalized.repeat);
        if (!isBoundDocumentExecutionActive(exec)) throw new Error('此骰子调用所属的 QQ 消息已过期。');
        throwIfAborted(signal);
        record.pending = false;
        record.result = result;
        return cloneDiceResult(result);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : '骰子生成失败。';
        record.pending = false;
        record.error = message;
        throw error instanceof Error ? error : new Error(message);
    }
}

function cloneDiceResult(result) {
    return {
        expression: result.expression,
        results: result.results.map(({ total, text }) => ({ total, text })),
        text: result.text,
        totalDice: result.totalDice,
    };
}

export function validateDiceToolCall(exec) {
    const scopeFailure = diceScopeFailure(exec);
    if (scopeFailure) return scopeFailure;
    const scope = getBoundDocumentExecution(exec);
    const callId = exec?.callId;
    if (typeof callId !== 'string' || callId.length === 0 || callId.length > 256) {
        return '骰子调用缺少有效的调用 ID。';
    }
    const signal = getTurnRequestSignal(scope, exec?.signal);
    if (signal?.aborted) return '本轮骰子请求已取消。';
    let normalized;
    try {
        normalized = exactArgumentsFingerprint(exec?.arguments);
    }
    catch (error) {
        return error instanceof Error ? error.message : '骰子参数无效。';
    }
    const existing = scope.diceCalls.get(callId);
    if (existing && existing.fingerprint !== normalized.fingerprint) return '此骰子调用 ID 已用于不同参数。';
    if (existing?.error) return existing.error;
    if (existing) return undefined;
        if (scope.diceCalls.size >= MAX_TURN_CALLS) return `每轮 QQ 消息最多独立掷骰 ${MAX_TURN_CALLS} 次。`;
    let parsed;
    try {
        parsed = parseDiceExpression(normalized.expression);
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : '骰式无效。';
        return cacheDiceFailure(scope, callId, normalized.fingerprint, reason);
    }
    const requestedDice = parsed.totalDice * normalized.repeat;
    if (requestedDice > MAX_DICE_PER_CALL) {
        return cacheDiceFailure(scope, callId, normalized.fingerprint, `单次请求最多掷 ${MAX_DICE_PER_CALL} 颗骰子。`);
    }
    if (scope.diceCount + requestedDice > MAX_TURN_DICE) {
        return cacheDiceFailure(scope, callId, normalized.fingerprint, `每轮 QQ 消息最多生成 ${MAX_TURN_DICE} 颗骰子。`);
    }
    return undefined;
}

function cacheDiceFailure(scope, callId, fingerprint, message) {
    const existing = scope.diceCalls.get(callId);
    if (existing) {
        if (existing.fingerprint !== fingerprint) return '此骰子调用 ID 已用于不同参数。';
        return existing.error ?? message;
    }
    if (scope.diceCalls.size < MAX_TURN_CALLS) scope.diceCalls.set(callId, { fingerprint, error: message, pending: false });
    return message;
}

export function registerDiceTool(ctx) {
    const tools = ctx.get('tools');
    if (typeof tools?.register !== 'function') throw new Error('Dice rolling requires the native dsh tools.register API.');
    tools.register({
        name: DICE_TOOL_NAME,
        description: 'Roll bounded tabletop RPG dice, for example d20+5, 2d6+1d4+3, 2d20kh1+5, or 4d6kh3 with repeat 6. Returns actual rolls, discarded dice, and totals; × marks discarded dice. Never invent or alter the result.',
        parameters: {
            type: 'object',
            properties: {
                expression: { type: 'string', minLength: 1, maxLength: MAX_EXPRESSION_LENGTH, description: 'Dice expression: dice first, then up to seven +/- dice or integer terms; optional khN or klN.' },
                repeat: { type: 'integer', minimum: 1, maximum: MAX_REPEAT, description: 'Repeat the full expression 1 to 20 times; default 1.' },
            },
            required: ['expression'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    expression: { type: 'string' },
                    results: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: { total: { type: 'integer' }, text: { type: 'string' } },
                            required: ['total', 'text'],
                            additionalProperties: false,
                        },
                    },
                    text: { type: 'string' },
                    totalDice: { type: 'integer' },
                },
                required: ['expression', 'results', 'text', 'totalDice'],
                additionalProperties: false,
            },
            render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        execute(args, exec) {
            return executeDiceTool(args, exec);
        },
    });
}

/** Normalize only the QQ bot marker removed by the pinned contentSanitizer. */
export function normalizeDiceCommandContent(content, appId) {
    if (typeof content !== 'string') return '';
    if (typeof appId !== 'string' || appId.length === 0) return content.trim();
    const escaped = appId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return content.replace(new RegExp(`<@!?${escaped}>\\s*`, 'g'), '').trim();
}

export function isDiceCommandCandidate(content, appId) {
    const normalized = normalizeDiceCommandContent(content, appId);
    return /^\.r(?:\s|$)/iu.test(normalized);
}

function parseDiceCommand(content, appId) {
    const normalized = normalizeDiceCommandContent(content, appId);
    const match = /^\.r(?:\s+([\s\S]*))?$/iu.exec(normalized);
    if (!match) return undefined;
    const rawExpression = match[1] ?? '';
    if (rawExpression.length > MAX_EXPRESSION_LENGTH + 4) return { error: '骰式命令过长。' };
    let expression = rawExpression.trim();
    let repeat = 1;
    const repeatSuffix = / +[xX]([0-9]+)$/.exec(expression);
    if (repeatSuffix) {
        repeat = Number(repeatSuffix[1]);
        expression = expression.slice(0, repeatSuffix.index).trim();
    }
    if (expression.length === 0) expression = 'd20';
    return { expression, repeat };
}

/** Intercept only current-message .r commands after access, mention, and rate checks. */
export function createDiceCommandMiddleware({ now = () => performance.now() } = {}) {
    if (typeof now !== 'function') throw new TypeError('Dice rate clock must be a function.');
    const senderWindows = new Map();
    const groupWindows = new Map();

    const pruneTimes = (times, cutoff) => {
        let expired = 0;
        while (expired < times.length && times[expired] <= cutoff) expired++;
        if (expired > 0) times.splice(0, expired);
    };
    const pruneMap = (windows, cutoff) => {
        for (const [key, times] of windows) {
            pruneTimes(times, cutoff);
            if (times.length === 0) windows.delete(key);
        }
    };
    const allowAttempt = (message) => {
        let timestamp;
        try {
            timestamp = now();
        }
        catch {
            return 'invalid-scope';
        }
        if (!Number.isFinite(timestamp)) return 'invalid-scope';

        const cutoff = timestamp - DIRECT_RATE_WINDOW_MS;
        pruneMap(senderWindows, cutoff);
        pruneMap(groupWindows, cutoff);

        const kind = message.kind;
        const senderId = message.senderId;
        const groupOpenid = message.groupOpenid;
        const validId = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
        if (!validId(senderId) || (kind === 'group' && !validId(groupOpenid))) return 'invalid-scope';

        const senderKey = JSON.stringify([kind, senderId]);
        const groupKey = kind === 'group' ? JSON.stringify([kind, groupOpenid]) : undefined;
        const senderTimes = senderWindows.get(senderKey);
        const groupTimes = groupKey === undefined ? undefined : groupWindows.get(groupKey);
        if ((senderTimes?.length ?? 0) >= MAX_DIRECT_SENDER_ATTEMPTS
            || (groupTimes?.length ?? 0) >= MAX_DIRECT_GROUP_ATTEMPTS) {
            return 'rate-limit';
        }

        // Commit both scopes only after every applicable limit passes.
        if (senderTimes) senderTimes.push(timestamp);
        else senderWindows.set(senderKey, [timestamp]);
        if (groupKey !== undefined) {
            if (groupTimes) groupTimes.push(timestamp);
            else groupWindows.set(groupKey, [timestamp]);
        }
        return undefined;
    };

    return async (ctx, next) => {
        const kind = ctx?.message?.kind;
        if (!['group', 'c2c'].includes(kind)) return next();
        if (!isDiceCommandCandidate(ctx.message.content, ctx.bot?.appId)) return next();
        const rateResult = allowAttempt(ctx.message);
        if (rateResult) {
            ctx.stop(rateResult === 'rate-limit' ? 'qqbot-dice-rate-limit' : 'qqbot-dice-invalid-scope');
            return;
        }
        const replyTarget = ctx.replyTarget ?? ctx.message.replyTarget;
        const parsed = parseDiceCommand(ctx.message.content, ctx.bot?.appId);
        if (!parsed) {
            await ctx.bot.sendMarkdown(replyTarget, '🎲 用法：.r <骰式> [x次数]，例如 .r 2d20kh1+5 x2；单独发送 .r 默认掷 d20。');
            ctx.stop('qqbot-dice-command');
            return;
        }
        let reply;
        if (parsed.error) reply = `🎲 ${parsed.error}`;
        else {
            try {
                const result = rollDice(parsed.expression, parsed.repeat);
                reply = `🎲 ${result.text}`;
            }
            catch (error) {
                reply = `🎲 ${error instanceof Error ? error.message : '骰式无效。'}`;
            }
        }
        // Exactly one send attempt. A transport failure must never trigger a reroll.
        await ctx.bot.sendMarkdown(replyTarget, reply);
        ctx.stop('qqbot-dice-command');
    };
}

/**
 * Exclude command candidates from group history while retaining the SDK
 * history middleware's list/skip semantics for every other current message.
 */
export function createDiceAwareHistoryBuffer(historyBuffer, options, createContentSanitizer) {
    // HistoryBuffer's store callbacks run asynchronously. Keep per-message
    // state in an AsyncLocalStorage so overlapping peers cannot suppress one
    // another's history writes.
    const storage = new AsyncLocalStorage();
    const sanitize = typeof createContentSanitizer === 'function'
        ? createContentSanitizer({ parseFaceTags: true })
        : undefined;
    const sourceStore = options.store;
    const store = {
        async list(...args) {
            const ctx = storage.getStore();
            const key = args[0];
            const groupId = ctx?.message?.groupOpenid ?? ctx?.message?.senderId;
            const expectedGroupKey = ctx?.message?.kind === 'group'
                && typeof ctx?.bot?.appId === 'string'
                && typeof groupId === 'string'
                ? `${ctx.bot.appId}:${groupId}`
                : undefined;
            const tracksGroup = expectedGroupKey !== undefined && key === expectedGroupKey;
            if (tracksGroup && isHistoryStoreSuppressed(sourceStore, key)) return [];
            // Capture before awaiting the store. If a reset commits while list()
            // is pending, the returned snapshot keeps the old generation.
            const epoch = tracksGroup ? getHistorySnapshotEpoch(sourceStore, key) : undefined;
            const history = await sourceStore.list(...args);
            if (tracksGroup) markHistorySnapshot(history, sourceStore, key, epoch);
            return history;
        },
        async append(...args) {
            const ctx = storage.getStore();
            if (ctx) {
                let content = ctx.message?.content;
                if (sanitize) {
                    const probe = {
                        bot: ctx.bot,
                        message: { ...ctx.message },
                        state: {},
                        log: ctx.log,
                        stop() {},
                        get stopped() { return false; },
                    };
                    await sanitize(probe, async () => {});
                    content = probe.message.content;
                }
                if (isDiceCommandCandidate(content, ctx.bot?.appId)) return;
            }
            return sourceStore.append(...args);
        },
        async clear(...args) { return sourceStore.clear?.(...args); },
    };
    const middleware = historyBuffer({ ...options, store });
    return (ctx, next) => storage.run(ctx, () => middleware(ctx, next));
}
