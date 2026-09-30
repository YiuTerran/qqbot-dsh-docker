const MAX_MESSAGE_BYTES = 16 * 1024;

const STABLE_CATEGORIES = new Map([
    ['QUOTA', 'quota'], ['ACCOUNT_QUOTA', 'quota'],
    ['AUTH', 'auth'], ['MISSING_CREDENTIAL', 'auth'], ['INVALID_CREDENTIAL', 'auth'],
    ['RATE_LIMIT', 'rate-limit'], ['SERVER', 'server'], ['TIMEOUT', 'timeout'],
    ['TRANSPORT', 'network'], ['CONTEXT_WINDOW_EXCEEDED', 'context'],
    ['EMPTY_RESPONSE', 'empty'], ['NO_ADAPTER', 'config'], ['NO_PROVIDER', 'config'],
    ['NO_MODEL', 'config'], ['INVALID_REQUEST', 'invalid'],
]);

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
