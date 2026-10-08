const MAX_MESSAGE_BYTES = 16 * 1024;

const STABLE_CATEGORIES = new Map([
    ['QUOTA', 'quota'], ['ACCOUNT_QUOTA', 'quota'],
    ['AUTH', 'auth'], ['MISSING_CREDENTIAL', 'auth'], ['INVALID_CREDENTIAL', 'auth'],
    ['RATE_LIMIT', 'rate-limit'], ['SERVER', 'server'], ['TIMEOUT', 'timeout'],
    ['TRANSPORT', 'network'], ['CONTEXT_WINDOW_EXCEEDED', 'context'],
    ['EMPTY_RESPONSE', 'empty'], ['NO_ADAPTER', 'config'], ['NO_PROVIDER', 'config'],
    ['NO_MODEL', 'config'], ['INVALID_REQUEST', 'invalid'],
]);

const LOG_TOOLS = new Set([
    'qqbot_describe_image', 'qqbot_read_document', 'qqbot_generate_image',
    'qqbot_create_markdown', 'qqbot_onebot_command', 'web_fetch', 'web_search',
]);
const LOG_STAGES = new Set([
    'execute', 'execute-result', 'execute-throw', 'quota-acquire', 'quota-reserve',
    'download', 'normalize-image', 'provider', 'qq-delivery', 'markdown-delivery',
    'registration', 'probe', 'call', 'authorize', 'private-delivery', 'send-notice', 'send-image',
    'send-markdown',
]);
const LOG_CODES = new Set([
    ...STABLE_CATEGORIES.keys(),
    'insufficient_quota', 'billing_hard_limit_reached', 'context_length_exceeded',
    'content_filter', 'invalid_api_key', 'permission_denied', 'model_not_found',
    'server_error', 'invalid_prompt', 'rate_limit_exceeded', 'UNSUPPORTED_SCHEMA',
    'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
    'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ERR_TLS_CERT_ALTNAME_INVALID',
    'group_state_private', 'group_role_unknown', 'group_role_denied', 'group_role_unsupported',
    'group_state_source_mismatch',
    'log_disabled', 'log_capability_unsupported', 'log_group_only', 'log_exact_source_required',
    'log_role_denied', 'log_role_unknown', 'log_role_unsupported', 'log_capture_order_unavailable',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
]);
const LOG_ERROR_TYPES = new Set([
    'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
    'AggregateError', 'DOMException', 'AbortError', 'TimeoutError',
    'JsonSchemaError', 'ToolNotFoundError', 'HarnessError', 'FetchError',
]);
const LOG_RESULT_REASONS = new Map([
    ['failed', 'generic'], ['unknown', 'generic'], ['busy', 'busy'], ['state', 'config'],
    ['quota', 'quota'], ['too-large', 'too-large'], ['image-type', 'invalid'],
    ['expired', 'generic'], ['invalid', 'invalid'],
]);
const NETWORK_CODES = new Set([
    'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH',
    'ENETUNREACH', 'EPIPE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UND_ERR_SOCKET',
]);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);

function safeRead(value, key) {
    try { return value?.[key]; } catch { return undefined; }
}

function safeLogCode(value) {
    return typeof value === 'string' && LOG_CODES.has(value) ? value : undefined;
}

/** Log a bounded diagnostic record without copying error text or tool data. */
export function logToolFailure(tool, stage, failure) {
    const fallback = '[qqbot-tool-error] {"tool":"other","stage":"other","reason":"generic"}';
    try {
        const statusCandidates = [safeRead(failure, 'status'), safeRead(failure, 'statusCode'), safeRead(failure, 'httpStatus'),
            safeRead(safeRead(failure, 'response'), 'status')];
        const envelope = parseEnvelope(failure);
        const status = statusCandidates.find((value) => Number.isInteger(value) && value >= 100 && value <= 599)
            ?? envelope?.status;
        const causes = [];
        const seenCauses = new Set([failure]);
        let cause = safeRead(failure, 'cause');
        while (cause && causes.length < 3 && !seenCauses.has(cause)) {
            seenCauses.add(cause);
            causes.push(cause);
            cause = safeRead(cause, 'cause');
        }
        const info = safeRead(failure, 'info');
        const identifiers = [safeRead(failure, 'code'), safeRead(info, 'code'), safeRead(safeRead(failure, 'error'), 'code'),
            ...(envelope?.identifiers ?? [])];
        const code = identifiers.map(safeLogCode).find(Boolean);
        const causeCode = causes.map((entry) => safeLogCode(safeRead(entry, 'code'))).find(Boolean);
        const infoName = safeRead(info, 'name');
        const constructorName = LOG_ERROR_TYPES.has(infoName) ? infoName : safeRead(safeRead(failure, 'constructor'), 'name');
        const failureName = safeRead(failure, 'name');
        const causeNames = causes.flatMap((entry) => [safeRead(safeRead(entry, 'constructor'), 'name'), safeRead(entry, 'name')]);
        const resultStatus = safeRead(failure, 'kind');
        const classifications = [
            classifyProviderFailure(failure),
            status === undefined ? 'generic' : classifyProviderFailure({ status }),
            code ? classifyProviderFailure({ code }) : 'generic',
            causeCode ? classifyProviderFailure({ code: causeCode }) : 'generic',
        ];
        let reason = LOG_RESULT_REASONS.get(resultStatus)
            ?? classifications.find((category) => category !== 'generic') ?? 'generic';
        if (reason === 'generic' && (failureName === 'AbortError' || constructorName === 'AbortError'
            || causeNames.includes('AbortError'))) reason = 'aborted';
        if (reason === 'generic' && (TIMEOUT_CODES.has(causeCode) || TIMEOUT_CODES.has(code)
            || failureName === 'TimeoutError' || constructorName === 'TimeoutError'
            || causeNames.includes('TimeoutError'))) reason = 'timeout';
        if (reason === 'generic' && (NETWORK_CODES.has(causeCode) || NETWORK_CODES.has(code))) reason = 'network';
        const record = {
            tool: LOG_TOOLS.has(tool) ? tool : 'other',
            stage: LOG_STAGES.has(stage) ? stage : 'other',
            reason,
            ...(typeof constructorName === 'string' && LOG_ERROR_TYPES.has(constructorName) ? { errorType: constructorName } : {}),
            ...(status !== undefined ? { status } : {}),
            ...(code ? { code } : {}),
            ...(causeCode ? { causeCode } : {}),
            ...(LOG_RESULT_REASONS.has(resultStatus) ? { resultStatus } : {}),
        };
        console.warn(`[qqbot-tool-error] ${JSON.stringify(record)}`);
    }
    catch {
        try { console.warn(fallback); } catch { /* Logging must never change tool behavior. */ }
    }
}

