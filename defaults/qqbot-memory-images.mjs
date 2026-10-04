import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import {
    prepareImageFile,
    requestImageVariantId,
    DEFAULT_MAX_IMAGE_PIXELS,
    DEFAULT_MAX_IMAGE_DIMENSION,
    DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS,
    DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
    DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
} from '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js';

const MAX_BYTES = 10 * 1024 * 1024;
const memoryCalls = new AsyncLocalStorage();
const memoryReadToken = Symbol('qqbot-memory-image-reads');
const memoryReferences = new WeakMap();
const require = createRequire(import.meta.url);

function assertActive(call, signal) {
    if (!call?.active) throw new Error('This memory image belongs to an expired vision call.');
    call.signal?.throwIfAborted();
    signal?.throwIfAborted();
}

function resolveMemoryImage(token, ref, signal) {
    const call = memoryCalls.getStore();
    const entry = call?.token === token && call.images.get(ref?.attachmentId);
    if (entry) {
        assertActive(call, signal);
        if (['mediaType', 'width', 'height', 'bytes'].some(key => ref[key] !== entry.ref[key])) {
            throw new Error('Memory image reference metadata does not match.');
        }
        return { call, entry };
    }
    if (memoryReferences.has(ref)) throw new Error('Memory image reference is not authorized for this vision call.');
    return undefined;
}

function validTarget(target) {
    return target && ['width', 'height', 'maxBytes'].every(key => Number.isSafeInteger(target[key]) && target[key] > 0);
}

async function requestVersion(call, entry, target, signal) {
    assertActive(call, signal);
    if (!validTarget(target)) throw new Error('Invalid memory image request target.');
    const variantId = requestImageVariantId(entry.ref, target);
    const cached = entry.versions.get(variantId);
    if (cached) return cached;
    let output = { data: entry.data, mediaType: entry.ref.mediaType, width: entry.ref.width, height: entry.ref.height };
    if (output.width > target.width || output.height > target.height || output.data.byteLength > target.maxBytes) {
        const sharp = require('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/sharp');
        const source = sharp(entry.data, { failOn: 'error', limitInputPixels: DEFAULT_MAX_IMAGE_PIXELS });
        const { hasAlpha } = await source.metadata();
        assertActive(call, signal);
        let smallest;
        for (const quality of [85, 75, 60]) {
            assertActive(call, signal);
            let pipeline = source.clone().toColourspace('srgb').resize({
                width: Math.min(target.width, entry.ref.width),
                height: Math.min(target.height, entry.ref.height),
                fit: 'inside', withoutEnlargement: true,
            }).timeout({ seconds: 10 });
            pipeline = hasAlpha ? pipeline.webp({ quality, effort: 0 }) : pipeline.jpeg({ quality });
            const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
            assertActive(call, signal);
            const candidate = { data: new Uint8Array(data), mediaType: hasAlpha ? 'image/webp' : 'image/jpeg', width: info.width, height: info.height };
            if (!smallest || candidate.data.byteLength < smallest.data.byteLength) smallest = candidate;
            if (candidate.data.byteLength <= target.maxBytes) { smallest = candidate; break; }
        }
        output = smallest;
    }
    assertActive(call, signal);
    const encodedMetadata = await require('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/sharp')(
        output.data, { failOn: 'error', limitInputPixels: DEFAULT_MAX_IMAGE_PIXELS },
    ).metadata();
    assertActive(call, signal);
    const version = Object.freeze({
        ...output, variantId, attachment: entry.ref, bytes: output.data.byteLength,
        depth: 'uchar', space: 'srgb', hasAlpha: encodedMetadata.hasAlpha,
    });
    // Route adapters enforce their final byte budgets, as on the native path.
    entry.versions.set(variantId, version);
    return version;
}

function installMemoryReads(store) {
    if (store[memoryReadToken]) return store[memoryReadToken];
    for (const method of ['readImage', 'readImageRequest', 'imageHostPath']) {
        if (typeof store?.[method] !== 'function') throw new Error('Vision requires the pinned attachment read API.');
    }
    const nativeRead = store.readImage.bind(store);
    const nativeRequest = store.readImageRequest.bind(store);
    const nativePath = store.imageHostPath.bind(store);
    const token = Object.freeze({
        compress: typeof store.compression?.run === 'function'
            ? task => store.compression.run(task) : task => task(),
    });
    // Only our call-local references take this branch. Native attachments keep
    // their original storage, normalization and cache behavior.
    store.readImage = async (ref, signal) => {
        const memory = resolveMemoryImage(token, ref, signal);
        return memory ? { ref: memory.entry.ref, data: memory.entry.data } : nativeRead(ref, signal);
    };
    store.readImageRequest = async (ref, target, signal) => {
        const memory = resolveMemoryImage(token, ref, signal);
        return memory ? token.compress(() => requestVersion(memory.call, memory.entry, target, signal)) : nativeRequest(ref, target, signal);
    };
    store.imageHostPath = (ref) => resolveMemoryImage(token, ref) ? undefined : nativePath(ref);
    Object.defineProperty(store, memoryReadToken, { value: token });
    return token;
}

/** Use the native vision model's attachment interface without durable storage. */
export async function withMemoryVisionImage(store, input, signal, callback) {
    if (!store || typeof callback !== 'function') throw new TypeError('Memory vision requires an attachment store and callback.');
    signal?.throwIfAborted();
    const token = installMemoryReads(store);
    const limits = {
        maxImageBytes: Math.min(store.imageLimits?.maxImageBytes ?? MAX_BYTES, MAX_BYTES),
        maxImagePixels: store.imageLimits?.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS,
        maxImageDimension: store.imageLimits?.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION,
    };
    const policy = store.normalizationPolicy ?? {
        maxPixels: DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS,
        maxDimension: DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
        maxBytes: DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
    };
    // This SDK function fully validates and normalizes, but never commits bytes.
    const prepared = await token.compress(() => {
        signal?.throwIfAborted();
        return prepareImageFile(input, limits, policy);
    });
    signal?.throwIfAborted();
    // A fresh native-format ID prevents collisions with durable images or a
    // simultaneous request for identical pixels. It never enters session logs.
    const ref = Object.freeze({ ...prepared.ref, attachmentId: `sha256:${randomBytes(32).toString('hex')}` });
    const entry = { ref, data: prepared.data, versions: new Map() };
    const call = { active: true, token, signal, images: new Map([[ref.attachmentId, entry]]) };
    memoryReferences.set(ref, true);
    try {
        return await memoryCalls.run(call, async () => {
            assertActive(call);
            const result = await callback(ref);
            assertActive(call);
            return result;
        });
    }
    finally {
        call.active = false;
        call.images.clear();
        entry.versions.clear();
        entry.data = undefined;
    }
}
