const MAX_RAW_BYTES = 1024 * 1024;
const MAX_EXT_BYTES = 4096;
const MAX_EXT_CHARS = Math.ceil(MAX_EXT_BYTES / 3) * 4;
const MAX_DECODED_TAGS = 32;
const PLACEHOLDER = '[表情]';
const utf8 = new TextDecoder('utf-8', { fatal: true });
const oldFaces = new Map([
    ['0', '微笑'], ['1', '撇嘴'], ['2', '色'], ['4', '得意'], ['5', '流泪'],
    ['6', '害羞'], ['8', '睡'], ['14', '微笑'], ['16', '赞'], ['21', '可爱'],
    ['60', '咖啡'], ['63', '玫瑰'], ['66', '爱心'], ['76', '赞'],
]);

function readableFace(tag, decodeAllowed) {
    if (!decodeAllowed) return PLACEHOLDER;
    if (tag.startsWith('[<face,')) {
        const match = tag.length <= 64 && tag.match(/^\[<face,id=(\d{1,6})\/?>\]$/u);
        const name = match && oldFaces.get(match[1]);
        return name ? `[表情: ${name}]` : PLACEHOLDER;
    }
    // Reject before matching or allocating decoded data. Never retain the ext.
    if (tag.length > MAX_EXT_CHARS + 256) return PLACEHOLDER;
    const match = tag.match(/^<faceType=\d{1,6},faceId="[^"<>]{1,80}",ext="([^"<>]*)">$/u);
    const ext = match?.[1];
    if (!ext || ext.length > MAX_EXT_CHARS || ext.length % 4 !== 0
        || !/^[A-Za-z0-9+/]*={0,2}$/u.test(ext)) return PLACEHOLDER;
    try {
        const bytes = Buffer.from(ext, 'base64');
        if (bytes.length > MAX_EXT_BYTES || bytes.toString('base64') !== ext) return PLACEHOLDER;
        const value = JSON.parse(utf8.decode(bytes));
        const name = value?.text;
        if (typeof name !== 'string' || !name.trim()
            || name.length > 160 || Array.from(name).length > 80
            || Buffer.byteLength(name, 'utf8') > 256
            || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(name)) return PLACEHOLDER;
        return `[表情: ${name}]`;
    }
    catch { return PLACEHOLDER; }
}

/** Normalize only QQ face tags; all other current text is preserved verbatim. */
export function normalizeOnebotLogText(text) {
    if (typeof text !== 'string' || text.length > MAX_RAW_BYTES
        || Buffer.byteLength(text, 'utf8') > MAX_RAW_BYTES) return undefined;
    const starts = /\[<face,|<faceType=/gu;
    const parts = [];
    let cursor = 0;
    let tags = 0;
    let match;
    while ((match = starts.exec(text))) {
        const start = match.index;
        parts.push(text.slice(cursor, start));
        let close = -1;
        let quoted = false;
        for (let index = start + match[0].length; index < text.length; index++) {
            if (text[index] === '"') quoted = !quoted;
            else if (text[index] === '>' && !quoted) {
                close = index;
                break;
            }
        }
        if (close < 0) {
            parts.push(PLACEHOLDER);
            cursor = text.length;
            break;
        }
        const end = close + 1 + (match[0][0] === '[' && text[close + 1] === ']' ? 1 : 0);
        parts.push(readableFace(text.slice(start, end), ++tags <= MAX_DECODED_TAGS));
        cursor = end;
        starts.lastIndex = end;
    }
    parts.push(text.slice(cursor));
    return parts.join('');
}
