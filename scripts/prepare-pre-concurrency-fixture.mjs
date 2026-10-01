import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('usage: prepare-pre-concurrency-fixture.mjs <dsh-qqbot-dist-directory>');
const helper = '/opt/qqbot-defaults/qqbot-concurrency.mjs';
const thinkingOnly = process.argv[3] === 'thinking-only';

function replaceOnce(source, before, after, label) {
    const parts = source.split(before);
    if (parts.length !== 2) throw new Error('pre-concurrency fixture expected one ' + label);
    return parts[0] + after + parts[1];
}

async function edit(file, operation) {
    const path = join(root, file);
    await writeFile(path, operation(await readFile(path, 'utf8')));
}

await edit('gateway/middleware-setup.js', (source) => {
    const currentImport = `import { createMergeConcurrencyGuard, sendMergeQueueFullNotice, sendMergeThinkingNotice } from '${helper}';`;
    const oldImport = `import { createMergeConcurrencyGuard, sendMergeQueueFullNotice } from '${helper}';`;
    const thinkingBlock = [
        '        // Chat-only idle group thinking notice v1.',
        '        onStart: async (startedCtx) => {',
        '            await sendMergeThinkingNotice(sender, startedCtx);',
        '        },',
    ].join('\n') + '\n';
    if (source.includes('// Chat-only idle group thinking notice v1.')) {
        source = replaceOnce(source, thinkingBlock, '', 'idle thinking notice block');
        source = replaceOnce(source, currentImport, oldImport, 'thinking notice import');
    }
    else if (source.includes('sendMergeThinkingNotice') || source.includes('onStart:')) {
        throw new Error('pre-concurrency fixture found a partial idle thinking notice');
    }
    return source;
});

if (thinkingOnly) {
    process.stdout.write('Prepared pre-thinking adapter volume fixture.\n');
    process.exit(0);
}

// Reverse the newer generation layers before reproducing the historical
// concurrency layout. Thinking-only fixtures keep these current layers.
await edit('transport/inbound.js', (source) => {
    if (source.includes('// Chat-only group model context v1.')) {
        source = replaceOnce(source,
            "import { beginGroupModelContext, endGroupModelContext } from '/opt/qqbot-defaults/qqbot-model-context.mjs';\n",
            '', 'group model context import');
        source = replaceOnce(source,
            '    let modelContextTurn;\n', '', 'group model context declaration');
        source = replaceOnce(source,
            '    // Chat-only group model context v1.\n    modelContextTurn = beginGroupModelContext(chatOnlyAgent, scope, documentTurn);\n',
            '', 'group model context binding');
        source = replaceOnce(source,
            '        endGroupModelContext(chatOnlyAgent, modelContextTurn);\n',
            '', 'group model context cleanup');
    }
    else if (source.includes('beginGroupModelContext') || source.includes('modelContextTurn')) {
        throw new Error('pre-concurrency fixture found partial group model context guard');
    }
    if (source.includes('// Chat-only lazy quoted image grants v1.')) {
        source = replaceOnce(source,
            '                // Chat-only lazy quoted image grants v1.\n                media: config.media,\n',
            '', 'lazy quote media configuration');
    }
    if (!source.includes('// Chat-only generation provenance v1.')) {
        if (source.includes('generationTurn') || source.includes('getMergedGenerationRequests'))
            throw new Error('pre-concurrency fixture found partial generation provenance');
        return source;
    }
    source = replaceOnce(source,
        "import { beginGenerationTurn, endGenerationTurn, renderGenerationRequestMetadata } from '/opt/qqbot-defaults/qqbot-generation-scope.mjs';\n",
        '', 'generation scope import');
    source = replaceOnce(source,
        `import { getMergedGenerationRequests, enqueueMergeBatchSend } from '${helper}';\n`,
        '', 'generation request import');
    source = replaceOnce(source, '    let documentTurn;\n    let generationTurn;',
        '    let documentTurn;', 'generation turn declaration');
    source = replaceOnce(source, [
        '        documentTurn = getDocumentTurn(chatOnlyAgent);',
        '        // Chat-only generation provenance v1.',
        '        generationTurn = beginGenerationTurn(',
        '            chatOnlyAgent,',
        '            getMergedGenerationRequests(ctx),',
        '            [...(mwState.downloadedFiles ?? []), ...(mwState.downloadedQuoteFiles ?? []), ...(mwState.downloadedGenerationQuoteFiles ?? [])],',
        '            {',
        '                documentScope: documentTurn,',
        '                signal: ctx.signal,',
        '                isCurrentRecord,',
        '                record,',
        '                enqueueSend: (operation) => enqueueMergeBatchSend(record, operation),',
        '            },',
        '        );',
        '        const generationMetadata = renderGenerationRequestMetadata(generationTurn);',
    ].join('\n'), '        documentTurn = getDocumentTurn(chatOnlyAgent);', 'generation scope binding');
    source = replaceOnce(source,
        "        const requestBody = [documentBody, generationMetadata].filter(Boolean).join('\\n\\n');\n",
        '', 'generation request body');
    source = replaceOnce(source, "const content = [{ type: 'text', text: requestBody }];",
        "const content = [{ type: 'text', text: documentBody }];", 'generation model content');
    source = replaceOnce(source,
        '        setCurrentImages(chatOnlyAgent, [...(mwState.downloadedFiles ?? []), ...(mwState.downloadedQuoteFiles ?? []), ...(mwState.downloadedGenerationQuoteFiles ?? [])], documentTurn);',
        '        setCurrentImages(chatOnlyAgent, [...(mwState.downloadedFiles ?? []), ...(mwState.downloadedQuoteFiles ?? [])], documentTurn);',
        'generation image grants');
    return replaceOnce(source, [
        '                // Chat-only generation cleanup v1.',
        '                if (generationTurn) await endGenerationTurn(chatOnlyAgent, generationTurn);',
        '                if (documentTurn) await finishContentRiskRecovery(documentTurn);',
    ].join('\n'), '                if (documentTurn) await finishContentRiskRecovery(documentTurn);', 'generation cleanup');
});

