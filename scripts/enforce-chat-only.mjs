import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('usage: enforce-chat-only.mjs <dsh-qqbot-dist-directory>');
const manifest = JSON.parse(await readFile(join(root, '..', 'package.json'), 'utf8'));
if (manifest.version !== '0.5.0') throw new Error('Chat-only patches require dsh-qqbot 0.5.0; refusing an unverified adapter.');
const policy = '/opt/qqbot-defaults/qqbot-chat-policy.mjs';
const webPagesPolicy = '/opt/qqbot-defaults/qqbot-web-pages.mjs';
const documentScopePolicy = '/opt/qqbot-defaults/qqbot-document-scope.mjs';
const sessionRecoveryPolicy = '/opt/qqbot-defaults/qqbot-session-recovery.mjs';
const providerErrorsPolicy = '/opt/qqbot-defaults/qqbot-provider-errors.mjs';
const concurrencyPolicy = '/opt/qqbot-defaults/qqbot-concurrency.mjs';
const generationPolicy = '/opt/qqbot-defaults/qqbot-generation.mjs';
const generationScopePolicy = '/opt/qqbot-defaults/qqbot-generation-scope.mjs';
const modelContextPolicy = '/opt/qqbot-defaults/qqbot-model-context.mjs';
const contextDiagnosticsPolicy = '/opt/qqbot-defaults/qqbot-context-diagnostics.mjs';
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

await patch('gateway/bootstrap.js', '// Chat-only generation tools v1.', (content, file) => {
    const protocolImport = "import { MediaApi, MessageApi } from '@tencent-connect/qqbot-nodejs/protocol';";
    const generationImport = "import { createGenerationSender, registerGenerationTools } from '" + generationPolicy + "';";
    if (!content.includes(protocolImport)) content = protocolImport + '\n' + content;
    if (!content.includes(generationImport)) content = generationImport + '\n' + content;
    const oldRegistration = '    // Chat-only deployment: file sending is not registered.';
    const registration = [
        '    // Chat-only deployment: file sending is not registered.',
        '    // Chat-only generation tools v1.',
        '    registerGenerationTools(ctx, {',
        '        sender: createGenerationSender({',
        '            bot,',
        '            replyLimiter,',
        '            sdk: { MediaApi, MessageApi },',
        '            credentials: { appId: config.appId, clientSecret: config.appSecret },',
        '            sendResolvedMarkdown,',
        '            logger,',
        '        }),',
        '        appId: config.appId,',
        '        logger,',
        '    });',
    ].join('\n');
    if (content.includes(oldRegistration)) content = replaceOne(content, oldRegistration, registration, file);
    else if (!content.includes('// Chat-only generation tools v1.'))
        throw new Error('Chat-only patch: expected dedicated generation registration point in ' + file);
    return content;
});

await patch('gateway/bootstrap.js', '// Chat-only merge batch reply adapter v1.', (content, file) => {
    const senderBlock = [
        '    const replyLimiter = new ReplyLimiter({ limit: 4 });',
        '    const sender = {',
        '        sendMarkdown: (target, content, opts) => sendResolvedMarkdown(bot, resolveReplyTarget(target, replyLimiter, true), content, opts),',
        '        openStream: (target) => bot.openStream({',
        '            target: {',
        '                scope: target.scope,',
        '                targetId: target.targetId,',
        '                msgId: target.msgId,',
        '            },',
        '        }),',
        '    };',
    ].join('\n');
    const oldBlock = [
        '    const replyLimiter = new ReplyLimiter({ limit: 4 });',
        '    const sender = {',
        '        sendMarkdown: (target, content, opts) => sendResolvedMarkdown(bot, resolveReplyTarget(target, replyLimiter, true), content, opts),',
        '        openStream: (target) => bot.openStream({',
        '            target: {',
        '                scope: target.scope,',
        '                targetId: target.targetId,',
        '                msgId: target.msgId,',
        '            },',
        '        }),',
        '    };',
    ].join('\n');
    if (!content.includes('// Chat-only merge batch reply adapter v1.')) {
        content = replaceOne(content, oldBlock, '', file);
        content = replaceOne(content, '    setupMiddlewares(bot, config, manager, logger);',
            `    // Chat-only merge batch reply adapter v1.\n${senderBlock}\n    setupMiddlewares(bot, config, manager, logger, sender);`, file);
    }
    return content;
});

await patch('gateway/middleware-setup.js', '// Chat-only serialized merge guard v1.', (content, file) => {
    const helperImport = `import { createMergeConcurrencyGuard, sendMergeQueueFullNotice } from '${concurrencyPolicy}';`;
    if (!content.includes(helperImport)) content = `${helperImport}\n${content}`;
    content = replaceOne(content, ', concurrencyGuard, typingIndicator,', ', typingIndicator,', file);
    const original = [
        '    bot.use(concurrencyGuard({',
        "        strategy: 'merge',",
        '        maxQueue: config.maxQueue,',
        '        maxProcessingMs: config.processingTimeoutMs,',
        '    }));',
    ].join('\n');
    const replacement = [
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
    ].join('\n');
    if (content.includes(original)) content = replaceOne(content, original, replacement, file);
    else if (!content.includes('// Chat-only serialized merge guard v1.'))
        throw new Error(`Chat-only patch: expected pinned merge guard in ${file}`);
    content = replaceOne(content, 'export function setupMiddlewares(bot, config, manager, logger) {',
        'export function setupMiddlewares(bot, config, manager, logger, sender) {', file);
    return content;
});

