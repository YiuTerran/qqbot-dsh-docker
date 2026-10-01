// QQ can render quoted attachments as text instead of msg_elements.attachments.
// Accept only complete image records from the current explicit QQ quote; never
// scan model output, group history, arbitrary URLs, or document contents.
export function recoverQuotedImageAttachments(quote, refMsgIdx) {
    if (!refMsgIdx || quote?.refKey !== refMsgIdx || quote.source !== 'msg_elements'
        || typeof quote.rawContent !== 'string') return [];
    const result = [];
    const seen = new Set();
    const record = /^\[附件[1-9]\d{0,2}\] +类型:图片 +文件名:(.{1,512}?) +尺寸:[1-9]\d{0,8}x[1-9]\d{0,8} +大小:(\d{1,9}(?:\.\d{1,3})?)(B|KB|MB) +URL:(\S{1,8192})\s*$/u;
    for (const line of quote.rawContent.slice(0, 128 * 1024).split(/\r?\n/u)) {
        const match = record.exec(line.trim());
        if (!match) continue;
        let url;
        try {
            url = new URL(match[4]);
            if (url.protocol !== 'https:' || url.username || url.password) continue;
            url.hash = '';
        } catch { continue; }
        if (seen.has(url.href)) continue;
        seen.add(url.href);
        const multiplier = { B: 1, KB: 1024, MB: 1024 * 1024 }[match[3]];
        result.push(Object.freeze({
            contentType: 'image', filename: match[1], url: url.href,
            size: Math.round(Number(match[2]) * multiplier),
        }));
        if (result.length === 16) break;
    }
    return result;
}
