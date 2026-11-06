// Reverse chat-only layers after pre-concurrency and pre-recovery fixtures.
// Kept standalone so the exact Docker legacy-volume transformation can be tested locally.
import fs from "node:fs";
const root = process.argv[2];
if (!root) throw new Error("usage: prepare-legacy-policy-fixture.mjs <dsh-qqbot-lib-directory>");
const originalDownload = "    const resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });\n    if (!resp.ok)\n        throw new Error(`HTTP ${resp.status}`);\n    const buf = Buffer.from(await resp.arrayBuffer());\n    if (buf.length > maxBytes) {\n        throw new Error(`Download exceeds ${Math.floor(maxBytes / 1024 / 1024)}MB`);\n    }";
const originalQuoteBlock = [
    "            // 引用消息附件：转成 RawAttachment 结构复用下载（voice 由 downloadMediaAttachments 自动跳过）",
    "            const quoteAttachments = ctx.state.quote?.attachments;",
    "            if (quoteAttachments && quoteAttachments.length > 0) {",
    "                const rawQuote = quoteAttachments",
    "                    .filter(a => a.url)",
    "                    .map((a) => ({",
    "                    content_type: a.contentType ?? \x27\x27,",
    "                    filename: a.filename ?? \x27\x27,",
    "                    size: 0,",
    "                    url: a.url,",
    "                }));",
    "                const downloadedQuote = await downloadMediaAttachments(rawQuote, config.media, logger);",
    "                ctx.state.downloadedQuoteFiles = downloadedQuote;",
    "            }",
].join("\n");
const inboundPath = `${root}/transport/inbound.js`;
const replaceExactlyOnce = (text, before, after, label) => {
    const parts = text.split(before);
    if (parts.length !== 2) throw new Error(`legacy fixture expected one ${label}`);
    return parts[0] + after + parts[1];
};
let inbound = fs.readFileSync(inboundPath, "utf8");
if (inbound.includes("// Chat-only OneBot provenance v1.") || inbound.includes("onebotMetadata") || inbound.includes("let onebotTurn;")) {
    const onebotScopeImport = "import { beginOnebotTurn, endOnebotTurn, renderOnebotRequestMetadata } from '/opt/qqbot-defaults/qqbot-onebot-scope.mjs';\n";
    if (inbound.includes(onebotScopeImport)) inbound = replaceExactlyOnce(inbound, onebotScopeImport, "", "OneBot scope import");
    const onebotPolicyImport = "import { setCurrentImages, clearCurrentImages, isOnebotToolAvailable } from '/opt/qqbot-defaults/qqbot-chat-policy.mjs';";
    if (inbound.includes(onebotPolicyImport)) inbound = replaceExactlyOnce(inbound, onebotPolicyImport,
        "import { setCurrentImages, clearCurrentImages } from '/opt/qqbot-defaults/qqbot-chat-policy.mjs';", "OneBot availability import");
    const onebotBinding = [
        "        // Chat-only OneBot provenance v1.",
        "        if (isOnebotToolAvailable()) onebotTurn = beginOnebotTurn(",
        "            chatOnlyAgent,",
        "            getMergedGenerationRequests(ctx),",
        "            { appId: config.appId, signal: ctx.signal, isCurrentRecord, record, documentScope: documentTurn },",
        "        );",
        "        const onebotMetadata = onebotTurn ? renderOnebotRequestMetadata(onebotTurn) : '';",
    ].join("\n");
    if (inbound.includes(onebotBinding + "\n")) inbound = replaceExactlyOnce(inbound, onebotBinding + "\n", "", "OneBot turn binding");
    else if (inbound.includes("// Chat-only OneBot provenance v1.") || inbound.includes("onebotMetadata")) {
        throw new Error("legacy fixture found a partial OneBot request binding");
    }
    const withOnebotMetadata = "        const requestBody = [documentBody, generationMetadata, onebotMetadata].filter(Boolean).join(\x27\\n\\n\x27);";
    const withoutOnebotMetadata = "        const requestBody = [documentBody, generationMetadata].filter(Boolean).join(\x27\\n\\n\x27);";
    if (inbound.includes(withOnebotMetadata)) inbound = replaceExactlyOnce(inbound, withOnebotMetadata, withoutOnebotMetadata, "OneBot model body");
    const onebotCleanup = "                // Chat-only OneBot scope cleanup v1.\n                if (onebotTurn) await endOnebotTurn(chatOnlyAgent, onebotTurn);\n";
    if (inbound.includes(onebotCleanup)) inbound = replaceExactlyOnce(inbound, onebotCleanup, "", "OneBot scope cleanup");
    else if (inbound.includes("endOnebotTurn(chatOnlyAgent, onebotTurn)")) throw new Error("legacy fixture found a partial OneBot cleanup");
    if (inbound.includes("    let onebotTurn;\n")) inbound = replaceExactlyOnce(inbound, "    let onebotTurn;\n", "", "OneBot turn declaration");
}
if (inbound.includes("onebotTurn") || inbound.includes("onebotMetadata") || inbound.includes("OneBot provenance"))
    throw new Error("legacy fixture did not remove the OneBot scope");
