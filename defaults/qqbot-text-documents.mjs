const EXTENSION_TYPES = new Map([
    ['txt', 'text/plain'],
    ['md', 'text/markdown'],
    ['markdown', 'text/markdown'],
    ['json', 'application/json'],
    ['yaml', 'application/yaml'],
    ['yml', 'application/yaml'],
    ['csv', 'text/csv'],
    ['tsv', 'text/tab-separated-values'],
    ['log', 'text/plain'],
    ['xml', 'application/xml'],
    ['ini', 'text/plain'],
    ['toml', 'text/plain'],
]);

const RTF_TYPES = new Set([
    'application/rtf',
    'application/x-rtf',
    'text/rtf',
    'text/richtext',
    'text/x-rtf',
]);

const BINARY_SIGNATURES = [
    ['PDF', [0x25, 0x50, 0x44, 0x46, 0x2d]],
    ['ZIP/archive', [0x50, 0x4b, 0x03, 0x04]],
    ['ZIP/archive', [0x50, 0x4b, 0x05, 0x06]],
    ['ZIP/archive', [0x50, 0x4b, 0x07, 0x08]],
    ['OLE/Office', [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
    ['PNG image', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ['JPEG image', [0xff, 0xd8, 0xff]],
    ['GIF image', [0x47, 0x49, 0x46, 0x38]],
    ['BMP image', [0x42, 0x4d]],
    ['WebP image', [0x52, 0x49, 0x46, 0x46]],
    ['ELF executable', [0x7f, 0x45, 0x4c, 0x46]],
    ['PE executable', [0x4d, 0x5a]],
    ['gzip archive', [0x1f, 0x8b]],
    ['bzip2 archive', [0x42, 0x5a, 0x68]],
    ['xz archive', [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]],
    ['7-Zip archive', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
    ['RAR archive', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]],
    ['SQLite database', [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66]],
    ['WebAssembly binary', [0x00, 0x61, 0x73, 0x6d]],
];

function startsWithBytes(bytes, signature, offset = 0) {
    if (bytes.length < offset + signature.length) return false;
    return signature.every((byte, index) => bytes[offset + index] === byte);
}

function textError(code, message) {
    return Object.assign(new Error(message), { code });
}

export function normalizeTextMediaType(value) {
    if (typeof value !== 'string') return '';
    return value.split(';', 1)[0].trim().toLowerCase();
}

function isAcceptedTextMediaType(mediaType) {
    if (!mediaType || RTF_TYPES.has(mediaType) || /(?:^|[+/.-])(?:x-)?(?:rtf|richtext)(?:$|[+./-])/.test(mediaType)) return false;
    if (mediaType.startsWith('text/')) return true;
    if (mediaType === 'application/xhtml+xml' || mediaType === 'application/json' || mediaType === 'application/yaml'
        || mediaType === 'application/x-yaml' || mediaType === 'application/xml') return true;
    if (!mediaType.startsWith('application/')) return false;
    const subtype = mediaType.slice('application/'.length);
    return subtype.endsWith('+json') || subtype.endsWith('+xml');
}

function extensionType(filename) {
    if (typeof filename !== 'string') return undefined;
    const base = filename.slice(Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\')) + 1);
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || dot === base.length - 1) return undefined;
    return EXTENSION_TYPES.get(base.slice(dot + 1).toLowerCase());
}

/** Resolve a declared MIME type, optionally allowing the narrow QQ filename fallback. */
export function resolveTextDocumentType(contentType, filename, { allowExtensionFallback = false } = {}) {
    const declared = normalizeTextMediaType(contentType);
    if (isAcceptedTextMediaType(declared)) return { accepted: true, contentType: declared, declaredContentType: declared };
    if (declared && declared !== 'application/octet-stream') {
        return { accepted: false, contentType: declared, declaredContentType: declared };
    }
    if (allowExtensionFallback) {
        const inferred = extensionType(filename);
        if (inferred) return { accepted: true, contentType: inferred, declaredContentType: declared };
    }
    return { accepted: false, contentType: declared || 'application/octet-stream', declaredContentType: declared };
}

function rtfTextPrefix(bytes, charset) {
    const sample = bytes.subarray(0, Math.min(bytes.length, 64));
    let text;
    try {
        text = new TextDecoder(charset, { fatal: false }).decode(sample);
    }
    catch {
        return false;
    }
    return /^\uFEFF?\s*\{\\rtf(?:\d|\b)/i.test(text);
}

/** Return a coarse binary signature label, or undefined for text-like bytes. */
export function isBinaryDocumentBytes(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let prefix = startsWithBytes(bytes, [0xef, 0xbb, 0xbf]) ? 3 : 0;
    while (prefix < Math.min(bytes.length, 1024) && [9, 10, 12, 13, 32].includes(bytes[prefix])) prefix++;
    if (startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d], prefix)) return 'PDF';
    for (const [label, signature] of BINARY_SIGNATURES) {
        if (startsWithBytes(bytes, signature)) return label;
    }
    if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'ISO media container';
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'WebP image';
    if ((bytes.length >= 4 && bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00)
        || (bytes.length >= 4 && bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)) return 'TIFF image';
    if (rtfTextPrefix(bytes, 'utf-8')) return 'RTF document';
    return undefined;
}

function declaredCharset(contentType) {
    if (typeof contentType !== 'string') return undefined;
    const match = /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(contentType);
    return match ? (match[1] ?? match[2] ?? match[3]).trim().toLowerCase() : undefined;
}

function chooseCharset(bytes, contentType) {
    const requested = declaredCharset(contentType);
    const bom = startsWithBytes(bytes, [0xff, 0xfe]) ? 'utf-16le'
        : startsWithBytes(bytes, [0xfe, 0xff]) ? 'utf-16be'
        : startsWithBytes(bytes, [0xef, 0xbb, 0xbf]) ? 'utf-8' : undefined;
    if (requested !== undefined) {
        let decoder;
        try {
            // TextDecoder itself is the authority for supported labels. Keep
            // ASCII's stricter byte semantics because WHATWG aliases it to
            // windows-1252 for decoding.
            decoder = new TextDecoder(requested, { fatal: true });
        }
        catch {
            throw textError('TEXT_UNSUPPORTED_CHARSET', 'Unsupported text charset.');
        }
        const charset = requested === 'utf-16' && bom?.startsWith('utf-16') ? bom : decoder.encoding;
        if (bom && bom !== charset) throw textError('TEXT_INVALID_ENCODING', 'Document BOM conflicts with its declared charset.');
        return { charset, asciiOnly: requested === 'ascii' || requested === 'us-ascii' };
    }
    return { charset: bom ?? 'utf-8', asciiOnly: false };
}

function assertDecodedText(text) {
    // Tabs and line breaks are ordinary text whitespace. Other C0/C1 controls,
    // including NUL, are rejected as binary or control-stream content.
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) {
        throw textError('TEXT_BINARY', 'Document contains binary control characters.');
    }
    if (/^\uFEFF?\s*\{\\rtf(?:\d|\b)/i.test(text)) throw textError('TEXT_BINARY', 'RTF documents are not readable.');
}

/** Decode validated text bytes strictly; byte-truncated final code points are discarded. */
export function decodeTextDocumentBytes(input, contentType, { truncatedByBytes = false } = {}) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const { charset, asciiOnly } = chooseCharset(bytes, contentType);
    const signature = isBinaryDocumentBytes(bytes);
    if (signature) throw textError('TEXT_BINARY', `Document bytes identify a binary ${signature}.`);
    if (asciiOnly && bytes.some((byte) => byte > 0x7f)) throw textError('TEXT_INVALID_ENCODING', 'Document bytes are not valid ASCII.');
    const decoder = new TextDecoder(charset, { fatal: true });
    let text;
    try {
        text = decoder.decode(bytes, { stream: Boolean(truncatedByBytes) });
    }
    catch {
        throw textError('TEXT_INVALID_ENCODING', 'Document bytes are not valid text in the declared or detected charset.');
    }
    assertDecodedText(text);
    return { text, charset, truncatedByBytes: Boolean(truncatedByBytes) };
}
