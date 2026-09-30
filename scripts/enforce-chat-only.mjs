import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('usage: enforce-chat-only.mjs <dsh-qqbot-dist-directory>');
const manifest = JSON.parse(await readFile(join(root, '..', 'package.json'), 'utf8'));
if (manifest.version !== '0.5.0') throw new Error('Chat-only patches require dsh-qqbot 0.5.0; refusing an unverified adapter.');
const policy = '/opt/qqbot-defaults/qqbot-chat-policy.mjs';
const webPagesPolicy = '/opt/qqbot-defaults/qqbot-web-pages.mjs';
const documentScopePolicy = '/opt/qqbot-defaults/qqbot-document-scope.mjs';
const imageToolPolicyImport = `import { loadChatImageBytes } from '${policy}';`;
const imageLoaderV3Marker = '// Chat-only scoped image loader v3.';
const imageSchemaV3Marker = '// Chat-only image schema: scoped QQ media paths or public HTTPS image URLs v3.';

function replaceOne(content, needle, replacement, file) {
    if (content.split(needle).length !== 2) {
        throw new Error(`Chat-only patch: expected one matching location in ${file}`);
    }
    return content.replace(needle, replacement);
}

// Check every source before writing. Repeat runs are idempotent for persistent
// volumes. A layout mismatch stops startup instead of silently losing policy.
const updates = new Map();
async function patch(file, marker, transform) {
    const filename = join(root, file);
    const content = updates.get(filename) ?? await readFile(filename, 'utf8');
    if (!content.includes(marker)) updates.set(filename, transform(content, file));
}

await patch('gateway/bootstrap.js', `import { installChatPolicy } from '${policy}';`, (content, file) => {
    content = `import { installChatPolicy } from '${policy}';\n${content}`;
    content = replaceOne(content, 'export async function bootstrapGateway(ctx, agents, config, logger) {',
        'export async function bootstrapGateway(ctx, agents, config, logger) {\n    installChatPolicy(ctx);', file);
    return replaceOne(content, '    registerSendFileTool(ctx, mediaSender, manager, config, logger);',
        '    // Chat-only deployment: file sending is not registered.', file);
});

await patch('gateway/middleware-setup.js', `import {createScopedQuoteRef} from '${policy}';`, (content, file) => {
    const scopedImport = `import {createScopedQuoteRef} from '${policy}';`;
    content = `${scopedImport}\n${content}`;
    return replaceOne(content, [
        '    bot.use(quoteRef({',
        '        maxSize: 500,',
        '        preferMsgElements: true,',
        '    }));',
    ].join('\n'), [
        '    // Chat-only scoped quote references prevent cross-peer message-key collisions.',
        '    bot.use(createScopedQuoteRef(quoteRef));',
    ].join('\n'), file);
});

await patch('index.js', "export const inject = ['agents', 'tools', 'web', 'systemPrompt'];", (content, file) => {
    const desired = "export const inject = ['agents', 'tools', 'web', 'systemPrompt'];";
    const intermediate = "export const inject = ['agents', 'tools', 'web'];";
    const original = "export const inject = ['agents'];";
    if (content.includes(intermediate)) return replaceOne(content, intermediate, desired, file);
    if (content.includes(original)) return replaceOne(content, original, desired, file);
    throw new Error(`Chat-only patch: expected one matching location in ${file}`);
});