const documentScopeBlock = [
    "    const chatOnlyAgent = record.agent;",
    "    let documentTurn;",
    "    try {",
    "        const documentMetadata = beginDocumentTurn(chatOnlyAgent, msg, mwState.quote);",
    "        documentTurn = getDocumentTurn(chatOnlyAgent);",
    "        const documentBody = documentMetadata.length > 0",
    "            ? `${agentBody}\\n\\n[Untrusted QQ text attachments; use qqbot_read_document with one attachmentId only]\\n${JSON.stringify(documentMetadata)}`",
    "            : agentBody;",
    "        // Chat-only per-turn document scope v1.",
    "        const content = [{ type: \x27text\x27, text: documentBody }];",
].join("\n");
if (inbound.split(documentScopeBlock).length !== 2) throw new Error("legacy fixture expected one document scope block");
inbound = inbound.replace(documentScopeBlock, "    const content = [{ type: \x27text\x27, text: agentBody }];\n    const chatOnlyAgent = record.agent;");
inbound = inbound.replace("import { beginDocumentTurn, endDocumentTurn, getDocumentTurn } from \x27/opt/qqbot-defaults/qqbot-document-scope.mjs\x27;\n", "");
inbound = inbound.replace("        setCurrentImages(chatOnlyAgent, [...(mwState.downloadedFiles ?? []), ...(mwState.downloadedQuoteFiles ?? [])], documentTurn);",
    "    setCurrentImages(chatOnlyAgent, [...(mwState.downloadedFiles ?? []), ...(mwState.downloadedQuoteFiles ?? [])]);");
