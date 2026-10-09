import { basename, join } from 'node:path';
import {
    generationScopeFailure,
    getBoundGenerationTurn,
    getGenerationRequest,
    getGenerationRequestSignal,
    trackGenerationOperation,
} from './qqbot-generation-scope.mjs';
import { DAYU_ASSET_ROOT, isDayuAssetImagePath, loadDayuAssetImage } from './qqbot-assets.mjs';
import { logToolFailure } from './qqbot-provider-errors.mjs';

export const SEND_ASSET_IMAGE_TOOL = 'qqbot_send_asset_image';

const ASSET_PATHS = new Set([
    join(DAYU_ASSET_ROOT, 'character-standard.png'),
    join(DAYU_ASSET_ROOT, 'portrait.png'),
]);
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_CALL_RECORDS = 40;
const MAX_ACTIVE_DELIVERIES = 2;
const MAX_WAITING_DELIVERIES = 20;
const TOOL_TIMEOUT_MS = 150_000;
const OPERATION_TIMEOUT_MS = 120_000;
const notices = Object.freeze({
    sent: '主人，原版形象设定图已经作为文件发出啦；这次没有调用生图服务。素材作者：YunYueSama；项目来源：https://github.com/YunYueSama/codex-deepseek-pet；许可证：https://github.com/YunYueSama/codex-deepseek-pet/blob/7661c8b304c5400701f91da01b1a643a207331de/LICENSE',
    failed: '主人，原版形象文件没有成功发出，本鱼没有生成替代图片。',
    unknown: '主人，原版形象文件的投递结果未知；为避免重复，本鱼没有再次发送。',
    timeout: '主人，发送原版形象文件超时了；本鱼没有重新发送或生成替代图片。',
    busy: '主人，文件发送队列正忙；本鱼没有调用生图服务，稍后可以再试。',
    expired: '主人，这条消息已过期，本鱼不能再向它发送形象文件啦。',
    invalid: '主人，请选择随镜像提供的原版形象设定图。',
    'too-large': '主人，这张原版形象文件超出发送大小限制。',
});

let activeDeliveries = 0;
const deliveryQueue = [];

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function exactArguments(args) {
    if (!isPlainObject(args)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(args);
    const keys = Reflect.ownKeys(descriptors);
    return keys.length === 2 && keys.every((key) => typeof key === 'string' && ['requestId', 'image'].includes(key)
        && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable)
        && Object.hasOwn(descriptors, 'requestId') && Object.hasOwn(descriptors, 'image')
        && typeof args.requestId === 'string' && typeof args.image === 'string';
}

function validCallId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 256
        && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function permittedPath(value) {
    return ASSET_PATHS.has(value) && isDayuAssetImagePath(value);
}

function receipt(status, imagePath, bytes = 0, delivery = 'none') {
    return {
        status,
        notice: notices[status] ?? notices.failed,
        filename: permittedPath(imagePath) ? basename(imagePath) : '',
        bytes,
        delivery,
    };
}

export function validateAssetImageDeliveryCall(exec) {
    if (exec?.name !== SEND_ASSET_IMAGE_TOOL) return undefined;
    if (!validCallId(exec.callId)) return 'A valid asset delivery tool-call id is required.';
    const scope = getBoundGenerationTurn(exec);
    const failure = generationScopeFailure(scope, 'asset');
    if (failure) return 'This QQ message no longer authorizes sending an original asset.';
    if (!exactArguments(exec.arguments)) return 'Asset delivery accepts only the requestId and bundled image path.';
    if (!getGenerationRequest(scope, exec.arguments.requestId, 'asset')) {
        return 'This requestId is not authorized for the current original QQ message.';
    }
    if (!permittedPath(exec.arguments.image)) return 'Choose one of the bundled original Dayu image files.';
    return undefined;
}

function releaseSemaphore() {
    activeDeliveries = Math.max(0, activeDeliveries - 1);
    while (deliveryQueue.length > 0 && activeDeliveries < MAX_ACTIVE_DELIVERIES) {
        const waiter = deliveryQueue.shift();
        if (waiter.signal?.aborted) {
            waiter.cleanup();
            waiter.reject(waiter.signal.reason ?? new Error('cancelled'));
            continue;
        }
        waiter.cleanup();
        activeDeliveries += 1;
        waiter.resolve(() => releaseSemaphore());
    }
}

function acquireSemaphore(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('cancelled'));
    if (activeDeliveries < MAX_ACTIVE_DELIVERIES) {
        activeDeliveries += 1;
        return Promise.resolve(() => releaseSemaphore());
    }
    if (deliveryQueue.length >= MAX_WAITING_DELIVERIES) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
        const waiter = { signal, resolve, reject, cleanup: () => {} };
        const onAbort = () => {
            const index = deliveryQueue.indexOf(waiter);
            if (index >= 0) deliveryQueue.splice(index, 1);
            waiter.cleanup();
            reject(signal.reason ?? new Error('cancelled'));
        };
        waiter.cleanup = () => signal?.removeEventListener('abort', onAbort);
        signal?.addEventListener('abort', onAbort, { once: true });
        deliveryQueue.push(waiter);
        if (signal?.aborted) onAbort();
    });
}

