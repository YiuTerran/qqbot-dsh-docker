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