const NOTICES = Object.freeze({
    quota: '主人，模型服务的余额或额度不足啦，麻烦联系管理员检查额度或充值，本鱼暂时还答不了这条。',
    auth: '主人，模型服务的凭据或访问权限好像有问题，麻烦联系管理员检查一下配置。',
    'rate-limit': '主人，模型服务这会儿有点忙，本鱼被限流啦，稍等一会儿再试吧。',
    server: '主人，模型服务器好像暂时出了点状况，等一会儿再试吧。',
    timeout: '主人，模型服务这次等得有点久，本鱼没能及时收到回复，稍后再试吧。',
    network: '主人，本鱼暂时连不上模型服务啦，稍后再试；一直这样的话，麻烦管理员检查一下网络。',
    context: '主人，这段对话有点太长啦，可以发一下 `/new` 开个新对话，记得补上需要的背景。',
    empty: '主人，模型服务这次没有送来完整回复，本鱼没接住，稍后再试吧。',
    config: '主人，当前模型或接口好像还没配置好，麻烦联系管理员检查一下。',
    invalid: '主人，模型服务没能接受这次请求，麻烦联系管理员检查模型和接口配置。',
    busy: '主人，模型服务正在处理别的请求，这次没接上，稍后再试吧。',
    'too-large': '主人，这次发送的内容有点多啦，试着减少文字或附件后再提问吧。',
    moderation: '主人，刚才这轮没能通过服务商的内容审核，本鱼暂时没法回复这条。我们聊点别的吧。',
    tool: '主人，本鱼这次没能完成这个工具操作，暂时拿不到结果，稍后再试吧。',
    generic: '主人，本鱼这轮遇到了一点状况，暂时没能完成回复，稍后再试；一直这样的话，麻烦联系管理员看看。',
});

function parseEnvelope(failure) {
    if (typeof failure?.message !== 'string' || Buffer.byteLength(failure.message, 'utf8') > MAX_MESSAGE_BYTES) return undefined;
    const match = /^OpenAI API error \(([1-5][0-9]{2})\): (\{[\s\S]*\})$/u.exec(failure.message);
    if (!match) return undefined;
    let payload;
    try { payload = JSON.parse(match[2]); } catch { return undefined; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
    const error = payload.error && typeof payload.error === 'object' && !Array.isArray(payload.error)
        ? payload.error : payload;
    const identifiers = [error.code, error.type].filter((value) => typeof value === 'string' && value.length <= 128);
    return { status: Number(match[1]), identifiers };
}

/** Classify only stable runtime codes and bounded, explicit HTTP envelopes. */
export function classifyProviderFailure(failure) {
    const stable = STABLE_CATEGORIES.get(failure?.code);
    if (stable && !['rate-limit', 'invalid'].includes(stable)) return stable;
    const envelope = parseEnvelope(failure);
    const structured = [failure?.code, failure?.type, failure?.error?.code, failure?.error?.type]
        .filter((value) => typeof value === 'string' && value.length <= 128);
    const identifiers = [...structured, ...(envelope?.identifiers ?? [])];
    const status = Number.isInteger(failure?.status) && failure.status >= 100 && failure.status <= 599
        ? failure.status : envelope?.status;
    {
        const has = (...values) => identifiers.some((identifier) => values.includes(identifier));
        if (has('insufficient_quota', 'billing_hard_limit_reached')) return 'quota';
        if (has('context_length_exceeded')) return 'context';
        if (has('content_filter')) return 'moderation';
        if (has('invalid_api_key', 'permission_denied')) return 'auth';
        if (has('model_not_found')) return 'config';
        if (has('server_error')) return 'server';
        if (has('invalid_prompt')) return 'invalid';
        if (has('rate_limit_exceeded')) return 'rate-limit';
        if (status === 402) return 'quota';
        if (status === 401 || status === 403) return 'auth';
        if (status === 404) return 'config';
        if (status === 408) return 'timeout';
        if (status === 409) return 'busy';
        if (status === 413) return 'too-large';
        if (status === 429) return 'rate-limit';
        if (status >= 500) return 'server';
        if (status === 400 || status === 422) return 'invalid';
    }
    return stable ?? 'generic';
}

/** Never interpolate provider payloads, URLs, credentials or request IDs. */
export function formatProviderFailure(failure) {
    return NOTICES[classifyProviderFailure(failure)] ?? NOTICES.generic;
}

export function formatToolFailure() {
    return NOTICES.tool;
}
