import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, rename, unlink } from 'node:fs/promises';
import { dirname, basename, resolve } from 'node:path';

const VERSION = 1;
const HOUR_MS = 60 * 60 * 1000;
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_ENTRIES = 10000;
const TYPES = Object.freeze(['image', 'markdown']);

function positiveLimit(value, fallback, name) {
    if (value === undefined || value === null) return fallback;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) {
        throw new TypeError(`${name} must be a positive safe integer.`);
    }
    return number;
}

function validateIdentity(value, name) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
        throw new TypeError(`${name} must be a non-empty string of at most 256 characters.`);
    }
    return value;
}

function typeKey(type) {
    if (!TYPES.includes(type)) throw new TypeError('type must be image or markdown.');
    return type;
}

function exactKeys(value, expected) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value).sort();
    return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function parseState(text, now) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (!exactKeys(parsed, ['entries', 'version']) || parsed.version !== VERSION ||
        !Array.isArray(parsed.entries) || parsed.entries.length > MAX_ENTRIES) {
        return undefined;
    }

    const cutoff = now - HOUR_MS;
    const entries = new Map();
    for (const entry of parsed.entries) {
        if (!exactKeys(entry, ['image', 'markdown', 'ownerKey']) ||
            typeof entry.ownerKey !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.ownerKey) ||
            !Array.isArray(entry.image) || !Array.isArray(entry.markdown) || entries.has(entry.ownerKey)) {
            return undefined;
        }
        const values = { image: [], markdown: [] };
        for (const type of TYPES) {
            for (const timestamp of entry[type]) {
                if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > now + HOUR_MS) {
                    return undefined;
                }
                if (timestamp > cutoff) values[type].push(timestamp);
            }
        }
        if (values.image.length > MAX_STORE_BYTES || values.markdown.length > MAX_STORE_BYTES) return undefined;
        if (values.image.length || values.markdown.length) entries.set(entry.ownerKey, values);
    }
    return entries;
}

function serializeState(entries) {
    const serialized = JSON.stringify({
        version: VERSION,
        entries: [...entries].map(([ownerKey, values]) => ({
            ownerKey,
            image: values.image,
            markdown: values.markdown,
        })),
    });
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STORE_BYTES) return undefined;
    return `${serialized}\n`;
}

async function readBoundedRegularFile(path) {
    let handle;
    try {
        const noFollow = constants.O_NOFOLLOW;
        if (!Number.isInteger(noFollow)) return undefined;
        handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_STORE_BYTES) return undefined;

        const chunks = [];
        const buffer = Buffer.alloc(16 * 1024);
        let total = 0;
        let position = 0;
        for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
            if (bytesRead === 0) break;
            total += bytesRead;
            if (total > MAX_STORE_BYTES) return undefined;
            chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
            position += bytesRead;
        }
        return Buffer.concat(chunks, total).toString('utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        return undefined;
    } finally {
        await handle?.close().catch(() => {});
    }
}