const documentCleanup = [
    "        await chatOnlyAgent.whenIdle();",
    "    }",
    "    catch (err) {",
    "        logger.warn(`whenIdle/followup rejected: ${err instanceof Error ? err.message : String(err)}`);",
    "    } finally {",
    "        clearCurrentImages(chatOnlyAgent, documentTurn);",
    "        if (documentTurn) endDocumentTurn(chatOnlyAgent, documentTurn);",
    "    }",
].join("\n");
if (inbound.split(documentCleanup).length !== 2) throw new Error("legacy fixture expected one document cleanup");
inbound = inbound.replace(documentCleanup, [
    "    try {",
    "        await chatOnlyAgent.whenIdle();",
    "    }",
    "    catch (err) {",
    "        logger.warn(`whenIdle rejected: ${err instanceof Error ? err.message : String(err)}`);",
    "    } finally {",
    "        clearCurrentImages(chatOnlyAgent);",
    "    }",
].join("\n"));
fs.writeFileSync(inboundPath, inbound);
const edits = {
    "gateway/bootstrap.js": [
        ["import { installChatPolicy } from \x27/opt/qqbot-defaults/qqbot-chat-policy.mjs\x27;\n", ""],
        ["    installChatPolicy(ctx);\n", ""],
        ["    // Chat-only deployment: file sending is not registered.", "    registerSendFileTool(ctx, mediaSender, manager, config, logger);"]
    ],
    "gateway/middleware-setup.js": [
        ["import {createScopedQuoteRef} from \x27/opt/qqbot-defaults/qqbot-chat-policy.mjs\x27;\n", ""],
        ["    // Chat-only scoped quote references prevent cross-peer message-key collisions.\n", ""],
        ["    // Chat-only generation quote capture v1.\n", ""],
        ["    // Chat-only quoted attachment cache v2.\n", ""],
        ["import { createPendingImageCaptureMiddleware, createPendingImagePromptMiddleware, createPendingImageNewCommandCleanup } from \x27/opt/qqbot-defaults/qqbot-pending-images.mjs\x27;\n", ""],
        ["    // Chat-only deferred image prompts v1.\n", ""],
        ["    bot.use(createPendingImageCaptureMiddleware({ appId: config.appId }));\n", ""],
        ["    // Chat-only pending image /new cleanup v1.\n", ""],
        ["    bot.use(createPendingImageNewCommandCleanup({ appId: config.appId }));\n", ""],
        ["    // Chat-only deferred image prompt association v1.\n", ""],
        ["    bot.use(createPendingImagePromptMiddleware({ appId: config.appId }));\n", ""],
        ["import { createHistorySnapshotBuffer } from \x27/opt/qqbot-defaults/qqbot-history-snapshot.mjs\x27;\n", ""],
        ["    // Chat-only history snapshot epoch guard v1.\n", ""],
        ["bot.use(createHistorySnapshotBuffer(historyBuffer, {", "bot.use(historyBuffer({"],
        [
            [
                "    bot.use(createScopedQuoteRef(quoteRef));",
            ].join("\n"),
            [
                "    bot.use(quoteRef({",
                "        maxSize: 500,",
                "        preferMsgElements: true,",
                "    }));",
            ].join("\n"),
        ],
    ],
    "index.js": [
        ["export const inject = [\x27agents\x27, \x27tools\x27, \x27web\x27, \x27systemPrompt\x27];", "export const inject = [\x27agents\x27];"],
        ["export const inject = [\x27agents\x27, \x27tools\x27, \x27web\x27];", "export const inject = [\x27agents\x27];"]
    ],
    "transport/inbound.js": [
        ["    // Chat-only explicit-quote text trigger v1.\n", ""],
        ["    if (isEmptyMessage(userContent, [...(msg.attachments ?? []), ...(state.quote?.attachments ?? [])], isGroup, wasMentioned))", "    if (isEmptyMessage(userContent, msg.attachments, isGroup, wasMentioned))"],
        ["import { setCurrentImages, clearCurrentImages } from \x27/opt/qqbot-defaults/qqbot-chat-policy.mjs\x27;\n", ""],
        ["    const chatOnlyAgent = record.agent;\n", ""],
        ["    // Chat-only current-and-quoted image scope v2.\n", ""],
        ["// Chat-only current-and-quoted image scope v2.\n", ""],
        ["    setCurrentImages(chatOnlyAgent, [...(mwState.downloadedFiles ?? []), ...(mwState.downloadedQuoteFiles ?? [])]);\n", ""],
        ["    setCurrentImages(chatOnlyAgent, mwState.downloadedFiles ?? []);\n", ""],
        ["    chatOnlyAgent.followup(message);", "    record.agent.followup(message);"],
        ["        await chatOnlyAgent.whenIdle();", "        await record.agent.whenIdle();"],
        ["    } finally {\n        clearCurrentImages(chatOnlyAgent);\n", ""]
    ],
    "transport/attachment.js": [
        ["import { downloadCurrentQQImage } from \x27/opt/qqbot-defaults/qqbot-web-pages.mjs\x27;\n", ""],
        ["import { downloadCurrentQQImage } from \x27/opt/qqbot-defaults/qqbot-chat-policy.mjs\x27;\n", ""],
        ["// Chat-only current-image downloads v3.\n", ""],
        ["    // Chat-only current-image downloads v3.\n", ""],
        ["    // Chat-only downloads: images only.\n", ""],
        ["    const targets = (attachments ?? []).filter(a => classifyContentType(a.content_type) === \x27image\x27 && a.url);", "    const targets = (attachments ?? []).filter(a => classifyContentType(a.content_type) !== \x27voice\x27 && a.url);"],
        ["    const buf = await downloadCurrentQQImage(parsed.href, maxBytes);", "    " + "const resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });\n    if (!resp.ok)\n        throw new Error(`HTTP ${resp.status}`);\n    const buf = Buffer.from(await resp.arrayBuffer());\n    if (buf.length > maxBytes) {\n        throw new Error(`Download exceeds ${Math.floor(maxBytes / 1024 / 1024)}MB`);\n    }"],
        ["    const resp = await fetch(parsed.href, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: \x27error\x27 });", "    const resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });"],
        ["    const chunks = [];\n    let total = 0;\n    for await (const chunk of resp.body) {\n        total += chunk.length;\n        if (total > maxBytes) throw new Error(\x27QQ image download exceeds size limit\x27);\n        chunks.push(chunk);\n    }\n    const buf = Buffer.concat(chunks, total);", "    const buf = Buffer.from(await resp.arrayBuffer());\n    if (buf.length > maxBytes) {\n        throw new Error(`Download exceeds ${Math.floor(maxBytes / 1024 / 1024)}MB`);\n    }"]
    ],
    "media/vision-tool.js": [["        timeoutMs: vision.timeoutMs,\n", ""]]
};
for (const [file, replacements] of Object.entries(edits)) {
    const path = `${root}/${file}`;
    let text = fs.readFileSync(path, "utf8");
    for (const [before, after] of replacements) {
        if (text.includes(before)) text = text.replace(before, after);
    }
    fs.writeFileSync(path, text);
}
const attachmentPath = `${root}/transport/attachment.js`;
let attachmentSource = fs.readFileSync(attachmentPath, "utf8");
const modernTargets = attachmentSource.split("\n").find((line) => line.includes("a.url && (classifyContentType"));
if (!modernTargets) throw new Error("legacy fixture expected the v3 image fallback target selector");
const apostrophe = String.fromCharCode(39);
const legacyTargets = "    const targets = (attachments ?? []).filter(a => classifyContentType(a.content_type) !== "
    + apostrophe + "voice" + apostrophe + " && a.url);";
