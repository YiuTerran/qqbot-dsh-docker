import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('usage: enforce-chat-only.mjs <dsh-qqbot-dist-directory>');
const manifest = JSON.parse(await readFile(join(root, '..', 'package.json'), 'utf8'));
if (manifest.version !== '0.5.0') throw new Error('Chat-only patches require dsh-qqbot 0.5.0; refusing an unverified adapter.');
const policy = '/opt/qqbot-defaults/qqbot-chat-policy.mjs';
const webPagesPolicy = '/opt/qqbot-defaults/qqbot-web-pages.mjs';

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

await patch('transport/inbound.js', '// Chat-only current-and-quoted image scope v2.', (content, file) => {
    const policyImport = `import { setCurrentImages, clearCurrentImages } from '${policy}';`;
    if (!content.includes(policyImport)) content = `${policyImport}\n${content}`;
    const originalScope = '    setCurrentImages(chatOnlyAgent, mwState.downloadedFiles ?? []);';
    const mergedScope = [
        '    // Chat-only current-and-quoted image scope v2.',
        '    setCurrentImages(chatOnlyAgent, [...(mwState.downloadedFiles ?? []), ...(mwState.downloadedQuoteFiles ?? [])]);',
    ].join('\n');
    if (content.includes('    record.agent.followup(message);')) {
        content = replaceOne(content, '    record.agent.followup(message);',
            '    const chatOnlyAgent = record.agent;\n' + mergedScope + '\n    chatOnlyAgent.followup(message);', file);
    }
    else if (content.includes('    chatOnlyAgent.followup(message);')) {
        if (content.includes(originalScope)) content = replaceOne(content, originalScope, mergedScope, file);
        else if (!content.includes('// Chat-only current-and-quoted image scope v2.') || !content.includes('mwState.downloadedQuoteFiles')) {
            throw new Error(`Chat-only patch: expected one matching location in ${file}`);
        }
    }
    else {
        throw new Error(`Chat-only patch: expected one matching location in ${file}`);
    }
    const originalIdle = '        await record.agent.whenIdle();';
    if (content.includes(originalIdle)) content = replaceOne(content, originalIdle, '        await chatOnlyAgent.whenIdle();', file);
    else if (!content.includes('        await chatOnlyAgent.whenIdle();')) throw new Error(`Chat-only patch: expected one matching location in ${file}`);
    const originalCatch = "        logger.warn(`whenIdle rejected: ${err instanceof Error ? err.message : String(err)}`);\n    }";
    const guardedCatch = "        logger.warn(`whenIdle rejected: ${err instanceof Error ? err.message : String(err)}`);\n    } finally {\n        clearCurrentImages(chatOnlyAgent);\n    }";
    if (content.includes(guardedCatch)) {
        // Existing v1 patch already clears the scope in finally; only upgrade its image set.
    }
    else if (content.includes(`${originalCatch}\n`)) content = replaceOne(content, originalCatch, guardedCatch, file);
    else throw new Error(`Chat-only patch: expected one matching location in ${file}`);
    return content;
});

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

await patch('media/vision-tool.js', '// Chat-only image schema: current and explicitly quoted QQ attachments v2.', (content, file) => {
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

for (const [file, content] of updates) await writeFile(file, content);
