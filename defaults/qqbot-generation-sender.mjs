const QQ_API_BASE = 'https://api.sgroup.qq.com';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 128 * 1024;
const MAX_QQ_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_QQ_REQUEST_BYTES = 15 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 2000;
const QQ_REQUEST_TIMEOUT_MS = 30_000;
const OPERATION_TIMEOUT_MS = 90_000;
const DELIVERY_ERROR_TEXT = 'Timeout: QQ generation delivery failed.';
const FALLBACK_PREFIX = '附件没能发送，本鱼把转义后的可复制 Markdown 原文放在下面啦：\n\n';
const FALLBACK_TRUNCATION = '\n[正文已截断]';
const SCOPE_VALUES = Object.freeze(['group', 'c2c']);

function senderError(code = 'failed') {
    const error = new Error(DELIVERY_ERROR_TEXT);
    error.code = code;
    return error;
}

function validTarget(request) {
    const target = request?.replyTarget;
    // QQ msgId is opaque and may contain punctuation; it is a JSON reply field, never a URL path segment.
    if (!target || !SCOPE_VALUES.includes(target.scope) ||
        typeof target.targetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(target.targetId) ||
        typeof target.msgId !== 'string' || !/^[\x21-\x7e]{1,256}$/u.test(target.msgId)) {
        return undefined;
    }
    return Object.freeze({ scope: target.scope, targetId: target.targetId, msgId: target.msgId });
}

function targetPath(target, resource) {
    const collection = target.scope === 'group' ? 'groups' : 'users';
    return `/v2/${collection}/${target.targetId}/${resource}`;
}

function validMarkdownFilename(value) {
    return typeof value === 'string' && Array.from(value).length <= 120 &&
        /^[\p{L}\p{N}._ -][\p{L}\p{N}._ -]{0,116}\.md$/u.test(value);
}

function isActive(request, target, kind, signal) {
    if (!target || signal?.aborted || typeof request?.isActive !== 'function') return false;
    try {
        return request.isActive(kind) === true;
    }
    catch {
        return false;
    }
}

function replySlotAvailable(replyLimiter, msgId) {
    try {
        return replyLimiter?.checkLimit?.(msgId)?.allowed === true;
    }
    catch {
        return false;
    }
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, required, optional = []) {
    if (!isPlainObject(value)) return false;
    const keys = Object.keys(value);
    return required.every((key) => keys.includes(key)) &&
        keys.every((key) => required.includes(key) || optional.includes(key));
}

function validateUploadBody(body, fileType) {
    const required = ['file_type', 'file_data', 'srv_send_msg'];
    const optional = fileType === 4 ? ['file_name'] : [];
    if (!exactKeys(body, required, optional) || body.file_type !== fileType || body.srv_send_msg !== false ||
        typeof body.file_data !== 'string' || body.file_data.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8) {
        return false;
    }
    if (fileType === 1 && Object.hasOwn(body, 'file_name')) return false;
    if (fileType === 4 && !validMarkdownFilename(body.file_name)) {
        return false;
    }
    return /^[A-Za-z0-9+/]*={0,2}$/u.test(body.file_data);
}

function validateMediaMessageBody(body, msgId) {
    if (!exactKeys(body, ['msg_type', 'media', 'msg_id'], ['msg_seq']) || body.msg_type !== 7 || body.msg_id !== msgId ||
        !exactKeys(body.media, ['file_info']) || typeof body.media.file_info !== 'string' ||
        body.media.file_info.length === 0 || body.media.file_info.length > MAX_QQ_RESPONSE_BYTES ||
        (Object.hasOwn(body, 'msg_seq') && !Number.isSafeInteger(body.msg_seq))) {
        return false;
    }
    return true;
}

function validateRawMessageBody(body, msgId, expectedContent) {
    if (!exactKeys(body, ['msg_type', 'content', 'msg_id'], ['msg_seq']) || body.msg_type !== 0 ||
        body.msg_id !== msgId || body.content !== expectedContent || typeof body.content !== 'string' ||
        Array.from(body.content).length > MAX_MESSAGE_CHARS ||
        (Object.hasOwn(body, 'msg_seq') && !Number.isSafeInteger(body.msg_seq))) {
        return false;
    }
    return true;
}