attachmentSource = attachmentSource.replace(modernTargets, legacyTargets);
const sourceUrlResult = "        results.push({ filename: att.filename, contentType, localPath, sourceUrl: att.url });";
const sourceUrlPatch = "        // Chat-only attachment source URL v2.\n" + sourceUrlResult;
if (attachmentSource.includes(sourceUrlPatch)) {
    attachmentSource = attachmentSource.replace(sourceUrlPatch,
        "        results.push({ filename: att.filename, contentType, localPath });");
}
else if (attachmentSource.includes("sourceUrl: att.url")
    || attachmentSource.includes("Chat-only attachment source URL v2.")) {
    throw new Error("legacy fixture found partial source URL provenance");
}
else if (!attachmentSource.includes("results.push({ filename: att.filename, contentType, localPath });")) {
    throw new Error("legacy fixture did not restore the stock attachment result shape");
}
fs.writeFileSync(attachmentPath, attachmentSource);
const visionPath = `${root}/media/vision-tool.js`;
let vision = fs.readFileSync(visionPath, "utf8");
const visionImport = "import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from \x27node:fs\x27;\n";
vision = replaceExactlyOnce(vision, visionImport,
    visionImport + "import { readFile, stat } from \x27node:fs/promises\x27;\n", "stock fs imports");
vision = replaceExactlyOnce(vision,
    "import { loadChatImageBytes } from \x27/opt/qqbot-defaults/qqbot-chat-policy.mjs\x27;\n", "", "v3 helper import");
const v3Description = [
    "// Chat-only image schema: scoped QQ media paths or public HTTPS image URLs v3.",
    "const DESCRIPTION = \x27Inspect one image and return the text the user needs. The image must be either an absolute path \x27",
    "    + \x27of an image attached to or explicitly quoted in the current QQ message and stored inside the QQ media directory, \x27",
    "    + \x27or a public HTTPS image URL. Other local paths, non-HTTPS URLs, and non-image files are forbidden. \x27",
    "    + \x27Use this when the user references an image, or when a task needs OCR, chart/diagram reading, screenshot or UI analysis, \x27",
    "    + \x27translation of image text, or photo understanding. Always pass an explicit `prompt` with a precise \x27",
    "    + \x27instruction (e.g. \"transcribe all text\", \"extract the table as CSV\", \"translate the text into Chinese\") \x27",
    "    + \x27instead of relying on the generic default.\x27;",
].join("\n");
const v2Description = [
    "// Chat-only image schema: current and explicitly quoted QQ attachments v2.",
    "const DESCRIPTION = \x27Inspect one image and return the text the user needs. The image must be an absolute path \x27",
    "    + \x27of an image attached to or explicitly quoted in the current QQ message. URLs and other files are forbidden. \x27",
    "    + \x27Use this when the user references an image, or when a task needs OCR, chart/diagram reading, screenshot or UI analysis, \x27",
    "    + \x27translation of image text, or photo understanding. Always pass an explicit `prompt` with a precise \x27",
    "    + \x27instruction (e.g. \"transcribe all text\", \"extract the table as CSV\", \"translate the text into Chinese\") \x27",
    "    + \x27instead of relying on the generic default.\x27;",
].join("\n");
vision = replaceExactlyOnce(vision, v3Description, v2Description, "v3 schema description");
vision = replaceExactlyOnce(vision,
    "                    description: \x27Absolute path of a current-message or explicitly quoted image inside the QQ media directory, or a public HTTPS image URL.\x27,",
    "                    description: \x27Absolute path of an image attached to or explicitly quoted in the current QQ message. URLs and other files are forbidden.\x27,",
    "v3 image parameter description");