await patch('transport/inbound.js', '// Chat-only per-turn document scope v1.', (content, file) => {
    const imageImport = `import { setCurrentImages, clearCurrentImages } from '${policy}';`;
    const scopeImport = `import { beginDocumentTurn, endDocumentTurn, getDocumentTurn } from '${documentScopePolicy}';`;
    if (!content.includes(imageImport)) content = `${imageImport}\n${content}`;
    if (!content.includes(scopeImport)) content = `${scopeImport}\n${content}`;

    const marker = '// Chat-only per-turn document scope v1.';
    const originalContent = "    const content = [{ type: 'text', text: agentBody }];";
    const scopedContent = [
        '    const chatOnlyAgent = record.agent;',
        '    let documentTurn;',
        '    try {',
        '        const documentMetadata = beginDocumentTurn(chatOnlyAgent, msg, mwState.quote);',
        '        documentTurn = getDocumentTurn(chatOnlyAgent);',
        '        const documentBody = documentMetadata.length > 0',
        "            ? `${agentBody}\\n\\n[Untrusted QQ text attachments; use qqbot_read_document with one attachmentId only]\\n${JSON.stringify(documentMetadata)}`",
        '            : agentBody;',
        `        ${marker}`,
        "        const content = [{ type: 'text', text: documentBody }];",
    ].join('\n');
    if (content.includes(originalContent)) content = replaceOne(content, originalContent, scopedContent, file);
    else if (!content.includes(marker)) throw new Error(`Chat-only patch: expected one matching location in ${file}`);

    const duplicateAgent = '    const chatOnlyAgent = record.agent;\n';
    const firstAgent = content.indexOf(duplicateAgent);
    const secondAgent = firstAgent < 0 ? -1 : content.indexOf(duplicateAgent, firstAgent + duplicateAgent.length);
    if (secondAgent >= 0) content = content.slice(0, secondAgent) + content.slice(secondAgent + duplicateAgent.length);

    const oldImageScope = '    setCurrentImages(chatOnlyAgent, mwState.downloadedFiles ?? []);';
    const currentAndQuoteScope = '    setCurrentImages(chatOnlyAgent, [...(mwState.downloadedFiles ?? []), ...(mwState.downloadedQuoteFiles ?? [])]);';
    const currentAndQuoteBoundScope = '        setCurrentImages(chatOnlyAgent, [...(mwState.downloadedFiles ?? []), ...(mwState.downloadedQuoteFiles ?? [])], documentTurn);';
    if (content.includes(oldImageScope)) content = replaceOne(content, oldImageScope, currentAndQuoteBoundScope, file);
    else if (content.includes(currentAndQuoteScope)) content = replaceOne(content, currentAndQuoteScope, currentAndQuoteBoundScope, file);
    else if (!content.includes(currentAndQuoteBoundScope)) {
        // A freshly installed upstream adapter has no previous image guard.
        content = replaceOne(content, '    record.agent.followup(message);',
            `${currentAndQuoteBoundScope}\n    record.agent.followup(message);`, file);
    }

    if (content.includes('    record.agent.followup(message);')) {
        content = replaceOne(content, '    record.agent.followup(message);', '    chatOnlyAgent.followup(message);', file);
    }
    else if (!content.includes('    chatOnlyAgent.followup(message);')) throw new Error(`Chat-only patch: expected one followup in ${file}`);

    const oldIdleAndCleanup = [
        '    try {',
        '        await chatOnlyAgent.whenIdle();',
        '    }',
        '    catch (err) {',
        '        logger.warn(`whenIdle rejected: ${err instanceof Error ? err.message : String(err)}`);',
        '    } finally {',
        '        clearCurrentImages(chatOnlyAgent);',
        '    }',
    ].join('\n');
    const legacyIdleAndCleanup = [
        '    try {',
        '        await record.agent.whenIdle();',
        '    }',
        '    catch (err) {',
        '        logger.warn(`whenIdle rejected: ${err instanceof Error ? err.message : String(err)}`);',
        '    }',
    ].join('\n');
    const scopedIdleAndCleanup = [
        '        await chatOnlyAgent.whenIdle();',
        '    }',
        '    catch (err) {',
        '        logger.warn(`whenIdle/followup rejected: ${err instanceof Error ? err.message : String(err)}`);',
        '    } finally {',
        '        clearCurrentImages(chatOnlyAgent, documentTurn);',
        '        if (documentTurn) endDocumentTurn(chatOnlyAgent, documentTurn);',
        '    }',
    ].join('\n');
    if (content.includes(oldIdleAndCleanup)) content = replaceOne(content, oldIdleAndCleanup, scopedIdleAndCleanup, file);
    else if (content.includes(legacyIdleAndCleanup)) content = replaceOne(content, legacyIdleAndCleanup, scopedIdleAndCleanup, file);
    else if (content.includes('        if (documentTurn) endDocumentTurn(chatOnlyAgent, documentTurn);')) {
        // The current per-turn cleanup is already installed.
    }
    else throw new Error(`Chat-only patch: expected one whenIdle cleanup in ${file}`);

    return content;
});