await edit('transport/outbound.js', (source) => {
    if (!source.includes('// Chat-only generation outbound v1.')) {
        if (source.includes('enqueueMergeBatchSend'))
            throw new Error('pre-concurrency fixture found partial generation outbound routing');
        return source;
    }
    source = replaceOnce(source,
        `import { captureMergeBatchReply, enqueueMergeBatchSend, noteMergeBatchTurnStart } from '${helper}';`,
        `import { captureMergeBatchReply, noteMergeBatchTurnStart, trackMergeBatchSend } from '${helper}';`,
        'generation outbound import');
    for (const indent of ['            ', '                ']) {
        source = replaceOnce(source, `\n${indent}enqueueMergeBatchSend(originRecord, () => buffer.flush());`,
            `\n${indent}trackMergeBatchSend(originRecord, buffer.flush());`, 'generation outbound flush at indent ' + indent.length);
    }
    source = replaceOnce(source, 'enqueueMergeBatchSend(originRecord, () => buffer.cancel());',
        'trackMergeBatchSend(originRecord, buffer.cancel());', 'generation outbound cancel');
    const sends = [
        "this.send(record, fullText, 'sendMarkdown')",
        "this.send(record, formatToolFailure(), 'sendToolResultError')",
        "this.send(record, text, 'sendToolResult')",
        "this.send(record, formatProviderFailure(failure), 'sendTurnEndError')",
        "this.send({ ...record, replyTarget: replyTarget ?? record.replyTarget }, text, 'sendContentRiskRecovery')",
    ];
    for (const send of sends) {
        source = replaceOnce(source, `enqueueMergeBatchSend(originRecord, () => ${send})`,
            `trackMergeBatchSend(originRecord, ${send})`, 'generation outbound send ' + send);
    }
    return replaceOnce(source, [
        '        // Chat-only generation outbound v1.',
        "        if (call.name === 'qqbot_generate_image' || call.name === 'qqbot_create_markdown') return;",
        '        if (!this.config.showToolResults)',
        '            return;',
    ].join('\n'), '        if (!this.config.showToolResults)\n            return;', 'generation tool-result gate');
});