const v3Loader = [
    "// Chat-only scoped image loader v3.",
    "async function loadImageBytes(image, maxBytes, exec) {",
    "    const data = await loadChatImageBytes(image, maxBytes, exec);",
    "    const mediaType = sniffImageMediaType(data);",
    "    if (mediaType === null)",
    "        throw new Error(\x27qqbot_describe_image: unrecognized image format (png/jpeg/gif/webp only)\x27);",
    "    return { data, mediaType };",
    "}",
].join("\n");
const stockLoader = [
    "/** 加载图片字节（本地路径 / http URL），校验大小 + 嗅探 MIME */",
    "async function loadImageBytes(image, maxBytes, signal) {",
    "    let data;",
    "    if (/^https?:\\/\\//i.test(image)) {",
    "        const resp = await fetch(image, { signal, redirect: \x27error\x27 });",
    "        if (!resp.ok)",
    "            throw new Error(`qqbot_describe_image: download failed (HTTP ${resp.status})`);",
    "        const buf = Buffer.from(await resp.arrayBuffer());",
    "        if (buf.length > maxBytes)",
    "            throw new Error(`qqbot_describe_image: image too large (${buf.length} bytes)`);",
    "        data = new Uint8Array(buf);",
    "    }",
    "    else {",
    "        const info = await stat(image).catch(() => null);",
    "        if (!info?.isFile())",
    "            throw new Error(`qqbot_describe_image: image file not found: ${image}`);",
    "        if (info.size > maxBytes)",
    "            throw new Error(`qqbot_describe_image: image too large (${info.size} bytes)`);",
    "        data = new Uint8Array(await readFile(image));",
    "    }",
    "    const mediaType = sniffImageMediaType(data);",
    "    if (mediaType === null)",
    "        throw new Error(\x27qqbot_describe_image: unrecognized image format (png/jpeg/gif/webp only)\x27);",
    "    return { data, mediaType };",
    "}",
].join("\n");
vision = replaceExactlyOnce(vision, v3Loader, stockLoader, "v3 image loader");
vision = replaceExactlyOnce(vision,
    "loadImageBytes(image, vision.maxBytes, exec)",
    "loadImageBytes(image, vision.maxBytes, exec.signal)", "v3 execute argument");
fs.writeFileSync(visionPath, vision);
const middlewarePath = `${root}/middleware/attachment.js`;
let middleware = fs.readFileSync(middlewarePath, "utf8");
const quoteMarker = "            // Chat-only quoted-image downloads v2.\n";
const patchedQuote = "            // Chat-only quote attachments: never downloaded.\n            // Keep quote text/metadata available to the conversation, but only current-message images may enter the cache.\n            ctx.state.downloadedQuoteFiles = [];";
if (middleware.includes("// Chat-only lazy quoted images v1.")) {
    const start = middleware.indexOf(quoteMarker);
    const end = middleware.indexOf("\n        }\n        catch (err)", start);
    if (start < 0 || end < start) throw new Error("legacy fixture expected the lazy quote block");
    middleware = middleware.slice(0, start) + originalQuoteBlock + middleware.slice(end);
    fs.writeFileSync(middlewarePath, middleware);
}
else if (middleware.includes(quoteMarker)) {
    middleware = middleware.replace(quoteMarker, "");
    fs.writeFileSync(middlewarePath, middleware);
}
else if (middleware.includes(patchedQuote)) {
    middleware = middleware.replace(patchedQuote, originalQuoteBlock);
    fs.writeFileSync(middlewarePath, middleware);
}
const mediaCleanerPath = `${root}/media/media-cleaner.js`;
let mediaCleaner = fs.readFileSync(mediaCleanerPath, "utf8");
mediaCleaner = replaceExactlyOnce(mediaCleaner,
    "// Chat-only persistent media root v1.\nexport const MEDIA_ROOT = \x27/data/qqbot-media\x27;",
    "export const MEDIA_ROOT = resolve(PLUGIN_HOME, \x27media\x27);",
    "persistent media root");
mediaCleaner = replaceExactlyOnce(mediaCleaner,
    "import { join } from \x27node:path\x27;\n",
    "import { join, resolve } from \x27node:path\x27;\n",
    "media cleaner path import");