function hasApiError(response) {
    if (!isPlainObject(response)) return true;
    for (const key of ['code', 'errcode', 'error_code', 'retcode']) {
        if (!Object.hasOwn(response, key)) continue;
        const value = response[key];
        if (value !== 0 && value !== '0') return true;
    }
    return Object.hasOwn(response, 'error') && response.error !== null && response.error !== '';
}

function validApiAcknowledgement(path, response) {
    if (hasApiError(response)) return false;
    if (path.endsWith('/files')) {
        return typeof response.file_info === 'string' && response.file_info.length > 0 &&
            Buffer.byteLength(response.file_info, 'utf8') <= MAX_QQ_RESPONSE_BYTES;
    }
    const validReturnedId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256 &&
        !/[\u0000-\u001f\u007f]/u.test(value);
    return validReturnedId(response.id);
}

function createAbortError() {
    return senderError('cancelled');
}

async function readBoundedResponse(response, maximum = MAX_QQ_RESPONSE_BYTES, signal) {
    if (!response || !Number.isInteger(response.status)) throw senderError();
    const declared = response.headers?.get?.('content-length');
    if (declared !== null && declared !== undefined) {
        if (!/^\d+$/u.test(declared) || Number(declared) > maximum) {
            await response.body?.cancel?.().catch(() => {});
            throw senderError();
        }
    }

    if (!response.body || typeof response.body.getReader !== 'function') {
        await response.body?.cancel?.().catch(() => {});
        throw senderError();
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            if (signal?.aborted) {
                await reader.cancel().catch(() => {});
                throw createAbortError();
            }
            const { done, value } = await reader.read();
            if (done) break;
            if (!(value instanceof Uint8Array)) throw senderError();
            total += value.byteLength;
            if (total > maximum) {
                await reader.cancel().catch(() => {});
                throw senderError();
            }
            chunks.push(Buffer.from(value));
        }
    }
    catch {
        await reader.cancel().catch(() => {});
        throw senderError(signal?.aborted ? 'cancelled' : 'failed');
    }
    finally {
        reader.releaseLock?.();
    }

    if (!response.ok) throw senderError();
    if (total === 0) return {};
    try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)));
    }
    catch {
        throw senderError();
    }
}

function boundedFallbackContent(content) {
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_MARKDOWN_BYTES) return undefined;
    // Raw QQ text must not become a mention or QQ markup command when the Markdown file cannot be sent.
    const suppliedPrefix = content.startsWith(FALLBACK_PREFIX);
    const inert = suppliedPrefix ? content : content
        .replace(/&/gu, '&amp;')
        .replace(/</gu, '&lt;')
        .replace(/@everyone/giu, '＠everyone');
    const prefix = FALLBACK_PREFIX;
    const body = suppliedPrefix ? inert.slice(FALLBACK_PREFIX.length) : inert;
    const codePoints = Array.from(body);
    const available = MAX_MESSAGE_CHARS - Array.from(prefix).length;
    if (codePoints.length <= available) return prefix + body;
    const marker = FALLBACK_TRUNCATION;
    const contentBudget = Math.max(0, available - Array.from(marker).length);
    return prefix + codePoints.slice(0, contentBudget).join('') + marker;
}