await patch('gateway/middleware-setup.js', '// Chat-only idle group thinking notice v1.', (content, file) => {
    const oldImport = `import { createMergeConcurrencyGuard, sendMergeQueueFullNotice } from '${concurrencyPolicy}';`;
    const nextImport = `import { createMergeConcurrencyGuard, sendMergeQueueFullNotice, sendMergeThinkingNotice } from '${concurrencyPolicy}';`;
    if (content.includes('sendMergeThinkingNotice') || content.includes('onStart:')) {
        throw new Error(`Chat-only patch: partial idle thinking notice in ${file}`);
    }
    content = replaceOne(content, oldImport, nextImport, file);
    return replaceOne(content, [
        '        maxProcessingMs: config.processingTimeoutMs,',
        '        onDrop: async (droppedCtx) => {',
    ].join('\n'), [
        '        maxProcessingMs: config.processingTimeoutMs,',
        '        // Chat-only idle group thinking notice v1.',
        '        onStart: async (startedCtx) => {',
        '            await sendMergeThinkingNotice(sender, startedCtx);',
        '        },',
        '        onDrop: async (droppedCtx) => {',
    ].join('\n'), file);
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

await patch('gateway/middleware-setup.js', '// Chat-only generation quote capture v1.', (content, file) => {
    const quoteBlock = [
        '    // Chat-only scoped quote references prevent cross-peer message-key collisions.',
        '    bot.use(createScopedQuoteRef(quoteRef));',
    ].join('\n');
    const marker = '// Chat-only generation quote capture v1.';
    if (content.includes(marker)) return content;
    if (content.split(quoteBlock).length !== 2) {
        throw new Error('Chat-only patch: scoped quote middleware is missing or duplicated in ' + file);
    }
    const guardMarker = '    // Chat-only serialized merge guard v1.';
    const answerCall = '    bot.use(questionAnswer(manager));';
    const guardPosition = content.indexOf(guardMarker);
    const answerPosition = content.indexOf(answerCall);
    if (answerPosition < 0 || guardPosition <= answerPosition) {
        throw new Error('Chat-only patch: quote capture cannot be ordered after question answering and before merge guard in ' + file);
    }
    content = replaceOne(content, quoteBlock, '', file);
    const nextGuardPosition = content.indexOf(guardMarker);
    return content.slice(0, nextGuardPosition)
        + '    // Chat-only generation quote capture v1.\n'
        + quoteBlock + '\n'
        + content.slice(nextGuardPosition);
});

await patch('gateway/middleware-setup.js', '// Chat-only quoted attachment cache v2.', (content, file) => {
    const quoteBlock = [
        '    // Chat-only generation quote capture v1.',
        '    // Chat-only scoped quote references prevent cross-peer message-key collisions.',
        '    bot.use(createScopedQuoteRef(quoteRef));',
    ].join('\n');
    content = replaceOne(content, quoteBlock, '', file);
    const mentionCall = '    bot.use(mentionGate({';
    return replaceOne(content, mentionCall,
        '    // Chat-only quoted attachment cache v2.\n' + quoteBlock + '\n' + mentionCall, file);
});

await patch('gateway/middleware-setup.js', '// Chat-only dice command middleware v1.', (content, file) => {
    const diceImport = `import { createDiceCommandMiddleware, createDiceAwareHistoryBuffer } from '${policy}';`;
    if (!content.includes(diceImport)) content = `${diceImport}\n${content}`;
    const originalHistory = [
        '    bot.use(historyBuffer({',
        '        limit: config.historyLimit,',
        '        store: getHistoryStore(),',
        '        recordOnSkip: true,',
        '        groupKey: (ctx) => {',
        '            const gid = ctx.message.groupOpenid;',
        '            if (ctx.message.kind !== \'group\' || !gid)',
        '                return undefined;',
        '            return historyGroupKey(config.appId, gid);',
        '        },',
        '    }));',
    ].join('\n');
    const wrappedHistory = [
        '    bot.use(createDiceAwareHistoryBuffer(historyBuffer, {',
        '        limit: config.historyLimit,',
        '        store: getHistoryStore(),',
        '        recordOnSkip: true,',
        '        groupKey: (ctx) => {',
        '            const gid = ctx.message.groupOpenid;',
        '            if (ctx.message.kind !== \'group\' || !gid)',
        '                return undefined;',
        '            return historyGroupKey(config.appId, gid);',
        '        },',
        '    }, contentSanitizer));',
    ].join('\n');
    if (content.includes(originalHistory)) content = replaceOne(content, originalHistory, wrappedHistory, file);
    else if (!content.includes(wrappedHistory)) throw new Error(`Chat-only patch: expected the pinned group history middleware in ${file}`);

    const originalRateMarker = '    bot.use(rateLimiter());\n';
    const diceCommandBlock = [
        '    bot.use(rateLimiter());',
        '    // Chat-only dice command middleware v1.',
        '    bot.use(createDiceCommandMiddleware());',
        '',
    ].join('\n');
    if (content.includes(originalRateMarker)) content = replaceOne(content, originalRateMarker, `${diceCommandBlock}\n`, file);
    else if (!content.includes('    bot.use(createDiceCommandMiddleware());')) {
        throw new Error(`Chat-only patch: expected rate limiter insertion point in ${file}`);
    }
    return content;
});

const middlewareSetupPath = join(root, 'gateway/middleware-setup.js');
const patchedMiddlewareSetup = updates.get(middlewareSetupPath) ?? await readFile(middlewareSetupPath, 'utf8');
const diceMiddlewareMarker = '// Chat-only dice command middleware v1.';
const diceMiddlewareImport = `import { createDiceCommandMiddleware, createDiceAwareHistoryBuffer } from '${policy}';`;
const rateLimitPosition = patchedMiddlewareSetup.indexOf('    bot.use(rateLimiter());');
const diceCommandPosition = patchedMiddlewareSetup.indexOf('    bot.use(createDiceCommandMiddleware());');
const slashPosition = patchedMiddlewareSetup.indexOf('    const slash = slashCommand({');
const accessPosition = patchedMiddlewareSetup.indexOf('    bot.use(accessPolicy({');
const mentionPosition = patchedMiddlewareSetup.indexOf('    bot.use(mentionGate({');
const sanitizerPosition = patchedMiddlewareSetup.indexOf('    bot.use(contentSanitizer({');
const attachmentPosition = patchedMiddlewareSetup.indexOf('    bot.use(attachmentProcessor(config, logger));');
if (patchedMiddlewareSetup.split(diceMiddlewareMarker).length !== 2
    || patchedMiddlewareSetup.split(diceMiddlewareImport).length !== 2
    || patchedMiddlewareSetup.split('bot.use(createDiceAwareHistoryBuffer(historyBuffer, {').length !== 2
    || patchedMiddlewareSetup.split('    }, contentSanitizer));').length !== 2
    || patchedMiddlewareSetup.split('bot.use(createDiceCommandMiddleware());').length !== 2
    || accessPosition < 0 || mentionPosition <= accessPosition || sanitizerPosition <= mentionPosition
    || rateLimitPosition <= sanitizerPosition || diceCommandPosition <= rateLimitPosition
    || slashPosition <= diceCommandPosition || attachmentPosition <= slashPosition) {
    throw new Error('Chat-only patch: dice command/history middleware is incomplete or ordered outside the guarded chain');
}
const mergeGuardImport = `import { createMergeConcurrencyGuard, sendMergeQueueFullNotice, sendMergeThinkingNotice } from '${concurrencyPolicy}';`;
const oldMergeGuardImport = `import { createMergeConcurrencyGuard, sendMergeQueueFullNotice } from '${concurrencyPolicy}';`;
const mergeGuardPosition = patchedMiddlewareSetup.indexOf('// Chat-only serialized merge guard v1.');
const thinkingNoticePosition = patchedMiddlewareSetup.indexOf('// Chat-only idle group thinking notice v1.');
const onStartPosition = patchedMiddlewareSetup.indexOf('onStart: async (startedCtx) => {');
const thinkingSendPosition = patchedMiddlewareSetup.indexOf('await sendMergeThinkingNotice(sender, startedCtx);');
const onDropPosition = patchedMiddlewareSetup.indexOf('onDrop: async (droppedCtx) => {');
const canonicalMergeGuard = [
    '    // Chat-only serialized merge guard v1.',
    '    bot.use(createMergeConcurrencyGuard({',
    '        maxQueue: config.maxQueue ?? 20,',
    '        maxProcessingMs: config.processingTimeoutMs,',
    '        // Chat-only idle group thinking notice v1.',
    '        onStart: async (startedCtx) => {',
    '            await sendMergeThinkingNotice(sender, startedCtx);',
    '        },',
    '        onDrop: async (droppedCtx) => {',
    '            try {',
    '                await sendMergeQueueFullNotice(sender, droppedCtx);',
    '            }',
    '            catch {',
    "                logger.warn('[concurrency:merge] busy notice failed');",
    '            }',
    '        },',
    '    }));',
].join('\n');
const mergeGuardEndPosition = patchedMiddlewareSetup.indexOf(canonicalMergeGuard) + canonicalMergeGuard.length;
const answerPosition = patchedMiddlewareSetup.indexOf('bot.use(questionAnswer(manager));');
const generationQuotePosition = patchedMiddlewareSetup.indexOf('// Chat-only generation quote capture v1.');
const scopedQuoteCallPosition = patchedMiddlewareSetup.indexOf('bot.use(createScopedQuoteRef(quoteRef));');
const typingPosition = patchedMiddlewareSetup.indexOf('bot.use(typingIndicator());');
if (patchedMiddlewareSetup.split(mergeGuardImport).length !== 2
    || patchedMiddlewareSetup.split(oldMergeGuardImport).length !== 1
    || patchedMiddlewareSetup.split('// Chat-only serialized merge guard v1.').length !== 2
    || patchedMiddlewareSetup.split('// Chat-only idle group thinking notice v1.').length !== 2
    || patchedMiddlewareSetup.split('onStart: async (startedCtx) => {').length !== 2
    || patchedMiddlewareSetup.split('await sendMergeThinkingNotice(sender, startedCtx);').length !== 2
    || patchedMiddlewareSetup.split(canonicalMergeGuard).length !== 2
    || !patchedMiddlewareSetup.includes('maxQueue: config.maxQueue ?? 20,')
    || !patchedMiddlewareSetup.includes('onDrop: async (droppedCtx) => {')
    || !patchedMiddlewareSetup.includes('await sendMergeQueueFullNotice(sender, droppedCtx);')
    || accessPosition < 0 || mentionPosition <= accessPosition || rateLimitPosition <= mentionPosition
    || diceCommandPosition <= rateLimitPosition || slashPosition <= diceCommandPosition
    || generationQuotePosition <= accessPosition || scopedQuoteCallPosition <= generationQuotePosition
    || mentionPosition <= scopedQuoteCallPosition || answerPosition <= slashPosition || mergeGuardPosition <= answerPosition
    || thinkingNoticePosition <= mergeGuardPosition || onStartPosition <= thinkingNoticePosition
    || thinkingSendPosition <= onStartPosition || onDropPosition <= thinkingSendPosition
    || attachmentPosition <= mergeGuardEndPosition || typingPosition <= mergeGuardEndPosition
    || !patchedMiddlewareSetup.includes('setupMiddlewares(bot, config, manager, logger, sender)')) {
    throw new Error('Chat-only patch: serialized merge middleware, overflow notice, or ordering is incomplete');
}
if (patchedMiddlewareSetup.split('// Chat-only generation quote capture v1.').length !== 2
    || patchedMiddlewareSetup.split('// Chat-only quoted attachment cache v2.').length !== 2
    || patchedMiddlewareSetup.split('bot.use(createScopedQuoteRef(quoteRef));').length !== 2) {
    throw new Error('Chat-only patch: generation quote provenance is missing or duplicated');
}

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

await patch('transport/inbound.js', '// Chat-only batch cancellation and reply binding v1.', (content, file) => {
    const helperImport = `import { beginMergeBatch, closeMergeBatch } from '${concurrencyPolicy}';`;
    if (!content.includes(helperImport)) content = `${helperImport}\n${content}`;
    const agentBinding = '    const chatOnlyAgent = record.agent;';
    const scopedAgentBinding = [
        agentBinding,
        '    // Chat-only batch cancellation and reply binding v1.',
        '    const replyBatch = beginMergeBatch(record, replyTarget);',
        '    const isCurrentRecord = () => typeof manager.getSessionRecord === \'function\' && manager.getSessionRecord(scope, peerId) === record;',
        '    const cancelCapturedAgent = () => {',
        '        if (record.agent !== chatOnlyAgent) return;',
        "        try { chatOnlyAgent.cancel({ kind: 'user' }); }",
        "        catch { logger.warn('inbound batch agent cancellation failed'); }",
        '    };',
        "    ctx.signal?.addEventListener('abort', cancelCapturedAgent, { once: true });",
        '    if (ctx.signal?.aborted) cancelCapturedAgent();',
    ].join('\n');
    if (content.includes(agentBinding) && !content.includes('// Chat-only batch cancellation and reply binding v1.')) {
        content = replaceOne(content, agentBinding, scopedAgentBinding, file);
    }
    const tryStart = '    let documentTurn;\n    try {\n        const documentMetadata = beginDocumentTurn(chatOnlyAgent, msg, mwState.quote);';
    const guardedTry = [
        '    let documentTurn;',
        '    try {',
        '        if (ctx.signal?.aborted) return;',
        '        if (!isCurrentRecord() || record.agent !== chatOnlyAgent) return;',
        '        const documentMetadata = beginDocumentTurn(chatOnlyAgent, msg, mwState.quote);',
    ].join('\n');
    if (content.includes(tryStart)) content = replaceOne(content, tryStart, guardedTry, file);
    else if (!content.includes('if (ctx.signal?.aborted) return;')
        || !content.includes('isCurrentRecord()')) {
        throw new Error(`Chat-only patch: expected inbound turn start in ${file}`);
    }
    content = replaceOne(content, '    chatOnlyAgent.followup(message);',
        '    if (ctx.signal?.aborted || !isCurrentRecord() || record.agent !== chatOnlyAgent) return;\n    chatOnlyAgent.followup(message);', file);
    const oldFinally = [
        '        clearCurrentImages(chatOnlyAgent, documentTurn);',
        '        if (documentTurn) endDocumentTurn(chatOnlyAgent, documentTurn);',
    ].join('\n');
    const guardedFinally = [
        oldFinally.split('\n')[0],
        oldFinally.split('\n')[1],
        "        ctx.signal?.removeEventListener('abort', cancelCapturedAgent);",
        '        await closeMergeBatch(replyBatch);',
    ].join('\n');
    if (content.includes(oldFinally)) content = replaceOne(content, oldFinally, guardedFinally, file);
    else if (!content.includes('await closeMergeBatch(replyBatch);')) throw new Error(`Chat-only patch: expected inbound cleanup in ${file}`);
    return content;
});

await patch('transport/inbound.js', '// Chat-only group-history epoch guard v1.', (content, file) => {
    const marker = '// Chat-only group-history epoch guard v1.';
    const original = '    const agentBody = assembleAgentBody(msg, mwState, scope, logger);';
    const guarded = [
        `    ${marker}`,
        '    const historySnapshot = getHistorySnapshot(mwState.history);',
        '    if (historySnapshot && !isHistorySnapshotCurrent(mwState.history)) mwState.history = [];',
        original,
    ].join('\n');
    if (content.includes(original)) return replaceOne(content, original, guarded, file);
    if (content.includes(marker) && content.includes('getHistorySnapshot(mwState.history)')
        && content.includes('isHistorySnapshotCurrent(mwState.history)')) return content;
    throw new Error(`Chat-only patch: expected one matching location in ${file}`);
});

await patch('transport/inbound.js', '// Chat-only content-risk recovery context v1.', (content, file) => {
    const recoveryImport = `import { finishContentRiskRecovery, getHistorySnapshot, isHistorySnapshotCurrent, registerRecoveryContext } from '${sessionRecoveryPolicy}';`;
    if (!content.includes(recoveryImport)) content = `${recoveryImport}\n${content}`;

    const marker = '// Chat-only content-risk recovery context v1.';
    const registration = '        registerRecoveryContext(documentTurn, { manager, scope, peerId, appId: config.appId, record, agent: chatOnlyAgent, sessionId: record.sessionId, replyTarget, historySnapshot, logger });';
    const turnBinding = '        documentTurn = getDocumentTurn(chatOnlyAgent);';
    if (content.includes(marker)) {
        if (content.split(marker).length !== 2 || content.split(registration).length !== 2)
            throw new Error(`Chat-only patch: recovery context is duplicated or incomplete in ${file}`);
    }
    else if (content.includes(registration)) {
        content = replaceOne(content, registration, `${marker}\n${registration}`, file);
    }
    else {
        content = replaceOne(content, turnBinding, `${turnBinding}\n${marker}\n${registration}`, file);
    }

    const endTurn = '        if (documentTurn) endDocumentTurn(chatOnlyAgent, documentTurn);';
    const finish = '        if (documentTurn) await finishContentRiskRecovery(documentTurn);';
    if (!content.includes(finish)) content = replaceOne(content, endTurn, `${endTurn}\n${finish}`, file);

    const importPosition = content.indexOf(recoveryImport);
    const historyPosition = content.indexOf('// Chat-only group-history epoch guard v1.');
    const registrationPosition = content.indexOf(registration);
    const turnBindingPosition = content.indexOf(turnBinding);
    const followupPosition = content.indexOf('    chatOnlyAgent.followup(message);');
    const endTurnPosition = content.indexOf(endTurn);
    const finishPosition = content.indexOf(finish);
    if (content.split(recoveryImport).length !== 2
        || content.split(marker).length !== 2
        || content.split(registration).length !== 2
        || content.split(finish).length !== 2
        || historyPosition < 0 || historyPosition > content.indexOf('    const agentBody = assembleAgentBody(')
        || importPosition < 0 || turnBindingPosition < 0 || registrationPosition <= turnBindingPosition
        || followupPosition <= registrationPosition || finishPosition <= endTurnPosition) {
        throw new Error(`Chat-only patch: content-risk recovery wiring is incomplete or misordered in ${file}`);
    }
    return content;
});

await patch('transport/inbound.js', '// Chat-only generation provenance v1.', (content, file) => {
    const generationImport = "import { beginGenerationTurn, endGenerationTurn, renderGenerationRequestMetadata } from '" + generationScopePolicy + "';";
    const requestsImport = "import { getMergedGenerationRequests, enqueueMergeBatchSend } from '" + concurrencyPolicy + "';";
    if (!content.includes(generationImport)) content = generationImport + '\n' + content;
    if (!content.includes(requestsImport)) content = requestsImport + '\n' + content;

    const marker = '// Chat-only generation provenance v1.';
    const oldDeclaration = '    let documentTurn;';
    if (content.includes(oldDeclaration)) content = replaceOne(content, oldDeclaration, '    let documentTurn;\n    let generationTurn;', file);
    else if (!content.includes('    let generationTurn;')) throw new Error('Chat-only patch: missing document scope declaration in ' + file);

    const oldTurnBinding = '        documentTurn = getDocumentTurn(chatOnlyAgent);';
    const generationBinding = [
        oldTurnBinding,
        '        ' + marker,
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
    ].join('\n');
    if (content.includes(oldTurnBinding) && !content.includes(marker)) {
        content = replaceOne(content, oldTurnBinding, generationBinding, file);
    }
    else if (!content.includes(marker) || !content.includes('renderGenerationRequestMetadata(generationTurn)')) {
        throw new Error('Chat-only patch: generation provenance scope is incomplete in ' + file);
    }

    const oldBodyEnd = '            : agentBody;';
    const requestBodyLine = "        const requestBody = [documentBody, generationMetadata].filter(Boolean).join('\\n\\n');";
    if (content.includes(oldBodyEnd) && !content.includes(requestBodyLine)) {
        content = replaceOne(content, oldBodyEnd, oldBodyEnd + '\n' + requestBodyLine, file);
    }
    else if (!content.includes(requestBodyLine)) throw new Error('Chat-only patch: inbound body composition is incomplete in ' + file);
    content = replaceOne(content, "const content = [{ type: 'text', text: documentBody }];",
        "const content = [{ type: 'text', text: requestBody }];", file);

    const oldImages = '        setCurrentImages(chatOnlyAgent, [...(mwState.downloadedFiles ?? []), ...(mwState.downloadedQuoteFiles ?? [])], documentTurn);';
    const generationImages = '        setCurrentImages(chatOnlyAgent, [...(mwState.downloadedFiles ?? []), ...(mwState.downloadedQuoteFiles ?? []), ...(mwState.downloadedGenerationQuoteFiles ?? [])], documentTurn);';
    if (content.includes(oldImages)) content = replaceOne(content, oldImages, generationImages, file);
    else if (!content.includes(generationImages)) throw new Error('Chat-only patch: generation images are not in the local image grant set in ' + file);
    return content;
});

await patch('transport/inbound.js', '// Chat-only lazy quoted image grants v1.', (content, file) => {
    return replaceOne(content, '                documentScope: documentTurn,',
        '                // Chat-only lazy quoted image grants v1.\n                media: config.media,\n                documentScope: documentTurn,', file);
});

await patch('transport/inbound.js', '// Chat-only safe batch finalization v1.', (content, file) => {
    const clearAndEnd = [
        '        clearCurrentImages(chatOnlyAgent, documentTurn);',
        '        if (documentTurn) endDocumentTurn(chatOnlyAgent, documentTurn);',
    ].join('\n');
    const finish = '        if (documentTurn) await finishContentRiskRecovery(documentTurn);';
    const removeSignal = "        ctx.signal?.removeEventListener('abort', cancelCapturedAgent);";
    const closeBatch = '        await closeMergeBatch(replyBatch);';
    const oldCurrent = [clearAndEnd, finish, removeSignal, closeBatch].join('\n');
    const oldVolume = [clearAndEnd, removeSignal, closeBatch, finish].join('\n');
    const safeFinalizer = [
        clearAndEnd.split('\n')[0],
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
    ].join('\n');
    if (content.includes(oldCurrent)) content = replaceOne(content, oldCurrent, safeFinalizer, file);
    else if (content.includes(oldVolume)) content = replaceOne(content, oldVolume, safeFinalizer, file);
    else if (!content.includes('// Chat-only safe batch finalization v1.')) {
        throw new Error(`Chat-only patch: expected current/old inbound batch cleanup order in ${file}`);
    }
    return content;
});

await patch('transport/inbound.js', '// Chat-only generation cleanup v1.', (content, file) => {
    const marker = '// Chat-only generation cleanup v1.';
    const finish = '                if (documentTurn) await finishContentRiskRecovery(documentTurn);';
    const cleanup = [
        '                ' + marker,
        '                if (generationTurn) await endGenerationTurn(chatOnlyAgent, generationTurn);',
        finish,
    ].join('\n');
    if (content.includes(finish) && !content.includes(marker)) content = replaceOne(content, finish, cleanup, file);
    else if (!content.includes(marker) || !content.includes('await endGenerationTurn(chatOnlyAgent, generationTurn);'))
        throw new Error('Chat-only patch: generation scope drain is missing from inbound cleanup in ' + file);
    const endDocumentPosition = content.indexOf('if (documentTurn) endDocumentTurn(chatOnlyAgent, documentTurn);');
    const generationPosition = content.indexOf('await endGenerationTurn(chatOnlyAgent, generationTurn);');
    const finishPosition = content.indexOf(finish);
    const closePosition = content.indexOf('await closeMergeBatch(replyBatch);');
    if (endDocumentPosition < 0 || generationPosition <= endDocumentPosition
        || finishPosition <= generationPosition || closePosition <= finishPosition) {
        throw new Error('Chat-only patch: generation scope is not revoked/drained before batch handoff in ' + file);
    }
    return content;
});

await patch('transport/inbound.js', '// Chat-only group model context v1.', (content, file) => {
    const marker = '// Chat-only group model context v1.';
    const importLine = `import { beginGroupModelContext, endGroupModelContext } from '${modelContextPolicy}';`;
    if (!content.includes(importLine)) content = `${importLine}\n${content}`;
    content = replaceOne(content, '    let generationTurn;\n    try {',
        '    let generationTurn;\n    let modelContextTurn;\n    try {', file);
    content = replaceOne(content,
        '    chatOnlyAgent.followup(message);',
        `    ${marker}\n    modelContextTurn = beginGroupModelContext(chatOnlyAgent, scope, documentTurn);\n    chatOnlyAgent.followup(message);`, file);
    content = replaceOne(content,
        '    } finally {\n        clearCurrentImages(chatOnlyAgent, documentTurn);',
        '    } finally {\n        endGroupModelContext(chatOnlyAgent, modelContextTurn);\n        clearCurrentImages(chatOnlyAgent, documentTurn);', file);
    return content;
});

await patch('transport/inbound.js', '// Chat-only context diagnostics v1.', (content, file) => {
    const importLine = `import { logContextInbound, logContextBinding } from '${contextDiagnosticsPolicy}';`;
    if (!content.includes(importLine)) content = `${importLine}\n${content}`;
    content = replaceOne(content,
        '    const agentBody = assembleAgentBody(msg, mwState, scope, logger);',
        '    const agentBody = assembleAgentBody(msg, mwState, scope, logger);\n'
        + '    // Chat-only context diagnostics v1.\n'
        + '    logContextInbound(ctx, getMergedGenerationRequests(ctx), agentBody);', file);
    const binding = '    modelContextTurn = beginGroupModelContext(chatOnlyAgent, scope, documentTurn);';
    return replaceOne(content, binding,
        `${binding}\n    // Chat-only context binding diagnostics v1.\n    logContextBinding(chatOnlyAgent, requestBody, agentBody);`, file);
});

await patch('transport/outbound.js', '// Chat-only content-risk turn recovery v1.', (content, file) => {
    const recoveryImport = `import { isContentRiskFailure, markContentRiskFailure, noteRecoveryTurnStart } from '${sessionRecoveryPolicy}';`;
    if (!content.includes(recoveryImport)) content = `${recoveryImport}\n${content}`;

    const marker = '// Chat-only content-risk turn recovery v1.';
    const routeStart = [
        '    route(session, raw) {',
        '        const event = parseEvent(raw);',
    ].join('\n');
    const guardedRoute = [
        '    route(session, raw) {',
        `        ${marker}`,
        "        if (raw?.type === 'turn/start') {",
        '            const sessionId = session.header.id;',
        '            const startRecord = this.manager.findBySessionId(sessionId);',
        '            if (startRecord) noteRecoveryTurnStart({ record: startRecord, sessionId, turnId: raw.data?.turn });',
        '            return;',
        '        }',
        '        const event = parseEvent(raw);',
    ].join('\n');
    if (content.includes(routeStart)) content = replaceOne(content, routeStart, guardedRoute, file);
    else if (!content.includes(marker)) throw new Error(`Chat-only patch: expected the pinned route() in ${file}`);

    const oldDispatch = '                this.onTurnEnd(session.header.id, record, event);';
    const newDispatch = '                this.onTurnEnd(session.header.id, record, event, raw.data?.turn);';
    if (content.includes(oldDispatch)) content = replaceOne(content, oldDispatch, newDispatch, file);
    else if (!content.includes(newDispatch)) throw new Error(`Chat-only patch: expected turn/end dispatch in ${file}`);

    const oldHandler = [
        '    onTurnEnd(sessionId, record, event) {',
        '        const buffer = this.buffers.get(sessionId);',
        '        if (buffer !== undefined) {',
        '            if (buffer.text.trim()) {',
        '                void buffer.flush();',
        '            }',
        '            else {',
        '                buffer.cancel();',
        '            }',
        '            this.buffers.delete(sessionId);',
        '        }',
        '        const failure = extractTurnError(event.reason);',
        "        if (failure !== undefined && !SILENT_TURN_ERROR_CODES.has(failure.code)) {",
        '            void this.send(record, `⚠️ 本轮异常结束\\n\\`${failure.code}\\`: ${failure.message}`, \'sendTurnEndError\');',
        '        }',
        '        this.logger.debug(`im-qqbot: turn/end sessionId=${sessionId}`);',
        '    }',
    ].join('\n');
    const recoveryHandler = [
        '    onTurnEnd(sessionId, record, event, turnId) {',
        '        const buffer = this.buffers.get(sessionId);',
        '        if (buffer !== undefined) {',
        '            if (buffer.text.trim()) {',
        '                void buffer.flush();',
        '            }',
        '            else {',
        '                buffer.cancel();',
        '            }',
        '            this.buffers.delete(sessionId);',
        '        }',
        '        const failure = extractTurnError(event.reason);',
        '        if (failure !== undefined) {',
        '            if (isContentRiskFailure(failure)) {',
        '                markContentRiskFailure({',
        '                    record,',
        '                    sessionId,',
        '                    turnId,',
        '                    failure,',
        '                    notify: (text, replyTarget) => this.send({ ...record, replyTarget: replyTarget ?? record.replyTarget }, text, \'sendContentRiskRecovery\'),',
        '                });',
        '            }',
        '            else if (!SILENT_TURN_ERROR_CODES.has(failure.code)) {',
        '                void this.send(record, `⚠️ 本轮异常结束\\n\\`${failure.code}\\`: ${failure.message}`, \'sendTurnEndError\');',
        '            }',
        '        }',
        '        this.logger.debug(`im-qqbot: turn/end sessionId=${sessionId}`);',
        '    }',
    ].join('\n');
    if (content.includes(oldHandler)) content = replaceOne(content, oldHandler, recoveryHandler, file);
    else if (!content.includes('onTurnEnd(sessionId, record, event, turnId)'))
        throw new Error(`Chat-only patch: expected pinned onTurnEnd() in ${file}`);

    const handlerPosition = content.indexOf('    onTurnEnd(sessionId, record, event, turnId) {');
    const registrationPosition = content.indexOf('markContentRiskFailure({', handlerPosition);
    if (content.split(recoveryImport).length !== 2
        || content.split(marker).length !== 2
        || !content.includes('raw.data?.turn')
        || !content.includes("if (raw?.type === 'turn/start')")
        || registrationPosition < handlerPosition) {
        throw new Error(`Chat-only patch: content-risk turn recovery wiring is incomplete in ${file}`);
    }
    return content;
});

await patch('transport/outbound.js', '// Chat-only friendly provider errors v1.', (content, file) => {
    const friendlyImport = `import { formatProviderFailure, formatToolFailure } from '${providerErrorsPolicy}';`;
    if (!content.includes(friendlyImport)) content = `${friendlyImport}\n${content}`;
    content = replaceOne(content,
        "                this.onToolResult(record, event);",
        "                this.onToolResult(record, event, raw);", file);
    content = replaceOne(content,
        '    onToolResult(record, event) {',
        '    onToolResult(record, event, raw) {\n        // Chat-only friendly provider errors v1.', file);
    const oldToolGate = [
        '        if (event.error === undefined && !this.config.showToolResults)',
        '            return;',
    ].join('\n');
    const safeToolGate = [
        '        const resultBlocks = raw?.data?.message?.content;',
        "        const failed = event.error !== undefined || (Array.isArray(resultBlocks) && resultBlocks.some((block) => block?.type === 'tool-result' && block.isError === true));",
        '        if (failed) {',
        "            void this.send(record, formatToolFailure(), 'sendToolResultError');",
        '            return;',
        '        }',
        '        if (!this.config.showToolResults)',
        '            return;',
    ].join('\n');
    content = replaceOne(content, oldToolGate, safeToolGate, file);
    content = replaceOne(content,
        '                void this.send(record, `⚠️ 本轮异常结束\\n\\`${failure.code}\\`: ${failure.message}`, \'sendTurnEndError\');',
        "                void this.send(record, formatProviderFailure(failure), 'sendTurnEndError');", file);
    return replaceOne(content,
        '                this.logger.error(`im-qqbot: ${tag} failed: ${err instanceof Error ? err.message : String(err)}`);',
        "                this.logger.error(`im-qqbot: ${tag} failed to send reply`);", file);
});

await patch('transport/outbound.js', '// Chat-only batch-bound outbound routing v1.', (content, file) => {
    const bindingImport = `import { captureMergeBatchReply, noteMergeBatchTurnStart, trackMergeBatchSend } from '${concurrencyPolicy}';`;
    if (!content.includes(bindingImport)) content = `${bindingImport}\n${content}`;
    const routeStart = content.indexOf('    route(session, raw) {');
    const routeEnd = content.indexOf('    /** 流式文本增量：累积到会话 buffer */', routeStart);
    if (routeStart < 0 || routeEnd <= routeStart) throw new Error(`Chat-only patch: expected OutboundRouter.route() in ${file}`);
    const route = [
        '    route(session, raw) {',
        '        // Chat-only content-risk turn recovery v1.',
        '        // Chat-only batch-bound outbound routing v1.',
        "        if (raw?.type === 'turn/start') {",
        '            const sessionId = session.header.id;',
        '            const startRecord = this.manager.findBySessionId(sessionId);',
        '            if (!startRecord) return;',
        '            if (!noteMergeBatchTurnStart(startRecord, { sessionId, turnId: raw.data?.turn, seq: raw.seq })) return;',
        '            noteRecoveryTurnStart({ record: startRecord, sessionId, turnId: raw.data?.turn });',
        '            return;',
        '        }',
        '        const event = parseEvent(raw);',
        '        if (event === undefined) return;',
        '        const sessionId = session.header.id;',
        '        const record = this.manager.findBySessionId(sessionId);',
        '        if (record === undefined) return;',
        '        const binding = captureMergeBatchReply(record, { sessionId, turnId: raw?.data?.turn, seq: raw?.seq });',
        '        if (!binding) return;',
        '        const replyRecord = binding.replyRecord;',
        '        switch (event.type) {',
        "            case 'assistant/chunk':",
        '                this.onChunk(sessionId, replyRecord, event);',
        '                break;',
        "            case 'assistant/message':",
        '                this.onMessage(sessionId, replyRecord, event, record);',
        '                break;',
        "            case 'tool/call':",
        '                this.onToolCall(event);',
        '                break;',
        "            case 'tool/result':",
        '                this.onToolResult(replyRecord, event, raw, record);',
        '                break;',
        "            case 'turn/end':",
        '                this.onTurnEnd(sessionId, replyRecord, event, raw.data?.turn, record);',
        '                break;',
        '        }',
        '    }',
        '',
    ].join('\n');
    content = content.slice(0, routeStart) + route + content.slice(routeEnd);
    content = replaceOne(content,
        "    onMessage(sessionId, record, event) {",
        "    onMessage(sessionId, record, event, originRecord = record) {", file);
    const messageBufferFlush = [
        '        if (buffer !== undefined && buffer.text.trim()) {',
        '            void buffer.flush();',
        '            this.buffers.delete(sessionId);',
        '            return;',
        '        }',
    ].join('\n');
    const trackedMessageBufferFlush = [
        '        if (buffer !== undefined && buffer.text.trim()) {',
        '            trackMergeBatchSend(originRecord, buffer.flush());',
        '            this.buffers.delete(sessionId);',
        '            return;',
        '        }',
    ].join('\n');
    content = replaceOne(content, messageBufferFlush, trackedMessageBufferFlush, file);
    content = replaceOne(content,
        "        void this.send(record, fullText, 'sendMarkdown');",
        "        trackMergeBatchSend(originRecord, this.send(record, fullText, 'sendMarkdown'));", file);
    content = replaceOne(content,
        '    onToolResult(record, event, raw) {',
        '    onToolResult(record, event, raw, originRecord = record) {', file);
    content = replaceOne(content,
        "            void this.send(record, formatToolFailure(), 'sendToolResultError');",
        "            trackMergeBatchSend(originRecord, this.send(record, formatToolFailure(), 'sendToolResultError'));", file);
    content = replaceOne(content,
        "        void this.send(record, text, 'sendToolResult');",
        "        trackMergeBatchSend(originRecord, this.send(record, text, 'sendToolResult'));", file);
    content = replaceOne(content,
        '    onTurnEnd(sessionId, record, event, turnId) {',
        '    onTurnEnd(sessionId, record, event, turnId, originRecord = record) {', file);
    content = replaceOne(content,
        '                void buffer.flush();',
        '                trackMergeBatchSend(originRecord, buffer.flush());', file);
    content = replaceOne(content,
        '                buffer.cancel();',
        '                trackMergeBatchSend(originRecord, buffer.cancel());', file);
    content = replaceOne(content,
        '                    record,\n                    sessionId,\n                    turnId,',
        '                    record: originRecord,\n                    sessionId,\n                    turnId,', file);
    content = replaceOne(content,
        "                    notify: (text, replyTarget) => this.send({ ...record, replyTarget: replyTarget ?? record.replyTarget }, text, 'sendContentRiskRecovery'),",
        "                    notify: (text, replyTarget) => trackMergeBatchSend(originRecord, this.send({ ...record, replyTarget: replyTarget ?? record.replyTarget }, text, 'sendContentRiskRecovery')),", file);
    content = replaceOne(content,
        "                void this.send(record, formatProviderFailure(failure), 'sendTurnEndError');",
        "                trackMergeBatchSend(originRecord, this.send(record, formatProviderFailure(failure), 'sendTurnEndError'));", file);
    return content;
});

await patch('transport/outbound.js', '// Chat-only generation outbound v1.', (content, file) => {
    const oldImport = `import { captureMergeBatchReply, noteMergeBatchTurnStart, trackMergeBatchSend } from '${concurrencyPolicy}';`;
    const newImport = `import { captureMergeBatchReply, enqueueMergeBatchSend, noteMergeBatchTurnStart } from '${concurrencyPolicy}';`;
    if (content.includes(oldImport)) content = replaceOne(content, oldImport, newImport, file);
    else if (!content.includes(newImport)) throw new Error('Chat-only patch: missing merge outbound executor import in ' + file);

    const flush = 'trackMergeBatchSend(originRecord, buffer.flush());';
    if (content.includes(flush)) content = content.split(flush).join('enqueueMergeBatchSend(originRecord, () => buffer.flush());');
    const cancel = 'trackMergeBatchSend(originRecord, buffer.cancel());';
    if (content.includes(cancel)) content = replaceOne(content, cancel, 'enqueueMergeBatchSend(originRecord, () => buffer.cancel());', file);
    const sends = [
        ["trackMergeBatchSend(originRecord, this.send(record, fullText, 'sendMarkdown'));", "enqueueMergeBatchSend(originRecord, () => this.send(record, fullText, 'sendMarkdown'));"],
        ["trackMergeBatchSend(originRecord, this.send(record, formatToolFailure(), 'sendToolResultError'));", "enqueueMergeBatchSend(originRecord, () => this.send(record, formatToolFailure(), 'sendToolResultError'));"],
        ["trackMergeBatchSend(originRecord, this.send(record, text, 'sendToolResult'));", "enqueueMergeBatchSend(originRecord, () => this.send(record, text, 'sendToolResult'));"],
        ["trackMergeBatchSend(originRecord, this.send(record, formatProviderFailure(failure), 'sendTurnEndError'));", "enqueueMergeBatchSend(originRecord, () => this.send(record, formatProviderFailure(failure), 'sendTurnEndError'));"],
        ["trackMergeBatchSend(originRecord, this.send({ ...record, replyTarget: replyTarget ?? record.replyTarget }, text, 'sendContentRiskRecovery'))", "enqueueMergeBatchSend(originRecord, () => this.send({ ...record, replyTarget: replyTarget ?? record.replyTarget }, text, 'sendContentRiskRecovery'))"],
    ];
    for (const [before, after] of sends) {
        if (content.includes(before)) content = replaceOne(content, before, after, file);
    }
    const resultGate = [
        '        if (!this.config.showToolResults)',
        '            return;',
    ].join('\n');
    const generationGate = [
        '        // Chat-only generation outbound v1.',
        "        if (call.name === 'qqbot_generate_image' || call.name === 'qqbot_create_markdown') return;",
        '        if (!this.config.showToolResults)',
        '            return;',
    ].join('\n');
    if (content.includes(resultGate)) content = replaceOne(content, resultGate, generationGate, file);
    else if (!content.includes('// Chat-only generation outbound v1.'))
        throw new Error('Chat-only patch: tool-result suppression point is missing in ' + file);
    return content;
});

await patch('transport/outbound.js', '// Chat-only deferred tool failures v1.', (content, file) => {
    content = replaceOne(content,
        '    toolCalls = new Map();',
        '    toolCalls = new Map();\n    // Chat-only deferred tool failures v1.\n    toolFailureTurns = new WeakMap();', file);
    content = replaceOne(content,
        '            noteRecoveryTurnStart({ record: startRecord, sessionId, turnId: raw.data?.turn });',
        '            this.toolFailureTurns.delete(startRecord);\n            noteRecoveryTurnStart({ record: startRecord, sessionId, turnId: raw.data?.turn });', file);
    content = replaceOne(content,
        "            case 'assistant/chunk':\n                this.onChunk(sessionId, replyRecord, event);",
        "            case 'assistant/chunk':\n                if (this.toolFailureTurns.get(record)?.toolFailed) this.toolFailureTurns.get(record).streamAfterFailure = true;\n                this.onChunk(sessionId, replyRecord, event);", file);
    content = replaceOne(content,
        "            case 'tool/call':\n                this.onToolCall(event);",
        "            case 'tool/call':\n                if (this.toolFailureTurns.get(record)?.toolFailed) this.toolFailureTurns.get(record).streamAfterFailure = false;\n                this.onToolCall(event);", file);
    content = replaceOne(content,
        '        const buffer = this.buffers.get(sessionId);\n        if (buffer !== undefined && buffer.text.trim()) {',
        '        const turn = this.toolFailureTurns.get(originRecord);\n        if (turn?.toolFailed) {\n            if (event.content.some((block) => block?.type === \'tool-call\')) turn.streamAfterFailure = false;\n            else if (event.content.some((block) => block?.type === \'text\' && typeof block.text === \'string\' && block.text.trim())) turn.hasAnswer = true;\n        }\n        const buffer = this.buffers.get(sessionId);\n        if (buffer !== undefined && buffer.text.trim()) {', file);
    content = replaceOne(content,
        '            enqueueMergeBatchSend(originRecord, () => this.send(record, formatToolFailure(), \'sendToolResultError\'));',
        '            this.toolFailureTurns.set(originRecord, { toolFailed: true, hasAnswer: false, streamAfterFailure: false });', file);
    content = replaceOne(content,
        '    onTurnEnd(sessionId, record, event, turnId, originRecord = record) {\n        const buffer = this.buffers.get(sessionId);',
        '    onTurnEnd(sessionId, record, event, turnId, originRecord = record) {\n        const turn = this.toolFailureTurns.get(originRecord);\n        this.toolFailureTurns.delete(originRecord);\n        const buffer = this.buffers.get(sessionId);\n        const completedStreamAnswer = !!(turn?.streamAfterFailure && buffer?.text.trim());', file);
    content = replaceOne(content,
        '        const failure = extractTurnError(event.reason);',
        '        if (event.reason.kind === \'completed\' && turn?.toolFailed && !turn.hasAnswer && !completedStreamAnswer)\n            enqueueMergeBatchSend(originRecord, () => this.send(record, formatToolFailure(), \'sendToolResultError\'));\n        const failure = extractTurnError(event.reason);', file);
    for (const invariant of [
        '// Chat-only deferred tool failures v1.',
        'this.toolFailureTurns.delete(startRecord);',
        'this.toolFailureTurns.delete(originRecord);',
        "event.reason.kind === 'completed'",
    ]) {
        if (content.split(invariant).length !== 2) throw new Error(`Chat-only patch: missing deferred tool failure invariant in ${file}: ${invariant}`);
    }
    return content;
});

await patch('transport/streaming-writer.js', '// Chat-only awaitable stream cancellation v1.', (content, file) => {
    const original = [
        '    abort() {',
        '        if (this.finished)',
        '            return;',
        '        this.finished = true;',
        '        this.aborted = true;',
        '        if (this.throttleTimer) {',
        '            clearTimeout(this.throttleTimer);',
        '            this.throttleTimer = null;',
        '        }',
        '        // 串行 complete（排在 pending update 之后），关闭已打开的流式会话',
        '        this.chain = this.chain.then(async () => {',
        '            if (this.session) {',
        '                try {',
        '                    await this.session.complete();',
        '                }',
        '                catch (err) {',
        '                    this.deps.logger.error(`im-qqbot: stream abort complete failed: ${err instanceof Error ? err.message : String(err)}`);',
        '                }',
        '            }',
        '        });',
        '    }',
    ].join('\n');
    const replacement = [
        '    // Chat-only awaitable stream cancellation v1.',
        '    abort() {',
        '        if (this.finished)',
        '            return this.chain;',
        '        this.finished = true;',
        '        this.aborted = true;',
        '        if (this.throttleTimer) {',
        '            clearTimeout(this.throttleTimer);',
        '            this.throttleTimer = null;',
        '        }',
        '        // 串行 complete（排在 pending update 之后），关闭已打开的流式会话',
        '        this.chain = this.chain.then(async () => {',
        '            if (this.session) {',
        '                try {',
        '                    await this.session.complete();',
        '                }',
        '                catch (err) {',
        '                    this.deps.logger.error(`im-qqbot: stream abort complete failed: ${err instanceof Error ? err.message : String(err)}`);',
        '                }',
        '            }',
        '        });',
        '        return this.chain;',
        '    }',
    ].join('\n');
    if (content.includes(original)) return replaceOne(content, original, replacement, file);
    if (!content.includes('// Chat-only awaitable stream cancellation v1.')
        || !content.includes('return this.chain;')) throw new Error(`Chat-only patch: expected StreamingWriter.abort() in ${file}`);
    return content;
});

await patch('transport/outbound-buffer.js', '// Chat-only awaitable stream cancellation v1.', (content, file) => {
    const originalFlush = [
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
    ].join('\n');
    const sharedFlush = [
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
    ].join('\n');
    if (content.includes(originalFlush)) content = replaceOne(content, originalFlush, sharedFlush, file);
    else if (!content.includes('this.flushPromise = completion;')
        || !content.includes('if (this.flushPromise)')) {
        throw new Error(`Chat-only patch: expected OutboundBuffer.flush() in ${file}`);
    }
    const original = [
        '    cancel() {',
        '        this.writer?.abort();',
        "        this.buffer = '';",
        '    }',
    ].join('\n');
    const replacement = [
        '    // Chat-only awaitable stream cancellation v1.',
        '    cancel() {',
        '        const completion = this.writer?.abort();',
        "        this.buffer = '';",
        '        return Promise.all([this.flushPromise, completion].filter(Boolean));',
        '    }',
    ].join('\n');
    if (content.includes(original)) return replaceOne(content, original, replacement, file);
    if (!content.includes('// Chat-only awaitable stream cancellation v1.')
        || !content.includes('return Promise.all([this.flushPromise, completion].filter(Boolean));')) throw new Error(`Chat-only patch: expected OutboundBuffer.cancel() in ${file}`);
    return content;
});

await patch('transport/inbound.js', '// Chat-only safe inbound errors v1.', (content, file) =>
    replaceOne(content,
        '        logger.warn(`whenIdle/followup rejected: ${err instanceof Error ? err.message : String(err)}`);',
        "        // Chat-only safe inbound errors v1.\n        logger.warn('whenIdle/followup rejected');", file));

await patch('transport/events.js', '// Chat-only structured provider failures v1.', (content, file) =>
    replaceOne(content,
        "        message: detail?.message ?? reason.message ?? 'unknown error',",
        [
            "        message: detail?.message ?? reason.message ?? 'unknown error',",
            '        // Chat-only structured provider failures v1.',
            '        status: detail?.status ?? reason.status,',
            '        type: detail?.type ?? reason.type,',
            '        error: detail?.error,',
        ].join('\n'), file));

await patch('model/prefs-store.js', '// Chat-only persistent model prefs v1.', (content, file) => {
    const originalImports = [
        "import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';",
        "import { resolve, dirname } from 'node:path';",
        "import { homedir } from 'node:os';",
    ].join('\n');
    const patchedImports = [
        "import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';",
        "import { randomUUID } from 'node:crypto';",
        "import { resolve, dirname } from 'node:path';",
        "import { homedir } from 'node:os';",
    ].join('\n');
    if (content.includes(originalImports)) content = replaceOne(content, originalImports, patchedImports, file);
    else if (!content.includes(patchedImports)) throw new Error(`Chat-only patch: expected pinned PrefsStore imports in ${file}`);

    const originalConstructor = [
        '    constructor(debugLog) {',
        "        this.prefsPath = resolve(homedir(), '.dsh-qqbot', 'model-prefs.json');",
        '        this.debugLog = debugLog;',
        '        this.load();',
        '    }',
    ].join('\n');
    const patchedConstructor = [
        '    constructor(debugLog) {',
        '        // Chat-only persistent model prefs v1.',
        "        this.prefsPath = '/data/qqbot-model-prefs.json';",
        '        this.debugLog = debugLog;',
        "        const legacyPath = resolve(homedir(), '.dsh-qqbot', 'model-prefs.json');",
        '        let migrationTemp;',
        '        try {',
        '            if (!existsSync(this.prefsPath) && existsSync(legacyPath)) {',
        '                mkdirSync(dirname(this.prefsPath), { recursive: true });',
        '                migrationTemp = `${this.prefsPath}.${process.pid}.${randomUUID()}.tmp`;',
        "                writeFileSync(migrationTemp, readFileSync(legacyPath), { flag: 'wx', mode: 0o600 });",
        '                renameSync(migrationTemp, this.prefsPath);',
        '                migrationTemp = undefined;',
        '            }',
        '        }',
        '        catch (err) {',
        '            if (migrationTemp) {',
        '                try { unlinkSync(migrationTemp); } catch {}',
        '            }',
        '            this.debugLog?.(`migratePrefs failed: ${err instanceof Error ? err.message : String(err)}`);',
        '        }',
        '        this.load();',
        '    }',
    ].join('\n');
    if (content.includes(originalConstructor)) content = replaceOne(content, originalConstructor, patchedConstructor, file);
    else if (!content.includes('// Chat-only persistent model prefs v1.'))
        throw new Error(`Chat-only patch: expected PrefsStore constructor in ${file}`);

    const originalSetter = [
        '    setSessionId(sessionKey, sessionId) {',
        '        this.sessionIds.set(sessionKey, sessionId);',
        '        this.write();',
        '    }',
    ].join('\n');
    const patchedSetter = [
        '    setSessionId(sessionKey, sessionId, options = {}) {',
        '        const hadPrevious = this.sessionIds.has(sessionKey);',
        '        const previous = this.sessionIds.get(sessionKey);',
        '        this.sessionIds.set(sessionKey, sessionId);',
        '        const written = this.write();',
        '        if (options?.strict && !written) {',
        '            if (hadPrevious) this.sessionIds.set(sessionKey, previous);',
        '            else this.sessionIds.delete(sessionKey);',
        "            throw new Error('Unable to persist automatic session reset.');",
        '        }',
        '        return written;',
        '    }',
    ].join('\n');
    if (content.includes(originalSetter)) content = replaceOne(content, originalSetter, patchedSetter, file);
    else if (!content.includes('setSessionId(sessionKey, sessionId, options = {})'))
        throw new Error(`Chat-only patch: expected PrefsStore.setSessionId() in ${file}`);

    const originalWrite = [
        '    write() {',
        '        try {',
        '            mkdirSync(dirname(this.prefsPath), { recursive: true });',
        '            const data = {',
        '                overrides: Object.fromEntries(this.overrides.entries()),',
        '                sessionIds: Object.fromEntries(this.sessionIds.entries()),',
        '                presets: Object.fromEntries(this.presets.entries()),',
        '            };',
        "            writeFileSync(this.prefsPath, JSON.stringify(data, null, 2), 'utf8');",
        '        }',
        '        catch (err) {',
        '            this.debugLog?.(`writePrefs failed: ${err instanceof Error ? err.message : String(err)}`);',
        '        }',
        '    }',
    ].join('\n');
    const patchedWrite = [
        '    write() {',
        '        let tempPath;',
        '        try {',
        '            mkdirSync(dirname(this.prefsPath), { recursive: true });',
        '            const data = {',
        '                overrides: Object.fromEntries(this.overrides.entries()),',
        '                sessionIds: Object.fromEntries(this.sessionIds.entries()),',
        '                presets: Object.fromEntries(this.presets.entries()),',
        '            };',
        '            tempPath = `${this.prefsPath}.${process.pid}.${randomUUID()}.tmp`;',
        "            writeFileSync(tempPath, JSON.stringify(data, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });",
        '            renameSync(tempPath, this.prefsPath);',
        '            return true;',
        '        }',
        '        catch (err) {',
        '            if (tempPath) {',
        '                try { unlinkSync(tempPath); } catch {}',
        '            }',
        '            this.debugLog?.(`writePrefs failed: ${err instanceof Error ? err.message : String(err)}`);',
        '            return false;',
        '        }',
        '    }',
    ].join('\n');
    if (content.includes(originalWrite)) content = replaceOne(content, originalWrite, patchedWrite, file);
    else if (!content.includes('return false;') || !content.includes('renameSync(tempPath, this.prefsPath);'))
        throw new Error(`Chat-only patch: expected PrefsStore.write() in ${file}`);

    if (content.split('// Chat-only persistent model prefs v1.').length !== 2
        || !content.includes("this.prefsPath = '/data/qqbot-model-prefs.json';")
        || !content.includes('options?.strict && !written')
        || !content.includes('renameSync(tempPath, this.prefsPath);')) {
        throw new Error(`Chat-only patch: persistent model prefs patch is incomplete in ${file}`);
    }
    return content;
});

await patch('model/model-resolver.js', '// Chat-only strict sessionId persistence v1.', (content, file) => {
    const original = [
        '    setSessionId(sessionKey, sessionId) {',
        '        this.prefs.setSessionId(sessionKey, sessionId);',
        '    }',
    ].join('\n');
    const replacement = [
        '    // Chat-only strict sessionId persistence v1.',
        '    setSessionId(sessionKey, sessionId, options) {',
        '        return this.prefs.setSessionId(sessionKey, sessionId, options);',
        '    }',
    ].join('\n');
    if (content.includes(original)) return replaceOne(content, original, replacement, file);
    if (!content.includes('// Chat-only strict sessionId persistence v1.')
        || !content.includes('this.prefs.setSessionId(sessionKey, sessionId, options);'))
        throw new Error(`Chat-only patch: expected ModelResolver.setSessionId() in ${file}`);
    return content;
});

await patch('session/session-manager.js', '// Chat-only strict automatic session reset v1.', (content, file) => {
    const original = [
        '    async remove(scope, peerId) {',
        '        const key = this.sessionKey(scope, peerId);',
        '        const record = this.sessions.get(key);',
        '        this.modelResolver.setSessionId(key, randomUUID());',
        '        if (!record)',
        '            return;',
        '        this.sessions.delete(key);',
        "        record.agent.cancel({ kind: 'user' });",
        '        await record.handle.dispose().catch(() => { });',
        '        this.logger.info(`session removed: key=${key}`);',
        '    }',
    ].join('\n');
    const replacement = [
        '    // Chat-only strict automatic session reset v1.',
        '    async remove(scope, peerId, recoveryOptions) {',
        '        const key = this.sessionKey(scope, peerId);',
        '        const record = this.sessions.get(key);',
        '        if (recoveryOptions?.requirePersisted === true) {',
        '            if (!record',
        '                || record !== recoveryOptions.expectedRecord',
        '                || record.agent !== recoveryOptions.expectedAgent',
        '                || record.sessionId !== recoveryOptions.expectedSessionId) return false;',
        '            this.modelResolver.setSessionId(key, randomUUID(), { strict: true });',
        '            this.sessions.delete(key);',
        '            try { recoveryOptions.onCommitted?.(record); } catch { }',
        "            try { record.agent.cancel({ kind: 'user' }); } catch { this.logger.warn('automatic session reset cancellation failed'); }",
        "            try { await record.handle.dispose(); } catch { this.logger.warn('automatic session reset disposal failed'); }",
        '            this.logger.info(`session removed: key=${key}`);',
        '            return true;',
        '        }',
        '        this.modelResolver.setSessionId(key, randomUUID());',
        '        if (!record)',
        '            return;',
        '        this.sessions.delete(key);',
        "        record.agent.cancel({ kind: 'user' });",
        '        await record.handle.dispose().catch(() => { });',
        '        this.logger.info(`session removed: key=${key}`);',
        '    }',
    ].join('\n');
    if (content.includes(original)) content = replaceOne(content, original, replacement, file);
    else if (!content.includes('// Chat-only strict automatic session reset v1.'))
        throw new Error(`Chat-only patch: expected SessionManager.remove() in ${file}`);
    if (content.split('// Chat-only strict automatic session reset v1.').length !== 2
        || !content.includes('recoveryOptions.expectedRecord')
        || !content.includes('this.modelResolver.setSessionId(key, randomUUID(), { strict: true });')
        || !content.includes('recoveryOptions.onCommitted?.(record)')) {
        throw new Error(`Chat-only patch: strict automatic session reset is incomplete in ${file}`);
    }
    return content;
});

await patch('session/session-manager.js', '// Chat-only committed reset disposal v1.', (content, file) => {
    const safeDispose = "            try { await record.handle.dispose(); } catch { this.logger.warn('automatic session reset disposal failed'); }";
    const oldDispose = '            await record.handle.dispose().catch(() => { });';
    const strictStart = content.indexOf('        if (recoveryOptions?.requirePersisted === true) {');
    const strictEnd = content.indexOf('            return true;', strictStart);
    if (strictStart < 0 || strictEnd < strictStart) throw new Error(`Chat-only patch: missing strict remove branch in ${file}`);
    let strictBranch = content.slice(strictStart, strictEnd);
    if (strictBranch.includes(oldDispose)) strictBranch = replaceOne(strictBranch, oldDispose, safeDispose, file);
    strictBranch = replaceOne(strictBranch, safeDispose, `            // Chat-only committed reset disposal v1.\n${safeDispose}`, file);
    return content.slice(0, strictStart) + strictBranch + content.slice(strictEnd);
});

await patch('transport/inbound.js', '// Chat-only explicit-quote text trigger v1.', (content, file) =>
    replaceOne(content,
        '    if (isEmptyMessage(userContent, msg.attachments, isGroup, wasMentioned))',
        '    // Chat-only explicit-quote text trigger v1.\n    if (isEmptyMessage(userContent, [...(msg.attachments ?? []), ...(state.quote?.attachments ?? [])], isGroup, wasMentioned))', file));

await patch('transport/attachment.js', '// Chat-only generation attachment provenance v1.', (content, file) => {
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
    const oldMetadata = '        results.push({ filename: att.filename, contentType, localPath });';
    const markedMetadata = '        // Chat-only generation attachment provenance v1.\n        results.push({ filename: att.filename, contentType, localPath, sourceUrl: normalizeUrl(att.url) });';
    if (content.includes(oldMetadata)) content = replaceOne(content, oldMetadata, markedMetadata, file);
    else if (!content.includes('// Chat-only generation attachment provenance v1.')
        || !content.includes('sourceUrl: normalizeUrl(att.url)')) {
        throw new Error('Chat-only patch: attachment provenance result is missing in ' + file);
    }
    return content;
});

await patch('transport/attachment.js', '// Chat-only image download diagnostics v1.', (content, file) => {
    content = "import { logDownloadDiagnostics, logDownloadSelection } from '/opt/qqbot-defaults/qqbot-image-diagnostics.mjs';\n" + content;
    content = replaceOne(content, '    if (!media.enabled)',
        '    // Chat-only image download diagnostics v1.\n    logDownloadSelection(attachments, media);\n    if (!media.enabled)', file);
    content = replaceOne(content, '        if (att.size > maxBytes) {',
        "        if (att.size > maxBytes) {\n            logDownloadDiagnostics(att, 'too_large');", file);
    content = replaceOne(content, '            bytes = await download(att.url, localPath, maxBytes);',
        "            logDownloadDiagnostics(att, 'start');\n            bytes = await download(att.url, localPath, maxBytes);\n            logDownloadDiagnostics(att, 'success');", file);
    return replaceOne(content, '        catch (err) {',
        "        catch (err) {\n            logDownloadDiagnostics(att, 'failed', err);", file);
});

await patch('middleware/attachment.js', '// Chat-only attachment processor diagnostics v1.', (content, file) => {
    content = "import { logDownloadDiagnostics } from '/opt/qqbot-defaults/qqbot-image-diagnostics.mjs';\n" + content;
    return replaceOne(content, '        catch (err) {',
        "        catch (err) {\n            // Chat-only attachment processor diagnostics v1.\n            logDownloadDiagnostics(undefined, 'processor_failed', err);", file);
});

await patch('middleware/attachment.js', '// Chat-only generation quote image downloads v1.', (content, file) => {
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
        content = replaceOne(content, legacyRestrictedBlock, replacement, file);
    }
    else if (content.includes(quoteDownloadBlock)) {
        if (!content.includes(marker)) content = replaceOne(content, quoteDownloadBlock, replacement, file);
    }
    else if (!content.includes(marker)) {
        throw new Error(`Chat-only patch: expected one matching location in ${file}`);
    }
    const oldQuoteAssignment = '                ctx.state.downloadedQuoteFiles = downloadedQuote;';
    const generationQuoteDownloads = [
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
    ].join('\n');
    if (content.includes(oldQuoteAssignment)) content = replaceOne(content, oldQuoteAssignment, generationQuoteDownloads, file);
    else if (!content.includes('// Chat-only generation quote image downloads v1.')
        || !content.includes('ctx.state.downloadedGenerationQuoteFiles = rawGenerationQuote.length > 0')) {
        throw new Error('Chat-only patch: generation quote image download path is missing in ' + file);
    }
    return content;
});

await patch('middleware/attachment.js', '// Chat-only independent merged quote downloads v2.', (content, file) => {
    const start = content.indexOf('                // Chat-only generation quote image downloads v1.');
    const lastLine = '                    : [];';
    const end = content.indexOf(lastLine, start);
    if (start < 0 || end < start) throw new Error('Chat-only patch: missing legacy generation quote download block in ' + file);
    const block = content.slice(start, end + lastLine.length);
    const independent = block.split('\n').map((line) => line.slice(4)).join('\n');
    return replaceOne(content, block + '\n            }',
        '            }\n            // Chat-only independent merged quote downloads v2.\n' + independent, file);
});

await patch('middleware/attachment.js', '// Chat-only lazy quoted images v1.', (content, file) => {
    const start = content.indexOf('            // Chat-only quoted-image downloads v2.');
    const end = content.indexOf('\n        }\n        catch (err)', start);
    if (start < 0 || end < start) throw new Error('Chat-only patch: missing eager quote download block in ' + file);
    // Preserve older migration markers so repeated enforcement and upgrades
    // never reinstall either quote download path.
    const lazy = [
        '            // Chat-only quoted-image downloads v2.',
        '            // Chat-only generation quote image downloads v1.',
        '            // Chat-only independent merged quote downloads v2.',
        '            // Chat-only lazy quoted images v1.',
        '            // Quote metadata is enough for grants; fetch bytes only in the selected tool.',
        '            ctx.state.downloadedQuoteFiles = [];',
        '            ctx.state.downloadedGenerationQuoteFiles = [];',
    ].join('\n');
    return content.slice(0, start) + lazy + content.slice(end);
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

// Validate the final staged text on every run, including volumes where a
// marker already existed. This catches partial or manually altered patches
// before any file is written.
async function finalText(file) {
    const filename = join(root, file);
    return updates.get(filename) ?? await readFile(filename, 'utf8');
}
function assertOnce(source, marker, label) {
    if (source.split(marker).length !== 2) throw new Error(`Chat-only patch: ${label} is missing or duplicated`);
}

const finalInbound = await finalText('transport/inbound.js');
const contextDiagnosticsImport = `import { logContextInbound, logContextBinding } from '${contextDiagnosticsPolicy}';`;
assertOnce(finalInbound, contextDiagnosticsImport, 'context diagnostics import');
assertOnce(finalInbound, '// Chat-only context diagnostics v1.', 'context diagnostics marker');
assertOnce(finalInbound, 'logContextInbound(ctx, getMergedGenerationRequests(ctx), agentBody);', 'context diagnostics call');
assertOnce(finalInbound, '// Chat-only context binding diagnostics v1.', 'context binding diagnostics marker');
assertOnce(finalInbound, 'logContextBinding(chatOnlyAgent, requestBody, agentBody);', 'context binding diagnostics call');
if (finalInbound.indexOf('logContextInbound(ctx, getMergedGenerationRequests(ctx), agentBody);')
    < finalInbound.indexOf('const agentBody = assembleAgentBody(msg, mwState, scope, logger);')
    || finalInbound.indexOf('logContextInbound(ctx, getMergedGenerationRequests(ctx), agentBody);')
    > finalInbound.indexOf('if (!agentBody)')
    || finalInbound.indexOf('logContextBinding(chatOnlyAgent, requestBody, agentBody);')
    < finalInbound.indexOf('modelContextTurn = beginGroupModelContext(chatOnlyAgent, scope, documentTurn);')
    || finalInbound.indexOf('logContextBinding(chatOnlyAgent, requestBody, agentBody);')
    > finalInbound.indexOf('chatOnlyAgent.followup(message);')) {
    throw new Error('Chat-only patch: context diagnostics must bracket the assembled and bound model input');
}
const modelContextImport = `import { beginGroupModelContext, endGroupModelContext } from '${modelContextPolicy}';`;
assertOnce(finalInbound, modelContextImport, 'group model context import');
assertOnce(finalInbound, '// Chat-only group model context v1.', 'group model context marker');
assertOnce(finalInbound, 'let modelContextTurn;', 'group model context scope');
assertOnce(finalInbound, 'modelContextTurn = beginGroupModelContext(chatOnlyAgent, scope, documentTurn);', 'group model context binding');
assertOnce(finalInbound, 'endGroupModelContext(chatOnlyAgent, modelContextTurn);', 'group model context cleanup');
if (finalInbound.indexOf('modelContextTurn = beginGroupModelContext(chatOnlyAgent, scope, documentTurn);')
    > finalInbound.indexOf('chatOnlyAgent.followup(message);')
    || finalInbound.indexOf('endGroupModelContext(chatOnlyAgent, modelContextTurn);')
    < finalInbound.indexOf('await chatOnlyAgent.whenIdle();')) {
    throw new Error('Chat-only patch: group model context must bracket the model turn');
}
assertOnce(finalInbound, '// Chat-only lazy quoted image grants v1.', 'lazy quote grant marker');
assertOnce(finalInbound, '                media: config.media,', 'lazy quote media configuration');
const finalAttachments = await finalText('middleware/attachment.js');
assertOnce(finalAttachments, '// Chat-only lazy quoted images v1.', 'lazy quote middleware marker');
assertOnce(finalAttachments, 'ctx.state.downloadedQuoteFiles = [];', 'deferred quote files');
assertOnce(finalAttachments, 'ctx.state.downloadedGenerationQuoteFiles = [];', 'deferred merged quote files');
if (finalAttachments.includes('downloadMediaAttachments(rawQuote')
    || finalAttachments.includes('downloadMediaAttachments(rawGenerationQuote')) {
    throw new Error('Chat-only patch: quoted images still have an eager download path');
}
const mergeInboundImport = `import { beginMergeBatch, closeMergeBatch } from '${concurrencyPolicy}';`;
assertOnce(finalInbound, mergeInboundImport, 'inbound merge batch import');
assertOnce(finalInbound, '// Chat-only batch cancellation and reply binding v1.', 'inbound batch cancellation marker');
assertOnce(finalInbound, 'const replyBatch = beginMergeBatch(record, replyTarget);', 'inbound target snapshot');
assertOnce(finalInbound, "const isCurrentRecord = () => typeof manager.getSessionRecord === 'function' && manager.getSessionRecord(scope, peerId) === record;", 'fail-closed current record check');
assertOnce(finalInbound, "ctx.signal?.addEventListener('abort', cancelCapturedAgent, { once: true });", 'inbound agent cancellation binding');
assertOnce(finalInbound, 'await closeMergeBatch(replyBatch);', 'inbound send drain');
assertOnce(finalInbound, '// Chat-only safe batch finalization v1.', 'nested inbound batch cleanup');
assertOnce(finalInbound, 'if (ctx.signal?.aborted || !isCurrentRecord() || record.agent !== chatOnlyAgent) return;', 'inbound stale/aborted followup check');
const recoveryInboundImport = `import { finishContentRiskRecovery, getHistorySnapshot, isHistorySnapshotCurrent, registerRecoveryContext } from '${sessionRecoveryPolicy}';`;
const recoveryInboundMarker = '// Chat-only content-risk recovery context v1.';
const recoveryInboundRegistration = 'registerRecoveryContext(documentTurn, { manager, scope, peerId, appId: config.appId, record, agent: chatOnlyAgent, sessionId: record.sessionId, replyTarget, historySnapshot, logger });';
assertOnce(finalInbound, recoveryInboundImport, 'inbound recovery import');
assertOnce(finalInbound, recoveryInboundMarker, 'inbound recovery marker');
assertOnce(finalInbound, recoveryInboundRegistration, 'inbound recovery registration');
assertOnce(finalInbound, 'if (documentTurn) await finishContentRiskRecovery(documentTurn);', 'inbound recovery completion');
assertOnce(finalInbound, '// Chat-only group-history epoch guard v1.', 'group history epoch guard');
assertOnce(finalInbound, 'if (historySnapshot && !isHistorySnapshotCurrent(mwState.history)) mwState.history = [];', 'stale history snapshot filter');
assertOnce(finalInbound, 'await chatOnlyAgent.whenIdle();', 'inbound idle wait');
assertOnce(finalInbound, 'clearCurrentImages(chatOnlyAgent, documentTurn);', 'inbound image cleanup');
assertOnce(finalInbound, 'endDocumentTurn(chatOnlyAgent, documentTurn);', 'inbound document cleanup');
assertOnce(finalInbound, 'await finishContentRiskRecovery(documentTurn);', 'inbound recovery cleanup');
assertOnce(finalInbound, '// Chat-only safe inbound errors v1.', 'safe inbound errors marker');
assertOnce(finalInbound, "logger.warn('whenIdle/followup rejected');", 'safe inbound exception log');
if (finalInbound.includes('whenIdle/followup rejected: ${'))
    throw new Error('Chat-only patch: inbound exception log exposes raw errors');
const historyGuardPosition = finalInbound.indexOf('// Chat-only group-history epoch guard v1.');
const historyFilterPosition = finalInbound.indexOf('if (historySnapshot && !isHistorySnapshotCurrent(mwState.history)) mwState.history = [];');
const inboundIdlePosition = finalInbound.indexOf('await chatOnlyAgent.whenIdle();');
const inboundImageClearPosition = finalInbound.indexOf('clearCurrentImages(chatOnlyAgent, documentTurn);');
const inboundDocumentEndPosition = finalInbound.indexOf('endDocumentTurn(chatOnlyAgent, documentTurn);');
const inboundRecoveryFinishPosition = finalInbound.indexOf('await finishContentRiskRecovery(documentTurn);');
if (historyGuardPosition > finalInbound.indexOf('const agentBody = assembleAgentBody(')
    || historyFilterPosition <= historyGuardPosition
    || inboundImageClearPosition <= inboundIdlePosition
    || inboundDocumentEndPosition <= inboundImageClearPosition
    || inboundRecoveryFinishPosition <= inboundDocumentEndPosition
    || inboundRecoveryFinishPosition >= finalInbound.indexOf('await closeMergeBatch(replyBatch);')
    || finalInbound.indexOf('await endGenerationTurn(chatOnlyAgent, generationTurn);') <= inboundDocumentEndPosition
    || finalInbound.indexOf('await endGenerationTurn(chatOnlyAgent, generationTurn);') >= inboundRecoveryFinishPosition
    || finalInbound.indexOf(recoveryInboundRegistration) < finalInbound.indexOf('documentTurn = getDocumentTurn(chatOnlyAgent);')
    || finalInbound.indexOf(recoveryInboundRegistration) > finalInbound.indexOf('chatOnlyAgent.followup(message);')
    ) {
    throw new Error(`Chat-only patch: inbound recovery wiring is outside the safe turn lifecycle (history=${historyGuardPosition}/${historyFilterPosition}, idle=${inboundIdlePosition}, image=${inboundImageClearPosition}, end=${inboundDocumentEndPosition}, recovery=${inboundRecoveryFinishPosition}, close=${finalInbound.indexOf('await closeMergeBatch(replyBatch);')}, registration=${finalInbound.indexOf(recoveryInboundRegistration)}, binding=${finalInbound.indexOf('documentTurn = getDocumentTurn(chatOnlyAgent);')}, followup=${finalInbound.indexOf('chatOnlyAgent.followup(message);')})`);
}
const finalBootstrap = await finalText('gateway/bootstrap.js');
assertOnce(finalBootstrap, '// Chat-only merge batch reply adapter v1.', 'early merge sender adapter');
assertOnce(finalBootstrap, 'setupMiddlewares(bot, config, manager, logger, sender);', 'merge sender injection');
if (finalBootstrap.indexOf('// Chat-only merge batch reply adapter v1.') > finalBootstrap.indexOf('setupMiddlewares(bot, config, manager, logger, sender);')
    || finalBootstrap.includes('const replyLimiter = new ReplyLimiter({ limit: 4 });', finalBootstrap.indexOf('setupMiddlewares(bot, config, manager, logger, sender);'))) {
    throw new Error('Chat-only patch: merge overflow sender is not initialized before inbound middleware');
}

const finalOutbound = await finalText('transport/outbound.js');
const mergeOutboundImports = [
    `import { captureMergeBatchReply, noteMergeBatchTurnStart, trackMergeBatchSend } from '${concurrencyPolicy}';`,
    `import { captureMergeBatchReply, enqueueMergeBatchSend, noteMergeBatchTurnStart } from '${concurrencyPolicy}';`,
];
if (!mergeOutboundImports.some((value) => finalOutbound.split(value).length === 2))
    throw new Error('Chat-only patch: outbound merge target import is missing or duplicated');
assertOnce(finalOutbound, '// Chat-only batch-bound outbound routing v1.', 'outbound merge routing marker');
assertOnce(finalOutbound, 'captureMergeBatchReply(record, { sessionId, turnId: raw?.data?.turn, seq: raw?.seq })', 'outbound native event binding');
const outboundFlushTracking = [
    'trackMergeBatchSend(originRecord, buffer.flush());',
    'enqueueMergeBatchSend(originRecord, () => buffer.flush());',
];
if (!outboundFlushTracking.some((value) => finalOutbound.split(value).length === 3))
    throw new Error('Chat-only patch: both message and turn flushes must be tracked exactly once');
const outboundTextTracking = [
    "trackMergeBatchSend(originRecord, this.send(record, fullText, 'sendMarkdown'));",
    "enqueueMergeBatchSend(originRecord, () => this.send(record, fullText, 'sendMarkdown'));",
];
if (!outboundTextTracking.some((value) => finalOutbound.split(value).length === 2))
    throw new Error('Chat-only patch: outbound text send tracking is missing or duplicated');
const finalEvents = await finalText('transport/events.js');
assertOnce(finalEvents, '// Chat-only structured provider failures v1.', 'structured provider failure marker');
assertOnce(finalEvents, 'status: detail?.status ?? reason.status,', 'provider status extraction');
assertOnce(finalEvents, 'type: detail?.type ?? reason.type,', 'provider type extraction');
assertOnce(finalEvents, 'error: detail?.error,', 'provider structured error extraction');
const friendlyOutboundImport = `import { formatProviderFailure, formatToolFailure } from '${providerErrorsPolicy}';`;
assertOnce(finalOutbound, friendlyOutboundImport, 'friendly errors import');
assertOnce(finalOutbound, '// Chat-only friendly provider errors v1.', 'friendly errors marker');
assertOnce(finalOutbound, 'this.onToolResult(replyRecord, event, raw, record);', 'raw tool result binding');
assertOnce(finalOutbound, 'onToolResult(record, event, raw, originRecord = record) {', 'safe tool result handler');
const toolFailureTracking = [
    "trackMergeBatchSend(originRecord, this.send(record, formatToolFailure(), 'sendToolResultError'));",
    "enqueueMergeBatchSend(originRecord, () => this.send(record, formatToolFailure(), 'sendToolResultError'));",
];
if (!toolFailureTracking.some((value) => finalOutbound.split(value).length === 2))
    throw new Error('Chat-only patch: safe tool failure notice is missing or duplicated');
assertOnce(finalOutbound, '// Chat-only deferred tool failures v1.', 'deferred tool failures marker');
for (const [value, label] of [
    ['toolFailureTurns = new WeakMap();', 'per-record deferred failure state'],
    ['this.toolFailureTurns.delete(startRecord);', 'deferred failure turn start reset'],
    ['this.toolFailureTurns.set(originRecord, { toolFailed: true, hasAnswer: false, streamAfterFailure: false });', 'deferred failure capture'],
    ["if (event.content.some((block) => block?.type === 'tool-call')) turn.streamAfterFailure = false;", 'tool-call preamble guard'],
    ['this.toolFailureTurns.delete(originRecord);', 'deferred failure turn end cleanup'],
    ["event.reason.kind === 'completed' && turn?.toolFailed && !turn.hasAnswer && !completedStreamAnswer", 'completed unanswered failure condition'],
]) assertOnce(finalOutbound, value, label);
const deferredResultBranch = finalOutbound.slice(finalOutbound.indexOf('        if (failed) {'), finalOutbound.indexOf('        // Chat-only generation outbound v1.'));
if (deferredResultBranch.includes('formatToolFailure()') || deferredResultBranch.includes('sendToolResultError'))
    throw new Error('Chat-only patch: a tool failure still sends an immediate generic notice');
const turnFailureTracking = [
    "trackMergeBatchSend(originRecord, this.send(record, formatProviderFailure(failure), 'sendTurnEndError'));",
    "enqueueMergeBatchSend(originRecord, () => this.send(record, formatProviderFailure(failure), 'sendTurnEndError'));",
];
if (!turnFailureTracking.some((value) => finalOutbound.split(value).length === 2))
    throw new Error('Chat-only patch: safe turn failure notice is missing or duplicated');
assertOnce(finalOutbound, "block?.type === 'tool-result' && block.isError === true", 'block-only tool failure check');
assertOnce(finalOutbound, 'this.logger.error(`im-qqbot: ${tag} failed to send reply`);', 'safe QQ send error log');
if (finalOutbound.includes('${failure.code}') || finalOutbound.includes('${failure.message}')
    || finalOutbound.includes('event.error === undefined && !this.config.showToolResults')) {
    throw new Error('Chat-only patch: outbound errors still contain an unsafe raw error exit');
}
const recoveryOutboundImport = `import { isContentRiskFailure, markContentRiskFailure, noteRecoveryTurnStart } from '${sessionRecoveryPolicy}';`;
assertOnce(finalOutbound, recoveryOutboundImport, 'outbound recovery import');
assertOnce(finalOutbound, '// Chat-only content-risk turn recovery v1.', 'outbound recovery marker');
assertOnce(finalOutbound, 'onTurnEnd(sessionId, record, event, turnId, originRecord = record) {', 'outbound turn handler');
assertOnce(finalOutbound, 'if (isContentRiskFailure(failure)) {', 'outbound content risk branch');
assertOnce(finalOutbound, 'markContentRiskFailure({', 'outbound recovery registration');
assertOnce(finalOutbound, "if (raw?.type === 'turn/start') {", 'native turn start binding');
assertOnce(finalOutbound, 'this.onTurnEnd(sessionId, replyRecord, event, raw.data?.turn, record);', 'native turn end binding');
const contentRiskPosition = finalOutbound.indexOf('if (isContentRiskFailure(failure)) {');
const normalFailurePosition = finalOutbound.indexOf('else if (!SILENT_TURN_ERROR_CODES.has(failure.code)) {', contentRiskPosition);
const contentRiskBranch = finalOutbound.slice(contentRiskPosition, normalFailurePosition);
if (normalFailurePosition < 0 || contentRiskBranch.includes('sendTurnEndError') || !contentRiskBranch.includes('markContentRiskFailure({')) {
    throw new Error('Chat-only patch: recognized content-risk failures are not isolated from raw error replies');
}
const finalStreamWriter = await finalText('transport/streaming-writer.js');
const finalOutboundBuffer = await finalText('transport/outbound-buffer.js');
assertOnce(finalStreamWriter, '// Chat-only awaitable stream cancellation v1.', 'awaitable streaming cancellation');
assertOnce(finalOutboundBuffer, '// Chat-only awaitable stream cancellation v1.', 'awaitable outbound buffer cancellation');
if (!finalStreamWriter.includes('return this.chain;')
    || !finalOutboundBuffer.includes('const completion = Promise.resolve().then(async () => {')
    || !finalOutboundBuffer.includes('        });\n        this.flushPromise = completion;')
    || !finalOutboundBuffer.includes('if (this.flushPromise)')
    || !finalOutboundBuffer.includes('this.flushPromise = completion;')
    || !finalOutboundBuffer.includes('return Promise.all([this.flushPromise, completion].filter(Boolean));')) {
    throw new Error('Chat-only patch: streaming cancellation is not awaitable before merge lock handoff');
}

const finalPrefs = await finalText('model/prefs-store.js');
assertOnce(finalPrefs, '// Chat-only persistent model prefs v1.', 'persistent model prefs marker');
if (!finalPrefs.includes("this.prefsPath = '/data/qqbot-model-prefs.json';")
    || !finalPrefs.includes("const legacyPath = resolve(homedir(), '.dsh-qqbot', 'model-prefs.json');")
    || !finalPrefs.includes('options?.strict && !written')
    || !finalPrefs.includes("throw new Error('Unable to persist automatic session reset.');")
    || !finalPrefs.includes('renameSync(tempPath, this.prefsPath);')
    || !finalPrefs.includes('if (hadPrevious) this.sessionIds.set(sessionKey, previous);')) {
    throw new Error('Chat-only patch: persistent model prefs migration/strict write is incomplete');
}
const finalResolver = await finalText('model/model-resolver.js');
assertOnce(finalResolver, '// Chat-only strict sessionId persistence v1.', 'strict model resolver marker');
if (!finalResolver.includes('return this.prefs.setSessionId(sessionKey, sessionId, options);'))
    throw new Error('Chat-only patch: ModelResolver does not forward strict persistence options');

const finalManager = await finalText('session/session-manager.js');
assertOnce(finalManager, '// Chat-only strict automatic session reset v1.', 'strict session manager marker');
const strictRemoveStart = finalManager.indexOf('async remove(scope, peerId, recoveryOptions) {');
const strictBranchStart = finalManager.indexOf('if (recoveryOptions?.requirePersisted === true) {', strictRemoveStart);
const durableResetPosition = finalManager.indexOf('this.modelResolver.setSessionId(key, randomUUID(), { strict: true });', strictBranchStart);
const expectedRecordPosition = finalManager.indexOf('record !== recoveryOptions.expectedRecord', strictBranchStart);
const expectedAgentPosition = finalManager.indexOf('record.agent !== recoveryOptions.expectedAgent', strictBranchStart);
const expectedSessionPosition = finalManager.indexOf('record.sessionId !== recoveryOptions.expectedSessionId', strictBranchStart);
const strictDeletePosition = finalManager.indexOf('this.sessions.delete(key);', durableResetPosition);
const committedCallbackPosition = finalManager.indexOf('recoveryOptions.onCommitted?.(record)', durableResetPosition);
const cancelPosition = finalManager.indexOf("record.agent.cancel({ kind: 'user' })", durableResetPosition);
const disposePosition = finalManager.indexOf('await record.handle.dispose()', durableResetPosition);
const strictSynchronousCommit = finalManager.slice(strictBranchStart, disposePosition);
assertOnce(finalManager, 'async remove(scope, peerId, recoveryOptions) {', 'strict SessionManager.remove signature');
assertOnce(finalManager, 'record !== recoveryOptions.expectedRecord', 'strict expected record guard');
assertOnce(finalManager, 'record.agent !== recoveryOptions.expectedAgent', 'strict expected agent guard');
assertOnce(finalManager, 'record.sessionId !== recoveryOptions.expectedSessionId', 'strict expected session guard');
assertOnce(finalManager, "try { await record.handle.dispose(); } catch { this.logger.warn('automatic session reset disposal failed'); }", 'safe committed session disposal');
assertOnce(finalManager, '// Chat-only committed reset disposal v1.', 'safe committed disposal marker');
if (durableResetPosition < 0
    || strictBranchStart < strictRemoveStart
    || expectedRecordPosition < strictBranchStart || expectedRecordPosition > durableResetPosition
    || expectedAgentPosition < strictBranchStart || expectedAgentPosition > durableResetPosition
    || expectedSessionPosition < strictBranchStart || expectedSessionPosition > durableResetPosition
    || strictDeletePosition <= durableResetPosition
    || committedCallbackPosition <= durableResetPosition
    || committedCallbackPosition <= strictDeletePosition
    || cancelPosition <= committedCallbackPosition
    || disposePosition <= cancelPosition
    || strictSynchronousCommit.includes('await')
    || !finalManager.includes('return false;')) {
    throw new Error('Chat-only patch: strict session reset atomic commit ordering is incomplete');
}

for (const [file, content] of updates) await writeFile(file, content);