await patch('transport/inbound.js', '// Chat-only explicit-quote text trigger v1.', (content, file) =>
    replaceOne(content,
        '    if (isEmptyMessage(userContent, msg.attachments, isGroup, wasMentioned))',
        '    // Chat-only explicit-quote text trigger v1.\n    if (isEmptyMessage(userContent, [...(msg.attachments ?? []), ...(state.quote?.attachments ?? [])], isGroup, wasMentioned))', file));

await patch('transport/attachment.js', '// Chat-only current-image downloads v2.', (content, file) => {
    const helperImport = `import { downloadCurrentQQImage } from '${webPagesPolicy}';`;
    if (content.includes(helperImport)) {
        if (content.split(helperImport).length !== 2) {
            throw new Error(`Chat-only patch: expected one matching location in ${file}`);
        }
    }
    else {
        content = `${helperImport}\n${content}`;
    }

    const oldImageMarker = '// Chat-only downloads: images only.';
    const newImageMarker = '// Chat-only current-image downloads v2.';
    const originalTargets = "    const targets = (attachments ?? []).filter(a => classifyContentType(a.content_type) !== 'voice' && a.url);";
    const currentTargets = "    const targets = (attachments ?? []).filter(a => classifyContentType(a.content_type) === 'image' && a.url);";
    if (content.includes(oldImageMarker)) {
        content = replaceOne(content, oldImageMarker, newImageMarker, file);
    }
    else if (content.includes(originalTargets)) {
        content = replaceOne(content, originalTargets,
            `${newImageMarker}\n${currentTargets}`, file);
    }
    else if (!content.includes(newImageMarker) || !content.includes(currentTargets)) {
        throw new Error(`Chat-only patch: expected one matching location in ${file}`);
    }

    const originalDownload = [
        '    const resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });',
        '    if (!resp.ok)',
        '        throw new Error(`HTTP ${resp.status}`);',
        '    const buf = Buffer.from(await resp.arrayBuffer());',
        '    if (buf.length > maxBytes) {',
        '        throw new Error(`Download exceeds ${Math.floor(maxBytes / 1024 / 1024)}MB`);',
        '    }',
    ].join('\n');
    const legacyDownload = [
        "    const resp = await fetch(parsed.href, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: 'error' });",
        '    if (!resp.ok)',
        '        throw new Error(`HTTP ${resp.status}`);',
        '    const chunks = [];',
        '    let total = 0;',
        '    for await (const chunk of resp.body) {',
        '        total += chunk.length;',
        "        if (total > maxBytes) throw new Error('QQ image download exceeds size limit');",
        '        chunks.push(chunk);',
        '    }',
        '    const buf = Buffer.concat(chunks, total);',
    ].join('\n');
    const replacement = '    const buf = await downloadCurrentQQImage(parsed.href, maxBytes);';
    if (content.includes(originalDownload)) {
        content = replaceOne(content, originalDownload, replacement, file);
    }
    else if (content.includes(legacyDownload)) {
        content = replaceOne(content, legacyDownload, replacement, file);
    }
    else if (!content.includes(replacement)) {
        throw new Error(`Chat-only patch: expected one matching location in ${file}`);
    }

    const resolverCall = '    await assertSafeHostname(parsed.hostname);\n';
    if (content.includes(resolverCall)) {
        content = replaceOne(content, resolverCall, '', file);
    }
    return content;
});