function boundedNotice(text) {
    if (typeof text !== 'string' || text.length === 0 || Array.from(text).length > MAX_MESSAGE_CHARS ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return undefined;
    return text;
}

/**
 * Build an SDK-compatible but private QQ sender. The only network surface is
 * the fixed QQ API origin and the immutable target captured for this request.
 * `fetchImpl` and `readResponse` are injection seams for deterministic tests.
 */
export function createGenerationSender({
    bot,
    replyLimiter,
    sdk,
    credentials,
    fetchImpl = globalThis.fetch,
    readResponse = readBoundedResponse,
    logger,
} = {}) {
    const MediaApi = sdk?.MediaApi;
    const MessageApi = sdk?.MessageApi;
    if (!bot?.tokenManager || typeof MediaApi !== 'function' || typeof MessageApi !== 'function' ||
        !credentials || typeof credentials.appId !== 'string' || typeof credentials.clientSecret !== 'string' ||
        typeof fetchImpl !== 'function' || typeof readResponse !== 'function') {
        throw new TypeError('QQ generation sender dependencies are incomplete.');
    }

    function logDeliveryFailure() {
        try {
            logger?.warn?.('[generation:sender] QQ delivery failed; retry disabled.');
        }
        catch { /* diagnostics must not affect delivery cleanup */ }
    }

    function makeShim(request, target, kind, signal, expectedRawContent) {
        const filesPath = targetPath(target, 'files');
        const messagesPath = targetPath(target, 'messages');
        return {
            async request(accessToken, method, path, body) {
                if (!isActive(request, target, kind, signal) || method !== 'POST' ||
                    typeof path !== 'string' || (path !== filesPath && path !== messagesPath) ||
                    typeof accessToken !== 'string' || accessToken.length < 1 || accessToken.length > 8192 ||
                    /[\u0000-\u0020\u007f]/u.test(accessToken)) {
                    throw senderError(signal?.aborted ? 'cancelled' : 'expired');
                }

                const upload = path === filesPath;
                const validBody = upload
                    ? validateUploadBody(body, kind === 'image' ? 1 : 4)
                    : expectedRawContent === undefined
                        ? validateMediaMessageBody(body, target.msgId)
                        : validateRawMessageBody(body, target.msgId, expectedRawContent);
                if (!validBody) throw senderError();

                let serialized;
                try {
                    serialized = JSON.stringify(body);
                }
                catch {
                    throw senderError();
                }
                const requestBytes = Buffer.byteLength(serialized, 'utf8');
                if (requestBytes > (upload ? MAX_QQ_REQUEST_BYTES : MAX_QQ_RESPONSE_BYTES)) throw senderError();

                // The limiter is charged only for a user-visible message, synchronously
                // immediately before fetch; uploads do not consume a QQ reply slot.
                if (!upload) {
                    if (!isActive(request, target, kind, signal) || !replySlotAvailable(replyLimiter, target.msgId)) {
                        throw senderError('limit');
                    }
                    try {
                        replyLimiter.record(target.msgId);
                    }
                    catch {
                        throw senderError('limit');
                    }
                }

                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), QQ_REQUEST_TIMEOUT_MS);
                timer.unref?.();
                const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
                let response;
                let completed = false;
                try {
                    response = await fetchImpl(`${QQ_API_BASE}${path}`, {
                        method: 'POST',
                        headers: {
                            Authorization: `QQBot ${accessToken}`,
                            Accept: 'application/json',
                            'Content-Type': 'application/json',
                            'User-Agent': 'qqbot-dsh (bounded generation)',
                        },
                        body: serialized,
                        signal: requestSignal,
                        redirect: 'error',
                    });
                    if (!isActive(request, target, kind, signal)) throw senderError('expired');
                    const parsed = await readResponse(response, MAX_QQ_RESPONSE_BYTES, requestSignal);
                    if (!validApiAcknowledgement(path, parsed)) throw senderError();
                    completed = true;
                    return parsed;
                }
                catch {
                    // The pinned SDK retries upload failures unless its error contains
                    // `Timeout`; use one fixed message for every failure, not just aborts.
                    throw senderError(signal?.aborted ? 'cancelled' : 'failed');
                }
                finally {
                    clearTimeout(timer);
                    if (!completed) controller.abort();
                }
            },
        };
    }

    async function execute(request, kind, signal, operation) {
        const target = validTarget(request);
        if (!target || typeof request?.enqueueSend !== 'function' ||
            !isActive(request, target, kind, signal) || signal?.aborted) {
            return { sent: false, reason: 'expired' };
        }

        let operationTimer;
        const send = async () => {
            const operationController = new AbortController();
            operationTimer = setTimeout(() => operationController.abort(), OPERATION_TIMEOUT_MS);
            operationTimer.unref?.();
            const operationSignal = signal
                ? AbortSignal.any([signal, operationController.signal])
                : operationController.signal;
            try {
                if (!isActive(request, target, kind, operationSignal)) return { sent: false, reason: 'expired' };
                return await operation(target, operationSignal);
            }
            catch (error) {
                if (error?.code === 'limit') return { sent: false, reason: 'limit' };
                if (error?.code === 'expired' || error?.code === 'cancelled' || signal?.aborted) {
                    return { sent: false, reason: 'expired' };
                }
                logDeliveryFailure();
                return { sent: false, reason: 'failed' };
            }
            finally {
                clearTimeout(operationTimer);
            }
        };

        try {
            return await request.enqueueSend(send);
        }
        catch {
            logDeliveryFailure();
            return { sent: false, reason: signal?.aborted ? 'expired' : 'failed' };
        }
    }

    function preflight(request, target, kind, signal) {
        if (!isActive(request, target, kind, signal)) return { sent: false, reason: 'expired' };
        if (!replySlotAvailable(replyLimiter, target.msgId)) return { sent: false, reason: 'limit' };
        return undefined;
    }

    async function sendUpload(request, buffer, filename, fileType, kind, signal) {
        return execute(request, kind, signal, async (target, operationSignal) => {
            const preflightResult = preflight(request, target, kind, operationSignal);
            if (preflightResult) return preflightResult;
            const shim = makeShim(request, target, kind, operationSignal);
            const media = new MediaApi(shim, bot.tokenManager, {});
            const upload = await media.uploadMedia(
                target.scope,
                target.targetId,
                fileType,
                credentials,
                { buffer, srvSendMsg: false, ...(fileType === 4 ? { fileName: filename } : {}) },
            );
            if (!isActive(request, target, kind, operationSignal)) return { sent: false, reason: 'expired' };
            if (!upload || typeof upload.file_info !== 'string' || upload.file_info.length === 0 ||
                Buffer.byteLength(upload.file_info, 'utf8') > MAX_QQ_RESPONSE_BYTES) {
                throw senderError();
            }
            await media.sendMediaMessage(
                target.scope,
                target.targetId,
                upload.file_info,
                credentials,
                { msgId: target.msgId },
            );
            if (!isActive(request, target, kind, operationSignal)) return { sent: false, reason: 'expired' };
            return { sent: true };
        });
    }

    async function sendRawText(request, text, kind, signal) {
        return execute(request, kind, signal, async (target, operationSignal) => {
            if (!isActive(request, target, kind, operationSignal)) return { sent: false, reason: 'expired' };
            if (!replySlotAvailable(replyLimiter, target.msgId)) return { sent: false, reason: 'limit' };
            const shim = makeShim(request, target, kind, operationSignal, text);
            const messages = new MessageApi(shim, bot.tokenManager, {});
            await messages.sendRaw(
                target.scope,
                target.targetId,
                credentials,
                { msg_type: 0, content: text, msg_id: target.msgId },
            );
            if (!isActive(request, target, kind, operationSignal)) return { sent: false, reason: 'expired' };
            return { sent: true };
        });
    }

    return Object.freeze({
        sendImage(request, buffer, signal) {
            if (!Buffer.isBuffer(buffer) || buffer.length < 1 || buffer.length > MAX_IMAGE_BYTES ||
                !((buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
                    (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff))) {
                return Promise.resolve({ sent: false, reason: 'failed' });
            }
            return sendUpload(request, buffer, undefined, 1, 'image', signal);
        },

        sendMarkdownFile(request, buffer, filename, signal) {
            if (!Buffer.isBuffer(buffer) || buffer.length < 1 || buffer.length > MAX_MARKDOWN_BYTES ||
                !validMarkdownFilename(filename)) {
                return Promise.resolve({ sent: false, reason: 'failed' });
            }
            try {
                new TextDecoder('utf-8', { fatal: true }).decode(buffer);
            }
            catch {
                return Promise.resolve({ sent: false, reason: 'failed' });
            }
            return sendUpload(request, buffer, filename, 4, 'markdown', signal);
        },

        sendMarkdownFallback(request, content, signal) {
            const text = boundedFallbackContent(content);
            if (text === undefined) return Promise.resolve({ sent: false, reason: 'failed' });
            return sendRawText(request, text, 'markdown', signal);
        },

        sendNotice(request, text, signal) {
            const safeText = boundedNotice(text);
            if (safeText === undefined) return Promise.resolve({ sent: false, reason: 'failed' });
            return sendRawText(request, safeText, 'markdown', signal);
        },
    });
}