function publish(record, promise) {
    record.promise = Promise.resolve(promise).then((value) => {
        record.pending = false;
        record.value = value;
        return value;
    }, () => {
        record.pending = false;
        record.value = receipt('failed', record.imagePath);
        return record.value;
    });
    return record.promise;
}

function resultForCall(scope, key, argsFingerprint) {
    const existing = scope.callRecords?.get(key);
    if (existing) return existing.fingerprint === argsFingerprint ? existing : { mismatch: true };
    if ((scope.callRecords?.size ?? 0) >= MAX_CALL_RECORDS) return { full: true };
    scope.callRecords ??= new Map();
    const record = { fingerprint: argsFingerprint, pending: true };
    scope.callRecords.set(key, record);
    return record;
}

function makeTrustedRequest(scope, request) {
    return Object.freeze({
        replyTarget: request.replyTarget,
        ownerId: request.ownerId,
        record: request.record,
        enqueueSend: request.enqueueSend,
        isActive: (kind = 'asset') => generationScopeFailure(scope, kind) === undefined,
    });
}

async function performAssetDelivery({ scope, request, imagePath, sender, callerSignal, operationTimeoutMs }) {
    const timeoutController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        timeoutController.abort(new Error('asset-delivery-timeout'));
    }, operationTimeoutMs);
    timeout.unref?.();
    let release;
    let bytes;
    try {
        const turnSignal = getGenerationRequestSignal(scope, callerSignal, 'asset');
        const signal = AbortSignal.any([turnSignal, timeoutController.signal]);
        try {
            release = await acquireSemaphore(signal);
        }
        catch {
            return receipt(timedOut ? 'timeout' : 'expired', imagePath);
        }
        if (!release) return receipt('busy', imagePath);
        if (generationScopeFailure(scope, 'asset') || signal.aborted) {
            return receipt(timedOut ? 'timeout' : 'expired', imagePath);
        }
        try {
            bytes = Buffer.from(await loadDayuAssetImage(imagePath, MAX_ASSET_BYTES, signal));
        }
        catch (error) {
            if (timedOut || timeoutController.signal.aborted) return receipt('timeout', imagePath);
            if (generationScopeFailure(scope, 'asset') || callerSignal?.aborted) return receipt('expired', imagePath);
            logToolFailure(SEND_ASSET_IMAGE_TOOL, 'asset-read', error);
            const status = /exceeds/u.test(error?.message ?? '') ? 'too-large' : 'failed';
            return receipt(status, imagePath);
        }
        if (generationScopeFailure(scope, 'asset') || signal.aborted) {
            return receipt(timedOut ? 'timeout' : 'expired', imagePath);
        }
        let sent;
        try {
            sent = await sender.sendAssetImageFile(makeTrustedRequest(scope, request), bytes,
                basename(imagePath), signal);
        }
        catch (error) {
            logToolFailure(SEND_ASSET_IMAGE_TOOL, 'asset-delivery', error);
            sent = { sent: false, reason: 'failed' };
        }
        if (sent?.sent) return receipt('sent', imagePath, bytes.length, 'attachment');
        if (sent?.reason === 'unknown') {
            logToolFailure(SEND_ASSET_IMAGE_TOOL, 'asset-delivery', { kind: 'unknown' });
            return receipt('unknown', imagePath, bytes.length, 'unknown');
        }
        if (timedOut || sent?.reason === 'timeout') return receipt('timeout', imagePath, bytes.length);
        if (generationScopeFailure(scope, 'asset') || sent?.reason === 'expired') return receipt('expired', imagePath, bytes.length);
        logToolFailure(SEND_ASSET_IMAGE_TOOL, 'asset-delivery', { kind: sent?.reason === 'limit' ? 'busy' : 'failed' });
        return receipt(sent?.reason === 'limit' ? 'busy' : 'failed', imagePath, bytes.length);
    }
    finally {
        clearTimeout(timeout);
        release?.();
    }
}