await edit('middleware/attachment.js', (source) => {
    if (source.includes('// Chat-only lazy quoted images v1.')) {
        const start = source.indexOf('            // Chat-only quoted-image downloads v2.');
        const end = source.indexOf('\n        }\n        catch (err)', start);
        if (start < 0 || end < start) throw new Error('pre-concurrency fixture found partial lazy quote downloads');
        const originalQuote = [
            '            // Chat-only quoted-image downloads v2.',
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
        return source.slice(0, start) + originalQuote + source.slice(end);
    }
    const independentMarker = '            // Chat-only independent merged quote downloads v2.';
    if (source.includes(independentMarker)) {
        const start = source.indexOf(independentMarker);
        const lastLine = '                : [];';
        const end = source.indexOf(lastLine, start);
        if (end < start) throw new Error('pre-concurrency fixture found partial independent quote downloads');
        return replaceOnce(source, source.slice(start, end + lastLine.length) + '\n', '', 'independent quote downloads');
    }
    if (!source.includes('// Chat-only generation quote image downloads v1.')) {
        if (source.includes('downloadedGenerationQuoteFiles') || source.includes('generationQuoteAttachments'))
            throw new Error('pre-concurrency fixture found partial generation quote downloads');
        return source;
    }
    const oldQuoteAssignment = '                ctx.state.downloadedQuoteFiles = downloadedQuote;';
    return replaceOnce(source, [
        oldQuoteAssignment,
        '                // Chat-only generation quote image downloads v1.',
        '                const generationQuoteAttachments = ctx.state.qqbotGenerationQuoteAttachments ?? [];',
        "                const generationImageQuotes = generationQuoteAttachments.filter((a) => a.url && ['image/png', 'image/jpeg', 'image', 'application/octet-stream', ''].includes((a.content_type ?? a.contentType ?? '').toLowerCase()));",
        '                const rawGenerationQuote = generationImageQuotes.map((a) => ({',
        "                    content_type: a.content_type ?? a.contentType ?? '',",
        "                    filename: a.filename ?? '',",
        '                    size: a.size ?? 0,',
        '                    url: a.url,',
        '                }));',
        '                ctx.state.downloadedGenerationQuoteFiles = rawGenerationQuote.length > 0',
        '                    ? await downloadMediaAttachments(rawGenerationQuote, config.media, logger)',
        '                    : [];',
    ].join('\n'), oldQuoteAssignment, 'generation quote downloads');
});

await edit('transport/attachment.js', (source) => {
    if (!source.includes('// Chat-only generation attachment provenance v1.')) {
        if (source.includes('sourceUrl: normalizeUrl(att.url)'))
            throw new Error('pre-concurrency fixture found partial generation attachment provenance');
        return source;
    }
    return replaceOnce(source, [
        '        // Chat-only generation attachment provenance v1.',
        '        results.push({ filename: att.filename, contentType, localPath, sourceUrl: normalizeUrl(att.url) });',
    ].join('\n'), '        results.push({ filename: att.filename, contentType, localPath });', 'generation attachment provenance');
});

await edit('gateway/bootstrap.js', (source) => {
    source = replaceOnce(source, '    // Chat-only merge batch reply adapter v1.\n', '', 'bootstrap sender marker');
    return replaceOnce(source, '    setupMiddlewares(bot, config, manager, logger, sender);',
        '    setupMiddlewares(bot, config, manager, logger);', 'bootstrap sender injection');
});

await edit('gateway/middleware-setup.js', (source) => {
    source = replaceOnce(source,
        'import { createMergeConcurrencyGuard, sendMergeQueueFullNotice } from ' + "'" + helper + "';\n",
        '', 'merge guard import');
    source = replaceOnce(source, ', typingIndicator,', ', concurrencyGuard, typingIndicator,', 'native concurrency import');
    source = replaceOnce(source, [
        '    // Chat-only serialized merge guard v1.',
        '    bot.use(createMergeConcurrencyGuard({',
        '        maxQueue: config.maxQueue ?? 20,',
        '        maxProcessingMs: config.processingTimeoutMs,',
        '        onDrop: async (droppedCtx) => {',
        '            try {',
        '                await sendMergeQueueFullNotice(sender, droppedCtx);',
        '            }',
        '            catch {',
        "                logger.warn('[concurrency:merge] busy notice failed');",
        '            }',
        '        },',
        '    }));',
    ].join('\n'), [
        '    bot.use(concurrencyGuard({',
        "        strategy: 'merge',",
        '        maxQueue: config.maxQueue,',
        '        maxProcessingMs: config.processingTimeoutMs,',
        '    }));',
    ].join('\n'), 'serialized merge guard');
    return replaceOnce(source,
        'export function setupMiddlewares(bot, config, manager, logger, sender) {',
        'export function setupMiddlewares(bot, config, manager, logger) {', 'middleware setup signature');
});

await edit('transport/inbound.js', (source) => {
    source = replaceOnce(source,
        'import { beginMergeBatch, closeMergeBatch } from ' + "'" + helper + "';\n",
        '', 'merge batch import');
    source = replaceOnce(source, [
        '    const chatOnlyAgent = record.agent;',
        '    // Chat-only batch cancellation and reply binding v1.',
        '    const replyBatch = beginMergeBatch(record, replyTarget);',
        "    const isCurrentRecord = () => typeof manager.getSessionRecord === 'function' && manager.getSessionRecord(scope, peerId) === record;",
        '    const cancelCapturedAgent = () => {',
        '        if (record.agent !== chatOnlyAgent) return;',
        "        try { chatOnlyAgent.cancel({ kind: 'user' }); }",
        "        catch { logger.warn('inbound batch agent cancellation failed'); }",
        '    };',
        "    ctx.signal?.addEventListener('abort', cancelCapturedAgent, { once: true });",
        '    if (ctx.signal?.aborted) cancelCapturedAgent();',
    ].join('\n'), '    const chatOnlyAgent = record.agent;', 'inbound batch binding');
    source = replaceOnce(source, [
        '    let documentTurn;',
        '    try {',
        '        if (ctx.signal?.aborted) return;',
        '        if (!isCurrentRecord() || record.agent !== chatOnlyAgent) return;',
        '        const documentMetadata = beginDocumentTurn(chatOnlyAgent, msg, mwState.quote);',
    ].join('\n'), [
        '    let documentTurn;',
        '    try {',
        '        const documentMetadata = beginDocumentTurn(chatOnlyAgent, msg, mwState.quote);',
    ].join('\n'), 'inbound pre-followup guard');
    source = replaceOnce(source,
        '    if (ctx.signal?.aborted || !isCurrentRecord() || record.agent !== chatOnlyAgent) return;\n    chatOnlyAgent.followup(message);',
        '    chatOnlyAgent.followup(message);', 'inbound followup guard');
    source = replaceOnce(source, [
        '        try {',
        '            if (documentTurn) endDocumentTurn(chatOnlyAgent, documentTurn);',
        '        } finally {',
        '            // Chat-only safe batch finalization v1.',
        '            try {',
        '                if (documentTurn) await finishContentRiskRecovery(documentTurn);',
        '            } finally {',
        "                ctx.signal?.removeEventListener('abort', cancelCapturedAgent);",
        '                await closeMergeBatch(replyBatch);',
        '            }',
        '        }',
    ].join('\n'), [
        '        if (documentTurn) endDocumentTurn(chatOnlyAgent, documentTurn);',
        '        if (documentTurn) await finishContentRiskRecovery(documentTurn);',
    ].join('\n'), 'safe batch finalizer');
    return source;
});

await edit('transport/outbound.js', (source) => {
    source = replaceOnce(source,
        "import { captureMergeBatchReply, noteMergeBatchTurnStart, trackMergeBatchSend } from '" + helper + "';\n",
        '', 'outbound merge import');
    const routeStart = source.indexOf('    route(session, raw) {');
    const routeEnd = source.indexOf('    /** 流式文本增量：累积到会话 buffer */', routeStart);
    if (routeStart < 0 || routeEnd <= routeStart) throw new Error('pre-concurrency fixture expected OutboundRouter.route()');
    const route = [
        '    route(session, raw) {',
        '        // Chat-only content-risk turn recovery v1.',
        "        if (raw?.type === 'turn/start') {",
        '            const sessionId = session.header.id;',
        '            const startRecord = this.manager.findBySessionId(sessionId);',
        '            if (startRecord) noteRecoveryTurnStart({ record: startRecord, sessionId, turnId: raw.data?.turn });',
        '            return;',
        '        }',
        '        const event = parseEvent(raw);',
        '        if (event === undefined) return;',
        '        const sessionId = session.header.id;',
        '        const record = this.manager.findBySessionId(sessionId);',
        '        if (record === undefined) return;',
        '        switch (event.type) {',
        "            case 'assistant/chunk':", '                this.onChunk(sessionId, record, event);', '                break;',
        "            case 'assistant/message':", '                this.onMessage(sessionId, record, event);', '                break;',
        "            case 'tool/call':", '                this.onToolCall(event);', '                break;',
        "            case 'tool/result':", '                this.onToolResult(record, event, raw);', '                break;',
        "            case 'turn/end':", '                this.onTurnEnd(session.header.id, record, event, raw.data?.turn);', '                break;',
        '        }',
        '    }', '',
    ].join('\n');
    source = source.slice(0, routeStart) + route + source.slice(routeEnd);
    source = replaceOnce(source, '    onMessage(sessionId, record, event, originRecord = record) {',
        '    onMessage(sessionId, record, event) {', 'outbound message signature');
    source = replaceOnce(source, [
        '        if (buffer !== undefined && buffer.text.trim()) {',
        '            trackMergeBatchSend(originRecord, buffer.flush());',
        '            this.buffers.delete(sessionId);',
        '            return;',
        '        }',
    ].join('\n'), [
        '        if (buffer !== undefined && buffer.text.trim()) {',
        '            void buffer.flush();',
        '            this.buffers.delete(sessionId);',
        '            return;',
        '        }',
    ].join('\n'), 'outbound message buffer tracking');
    source = replaceOnce(source, "        trackMergeBatchSend(originRecord, this.send(record, fullText, 'sendMarkdown'));",
        "        void this.send(record, fullText, 'sendMarkdown');", 'outbound message tracking');
    source = replaceOnce(source, '    onToolResult(record, event, raw, originRecord = record) {',
        '    onToolResult(record, event, raw) {', 'outbound tool signature');
    source = replaceOnce(source, "            trackMergeBatchSend(originRecord, this.send(record, formatToolFailure(), 'sendToolResultError'));",
        "            void this.send(record, formatToolFailure(), 'sendToolResultError');", 'outbound tool failure tracking');
    source = replaceOnce(source, "        trackMergeBatchSend(originRecord, this.send(record, text, 'sendToolResult'));",
        "        void this.send(record, text, 'sendToolResult');", 'outbound tool tracking');
    source = replaceOnce(source, '    onTurnEnd(sessionId, record, event, turnId, originRecord = record) {',
        '    onTurnEnd(sessionId, record, event, turnId) {', 'outbound turn signature');
    source = replaceOnce(source, '                trackMergeBatchSend(originRecord, buffer.flush());',
        '                void buffer.flush();', 'outbound turn flush tracking');
    source = replaceOnce(source, '                trackMergeBatchSend(originRecord, buffer.cancel());',
        '                buffer.cancel();', 'outbound turn cancel tracking');
    source = replaceOnce(source, '                    record: originRecord,\n                    sessionId,\n                    turnId,',
        '                    record,\n                    sessionId,\n                    turnId,', 'recovery originating record');
    source = replaceOnce(source,
        "                    notify: (text, replyTarget) => trackMergeBatchSend(originRecord, this.send({ ...record, replyTarget: replyTarget ?? record.replyTarget }, text, 'sendContentRiskRecovery')),",
        "                    notify: (text, replyTarget) => this.send({ ...record, replyTarget: replyTarget ?? record.replyTarget }, text, 'sendContentRiskRecovery'),", 'recovery notice tracking');
    source = replaceOnce(source, "                trackMergeBatchSend(originRecord, this.send(record, formatProviderFailure(failure), 'sendTurnEndError'));",
        "                void this.send(record, formatProviderFailure(failure), 'sendTurnEndError');", 'provider failure tracking');
    return source;
});

await edit('transport/streaming-writer.js', (source) => {
    source = replaceOnce(source, '    // Chat-only awaitable stream cancellation v1.\n', '', 'streaming cancellation marker');
    source = replaceOnce(source, '        if (this.finished)\n            return this.chain;', '        if (this.finished)\n            return;', 'streaming repeated abort result');
    return replaceOnce(source, '        return this.chain;\n    }', '    }', 'streaming abort completion return');
});

await edit('transport/outbound-buffer.js', (source) => {
    source = replaceOnce(source, [
    '    /** 发送所有累积文本：流式优先，降级静态 */',
    '    flush() {',
    '        if (this.flushPromise)',
    '            return this.flushPromise;',
    '        if (!this.buffer.trim())',
    '            return Promise.resolve();',
    '        this.flushing = true;',
    '        const completion = Promise.resolve().then(async () => {',
    '            try {',
    '                if (this.writer) {',
    '                    await this.writer.finish();',
    '                    // 流式成功（未降级）→ 直接返回',
    '                    if (!this.writer.shouldFallback)',
    '                        return;',
    '                }',
    '                // 降级：静态发送（writer 不存在 or 流式失败）',
    '                const chunks = chunkMarkdownText(this.buffer, this.limit);',
    '                for (const chunk of chunks) {',
    '                    await this.bot.sendMarkdown(this.record.replyTarget, chunk);',
    '                }',
    '            }',
    '            catch (err) {',
    '                this.logger.error(`im-qqbot: flush failed: ${err instanceof Error ? err.message : String(err)}`);',
    '            }',
    '            finally {',
    "                this.buffer = '';",
    '                this.flushing = false;',
    '                this.flushPromise = undefined;',
    '            }',
    '        });',
    '        this.flushPromise = completion;',
    '        return completion;',
    '    }',
].join('\n'), [
    '    /** 发送所有累积文本：流式优先，降级静态 */',
    '    async flush() {',
    '        if (this.flushing || !this.buffer.trim())',
    '            return;',
    '        this.flushing = true;',
    '        try {',
    '            if (this.writer) {',
    '                await this.writer.finish();',
    '                // 流式成功（未降级）→ 直接返回',
    '                if (!this.writer.shouldFallback)',
    '                    return;',
    '            }',
    '            // 降级：静态发送（writer 不存在 or 流式失败）',
    '            const chunks = chunkMarkdownText(this.buffer, this.limit);',
    '            for (const chunk of chunks) {',
    '                await this.bot.sendMarkdown(this.record.replyTarget, chunk);',
    '            }',
    '        }',
    '        catch (err) {',
    '            this.logger.error(`im-qqbot: flush failed: ${err instanceof Error ? err.message : String(err)}`);',
    '        }',
    '        finally {',
    "            this.buffer = '';",
    '            this.flushing = false;',
    '        }',
    '    }',
].join('\n'), 'shared outbound buffer flush');
    return replaceOnce(source, [
    '    // Chat-only awaitable stream cancellation v1.',
    '    cancel() {',
    '        const completion = this.writer?.abort();',
    "        this.buffer = '';",
    '        return Promise.all([this.flushPromise, completion].filter(Boolean));',
    '    }',
].join('\n'), [
    '    cancel() {',
    '        this.writer?.abort();',
    "        this.buffer = '';",
    '    }',
].join('\n'), 'outbound buffer cancellation');
});

process.stdout.write('Prepared pre-concurrency adapter volume fixture.\n');