await patch('middleware/attachment.js', '// Chat-only quoted-image downloads v2.', (content, file) => {
    const quoteDownloadBlock = [
        '            // 引用消息附件：转成 RawAttachment 结构复用下载（voice 由 downloadMediaAttachments 自动跳过）',
        '            const quoteAttachments = ctx.state.quote?.attachments;',
        '            if (quoteAttachments && quoteAttachments.length > 0) {',
        '                const rawQuote = quoteAttachments',
        '                    .filter(a => a.url)',
        '                    .map((a) => ({',
        "                    content_type: a.contentType ?? '',",
        "                    filename: a.filename ?? '',",
        '                    size: 0,',
        '                    url: a.url,',
        '                }));',
        '                const downloadedQuote = await downloadMediaAttachments(rawQuote, config.media, logger);',
        '                ctx.state.downloadedQuoteFiles = downloadedQuote;',
        '            }',
    ].join('\n');
    const marker = '            // Chat-only quoted-image downloads v2.';
    const replacement = `${marker}\n${quoteDownloadBlock}`;
    const legacyRestrictedBlock = [
        '            // Chat-only quote attachments: never downloaded.',
        '            // Keep quote text/metadata available to the conversation, but only current-message images may enter the cache.',
        '            ctx.state.downloadedQuoteFiles = [];',
    ].join('\n');
    if (content.includes(legacyRestrictedBlock)) {
        return replaceOne(content, legacyRestrictedBlock, replacement, file);
    }
    if (content.includes(quoteDownloadBlock)) {
        return replaceOne(content, quoteDownloadBlock, replacement, file);
    }
    throw new Error(`Chat-only patch: expected one matching location in ${file}`);
});

await patch('media/vision-tool.js', '        timeoutMs: vision.timeoutMs,', (content, file) =>
    replaceOne(content, '        name: DESCRIBE_IMAGE_TOOL_NAME,',
        '        name: DESCRIBE_IMAGE_TOOL_NAME,\n        timeoutMs: vision.timeoutMs,', file));

const mediaRootMarker = '// Chat-only persistent media root v1.';
await patch('media/media-cleaner.js', mediaRootMarker, (content, file) => {
    content = replaceOne(content, "import { join, resolve } from 'node:path';\n",
        "import { join } from 'node:path';\n", file);
    content = replaceOne(content, "import { homedir } from 'node:os';\n", '', file);
    return replaceOne(content,
        "export const MEDIA_ROOT = resolve(homedir(), '.dsh-qqbot', 'media');",
        `${mediaRootMarker}\nexport const MEDIA_ROOT = '/data/qqbot-media';`, file);
});

const mediaCleanerPath = join(root, 'media/media-cleaner.js');
const patchedMediaCleaner = updates.get(mediaCleanerPath) ?? await readFile(mediaCleanerPath, 'utf8');
if (patchedMediaCleaner.split(mediaRootMarker).length !== 2
    || !patchedMediaCleaner.includes("export const MEDIA_ROOT = '/data/qqbot-media';")
    || patchedMediaCleaner.includes("resolve(homedir(), '.dsh-qqbot', 'media')")
    || patchedMediaCleaner.includes("import { homedir } from 'node:os';")
    || patchedMediaCleaner.includes("import { join, resolve } from 'node:path';")) {
    throw new Error('Chat-only patch: persistent media root is incomplete or still uses the home-directory path');
}

