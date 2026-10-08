const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const APP_ID = /^[0-9]{1,20}$/u;
const MAX_RAW_MENTIONS = 64;
const MAX_MARKDOWN_URL_CHARS = 2048;
const MAX_LABEL_CODE_POINTS = 80;
const MAX_LABEL_BYTES = 256;
const MARKDOWN_MENTION_TOKEN = /\[([^\[\]]*)\]\(([^()]*)\)/gu;
const UNRESOLVED_MARKDOWN_MENTION = /mqqapi:\/\/markdown\/mention/iu;
const NATIVE_MENTION = /<@!?([A-Za-z0-9_-]{1,128})>\s*/gu;

function safeWireId(value) {
    if (typeof value === 'string') return SAFE_ID.test(value) ? value : undefined;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
    return undefined;
}

function currentRawMentions(message) {
    const raw = message?.raw;
    if (!raw || typeof raw !== 'object' || typeof message?.messageId !== 'string'
        || message.messageId.length === 0 || message.messageId.length > 256
        || /[\u0000-\u001f\u007f-\u009f]/u.test(message.messageId)
        || raw.id !== message.messageId || typeof message.senderId !== 'string'
        || !SAFE_ID.test(message.senderId)) return undefined;

    if (message.kind === 'group') {
        if (typeof message.groupOpenid !== 'string' || !SAFE_ID.test(message.groupOpenid)
            || raw.group_openid !== message.groupOpenid
            || raw.author?.member_openid !== message.senderId) return undefined;
    }
    else if (message.kind === 'c2c') {
        if (raw.author?.user_openid !== message.senderId) return undefined;
    }
    else return undefined;

    const aliases = new Set();
    let selfMentionCount = 0;
    const mentions = Array.isArray(raw.mentions) ? raw.mentions : [];
    for (const mention of mentions.slice(0, MAX_RAW_MENTIONS)) {
        if (!mention || typeof mention !== 'object' || mention.is_you !== true) continue;
        selfMentionCount++;
        for (const key of ['member_openid', 'id', 'user_openid']) {
            const id = safeWireId(mention[key]);
            if (id) aliases.add(id);
        }
    }
    return { aliases, selfMentionCount, rawEventBound: true };
}

function validLabel(label) {
    return typeof label === 'string' && label.startsWith('@') && label.length > 1
        && label.length <= MAX_LABEL_CODE_POINTS * 2
        && Array.from(label).length <= MAX_LABEL_CODE_POINTS
        && Buffer.byteLength(label, 'utf8') <= MAX_LABEL_BYTES
        && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(label);
}

function markdownMentionTarget(urlText) {
    if (typeof urlText !== 'string' || urlText.length > MAX_MARKDOWN_URL_CHARS
        || !urlText.startsWith('mqqapi://markdown/mention?')) return undefined;
    let url;
    try { url = new URL(urlText); }
    catch { return undefined; }
    if (url.protocol !== 'mqqapi:' || url.hostname !== 'markdown' || url.pathname !== '/mention'
        || url.username || url.password || url.port || url.hash) return undefined;

    const query = urlText.slice(urlText.indexOf('?') + 1);
    const match = /^(?:at_type=1&at_tinyid=([1-9][0-9]{0,19})|at_tinyid=([1-9][0-9]{0,19})&at_type=1)$/u.exec(query);
    return match?.[1] ?? match?.[2];
}

function normalizeNativeMentions(text, ownIds) {
    if (ownIds.size === 0) return text;
    NATIVE_MENTION.lastIndex = 0;
    return text.replace(NATIVE_MENTION, (whole, id) => ownIds.has(id) ? '' : whole);
}

/** Return normalized current-message text and fixed, non-identifying evidence. */
export function inspectOwnMentionText(text, message, appId) {
    if (typeof text !== 'string') return Object.freeze({
        text: '', rawEventBound: false, selfMentionCount: 0, hasUnresolvedMarkdownMention: false,
    });

    const { aliases, selfMentionCount, rawEventBound } = currentRawMentions(message) ?? {
        aliases: new Set(), selfMentionCount: 0, rawEventBound: false,
    };
    const ownIds = new Set(aliases);
    if (typeof appId === 'string' && APP_ID.test(appId)) ownIds.add(appId);

    const output = [];
    let lastIndex = 0;
    MARKDOWN_MENTION_TOKEN.lastIndex = 0;
    for (const match of text.matchAll(MARKDOWN_MENTION_TOKEN)) {
        const [, label, urlText] = match;
        const target = validLabel(label) ? markdownMentionTarget(urlText) : undefined;
        const index = match.index;
        output.push(normalizeNativeMentions(text.slice(lastIndex, index), ownIds));
        if (!target || !aliases.has(target)) output.push(match[0]);
        else output.push('');
        lastIndex = index + match[0].length;
    }
    output.push(normalizeNativeMentions(text.slice(lastIndex), ownIds));
    const normalized = output.join('');

    return Object.freeze({
        text: normalized,
        rawEventBound,
        selfMentionCount,
        hasUnresolvedMarkdownMention: UNRESOLVED_MARKDOWN_MENTION.test(normalized),
    });
}

/** Remove only bot mentions established by the current raw event. */
export function normalizeOwnMentionText(text, message, appId) {
    return inspectOwnMentionText(text, message, appId).text;
}
