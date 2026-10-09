import { constants, lstatSync, realpathSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';

export const DAYU_ASSET_ROOT = '/opt/qqbot-assets/dayu';
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

function isWithin(root, candidate) {
    const path = relative(root, candidate);
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function pathIdentity(info) {
    return { dev: info.dev, ino: info.ino };
}

function samePathIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}

function fullIdentity(info) {
    return {
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mtimeNs: info.mtimeNs,
        ctimeNs: info.ctimeNs,
    };
}

function sameFullIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino && left.size === right.size
        && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function inspectDayuAssetPath(image, assetRoot = DAYU_ASSET_ROOT) {
    if (typeof image !== 'string' || !isAbsolute(image)) return undefined;
    try {
        const lexicalPath = resolve(image);
        const lexicalRoot = resolve(assetRoot);
        if (image !== lexicalPath || !isWithin(lexicalRoot, lexicalPath) || lexicalPath === lexicalRoot
            || !IMAGE_EXTENSIONS.has(extname(lexicalPath).toLowerCase())) return undefined;

        // Node has no openat2(RESOLVE_NO_SYMLINKS). Check every component,
        // then repeat the check after O_NOFOLLOW-open and compare inodes.
        const components = [];
        let current = lexicalPath;
        while (current !== dirname(current)) {
            components.push(current);
            current = dirname(current);
        }
        components.push(current);
        components.reverse();
        const identities = [];
        for (let index = 0; index < components.length; index += 1) {
            const component = components[index];
            const info = lstatSync(component, { bigint: true });
            if (info.isSymbolicLink()) return undefined;
            const isFile = index === components.length - 1;
            if (isFile ? !info.isFile() : !info.isDirectory()) return undefined;
            identities.push({ path: component, identity: pathIdentity(info) });
        }
        if (realpathSync(lexicalPath) !== lexicalPath) return undefined;
        return { lexicalPath, identities, file: identities.at(-1).identity };
    }
    catch {
        return undefined;
    }
}

export function isDayuAssetImagePath(image) {
    return Boolean(inspectDayuAssetPath(image));
}

// The optional root is for isolated filesystem tests only. The model-facing
// tools call isDayuAssetImagePath/loadDayuAssetImage, which always use the
// fixed image directory above.
export function isSafeBundledImagePath(image, assetRoot) {
    return Boolean(inspectDayuAssetPath(image, assetRoot));
}

function imageMimeFromBytes(bytes) {
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
    if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return undefined;
}

function expectedMimeFromPath(image) {
    const ext = extname(image).toLowerCase();
    return ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : undefined;
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw signal.reason ?? new Error('Bundled image read was aborted.');
}

export async function loadDayuAssetImage(image, maxBytes, signal) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('Bundled image size limit must be positive.');
    const limit = Math.min(Math.floor(maxBytes), 10 * 1024 * 1024);
    if (limit <= 0) throw new Error('Bundled image size limit must be at least one byte.');
    if (!constants.O_NOFOLLOW) throw new Error('Safe bundled image opening is unavailable.');
    const authorized = inspectDayuAssetPath(image);
    if (!authorized) throw new Error('This image path is not an allowed bundled Dayu reference image.');
    const openFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    let handle;
    try {
        throwIfAborted(signal);
        handle = await open(authorized.lexicalPath, openFlags);
        const openedInfo = await handle.stat({ bigint: true });
        if (!openedInfo.isFile() || !samePathIdentity(authorized.file, pathIdentity(openedInfo))) {
            throw new Error('Bundled image changed before opening.');
        }
        if (openedInfo.size > BigInt(limit)) throw new Error(`Bundled image exceeds ${limit} bytes.`);
        const chunks = [];
        let total = 0;
        while (total <= limit) {
            throwIfAborted(signal);
            const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
            if (bytesRead === 0) break;
            total += bytesRead;
            if (total > limit) throw new Error(`Bundled image exceeds ${limit} bytes.`);
            chunks.push(chunk.subarray(0, bytesRead));
        }
        throwIfAborted(signal);
        const finishedInfo = await handle.stat({ bigint: true });
        const afterRead = inspectDayuAssetPath(image);
        if (!finishedInfo.isFile() || !sameFullIdentity(fullIdentity(openedInfo), fullIdentity(finishedInfo))
            || !afterRead || afterRead.identities.length !== authorized.identities.length
            || authorized.identities.some((entry, index) => entry.path !== afterRead.identities[index].path
                || !samePathIdentity(entry.identity, afterRead.identities[index].identity))) {
            throw new Error('Bundled image changed while it was being read.');
        }
        const bytes = Buffer.concat(chunks, total);
        if (imageMimeFromBytes(bytes) !== expectedMimeFromPath(image)) {
            throw new Error('Bundled reference is not a supported image or its extension does not match its contents.');
        }
        return new Uint8Array(bytes);
    }
    finally {
        await handle?.close();
    }
}