export function registerAssetImageDeliveryTool(ctx, { sender, operationTimeoutMs = OPERATION_TIMEOUT_MS } = {}) {
    const tools = ctx.get('tools');
    if (typeof tools?.register !== 'function') throw new Error('Asset image delivery requires the pinned dsh tools.register API.');
    if (typeof sender?.sendAssetImageFile !== 'function') throw new Error('QQ asset file sender is unavailable.');
    if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > OPERATION_TIMEOUT_MS) {
        throw new Error('Invalid original asset delivery timeout.');
    }
    const definition = {
        name: SEND_ASSET_IMAGE_TOOL,
        description: 'Send an original Dayu setting image file from the bundled assets to the exact QQ message that authorized this request. Use only when the user asks to see or receive the existing original setting image, not when they ask to create or redraw an image. This sends the unchanged source file as a QQ file attachment; it does not call the image API and does not consume image-generation quota. Choose /opt/qqbot-assets/dayu/character-standard.png for the six-view design sheet or /opt/qqbot-assets/dayu/portrait.png for the single front portrait. Pass the opaque requestId from the same original QQ message. Do not use this tool for user-photo edits or arbitrary files.',
        parameters: {
            type: 'object',
            properties: {
                requestId: { type: 'string', minLength: 1, maxLength: 64, description: 'Opaque requestId from the original QQ message metadata.' },
                image: { type: 'string', enum: [...ASSET_PATHS], description: 'Absolute path of one bundled original Dayu setting PNG.' },
            },
            required: ['requestId', 'image'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    status: { type: 'string', enum: ['sent', 'failed', 'timeout', 'busy', 'expired', 'unknown', 'too-large'] },
                    notice: { type: 'string' },
                    filename: { type: 'string' },
                    bytes: { type: 'integer' },
                    delivery: { type: 'string', enum: ['attachment', 'unknown', 'none'] },
                },
                required: ['status', 'notice', 'filename', 'bytes', 'delivery'],
                additionalProperties: false,
            },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
            if (!exactArguments(args) || !exactArguments(exec?.arguments)
                || args.requestId !== exec.arguments.requestId || args.image !== exec.arguments.image) {
                throw new Error('Asset delivery arguments do not match the guarded execution.');
            }
            // Preserve the original execution object: document-scope binding is
            // keyed by object identity and must never be reconstructed from IDs.
            const failure = validateAssetImageDeliveryCall(exec);
            if (failure) throw new Error(failure);
            const scope = getBoundGenerationTurn(exec);
            const request = getGenerationRequest(scope, args.requestId, 'asset');
            const key = exec.callId;
            const argsFingerprint = JSON.stringify([SEND_ASSET_IMAGE_TOOL, args.requestId, args.image]);
            const callRecord = resultForCall(scope, key, argsFingerprint);
            if (callRecord.mismatch) throw new Error('This asset tool-call id was already used with different arguments.');
            if (callRecord.full) return receipt('busy', args.image);
            if (callRecord.promise) return callRecord.promise;
            if (callRecord.value) return callRecord.value;

            request.assetCalls ??= new Map();
            let pathRecord = request.assetCalls.get(args.image);
            if (!pathRecord && request.assetCalls.size >= ASSET_PATHS.size) {
                callRecord.pending = false;
                callRecord.value = receipt('busy', args.image);
                return callRecord.value;
            }
            if (!pathRecord) {
                pathRecord = { imagePath: args.image };
                request.assetCalls.set(args.image, pathRecord);
                const operation = trackGenerationOperation(scope, performAssetDelivery({
                    scope,
                    request,
                    imagePath: args.image,
                    sender,
                    callerSignal: exec.signal,
                    operationTimeoutMs,
                }));
                pathRecord.promise = publish(pathRecord, operation);
            }
            callRecord.imagePath = args.image;
            callRecord.promise = pathRecord.promise.then((value) => {
                callRecord.pending = false;
                callRecord.value = value;
                return value;
            });
            return callRecord.promise;
        },
        timeoutMs: TOOL_TIMEOUT_MS,
    };
    tools.register(definition);
    return Object.freeze({ tool: SEND_ASSET_IMAGE_TOOL });
}