mediaCleaner = replaceExactlyOnce(mediaCleaner,
    "import { join, resolve } from \x27node:path\x27;\n",
    "import { join, resolve } from \x27node:path\x27;\nimport { PLUGIN_HOME } from \x22../shared/dirs.js\x22;\n",
    "upstream media cleaner directory import");
fs.writeFileSync(mediaCleanerPath, mediaCleaner);
if (!mediaCleaner.includes("export const MEDIA_ROOT = resolve(PLUGIN_HOME, \x27media\x27);")
    || !mediaCleaner.includes("import { join, resolve } from \x27node:path\x27;")
    || !mediaCleaner.includes("import { PLUGIN_HOME } from \x22../shared/dirs.js\x22;")
    || mediaCleaner.includes("Chat-only persistent media root v1.")) {
    throw new Error("legacy fixture did not restore the original media root");
}
const legacyMarkers = [
    ["gateway/bootstrap.js", "installChatPolicy"],
    ["gateway/bootstrap.js", "Chat-only deployment: file sending is not registered."],
    ["gateway/middleware-setup.js", "createScopedQuoteRef"],
    ["gateway/middleware-setup.js", "Chat-only scoped quote references prevent cross-peer message-key collisions."],
    ["gateway/middleware-setup.js", "createHistorySnapshotBuffer"],
    ["gateway/middleware-setup.js", "Chat-only history snapshot epoch guard v1."],
    ["gateway/middleware-setup.js", "createPendingImageCaptureMiddleware"],
    ["gateway/middleware-setup.js", "createPendingImageNewCommandCleanup"],
    ["gateway/middleware-setup.js", "createPendingImagePromptMiddleware"],
    ["gateway/middleware-setup.js", "Chat-only deferred image prompts v1."],
    ["gateway/middleware-setup.js", "Chat-only pending image /new cleanup v1."],
    ["gateway/middleware-setup.js", "Chat-only deferred image prompt association v1."],
    ["index.js", "export const inject = [\x27agents\x27, \x27tools\x27, \x27web\x27, \x27systemPrompt\x27];"],
    ["transport/inbound.js", "Chat-only current-and-quoted image scope v2."],
    ["transport/inbound.js", "Chat-only per-turn document scope v1."],
    ["transport/inbound.js", "Chat-only explicit-quote text trigger v1."],
    ["transport/inbound.js", "beginDocumentTurn"],
    ["transport/inbound.js", "endDocumentTurn"],
    ["transport/inbound.js", "setCurrentImages"],
    ["transport/inbound.js", "clearCurrentImages"],
    ["transport/attachment.js", "downloadCurrentQQImage"],
    ["transport/attachment.js", "Chat-only current-image downloads v3."],
    ["transport/attachment.js", "Chat-only attachment source URL v2."],
    ["transport/attachment.js", "sourceUrl: att.url"],
    ["transport/attachment.js", "a.url && (classifyContentType"],
    ["middleware/attachment.js", "Chat-only quoted-image downloads v2."],
    ["media/vision-tool.js", "timeoutMs: vision.timeoutMs"],
    ["media/vision-tool.js", "loadChatImageBytes"],
    ["media/vision-tool.js", "Chat-only scoped image loader v3."],
    ["media/vision-tool.js", "Chat-only image schema: fixed bundled Dayu image assets v5."],
    ["media/vision-tool.js", "/opt/qqbot-assets/dayu/"],
    ["media/media-cleaner.js", "Chat-only persistent media root v1."]
];
const restoredAttachment = fs.readFileSync(root + "/transport/attachment.js", "utf8");
if (!restoredAttachment.includes("classifyContentType(a.content_type) !== \x27voice\x27 && a.url")) {
    throw new Error("legacy fixture did not restore the original non-voice attachment target selector");
}
for (const [file, marker] of legacyMarkers) {
    if (fs.readFileSync(`${root}/${file}`, "utf8").includes(marker)) throw new Error(`legacy fixture still patched: ${file}`);
}
const restoredVision = fs.readFileSync(visionPath, "utf8");
if (!restoredVision.includes("async function loadImageBytes(image, maxBytes, signal)")
    || !restoredVision.includes("loadImageBytes(image, vision.maxBytes, exec.signal)")
    || !restoredVision.includes("Chat-only image schema: current and explicitly quoted QQ attachments v2.")) {
    throw new Error("legacy fixture did not restore the original loader and v2 schema");
}
