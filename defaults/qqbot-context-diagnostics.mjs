import { createHmac, randomBytes } from 'node:crypto';

const PREFIX = '[qqbot-context-debug]';
const key = randomBytes(32);
const MAX_ITEMS = 16;
const HISTORY_START = '[Chat history begins]';
const HISTORY_END = '[Chat history ends]';
const QUOTE_START = '[Quoted message begins]';
const QUOTE_END = '[Quoted message ends]';
const QQ_QUOTE_TYPE = '[消息类型] 引用消息';
const QQ_RELATED = '[关联消息]';
const QQ_CONTENT = '[消息内容]';
const QQ_NUMBERED = /--- 第\d+条 ---/gu;

export function isContextDebugEnabled() {
    return process.env.QQBOT_CONTEXT_DEBUG === 'true';
}

function choice(value, allowed, fallback = 'other') {
    return allowed.includes(value) ? value : fallback;
}

function count(value) {
    return Array.isArray(value) ? value.length : 0;
}

function occurrences(text, marker) {
    return typeof text === 'string' ? text.split(marker).length - 1 : 0;
}

function markers(text) {
    return {
        historyStart: occurrences(text, HISTORY_START),
        historyEnd: occurrences(text, HISTORY_END),
        quoteStart: occurrences(text, QUOTE_START),
        quoteEnd: occurrences(text, QUOTE_END),
        qqQuoteType: occurrences(text, QQ_QUOTE_TYPE),
        qqRelated: occurrences(text, QQ_RELATED),
        qqContent: occurrences(text, QQ_CONTENT),
        qqNumbered: typeof text === 'string' ? [...text.matchAll(QQ_NUMBERED)].length : 0,
    };
}

function fingerprint(text) {
    if (typeof text !== 'string') return { length: 0, hmac: null };
    return {
        length: text.length,
        hmac: createHmac('sha256', key).update(text).digest('hex').slice(0, 20),
    };
}

function sessionHmac(agent) {
    return fingerprint(agent?.session?.id).hmac;
}

function textSummary(text) {
    return { ...fingerprint(text), ...markers(text) };
}

function messageText(message) {
    if (!Array.isArray(message?.content)) return '';
    return message.content.filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text).join('\n');
}

function messageSummary(message) {
    const text = messageText(message);
    return {
        role: choice(message?.role, ['system', 'developer', 'user', 'assistant', 'tool']),
        ...textSummary(text),
        nonTextBlocks: Array.isArray(message?.content)
            ? message.content.filter((block) => block?.type !== 'text').length : 0,
    };
}

function elementSummary(elements) {
    const items = Array.isArray(elements) ? elements : [];
    return {
        count: items.length,
        shown: items.slice(0, MAX_ITEMS).map((item) => textSummary(item?.content)),
        omitted: Math.max(0, items.length - MAX_ITEMS),
    };
}

function roleCounts(messages) {
    const roles = { system: 0, developer: 0, user: 0, assistant: 0, tool: 0, other: 0 };
    for (const message of messages ?? []) {
        roles[choice(message?.role, ['system', 'developer', 'user', 'assistant', 'tool'])] += 1;
    }
    return roles;
}

function emit(stage, details) {
    try {
        console.info(`${PREFIX} ${JSON.stringify({ stage, ...details })}`);
    } catch {
        // Diagnostics must never affect a QQ turn.
    }
}

export function logContextInbound(ctx, mergedRequests, assembledBody) {
    if (!isContextDebugEnabled()) return;
    try {
        const message = ctx?.message;
        const state = ctx?.state;
        const quote = state?.quote;
        const requests = Array.isArray(mergedRequests) ? mergedRequests : [];
        const rawElements = message?.raw?.msg_elements ?? ctx?.raw?.msg_elements;
        emit('inbound', {
            scope: choice(message?.kind, ['group', 'c2c'], 'unknown'),
            currentOnly: process.env.QQBOT_GROUP_CURRENT_ONLY !== 'false',
            current: textSummary(message?.content),
            msgElements: elementSummary(message?.msgElements),
            rawMsgElements: elementSummary(rawElements),
            explicitQuote: Boolean(message?.refMsgIdx || quote?.refKey || quote?.entry),
            quote: {
                source: choice(quote?.source, ['msg_elements', 'store', 'none'], 'unknown'),
                text: textSummary(quote?.text),
            },
            historyCount: count(state?.history),
            mergedRequestCount: requests.length,
            mergedRequests: requests.slice(0, MAX_ITEMS).map((request) => textSummary(request?.text)),
            mergedRequestsOmitted: Math.max(0, requests.length - MAX_ITEMS),
            assembledBody: textSummary(assembledBody),
        });
    } catch {
        // Diagnostics must never affect a QQ turn.
    }
}

export function logContextBinding(agent, requestBody, assembledBody) {
    if (!isContextDebugEnabled()) return;
    try {
        emit('bound', { sessionHmac: sessionHmac(agent),
            assembledBody: textSummary(assembledBody), body: textSummary(requestBody) });
    } catch {
        // Diagnostics must never affect a QQ turn.
    }
}

export function logContextGuard(details) {
    if (!isContextDebugEnabled()) return;
    try {
        emit('guard', {
            sessionHmac: sessionHmac(details?.agent),
            state: choice(details?.state, ['active', 'bypass', 'ended', 'rejected'], 'unknown'),
            reason: choice(details?.reason,
                ['group', 'private', 'disabled', 'unbound', 'invalid-session'], 'none'),
            enabled: details?.enabled === true,
            floor: Number.isSafeInteger(details?.floor) && details.floor >= 0 ? details.floor : null,
        });
    } catch {
        // Diagnostics must never affect a QQ turn.
    }
}

export function logContextProjection(details) {
    if (!isContextDebugEnabled()) return;
    try {
        const input = Array.isArray(details?.input) ? details.input : [];
        const output = Array.isArray(details?.output) ? details.output : [];
        emit('projection', {
            sessionHmac: sessionHmac(details?.agent),
            state: choice(details?.state, ['applied', 'bypass', 'rejected'], 'unknown'),
            reason: choice(details?.reason, ['group', 'private', 'disabled', 'unbound', 'expired',
                'session-changed', 'missing-surface', 'projection-mismatch'], 'none'),
            inputCount: input.length,
            outputCount: output.length,
            inputRoles: roleCounts(input),
            outputRoles: roleCounts(output),
            retainedSystemCount: Number.isSafeInteger(details?.retainedSystemCount) ? details.retainedSystemCount : 0,
            droppedOldEventCount: Number.isSafeInteger(details?.droppedOldEventCount) ? details.droppedOldEventCount : 0,
            droppedOldLineageCount: Number.isSafeInteger(details?.droppedOldLineageCount) ? details.droppedOldLineageCount : 0,
            droppedCheckpointCount: Number.isSafeInteger(details?.droppedCheckpointCount) ? details.droppedCheckpointCount : 0,
            currentRoles: roleCounts(details?.current),
            messages: output.slice(0, MAX_ITEMS).map(messageSummary),
            messagesOmitted: Math.max(0, output.length - MAX_ITEMS),
        });
    } catch {
        // Diagnostics must never affect a QQ turn.
    }
}