await patch('media/vision-tool.js', '// Chat-only image schema: current and explicitly quoted QQ attachments v2.', (content, file) => {
    if (content.includes(imageSchemaV3Marker)) return content;
    const oldDescription = [
        "const DESCRIPTION = 'Inspect one image and return the text the user needs. The image is a local absolute path '",
        "    + '(downloaded by the QQ bot) or an http(s) URL. Use this when the user references an image, '",
        "    + 'or when a task needs OCR, chart/diagram reading, screenshot or UI analysis, translation of '",
        "    + 'image text, or photo understanding. Always pass an explicit `prompt` with a precise '",
        "    + 'instruction (e.g. \"transcribe all text\", \"extract the table as CSV\", \"translate the text '",
        "    + 'into Chinese\") instead of relying on the generic default.';",
    ].join('\n');
    const previousDescription = [
        '// Chat-only image schema: current QQ attachment paths only.',
        "const DESCRIPTION = 'Inspect one image and return the text the user needs. The image must be an absolute path '",
        "    + 'of an image attached to the current QQ message. URLs and other files are forbidden. Use this when '",
        "    + 'the user references an image, or when a task needs OCR, chart/diagram reading, screenshot or UI analysis, '",
        "    + 'translation of image text, or photo understanding. Always pass an explicit `prompt` with a precise '",
        "    + 'instruction (e.g. \"transcribe all text\", \"extract the table as CSV\", \"translate the text into Chinese\") '",
        "    + 'instead of relying on the generic default.';",
    ].join('\n');
    const newDescription = [
        '// Chat-only image schema: current and explicitly quoted QQ attachments v2.',
        "const DESCRIPTION = 'Inspect one image and return the text the user needs. The image must be an absolute path '",
        "    + 'of an image attached to or explicitly quoted in the current QQ message. URLs and other files are forbidden. '",
        "    + 'Use this when the user references an image, or when a task needs OCR, chart/diagram reading, screenshot or UI analysis, '",
        "    + 'translation of image text, or photo understanding. Always pass an explicit `prompt` with a precise '",
        "    + 'instruction (e.g. \"transcribe all text\", \"extract the table as CSV\", \"translate the text into Chinese\") '",
        "    + 'instead of relying on the generic default.';",
    ].join('\n');
    if (content.includes(oldDescription)) {
        content = replaceOne(content, oldDescription, newDescription, file);
    }
    else if (content.includes(previousDescription)) {
        content = replaceOne(content, previousDescription, newDescription, file);
    }
    else {
        throw new Error(`Chat-only patch: expected one matching location in ${file}`);
    }
    const originalParameter = "                    description: 'Absolute path to a local image file, or an http(s) URL of the image.',";
    const previousParameter = "                    description: 'Absolute path of an image attached to the current QQ message. URLs and other files are forbidden.',";
    const newParameter = "                    description: 'Absolute path of an image attached to or explicitly quoted in the current QQ message. URLs and other files are forbidden.',";
    if (content.includes(originalParameter)) return replaceOne(content, originalParameter, newParameter, file);
    if (content.includes(previousParameter)) return replaceOne(content, previousParameter, newParameter, file);
    throw new Error(`Chat-only patch: expected one matching location in ${file}`);
});

await patch('media/vision-tool.js', imageSchemaV3Marker, (content, file) => {
    const oldDescription = [
        '// Chat-only image schema: current and explicitly quoted QQ attachments v2.',
        "const DESCRIPTION = 'Inspect one image and return the text the user needs. The image must be an absolute path '",
        "    + 'of an image attached to or explicitly quoted in the current QQ message. URLs and other files are forbidden. '",
        "    + 'Use this when the user references an image, or when a task needs OCR, chart/diagram reading, screenshot or UI analysis, '",
        "    + 'translation of image text, or photo understanding. Always pass an explicit `prompt` with a precise '",
        "    + 'instruction (e.g. \"transcribe all text\", \"extract the table as CSV\", \"translate the text into Chinese\") '",
        "    + 'instead of relying on the generic default.';",
    ].join('\n');
    const newDescription = [
        imageSchemaV3Marker,
        "const DESCRIPTION = 'Inspect one image and return the text the user needs. The image must be either an absolute path '",
        "    + 'of an image attached to or explicitly quoted in the current QQ message and stored inside the QQ media directory, '",
        "    + 'or a public HTTPS image URL. Other local paths, non-HTTPS URLs, and non-image files are forbidden. '",
        "    + 'Use this when the user references an image, or when a task needs OCR, chart/diagram reading, screenshot or UI analysis, '",
        "    + 'translation of image text, or photo understanding. Always pass an explicit `prompt` with a precise '",
        "    + 'instruction (e.g. \"transcribe all text\", \"extract the table as CSV\", \"translate the text into Chinese\") '",
        "    + 'instead of relying on the generic default.';",
    ].join('\n');
    content = replaceOne(content, oldDescription, newDescription, file);
    content = replaceOne(content,
        "                    description: 'Absolute path of an image attached to or explicitly quoted in the current QQ message. URLs and other files are forbidden.',",
        "                    description: 'Absolute path of a current-message or explicitly quoted image inside the QQ media directory, or a public HTTPS image URL.',",
        file);
    return content;
});