async function writeAtomicRegularFile(path, content) {
    if (Buffer.byteLength(content, 'utf8') > MAX_STORE_BYTES) return false;
    const directory = dirname(path);
    const name = basename(path);
    let directoryInfo;
    try {
        directoryInfo = await lstat(directory);
        if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return false;
        const existing = await lstat(path).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
        if (existing && (!existing.isFile() || existing.isSymbolicLink())) return false;
    } catch {
        return false;
    }

    const tempPath = resolve(directory, `.${name}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`);
    let handle;
    try {
        const noFollow = constants.O_NOFOLLOW;
        if (!Number.isInteger(noFollow)) return false;
        handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
        await handle.writeFile(content, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;

        // rename replaces the destination entry itself; it does not follow a
        // destination symlink if one is introduced after the lstat check.
        await rename(tempPath, path);
        const directoryHandle = await open(directory, constants.O_RDONLY);
        try {
            await directoryHandle.sync();
        } finally {
            await directoryHandle.close();
        }
        return true;
    } catch {
        return false;
    } finally {
        await handle?.close().catch(() => {});
        await unlink(tempPath).catch(() => {});
    }
}

/**
 * Create a single-process quota store for generation tools.
 *
 * API: tryAcquire({ ownerId, type }) synchronously claims one active slot and
 * returns an idempotent release callback. reserve({ ownerId, type }) atomically
 * persists a rolling-hour reservation. Only a SHA-256 key derived from
 * (appId, ownerId) and timestamps are stored; prompts, content, and secrets
 * are never accepted or written. The optional path/now parameters are test
 * seams; production uses /data/qqbot-generation-quota.json and Date.now.
 *
 * limits: imageHourlyLimit=10, markdownHourlyLimit=30,
 * imageConcurrent=2, markdownConcurrent=4.
 */
export function createGenerationQuota({
    path = '/data/qqbot-generation-quota.json',
    appId,
    limits = {},
    now = Date.now,
} = {}) {
    const applicationId = validateIdentity(appId, 'appId');
    if (typeof now !== 'function') throw new TypeError('now must be a function.');
    const quotaLimits = Object.freeze({
        imageHourlyLimit: positiveLimit(limits.imageHourlyLimit, 10, 'imageHourlyLimit'),
        markdownHourlyLimit: positiveLimit(limits.markdownHourlyLimit, 30, 'markdownHourlyLimit'),
        imageConcurrent: positiveLimit(limits.imageConcurrent, 2, 'imageConcurrent'),
        markdownConcurrent: positiveLimit(limits.markdownConcurrent, 4, 'markdownConcurrent'),
    });
    const storePath = resolve(path);
    const active = new Map();
    const activeCounts = { image: 0, markdown: 0 };
    let writeQueue = Promise.resolve();

    function ownerKey(ownerId) {
        const owner = validateIdentity(ownerId, 'ownerId');
        return createHash('sha256').update(applicationId).update('\0').update(owner).digest('hex');
    }

    function tryAcquire({ ownerId, type }) {
        const owner = ownerKey(ownerId);
        const taskType = typeKey(type);
        const activeKey = `${taskType}:${owner}`;
        const concurrentLimit = taskType === 'image' ? quotaLimits.imageConcurrent : quotaLimits.markdownConcurrent;
        if (active.has(activeKey) || activeCounts[taskType] >= concurrentLimit) {
            return { ok: false, reason: 'busy' };
        }

        active.set(activeKey, taskType);
        activeCounts[taskType] += 1;
        let released = false;
        return {
            ok: true,
            release() {
                if (released) return;
                released = true;
                if (active.delete(activeKey)) activeCounts[taskType] -= 1;
            },
        };
    }

    async function reserveLocked(owner, taskType) {
        let current;
        try {
            current = now();
        } catch {
            return { ok: false, reason: 'state' };
        }
        if (!Number.isSafeInteger(current) || current < 0) return { ok: false, reason: 'state' };

        const raw = await readBoundedRegularFile(storePath);
        if (raw === undefined) return { ok: false, reason: 'state' };
        const entries = raw === null ? new Map() : parseState(raw, current);
        if (!entries) return { ok: false, reason: 'state' };

        const user = entries.get(owner) ?? { image: [], markdown: [] };
        const hourlyLimit = taskType === 'image' ? quotaLimits.imageHourlyLimit : quotaLimits.markdownHourlyLimit;
        const changedByPruning = raw !== null && raw.trim() !== serializeState(entries)?.trim();
        if (user[taskType].length >= hourlyLimit) {
            if (changedByPruning) {
                const serialized = serializeState(entries);
                if (!serialized || !(await writeAtomicRegularFile(storePath, serialized))) {
                    return { ok: false, reason: 'state' };
                }
            }
            return { ok: false, reason: 'quota' };
        }

        if (!entries.has(owner) && entries.size >= MAX_ENTRIES) {
            return { ok: false, reason: 'state' };
        }
        user[taskType].push(current);
        entries.set(owner, user);
        const serialized = serializeState(entries);
        if (!serialized || !(await writeAtomicRegularFile(storePath, serialized))) {
            return { ok: false, reason: 'state' };
        }
        return { ok: true };
    }

    function reserve({ ownerId, type }) {
        const owner = ownerKey(ownerId);
        const taskType = typeKey(type);
        const operation = writeQueue.then(() => reserveLocked(owner, taskType));
        writeQueue = operation.then(() => undefined, () => undefined);
        return operation.catch(() => ({ ok: false, reason: 'state' }));
    }

    return Object.freeze({ tryAcquire, reserve });
}
