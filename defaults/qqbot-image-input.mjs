import { Worker } from 'node:worker_threads';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const CONVERSION_TIMEOUT_MS = 10_000;
const workerUrl = new URL('./qqbot-image-input-worker.mjs', import.meta.url);

function imageError(kind) {
    return Object.assign(new Error(kind), { kind });
}

function sniffImage(bytes) {
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
    if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'gif';
    if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    return undefined;
}

/** Convert only a bounded, already-authorized edit input. No URLs or paths reach the decoder. */
export async function normalizeEditImage(bytes, { signal, inspectImage, createWorker, timeoutMs = CONVERSION_TIMEOUT_MS } = {}) {
    if (!Buffer.isBuffer(bytes)) throw imageError('image-type');
    if (bytes.length > MAX_IMAGE_BYTES) throw imageError('too-large');
    if (signal?.aborted) throw imageError('cancelled');
    const format = sniffImage(bytes);
    if (!format) throw imageError('image-type');
    if ((format === 'png' || format === 'jpeg') && inspectImage?.(bytes)) return bytes;

    return new Promise((resolve, reject) => {
        let done = false;
        let worker;
        let timer;
        const settle = (error, output) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            worker?.removeAllListeners();
            Promise.resolve(worker?.terminate()).catch(() => {}).then(() => {
                if (error) reject(error);
                else resolve(output);
            });
        };
        const onAbort = () => settle(imageError('cancelled'));
        try {
            worker = createWorker?.() ?? new Worker(workerUrl, { execArgv: [] });
            worker.on('message', (message) => {
                if (message?.kind) return settle(imageError(message.kind));
                const output = message?.bytes && Buffer.from(message.bytes);
                if (!output) return settle(imageError('image-type'));
                if (output.length > MAX_IMAGE_BYTES) return settle(imageError('too-large'));
                if (inspectImage?.(output) !== 'image/png') return settle(imageError('image-type'));
                settle(undefined, output);
            });
            worker.on('error', () => settle(imageError('failed')));
            worker.on('exit', () => settle(imageError('failed')));
            signal?.addEventListener('abort', onAbort, { once: true });
            timer = setTimeout(() => settle(imageError('failed')), timeoutMs);
            if (signal?.aborted) return onAbort();
            worker.postMessage({ bytes: Uint8Array.from(bytes), expectedFormat: format });
        }
        catch {
            settle(imageError('failed'));
        }
    });
}