await patch('media/vision-tool.js', imageLoaderV3Marker, (content, file) => {
    const originalLoader = [
        '/** 加载图片字节（本地路径 / http URL），校验大小 + 嗅探 MIME */',
        'async function loadImageBytes(image, maxBytes, signal) {',
        '    let data;',
        '    if (/^https?:\\/\\//i.test(image)) {',
        "        const resp = await fetch(image, { signal, redirect: 'error' });",
        '        if (!resp.ok)',
        '            throw new Error(`qqbot_describe_image: download failed (HTTP ${resp.status})`);',
        '        const buf = Buffer.from(await resp.arrayBuffer());',
        '        if (buf.length > maxBytes)',
        '            throw new Error(`qqbot_describe_image: image too large (${buf.length} bytes)`);',
        '        data = new Uint8Array(buf);',
        '    }',
        '    else {',
        '        const info = await stat(image).catch(() => null);',
        '        if (!info?.isFile())',
        '            throw new Error(`qqbot_describe_image: image file not found: ${image}`);',
        '        if (info.size > maxBytes)',
        '            throw new Error(`qqbot_describe_image: image too large (${info.size} bytes)`);',
        '        data = new Uint8Array(await readFile(image));',
        '    }',
        '    const mediaType = sniffImageMediaType(data);',
        '    if (mediaType === null)',
        "        throw new Error('qqbot_describe_image: unrecognized image format (png/jpeg/gif/webp only)');",
        '    return { data, mediaType };',
        '}',
    ].join('\n');
    const scopedLoader = [
        imageLoaderV3Marker,
        'async function loadImageBytes(image, maxBytes, exec) {',
        '    const data = await loadChatImageBytes(image, maxBytes, exec);',
        '    const mediaType = sniffImageMediaType(data);',
        '    if (mediaType === null)',
        "        throw new Error('qqbot_describe_image: unrecognized image format (png/jpeg/gif/webp only)');",
        '    return { data, mediaType };',
        '}',
    ].join('\n');
    content = replaceOne(content, 'import { readFile, stat } from \'node:fs/promises\';\n', '', file);
    content = replaceOne(content, "import { existsSync, readFileSync, writeFileSync } from 'node:fs';\n",
        `import { existsSync, readFileSync, writeFileSync } from 'node:fs';\n${imageToolPolicyImport}\n`, file);
    content = replaceOne(content, originalLoader, scopedLoader, file);
    content = replaceOne(content, 'loadImageBytes(image, vision.maxBytes, exec.signal)',
        'loadImageBytes(image, vision.maxBytes, exec)', file);
    return content;
});

const visionPath = join(root, 'media/vision-tool.js');
const patchedVision = updates.get(visionPath) ?? await readFile(visionPath, 'utf8');
if (patchedVision.split(imageToolPolicyImport).length !== 2
    || patchedVision.split(imageLoaderV3Marker).length !== 2
    || patchedVision.split(imageSchemaV3Marker).length !== 2
    || !patchedVision.includes('const data = await loadChatImageBytes(image, maxBytes, exec);')
    || !patchedVision.includes('loadImageBytes(image, vision.maxBytes, exec)')
    || patchedVision.includes('await readFile(image)')
    || patchedVision.includes('await fetch(image,')
    || patchedVision.includes('loadImageBytes(image, vision.maxBytes, exec.signal)')) {
    throw new Error('Chat-only patch: vision image loader v3 is incomplete or still contains an unrestricted loader');
}

for (const [file, content] of updates) await writeFile(file, content);
