import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('usage: enforce-chat-only.mjs <dsh-qqbot-dist-directory>');
const manifest = JSON.parse(await readFile(join(root, '..', 'package.json'), 'utf8'));
if (manifest.version !== '0.5.0') throw new Error('Chat-only patches require dsh-qqbot 0.5.0; refusing an unverified adapter.');
const policy = '/opt/qqbot-defaults/qqbot-chat-policy.mjs';
const historySnapshotPolicy = '/opt/qqbot-defaults/qqbot-history-snapshot.mjs';
const pendingImagesPolicy = '/opt/qqbot-defaults/qqbot-pending-images.mjs';
const webPagesPolicy = '/opt/qqbot-defaults/qqbot-web-pages.mjs';
const documentScopePolicy = '/opt/qqbot-defaults/qqbot-document-scope.mjs';
const sessionRecoveryPolicy = '/opt/qqbot-defaults/qqbot-session-recovery.mjs';
const providerErrorsPolicy = '/opt/qqbot-defaults/qqbot-provider-errors.mjs';
const concurrencyPolicy = '/opt/qqbot-defaults/qqbot-concurrency.mjs';
const generationPolicy = '/opt/qqbot-defaults/qqbot-generation.mjs';
const generationScopePolicy = '/opt/qqbot-defaults/qqbot-generation-scope.mjs';
const memoryImagesPolicy = '/opt/qqbot-defaults/qqbot-memory-images.mjs';
const onebotPolicy = '/opt/qqbot-defaults/qqbot-onebot.mjs';
const onebotScopePolicy = '/opt/qqbot-defaults/qqbot-onebot-scope.mjs';
const onebotDirectPolicy = '/opt/qqbot-defaults/qqbot-onebot-direct.mjs';
const onebotLogPolicy = '/opt/qqbot-defaults/qqbot-onebot-log.mjs';
const mentionTextPolicy = '/opt/qqbot-defaults/qqbot-mention-text.mjs';
const imageToolPolicyImport = `import { loadChatImageBytes } from '${policy}';`;
const imageLoaderV3Marker = '// Chat-only scoped image loader v3.';
const imageSchemaV3Marker = '// Chat-only image schema: scoped QQ media paths or public HTTPS image URLs v3.';
const imageSchemaV4Marker = '// Chat-only image schema: current, quoted, public HTTPS, or recent QQ image references v4.';
const memoryVisionImageMarker = '// Chat-only recent image bytes stay in memory v1.';

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
        '    generationSender = createGenerationSender({',
        '        bot,',
        '        replyLimiter,',
        '        sdk: { MediaApi, MessageApi },',
        '        credentials: { appId: config.appId, clientSecret: config.appSecret },',
        '        sendResolvedMarkdown,',
        '        logger,',
        '        onDelivery: (event) => onebotService?.observeGenerationDelivery(event),',
        '    });',
        '    registerGenerationTools(ctx, {',
        '        sender: generationSender,',
        '        appId: config.appId,',
        '        logger,',
        '    });',
    ].join('\n');
    if (content.includes(oldRegistration)) content = replaceOne(content, oldRegistration, registration, file);
    else if (!content.includes('// Chat-only generation tools v1.'))
        throw new Error('Chat-only patch: expected dedicated generation registration point in ' + file);
    return content;
});

await patch('gateway/bootstrap.js', '// Chat-only native OneBot command v1.', (content, file) => {
    const onebotImport = `import { registerOnebotCommandTool } from '${onebotPolicy}';`;
    const availabilityImport = `import { setOnebotToolAvailable } from '${policy}';`;
    const protocolImport = "import { MediaApi, MessageApi } from '@tencent-connect/qqbot-nodejs/protocol';";
    if (!content.includes(onebotImport)) content = `${onebotImport}\n${content}`;
    if (!content.includes(availabilityImport)) content = `${availabilityImport}\n${content}`;
    content = replaceOne(content, protocolImport,
        "import { MediaApi, MessageApi, messagePath } from '@tencent-connect/qqbot-nodejs/protocol';", file);
    const registration = [
        '    // Chat-only native OneBot command v1.',
        '    onebotService = registerOnebotCommandTool(ctx, {',
        '        appId: config.appId,',
        '        bot,',
        '        messagePath,',
        '        sendArtifactFile: (...args) => generationSender?.sendArtifactFile?.(...args),',
        '        logger,',
        '        onAvailability: setOnebotToolAvailable,',
        '    });',
    ].join('\n');
    content = replaceOne(content, '    // ── 生命周期 ──', `${registration}\n    // ── 生命周期 ──`, file);
    return replaceOne(content, "            logger.info('Shutting down');",
        "            logger.info('Shutting down');\n            await onebotService.stop();", file);
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

await patch('gateway/bootstrap.js', '// Chat-only QQ delivery logging v1.', (content, file) => {
    content = `import { attachOnebotDeliveryObserver } from '${onebotLogPolicy}';\n${content}`;
    if (content.includes('sender: createGenerationSender({')) {
        content = replaceOne(content, [
            '    registerGenerationTools(ctx, {',
            '        sender: createGenerationSender({',
            '            bot,',
            '            replyLimiter,',
            '            sdk: { MediaApi, MessageApi },',
            '            credentials: { appId: config.appId, clientSecret: config.appSecret },',
            '            sendResolvedMarkdown,',
            '            logger,',
            '        }),',
        ].join('\n'), [
            '    generationSender = createGenerationSender({',
            '        bot,',
            '        replyLimiter,',
            '        sdk: { MediaApi, MessageApi },',
            '        credentials: { appId: config.appId, clientSecret: config.appSecret },',
            '        sendResolvedMarkdown,',
            '        logger,',
            '        onDelivery: (event) => onebotService?.observeGenerationDelivery(event),',
            '    });',
            '    registerGenerationTools(ctx, {',
            '        sender: generationSender,',
        ].join('\n'), file);
    }
    content = replaceOne(content, '    const replyLimiter = new ReplyLimiter({ limit: 4 });',
        '    let onebotService;\n    let generationSender;\n    let detachOnebotDeliveryObserver;\n    const replyLimiter = new ReplyLimiter({ limit: 4 });', file);
    content = replaceOne(content, '    const sender = {',
        '    // Chat-only QQ delivery logging v1.\n    const sender = {', file);
    return content;
});

await patch('gateway/bootstrap.js', '// Chat-only native OneBot direct router v1.', (content, file) => {
    const directImport = `import { createOnebotDirectRouter } from '${onebotDirectPolicy}';`;
    if (content.includes(directImport) || content.includes('directRouter'))
        throw new Error(`Chat-only patch: partial native OneBot direct router in ${file}`);
    content = `${directImport}\n${content}`;
    const oldRegistration = [
        '    // Chat-only native OneBot command v1.',
        '    onebotService = registerOnebotCommandTool(ctx, {',
        '        appId: config.appId,',
        '        bot,',
        '        messagePath,',
        '        sendArtifactFile: (...args) => generationSender?.sendArtifactFile?.(...args),',
        '        logger,',
        '        onAvailability: setOnebotToolAvailable,',
        '    });',
        '    // ── 生命周期 ──',
    ].join('\n');
    const legacyRegistration = oldRegistration
        .replace('    onebotService = registerOnebotCommandTool(ctx, {',
            '    const onebotService = registerOnebotCommandTool(ctx, {')
        .replace('        sendArtifactFile: (...args) => generationSender?.sendArtifactFile?.(...args),\n', '');
    const matchedRegistration = content.includes(oldRegistration) ? oldRegistration
        : content.includes(legacyRegistration) ? legacyRegistration : undefined;
    if (!matchedRegistration)
        throw new Error(`Chat-only patch: expected canonical native OneBot registration before lifecycle in ${file}`);
    content = replaceOne(content, matchedRegistration, '    // ── 生命周期 ──', file);
    const directRegistration = [
        '    // Chat-only native OneBot command v1.',
        '    onebotService = registerOnebotCommandTool(ctx, {',
        '        appId: config.appId,',
        '        bot,',
        '        messagePath,',
        '        sendArtifactFile: (...args) => generationSender?.sendArtifactFile?.(...args),',
        '        logger,',
        '        onAvailability: setOnebotToolAvailable,',
        '    });',
        '    detachOnebotDeliveryObserver = attachOnebotDeliveryObserver(bot, onebotService);',
        '    // Chat-only native OneBot direct router v1.',
        '    const directRouter = createOnebotDirectRouter({',
        '        service: onebotService,',
        '        appId: config.appId,',
        '        sender,',
        '        env: process.env,',
        '        logger,',
        '    });',
        '    setupMiddlewares(bot, config, manager, logger, sender, directRouter, onebotService);',
    ].join('\n');
    content = replaceOne(content,
        '    setupMiddlewares(bot, config, manager, logger, sender);',
        directRegistration, file);
    return replaceOne(content,
        '            await onebotService.stop();',
        '            await directRouter.stop();\n            detachOnebotDeliveryObserver();\n            await onebotService.stop();', file);
});

// The direct-router v1 marker also exists in v0.11.2 persisted profiles. Its
// original transform must remain idempotent, so delivery integration has its
// own migration marker and recognizes only the complete released layout.
await patch('gateway/bootstrap.js', '// Chat-only native OneBot delivery integration v1.', (content, file) => {
    const directMarker = '    // Chat-only native OneBot direct router v1.';
    const legacyRegistration = [
        '    // Chat-only native OneBot command v1.',
        '    const onebotService = registerOnebotCommandTool(ctx, {',
        '        appId: config.appId,',
        '        bot,',
        '        messagePath,',
        '        logger,',
        '        onAvailability: setOnebotToolAvailable,',
        '    });',
        directMarker,
    ].join('\n');
    const currentRegistration = [
        '    // Chat-only native OneBot command v1.',
        '    onebotService = registerOnebotCommandTool(ctx, {',
        '        appId: config.appId,',
        '        bot,',
        '        messagePath,',
        '        sendArtifactFile: (...args) => generationSender?.sendArtifactFile?.(...args),',
        '        logger,',
        '        onAvailability: setOnebotToolAvailable,',
        '    });',
        '    detachOnebotDeliveryObserver = attachOnebotDeliveryObserver(bot, onebotService);',
        directMarker,
    ].join('\n');
    const legacySetup = '    setupMiddlewares(bot, config, manager, logger, sender, directRouter);';
    const currentSetup = '    setupMiddlewares(bot, config, manager, logger, sender, directRouter, onebotService);';
    const legacyShutdown = '            await directRouter.stop();\n            await onebotService.stop();';
    const currentShutdown = '            await directRouter.stop();\n            detachOnebotDeliveryObserver();\n            await onebotService.stop();';
    if (content.includes(legacyRegistration)) {
        content = replaceOne(content, legacyRegistration, currentRegistration, file);
        content = replaceOne(content, legacySetup, currentSetup, file);
        content = replaceOne(content, legacyShutdown, currentShutdown, file);
    }
    else if (content.split(currentRegistration).length !== 2
        || content.split(currentSetup).length !== 2
        || content.split(currentShutdown).length !== 2) {
        throw new Error(`Chat-only patch: native OneBot delivery integration layout is incomplete in ${file}`);
    }
    return replaceOne(content, directMarker,
        `    // Chat-only native OneBot delivery integration v1.\n${directMarker}`, file);
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

await patch('gateway/middleware-setup.js', '// Chat-only OneBot direct router middleware v1.', (content, file) => {
    const originalSignature = 'export function setupMiddlewares(bot, config, manager, logger, sender) {';
    const patchedSignature = 'export function setupMiddlewares(bot, config, manager, logger, sender, directRouter) {';
    if (!content.includes(patchedSignature)) content = replaceOne(content, originalSignature, patchedSignature, file);
    const cancelBlock = [
        '    // Chat-only OneBot /new cancellation v1.',
        '    bot.use(async (ctx, next) => {',
        "        if (ctx.message.content?.trim() === '/new') await directRouter?.cancelConversation(ctx);",
        '        await next();',
        '    });',
    ].join('\n');
    const cancellationAnchor = '    bot.use(rateLimiter());';
    if (!content.includes('// Chat-only OneBot /new cancellation v1.')) {
        content = replaceOne(content, cancellationAnchor, `${cancellationAnchor}\n${cancelBlock}`, file);
    }
    else if (!content.includes("if (ctx.message.content?.trim() === '/new') await directRouter?.cancelConversation(ctx);")) {
        throw new Error(`Chat-only patch: native OneBot /new cancellation is partial in ${file}`);
    }
    const routerBlock = [
        '    // Chat-only OneBot direct router middleware v1.',
        '    if (directRouter) bot.use(directRouter.middleware);',
    ].join('\n');
    const slashAnchor = '    bot.use(slash.middleware);';
    if (!content.includes('// Chat-only OneBot direct router middleware v1.')) {
        content = replaceOne(content, slashAnchor, `${slashAnchor}\n${routerBlock}`, file);
    }
    else if (!content.includes('if (directRouter) bot.use(directRouter.middleware);')) {
        throw new Error(`Chat-only patch: native OneBot direct router middleware is partial in ${file}`);
    }
    return content;
});

await patch('gateway/middleware-setup.js', '// Chat-only OneBot log capture after access policy v1.', (content, file) => {
    const importLine = `import { createOnebotLogCaptureMiddleware } from '${onebotLogPolicy}';`;
    if (!content.includes(importLine)) content = `${importLine}\n${content}`;
    content = replaceOne(content,
        'export function setupMiddlewares(bot, config, manager, logger, sender, directRouter) {',
        'export function setupMiddlewares(bot, config, manager, logger, sender, directRouter, onebotService) {', file);
    const anchor = '    // 4. 群历史缓冲';
    const captureBlock = [
        '    // Chat-only OneBot log capture after access policy v1.',
        '    bot.use(createOnebotLogCaptureMiddleware(onebotService));',
    ].join('\n');
    return replaceOne(content, anchor, `${captureBlock}\n${anchor}`, file);
});

await patch('middleware/question-answer.js', '// Chat-only OneBot fallback question bypass v1.', (content, file) => {
    const fallbackImport = `import { getOnebotDirectFallback } from '${onebotScopePolicy}';`;
    if (!content.includes(fallbackImport)) content = `${fallbackImport}\n${content}`;
    return replaceOne(content, '    return async (ctx, next) => {',
        '    return async (ctx, next) => {\n        // Chat-only OneBot fallback question bypass v1.\n        if (getOnebotDirectFallback(ctx)) return await next();', file);
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

await patch('gateway/middleware-setup.js', '// Chat-only history snapshot epoch guard v1.', (content, file) => {
    const newImport = `import { createHistorySnapshotBuffer } from '${historySnapshotPolicy}';`;
    const oldImport = `import { createGroupHistoryBuffer } from '/opt/qqbot-defaults/qqbot-group-history.mjs';`;
    const earlierImport = `import { createGroupHistoryBuffer } from '${historySnapshotPolicy}';`;
    const legacyImport = `import { createDiceCommandMiddleware, createDiceAwareHistoryBuffer } from '${policy}';`;
    const legacyCommandBlock = [
        '    // Chat-only dice command middleware v1.',
        '    bot.use(createDiceCommandMiddleware());',
        '',
    ].join('\n');
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
        '    bot.use(createHistorySnapshotBuffer(historyBuffer, {',
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
    // A persistent /data volume may still carry the removed dice middleware and
    // its named imports. Rewrite those before the gateway can import them.
    if (content.includes(legacyCommandBlock)) content = replaceOne(content, legacyCommandBlock, '', file);
    if (content.includes(legacyImport)) content = replaceOne(content, legacyImport, newImport, file);
    else if (content.includes(oldImport)) {
        content = replaceOne(content, oldImport, newImport, file);
        content = content.replaceAll('createGroupHistoryBuffer(historyBuffer, {', 'createHistorySnapshotBuffer(historyBuffer, {');
    }
    else if (content.includes(earlierImport)) {
        content = replaceOne(content, earlierImport, newImport, file);
        content = content.replaceAll('createGroupHistoryBuffer(historyBuffer, {', 'createHistorySnapshotBuffer(historyBuffer, {');
    }
    else if (!content.includes(newImport)) content = `${newImport}\n${content}`;
    if (content.includes(originalHistory)) content = replaceOne(content, originalHistory, wrappedHistory, file);
    else if (content.includes('bot.use(createDiceAwareHistoryBuffer(historyBuffer, {')) {
        content = replaceOne(content, 'bot.use(createDiceAwareHistoryBuffer(historyBuffer, {',
            'bot.use(createHistorySnapshotBuffer(historyBuffer, {', file);
        if (content.includes('    }, contentSanitizer));')) {
            content = replaceOne(content, '    }, contentSanitizer));', '    }));', file);
        }
    }
    else if (!content.includes(wrappedHistory)) {
        throw new Error(`Chat-only patch: expected the pinned group history middleware in ${file}`);
    }
    if (content.includes('// Chat-only group history buffer v1.')) {
        content = replaceOne(content, '// Chat-only group history buffer v1.', '// Chat-only history snapshot epoch guard v1.', file);
        content = content.replaceAll('createGroupHistoryBuffer(historyBuffer, {', 'createHistorySnapshotBuffer(historyBuffer, {');
    }
    if (!content.includes('// Chat-only history snapshot epoch guard v1.')) {
        content = replaceOne(content, '    bot.use(createHistorySnapshotBuffer(historyBuffer, {',
            '    // Chat-only history snapshot epoch guard v1.\n    bot.use(createHistorySnapshotBuffer(historyBuffer, {', file);
    }
    return content;
});

await patch('gateway/middleware-setup.js', '// Chat-only deferred image prompts v1.', (content, file) => {
    const importLine = `import { createPendingImageCaptureMiddleware, createPendingImagePromptMiddleware, createPendingImageNewCommandCleanup } from '${pendingImagesPolicy}';`;
    if (!content.includes(importLine)) content = `${importLine}\n${content}`;

    const captureMarker = '    // Chat-only deferred image prompts v1.';
    const captureCall = '    bot.use(createPendingImageCaptureMiddleware({ appId: config.appId }));';
    if (!content.includes(captureMarker)) {
        const quoteCall = '    bot.use(createScopedQuoteRef(quoteRef));';
        if (!content.includes(quoteCall)) throw new Error(`Chat-only patch: missing scoped quote insertion point in ${file}`);
        content = replaceOne(content, quoteCall, `${quoteCall}\n${captureMarker}\n${captureCall}`, file);
    }
    else if (!content.includes(captureCall)) throw new Error(`Chat-only patch: deferred image capture is partial in ${file}`);

    const mentionBlock = [
        '    bot.use(mentionGate({',
        '        requireMentionInGroup: config.requireMention,',
        '    }));',
    ].join('\n');
    const cleanupMarker = '    // Chat-only pending image /new cleanup v1.';
    const cleanupCall = '    bot.use(createPendingImageNewCommandCleanup({ appId: config.appId }));';
    if (!content.includes(cleanupMarker)) {
        if (!content.includes(mentionBlock)) throw new Error(`Chat-only patch: missing mention gate insertion point in ${file}`);
        content = replaceOne(content, mentionBlock, `${mentionBlock}\n${cleanupMarker}\n${cleanupCall}`, file);
    }
    else if (!content.includes(cleanupCall)) throw new Error(`Chat-only patch: pending image cleanup is partial in ${file}`);

    const answerCall = '    bot.use(questionAnswer(manager));';
    const mergeMarker = '    // Chat-only serialized merge guard v1.';
    const promptMarker = '    // Chat-only deferred image prompt association v1.';
    const promptCall = '    bot.use(createPendingImagePromptMiddleware({ appId: config.appId }));';
    if (!content.includes(promptMarker)) {
        const answerPosition = content.indexOf(answerCall);
        const mergePosition = content.indexOf(mergeMarker);
        if (answerPosition < 0 || mergePosition <= answerPosition) {
            throw new Error(`Chat-only patch: deferred image prompt must follow question answering and precede the merge guard in ${file}`);
        }
        content = content.slice(0, mergePosition) + `${promptMarker}\n${promptCall}\n` + content.slice(mergePosition);
    }
    else if (!content.includes(promptCall)) throw new Error(`Chat-only patch: prompt association middleware is partial in ${file}`);
    return content;
});

await patch('gateway/middleware-setup.js', '// Chat-only current-event self mention text normalization v1.', (content, file) => {
    const importLine = `import { normalizeOwnMentionText } from '${mentionTextPolicy}';`;
    if (content.includes(importLine)) throw new Error(`Chat-only patch: self mention normalization import exists without its marker in ${file}`);
    const sanitizer = [
        '    bot.use(contentSanitizer({',
        '        parseFaceTags: true,',
        '    }));',
    ].join('\n');
    const normalizedSanitizer = [
        '    // Chat-only current-event self mention text normalization v1.',
        '    bot.use(contentSanitizer({',
        '        stripBotMention: false,',
        '        parseFaceTags: true,',
        '        transform: (content, ctx) => normalizeOwnMentionText(content, ctx.message, config.appId).trim(),',
        '    }));',
    ].join('\n');
    content = `${importLine}\n${content}`;
    return replaceOne(content, sanitizer, normalizedSanitizer, file);
});

const middlewareSetupPath = join(root, 'gateway/middleware-setup.js');
let patchedMiddlewareSetup = updates.get(middlewareSetupPath) ?? await readFile(middlewareSetupPath, 'utf8');
const historySnapshotMarker = '// Chat-only history snapshot epoch guard v1.';
const historySnapshotImport = `import { createHistorySnapshotBuffer } from '${historySnapshotPolicy}';`;
const legacyDiceImport = `import { createDiceCommandMiddleware, createDiceAwareHistoryBuffer } from '${policy}';`;
const canonicalHistorySnapshot = [
    '    // Chat-only history snapshot epoch guard v1.',
    '    bot.use(createHistorySnapshotBuffer(historyBuffer, {',
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
const deferredCaptureBlock = [
    '    // Chat-only deferred image prompts v1.',
    '    bot.use(createPendingImageCaptureMiddleware({ appId: config.appId }));',
].join('\n');
const historySnapshotPosition = patchedMiddlewareSetup.indexOf(canonicalHistorySnapshot);
const deferredCapturePosition = patchedMiddlewareSetup.indexOf(deferredCaptureBlock);
if (historySnapshotPosition < 0 || deferredCapturePosition < 0) {
    throw new Error('Chat-only patch: history snapshot or deferred image capture middleware is missing');
}
if (historySnapshotPosition < deferredCapturePosition) {
    patchedMiddlewareSetup = replaceOne(patchedMiddlewareSetup, canonicalHistorySnapshot, '', 'gateway/middleware-setup.js');
    const captureEnd = patchedMiddlewareSetup.indexOf(deferredCaptureBlock) + deferredCaptureBlock.length;
    patchedMiddlewareSetup = patchedMiddlewareSetup.slice(0, captureEnd) + '\n' + canonicalHistorySnapshot
        + patchedMiddlewareSetup.slice(captureEnd);
    updates.set(middlewareSetupPath, patchedMiddlewareSetup);
}
const rateLimitPosition = patchedMiddlewareSetup.indexOf('    bot.use(rateLimiter());');
const slashPosition = patchedMiddlewareSetup.indexOf('    const slash = slashCommand({');
const accessPosition = patchedMiddlewareSetup.indexOf('    bot.use(accessPolicy({');
const mentionPosition = patchedMiddlewareSetup.indexOf('    bot.use(mentionGate({');
const logCapturePosition = patchedMiddlewareSetup.indexOf('// Chat-only OneBot log capture after access policy v1.');
const logCaptureCall = 'bot.use(createOnebotLogCaptureMiddleware(onebotService));';
const sanitizerPosition = patchedMiddlewareSetup.indexOf('    bot.use(contentSanitizer({');
const ownMentionMarker = '// Chat-only current-event self mention text normalization v1.';
const ownMentionImport = `import { normalizeOwnMentionText } from '${mentionTextPolicy}';`;
const ownMentionTransform = 'transform: (content, ctx) => normalizeOwnMentionText(content, ctx.message, config.appId).trim(),';
const ownMentionStripSetting = 'stripBotMention: false,';
const canonicalSelfMentionSanitizer = [
    `    ${ownMentionMarker}`,
    '    bot.use(contentSanitizer({',
    '        stripBotMention: false,',
    '        parseFaceTags: true,',
    `        ${ownMentionTransform}`,
    '    }));',
].join('\n');
const ownMentionPosition = patchedMiddlewareSetup.indexOf(ownMentionMarker);
const ownMentionTransformPosition = patchedMiddlewareSetup.indexOf(ownMentionTransform);
const attachmentPosition = patchedMiddlewareSetup.indexOf('    bot.use(attachmentProcessor(config, logger));');
const capturePosition = patchedMiddlewareSetup.indexOf('bot.use(createPendingImageCaptureMiddleware({ appId: config.appId }));');
const promptCleanupPosition = patchedMiddlewareSetup.indexOf('bot.use(createPendingImageNewCommandCleanup({ appId: config.appId }));');
const promptAssociationPosition = patchedMiddlewareSetup.indexOf('bot.use(createPendingImagePromptMiddleware({ appId: config.appId }));');
const scopedQuotePosition = patchedMiddlewareSetup.indexOf('bot.use(createScopedQuoteRef(quoteRef));');
const slashMiddlewarePosition = patchedMiddlewareSetup.indexOf('bot.use(slash.middleware);');
const onebotCancelMarker = '// Chat-only OneBot /new cancellation v1.';
const onebotCancelPosition = patchedMiddlewareSetup.indexOf(onebotCancelMarker);
const onebotCancelCall = "if (ctx.message.content?.trim() === '/new') await directRouter?.cancelConversation(ctx);";
const onebotDirectMarker = '// Chat-only OneBot direct router middleware v1.';
const onebotDirectPosition = patchedMiddlewareSetup.indexOf(onebotDirectMarker);
const onebotDirectCall = 'if (directRouter) bot.use(directRouter.middleware);';
if (patchedMiddlewareSetup.split(historySnapshotMarker).length !== 2
    || patchedMiddlewareSetup.split(historySnapshotImport).length !== 2
    || patchedMiddlewareSetup.split(canonicalHistorySnapshot).length !== 2
    || patchedMiddlewareSetup.includes(legacyDiceImport)
    || patchedMiddlewareSetup.includes('createDiceCommandMiddleware')
    || patchedMiddlewareSetup.includes('createDiceAwareHistoryBuffer')
    || patchedMiddlewareSetup.includes('createGroupHistoryBuffer')
    || !patchedMiddlewareSetup.includes('bot.use(createHistorySnapshotBuffer(historyBuffer, {')
    || patchedMiddlewareSetup.split(ownMentionMarker).length !== 2
    || patchedMiddlewareSetup.split(ownMentionImport).length !== 2
    || patchedMiddlewareSetup.split(ownMentionTransform).length !== 2
    || patchedMiddlewareSetup.split(ownMentionStripSetting).length !== 2
    || patchedMiddlewareSetup.split(canonicalSelfMentionSanitizer).length !== 2
    || ownMentionPosition <= mentionPosition || ownMentionPosition >= sanitizerPosition
    || ownMentionTransformPosition <= sanitizerPosition || ownMentionTransformPosition >= rateLimitPosition
    || accessPosition < 0 || mentionPosition <= accessPosition || sanitizerPosition <= mentionPosition
    || rateLimitPosition <= sanitizerPosition
    || slashPosition <= rateLimitPosition || attachmentPosition <= slashPosition) {
    throw new Error('Chat-only patch: native history snapshot wrapper is incomplete or outside the guarded chain');
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
const historySnapshotCallPosition = patchedMiddlewareSetup.indexOf('bot.use(createHistorySnapshotBuffer(historyBuffer, {');
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
    || slashPosition <= rateLimitPosition
    || generationQuotePosition <= accessPosition || scopedQuoteCallPosition <= generationQuotePosition
    || mentionPosition <= scopedQuoteCallPosition || answerPosition <= slashPosition || mergeGuardPosition <= answerPosition
    || capturePosition <= scopedQuotePosition || capturePosition >= mentionPosition
    || capturePosition >= historySnapshotCallPosition || historySnapshotCallPosition >= mentionPosition
    || promptCleanupPosition <= mentionPosition || promptCleanupPosition >= slashMiddlewarePosition
    || promptAssociationPosition <= answerPosition || promptAssociationPosition >= mergeGuardPosition
    || patchedMiddlewareSetup.split(onebotCancelMarker).length !== 2
    || patchedMiddlewareSetup.split(onebotCancelCall).length !== 2
    || patchedMiddlewareSetup.split(onebotDirectMarker).length !== 2
    || patchedMiddlewareSetup.split(onebotDirectCall).length !== 2
    || patchedMiddlewareSetup.split(`import { createOnebotLogCaptureMiddleware } from '${onebotLogPolicy}';`).length !== 2
    || patchedMiddlewareSetup.split('// Chat-only OneBot log capture after access policy v1.').length !== 2
    || patchedMiddlewareSetup.split(logCaptureCall).length !== 2
    || !patchedMiddlewareSetup.includes('export function setupMiddlewares(bot, config, manager, logger, sender, directRouter, onebotService) {')
    || onebotCancelPosition <= rateLimitPosition || onebotCancelPosition >= slashPosition
    || logCapturePosition <= accessPosition || logCapturePosition >= mentionPosition
    || onebotDirectPosition <= slashMiddlewarePosition || onebotDirectPosition >= answerPosition
    || onebotDirectPosition >= mergeGuardPosition || onebotDirectPosition >= attachmentPosition
    || thinkingNoticePosition <= mergeGuardPosition || onStartPosition <= thinkingNoticePosition
    || thinkingSendPosition <= onStartPosition || onDropPosition <= thinkingSendPosition
    || attachmentPosition <= mergeGuardEndPosition || typingPosition <= mergeGuardEndPosition
    || !patchedMiddlewareSetup.includes('setupMiddlewares(bot, config, manager, logger, sender, directRouter, onebotService)')) {
    throw new Error('Chat-only patch: serialized merge middleware, overflow notice, or ordering is incomplete');
}
if (patchedMiddlewareSetup.split(`import { createPendingImageCaptureMiddleware, createPendingImagePromptMiddleware, createPendingImageNewCommandCleanup } from '${pendingImagesPolicy}';`).length !== 2
    || patchedMiddlewareSetup.split('// Chat-only deferred image prompts v1.').length !== 2
    || patchedMiddlewareSetup.split('// Chat-only pending image /new cleanup v1.').length !== 2
    || patchedMiddlewareSetup.split('// Chat-only deferred image prompt association v1.').length !== 2
    || patchedMiddlewareSetup.split('// Chat-only generation quote capture v1.').length !== 2
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

await patch('transport/inbound.js', '// Chat-only history snapshot epoch guard v1.', (content, file) => {
    const marker = '// Chat-only history snapshot epoch guard v1.';
    const original = '    const agentBody = assembleAgentBody(msg, mwState, scope, logger);';
    const guarded = [
        `    ${marker}`,
        '    const historySnapshot = getHistorySnapshot(mwState.history);',
        '    if (historySnapshot && !isHistorySnapshotCurrent(mwState.history)) mwState.history = [];',
        original,
    ].join('\n');
    const previousMarker = '// Chat-only group-history epoch guard v1.';
    if (content.includes(previousMarker)) {
        content = replaceOne(content, previousMarker, marker, file);
        if (!content.includes('getHistorySnapshot(mwState.history)')
            || !content.includes('isHistorySnapshotCurrent(mwState.history)')) {
            throw new Error(`Chat-only patch: legacy history snapshot guard is incomplete in ${file}`);
        }
        return content;
    }
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
    const historyPosition = content.indexOf('// Chat-only history snapshot epoch guard v1.');
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

await patch('transport/inbound.js', '// Chat-only OneBot provenance v1.', (content, file) => {
    const scopeImport = `import { beginOnebotTurn, endOnebotTurn, renderOnebotRequestMetadata } from '${onebotScopePolicy}';`;
    const oldPolicyImport = `import { setCurrentImages, clearCurrentImages } from '${policy}';`;
    const nextPolicyImport = `import { setCurrentImages, clearCurrentImages, isOnebotToolAvailable } from '${policy}';`;
    if (!content.includes(scopeImport)) content = `${scopeImport}\n${content}`;
    if (content.includes(oldPolicyImport)) content = replaceOne(content, oldPolicyImport, nextPolicyImport, file);
    else if (!content.includes(nextPolicyImport)) content = `${nextPolicyImport}\n${content}`;
    content = replaceOne(content, '    let documentTurn;\n    let generationTurn;',
        '    let documentTurn;\n    let generationTurn;\n    let onebotTurn;', file);
    const generationBinding = '        const generationMetadata = renderGenerationRequestMetadata(generationTurn);';
    const onebotBinding = [
        generationBinding,
        `        // Chat-only OneBot provenance v1.`,
        '        const onebotToolAvailable = isOnebotToolAvailable();',
        '        if (onebotToolAvailable) onebotTurn = beginOnebotTurn(',
        '            chatOnlyAgent,',
        '            getMergedGenerationRequests(ctx),',
        '            { appId: config.appId, signal: ctx.signal, isCurrentRecord, record, documentScope: documentTurn },',
        '        );',
        "        const onebotMetadata = onebotTurn ? renderOnebotRequestMetadata(onebotTurn) : '';",
    ].join('\n');
    content = replaceOne(content, generationBinding, onebotBinding, file);
    content = replaceOne(content,
        "const requestBody = [documentBody, generationMetadata].filter(Boolean).join('\\n\\n');",
        "const requestBody = [documentBody, generationMetadata, onebotMetadata].filter(Boolean).join('\\n\\n');", file);
    return content;
});

await patch('transport/inbound.js', '// Chat-only deferred image prompt metadata v1.', (content, file) => {
    const importLine = `import { renderDeferredImagePromptMetadata } from '${pendingImagesPolicy}';`;
    if (!content.includes(importLine)) content = `${importLine}\n${content}`;
    const marker = '// Chat-only deferred image prompt metadata v1.';
    const bodyLine = '    const agentBody = assembleAgentBody(msg, mwState, scope, logger);';
    const metadataLine = '    const deferredImagePromptMetadata = renderDeferredImagePromptMetadata(getMergedGenerationRequests(ctx));';
    if (!content.includes(marker)) {
        if (!content.includes(bodyLine)) throw new Error(`Chat-only patch: missing model input assembly in ${file}`);
        content = replaceOne(content, bodyLine, `${bodyLine}\n${metadataLine}\n    ${marker}`, file);
    }
    const oldBody = "const requestBody = [documentBody, generationMetadata, onebotMetadata].filter(Boolean).join('\\n\\n');";
    const newBody = "const requestBody = [documentBody, deferredImagePromptMetadata, generationMetadata, onebotMetadata].filter(Boolean).join('\\n\\n');";
    if (content.includes(oldBody)) content = replaceOne(content, oldBody, newBody, file);
    else if (!content.includes(newBody)) throw new Error(`Chat-only patch: deferred image prompt metadata is not bound to the model input in ${file}`);
    return content;
});

await patch('transport/inbound.js', '// Chat-only OneBot direct fallback v1.', (content, file) => {
    const fallbackImport = `import { renderOnebotDirectFallbackMetadata } from '${onebotScopePolicy}';`;
    if (!content.includes(fallbackImport)) content = `${fallbackImport}\n${content}`;
    const oldBody = "        const requestBody = [documentBody, deferredImagePromptMetadata, generationMetadata, onebotMetadata].filter(Boolean).join('\\n\\n');";
    const newBody = "        const requestBody = [documentBody, deferredImagePromptMetadata, generationMetadata, onebotMetadata, onebotFallbackMetadata].filter(Boolean).join('\\n\\n');";
    return replaceOne(content, oldBody,
        '        // Chat-only OneBot direct fallback v1.\n        const onebotFallbackMetadata = renderOnebotDirectFallbackMetadata(getMergedGenerationRequests(ctx));\n' + newBody, file);
});

await patch('transport/inbound.js', '// Chat-only OneBot auth diagnostics v1.', (content, file) => {
    const diagnosticImport = `import { renderCurrentLogSourceDiagnostics } from '${onebotScopePolicy}';`;
    if (!content.includes(diagnosticImport)) content = `${diagnosticImport}\n${content}`;
    const marker = '// Chat-only OneBot auth diagnostics v1.';
    const oldAvailabilityGate = '        if (isOnebotToolAvailable()) onebotTurn = beginOnebotTurn(';
    const availabilityBinding = [
        '        const onebotToolAvailable = isOnebotToolAvailable();',
        '        if (onebotToolAvailable) onebotTurn = beginOnebotTurn(',
    ].join('\n');
    if (!content.includes('const onebotToolAvailable = isOnebotToolAvailable();')) {
        if (!content.includes(oldAvailabilityGate)) throw new Error(`Chat-only patch: missing OneBot availability gate in ${file}`);
        content = replaceOne(content, oldAvailabilityGate, availabilityBinding, file);
    }
    const onebotLine = "        const onebotMetadata = onebotTurn ? renderOnebotRequestMetadata(onebotTurn) : '';";
    const diagnosticLine = '        const currentLogDiagnosticMetadata = renderCurrentLogSourceDiagnostics(getMergedGenerationRequests(ctx), { appId: config.appId, logger, toolAvailable: onebotToolAvailable });';
    if (!content.includes(marker)) {
        if (!content.includes(onebotLine)) throw new Error(`Chat-only patch: missing OneBot metadata in ${file}`);
        content = replaceOne(content, onebotLine, `${onebotLine}\n        ${diagnosticLine}\n        ${marker}`, file);
    }
    const oldBody = "const requestBody = [documentBody, deferredImagePromptMetadata, generationMetadata, onebotMetadata, onebotFallbackMetadata].filter(Boolean).join('\\n\\n');";
    const newBody = "const requestBody = [documentBody, deferredImagePromptMetadata, generationMetadata, onebotMetadata, currentLogDiagnosticMetadata, onebotFallbackMetadata].filter(Boolean).join('\\n\\n');";
    if (content.includes(oldBody)) content = replaceOne(content, oldBody, newBody, file);
    else if (!content.includes(newBody)) throw new Error(`Chat-only patch: current log diagnostics are not bound to the model input in ${file}`);
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

await patch('transport/inbound.js', '// Chat-only OneBot scope cleanup v1.', (content, file) => {
    const marker = '                // Chat-only OneBot scope cleanup v1.';
    const generationCleanup = '                if (generationTurn) await endGenerationTurn(chatOnlyAgent, generationTurn);';
    const finishCleanup = '                if (documentTurn) await finishContentRiskRecovery(documentTurn);';
    const onebotCleanup = [
        marker,
        '                if (onebotTurn) await endOnebotTurn(chatOnlyAgent, onebotTurn);',
    ].join('\n');
    if (!content.includes(marker)) {
        content = replaceOne(content, [generationCleanup, finishCleanup].join('\n'),
            [generationCleanup, onebotCleanup, finishCleanup].join('\n'), file);
    }
    else if (!content.includes('await endOnebotTurn(chatOnlyAgent, onebotTurn);')) {
        throw new Error('Chat-only patch: OneBot scope cleanup is partial in ' + file);
    }
    return content;
});

await patch('transport/inbound.js', '// Chat-only native model history restored v1.', (content, file) => {
    const staleImports = [
        `import { beginGroupModelContext, endGroupModelContext } from '/opt/qqbot-defaults/qqbot-model-context.mjs';\n`,
        `import { logContextInbound, logContextBinding } from '/opt/qqbot-defaults/qqbot-context-diagnostics.mjs';\n`,
    ];
    for (const importLine of staleImports) {
        if (content.includes(importLine)) content = replaceOne(content, importLine, '', file);
    }
    const staleLines = [
        '    let modelContextTurn;\n',
        '    // Chat-only group model context v1.\n',
        '    modelContextTurn = beginGroupModelContext(chatOnlyAgent, scope, documentTurn);\n',
        '        endGroupModelContext(chatOnlyAgent, modelContextTurn);\n',
        '    // Chat-only context diagnostics v1.\n',
        '    logContextInbound(ctx, getMergedGenerationRequests(ctx), agentBody);\n',
        '    // Chat-only context binding diagnostics v1.\n',
        '    logContextBinding(chatOnlyAgent, requestBody, agentBody);\n',
    ];
    for (const staleLine of staleLines) {
        if (content.includes(staleLine)) content = replaceOne(content, staleLine, '', file);
    }
    if (!content.includes('// Chat-only native model history restored v1.')) {
        content = `// Chat-only native model history restored v1.\n${content}`;
    }
    return content;
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

await patch('transport/attachment.js', '// Chat-only attachment source URL v2.', (content, file) => {
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
    const newImageMarker = '// Chat-only current-image downloads v3.';
    const originalTargets = "    const targets = (attachments ?? []).filter(a => classifyContentType(a.content_type) !== 'voice' && a.url);";
    const previousCurrentTargets = "    const targets = (attachments ?? []).filter(a => classifyContentType(a.content_type) === 'image' && a.url);";
    const currentTargets = "    const targets = (attachments ?? []).filter(a => a.url && (classifyContentType(a.content_type) === 'image' || ((!a.content_type || ['file', 'application/octet-stream'].includes(a.content_type.toLowerCase())) && /\\.(?:png|jpe?g|gif|webp)$/iu.test(a.filename ?? ''))));";
    if (content.includes(oldImageMarker)) {
        content = replaceOne(content, oldImageMarker, newImageMarker, file);
        if (content.includes(previousCurrentTargets)) content = replaceOne(content, previousCurrentTargets, currentTargets, file);
    }
    else if (content.includes(originalTargets)) {
        content = replaceOne(content, originalTargets,
            `${newImageMarker}\n${currentTargets}`, file);
    }
    else if (content.includes(previousCurrentTargets)) {
        content = replaceOne(content, previousCurrentTargets,
            `${newImageMarker}\n${currentTargets}`, file);
    }
    else if (content.includes('// Chat-only current-image downloads v2.')) {
        content = replaceOne(content, '// Chat-only current-image downloads v2.', newImageMarker, file);
        content = replaceOne(content, previousCurrentTargets, currentTargets, file);
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
    const oldSourceUrlMetadata = '        results.push({ filename: att.filename, contentType, localPath, sourceUrl: normalizeUrl(att.url) });';
    const markedMetadata = '        // Chat-only attachment source URL v2.\n        results.push({ filename: att.filename, contentType, localPath, sourceUrl: att.url });';
    if (content.includes(oldMetadata)) content = replaceOne(content, oldMetadata, markedMetadata, file);
    else if (content.includes(oldSourceUrlMetadata)) content = replaceOne(content, oldSourceUrlMetadata, markedMetadata, file);
    else if (!content.includes('// Chat-only attachment source URL v2.')
        || !content.includes('sourceUrl: att.url')) {
        throw new Error('Chat-only patch: attachment provenance result is missing in ' + file);
    }
    return content;
});

await patch('transport/inbound.js', '// Chat-only downloaded attachment lookup by source URL v1.', (content, file) => {
    const oldMap = '        const downloadedByFilename = new Map((state.downloadedFiles ?? []).map(d => [d.filename, d]));';
    const sourceMap = [
        '        // Chat-only downloaded attachment lookup by source URL v1.',
        "        const downloadedBySourceUrl = new Map((state.downloadedFiles ?? []).filter(d => typeof d.sourceUrl === 'string').map(d => [d.sourceUrl, d]));",
    ].join('\n');
    const oldLookup = '            const d = downloadedByFilename.get(att.filename);';
    const sourceLookup = '            const d = downloadedBySourceUrl.get(att.url);';
    if (content.includes(oldMap)) content = replaceOne(content, oldMap, sourceMap, file);
    else if (!content.includes(sourceMap)) throw new Error(`Chat-only patch: source URL download map is missing in ${file}`);
    if (content.includes(oldLookup)) content = replaceOne(content, oldLookup, sourceLookup, file);
    else if (!content.includes(sourceLookup)) throw new Error(`Chat-only patch: source URL download lookup is missing in ${file}`);
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
    if (content.includes(imageSchemaV4Marker)) return content;
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
    if (content.includes(imageSchemaV4Marker)) return content;
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

await patch('media/vision-tool.js', imageSchemaV4Marker, (content, file) => {
    const previousDescription = [
        '// Chat-only image schema: current and explicitly quoted QQ attachments v2.',
        "const DESCRIPTION = 'Inspect one image and return the text the user needs. The image must be either an absolute path '",
        "    + 'of an image attached to or explicitly quoted in the current QQ message and stored inside the QQ media directory, '",
        "    + 'or a public HTTPS image URL. Other local paths, non-HTTPS URLs, and non-image files are forbidden. '",
        "    + 'Use this when the user references an image, or when a task needs OCR, chart/diagram reading, screenshot or UI analysis, '",
        "    + 'translation of image text, or photo understanding. Always pass an explicit `prompt` with a precise '",
        "    + 'instruction (e.g. \"transcribe all text\", \"extract the table as CSV\", \"translate the text into Chinese\") '",
        "    + 'instead of relying on the generic default.';",
    ].join('\n');
    const currentV3Description = [
        imageSchemaV3Marker,
        "const DESCRIPTION = 'Inspect one image and return the text the user needs. The image must be either an absolute path '",
        "    + 'of an image attached to or explicitly quoted in the current QQ message and stored inside the QQ media directory, '",
        "    + 'or a public HTTPS image URL. Other local paths, non-HTTPS URLs, and non-image files are forbidden. '",
        "    + 'Use this when the user references an image, or when a task needs OCR, chart/diagram reading, screenshot or UI analysis, '",
        "    + 'translation of image text, or photo understanding. Always pass an explicit `prompt` with a precise '",
        "    + 'instruction (e.g. \"transcribe all text\", \"extract the table as CSV\", \"translate the text into Chinese\") '",
        "    + 'instead of relying on the generic default.';",
    ].join('\n');
    const newDescription = [
        imageSchemaV4Marker,
        "const DESCRIPTION = 'Inspect one image and return the text the user needs. The image must be either an absolute path '",
        "    + 'of a current or explicitly quoted QQ image inside the QQ media directory, a public HTTPS image URL, or the exact '",
        "    + 'imageRef capability listed in recentImages for the matching original request. Recent refs are only for explicit '",
        "    + 'image analysis, OCR, image content questions, or edits. Other local paths and non-HTTPS URLs are forbidden. '",
        "    + 'Current and explicitly quoted images and user-provided URLs take priority; never fall back to a recent image when '",
        "    + 'the selected source fails. Ask which image to edit when multiple recent candidates are ambiguous. Always pass an '",
        "    + 'explicit `prompt` with a precise instruction instead of relying on the generic default.';",
    ].join('\n');
    if (content.includes(currentV3Description)) content = replaceOne(content, currentV3Description, newDescription, file);
    else if (content.includes(previousDescription)) content = replaceOne(content, previousDescription, newDescription, file);
    else throw new Error(`Chat-only patch: expected v3 vision description in ${file}`);
    const previousParameter = "                    description: 'Absolute path of a current-message or explicitly quoted image inside the QQ media directory, or a public HTTPS image URL.',";
    const recentParameter = "                    description: 'Current or explicitly quoted QQ image path inside the QQ media directory, public HTTPS image URL, or exact recentImages imageRef for the matching original request.',";
    if (content.includes(previousParameter)) content = replaceOne(content, previousParameter, recentParameter, file);
    else if (!content.includes(recentParameter)) throw new Error(`Chat-only patch: expected v3 image parameter in ${file}`);
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

await patch('media/vision-tool.js', memoryVisionImageMarker, (content, file) => {
    const helperImport = `import { withMemoryVisionImage } from '${memoryImagesPolicy}';`;
    if (!content.includes(helperImport)) content = `${helperImport}\n${content}`;
    const nativeAttachmentSave = [
        '            const ref = await attachments.saveImage({',
        '                data: loaded.data,',
        '                mediaType: loaded.mediaType,',
        '                name: /^https?:\\/\\//i.test(image) ? undefined : basename(image),',
        '            });',
        '            const text = await callVision(llm, vision, prompt ?? vision.defaultPrompt, ref, exec.signal);',
    ].join('\n');
    const scopedSave = [
        memoryVisionImageMarker,
        '            let text;',
        "            if (image.startsWith('qqbot-image:')) {",
        '                text = await withMemoryVisionImage(attachments, loaded, exec.signal, (ref) =>',
        '                    callVision(llm, vision, prompt ?? vision.defaultPrompt, ref, exec.signal));',
        '            }',
        '            else {',
        '                const ref = await attachments.saveImage({',
        '                    data: loaded.data,',
        '                    mediaType: loaded.mediaType,',
        '                    name: /^https?:\\/\\//i.test(image) ? undefined : basename(image),',
        '                });',
        '                text = await callVision(llm, vision, prompt ?? vision.defaultPrompt, ref, exec.signal);',
        '            }',
    ].join('\n');
    return replaceOne(content, nativeAttachmentSave, scopedSave, file);
});

const visionPath = join(root, 'media/vision-tool.js');
const patchedVision = updates.get(visionPath) ?? await readFile(visionPath, 'utf8');
if (patchedVision.split(imageToolPolicyImport).length !== 2
    || patchedVision.split(`import { withMemoryVisionImage } from '${memoryImagesPolicy}';`).length !== 2
    || patchedVision.split(imageLoaderV3Marker).length !== 2
    || patchedVision.split(imageSchemaV4Marker).length !== 2
    || patchedVision.split(memoryVisionImageMarker).length !== 2
    || !patchedVision.includes('const data = await loadChatImageBytes(image, maxBytes, exec);')
    || !patchedVision.includes('loadImageBytes(image, vision.maxBytes, exec)')
    || !patchedVision.includes("if (image.startsWith('qqbot-image:')) {")
    || !patchedVision.includes('withMemoryVisionImage(attachments, loaded, exec.signal, (ref) =>')
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
assertOnce(finalInbound, '// Chat-only native model history restored v1.', 'native model history migration marker');
const obsoleteGroupFilter = [
    'QQBOT_GROUP_CURRENT_ONLY',
    'beginGroupModelContext',
    'endGroupModelContext',
    'projectGroupModelMessages',
    'logContextInbound',
    'logContextBinding',
    'qqbot-model-context.mjs',
    'qqbot-context-diagnostics.mjs',
];
if (obsoleteGroupFilter.some((value) => finalInbound.includes(value))) {
    throw new Error('Chat-only patch: stale local group-history filtering or diagnostics remain in the inbound adapter');
}
const deferredPromptImport = `import { renderDeferredImagePromptMetadata } from '${pendingImagesPolicy}';`;
assertOnce(finalInbound, deferredPromptImport, 'deferred image prompt metadata import');
assertOnce(finalInbound, 'renderDeferredImagePromptMetadata(getMergedGenerationRequests(ctx))', 'per-original-request deferred image metadata');
assertOnce(finalInbound, 'deferredImagePromptMetadata, generationMetadata, onebotMetadata', 'separate image prompt metadata in model body');
if (finalInbound.indexOf('renderDeferredImagePromptMetadata(getMergedGenerationRequests(ctx))')
    < finalInbound.indexOf('const agentBody = assembleAgentBody(msg, mwState, scope, logger);')
    || finalInbound.indexOf('renderDeferredImagePromptMetadata(getMergedGenerationRequests(ctx))')
    > finalInbound.indexOf('chatOnlyAgent.followup(message);')) {
    throw new Error('Chat-only patch: deferred image prompt metadata is outside the bound model input lifecycle');
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
assertOnce(finalInbound, '// Chat-only history snapshot epoch guard v1.', 'history snapshot epoch guard');
assertOnce(finalInbound, 'if (historySnapshot && !isHistorySnapshotCurrent(mwState.history)) mwState.history = [];', 'stale history snapshot filter');
assertOnce(finalInbound, 'await chatOnlyAgent.whenIdle();', 'inbound idle wait');
assertOnce(finalInbound, 'clearCurrentImages(chatOnlyAgent, documentTurn);', 'inbound image cleanup');
assertOnce(finalInbound, 'endDocumentTurn(chatOnlyAgent, documentTurn);', 'inbound document cleanup');
assertOnce(finalInbound, 'await finishContentRiskRecovery(documentTurn);', 'inbound recovery cleanup');
assertOnce(finalInbound, `import { beginOnebotTurn, endOnebotTurn, renderOnebotRequestMetadata } from '${onebotScopePolicy}';`, 'OneBot scope import');
assertOnce(finalInbound, `import { setCurrentImages, clearCurrentImages, isOnebotToolAvailable } from '${policy}';`, 'OneBot availability import');
assertOnce(finalInbound, '// Chat-only OneBot provenance v1.', 'OneBot provenance marker');
assertOnce(finalInbound, 'const onebotToolAvailable = isOnebotToolAvailable();', 'single OneBot tool availability snapshot');
assertOnce(finalInbound, 'if (onebotToolAvailable) onebotTurn = beginOnebotTurn(', 'OneBot availability-gated turn binding');
assertOnce(finalInbound, "const onebotMetadata = onebotTurn ? renderOnebotRequestMetadata(onebotTurn) : '';", 'OneBot request metadata');
assertOnce(finalInbound, `import { renderCurrentLogSourceDiagnostics } from '${onebotScopePolicy}';`, 'current log diagnostic import');
assertOnce(finalInbound, 'const currentLogDiagnosticMetadata = renderCurrentLogSourceDiagnostics(getMergedGenerationRequests(ctx), { appId: config.appId, logger, toolAvailable: onebotToolAvailable });', 'current log diagnostics with shared availability snapshot');
assertOnce(finalInbound, '// Chat-only OneBot auth diagnostics v1.', 'current log diagnostics marker');
assertOnce(finalInbound, "const requestBody = [documentBody, deferredImagePromptMetadata, generationMetadata, onebotMetadata, currentLogDiagnosticMetadata, onebotFallbackMetadata].filter(Boolean).join('\\n\\n');", 'OneBot model input with independent diagnostics');
assertOnce(finalInbound, `import { renderOnebotDirectFallbackMetadata } from '${onebotScopePolicy}';`, 'OneBot independent fallback import');
assertOnce(finalInbound, 'const onebotFallbackMetadata = renderOnebotDirectFallbackMetadata(getMergedGenerationRequests(ctx));', 'OneBot fallback even without tool availability');
const finalQuestionAnswer = await finalText('middleware/question-answer.js');
assertOnce(finalQuestionAnswer, 'if (getOnebotDirectFallback(ctx)) return await next();', 'OneBot fallback bypasses pending questions');
assertOnce(finalInbound, 'await endOnebotTurn(chatOnlyAgent, onebotTurn);', 'OneBot scope cleanup');
assertOnce(finalInbound, '// Chat-only safe inbound errors v1.', 'safe inbound errors marker');
assertOnce(finalInbound, "logger.warn('whenIdle/followup rejected');", 'safe inbound exception log');
if (finalInbound.includes('whenIdle/followup rejected: ${'))
    throw new Error('Chat-only patch: inbound exception log exposes raw errors');
const historyGuardPosition = finalInbound.indexOf('// Chat-only history snapshot epoch guard v1.');
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
    || finalInbound.indexOf('await endOnebotTurn(chatOnlyAgent, onebotTurn);') <= finalInbound.indexOf('await endGenerationTurn(chatOnlyAgent, generationTurn);')
    || finalInbound.indexOf('await endOnebotTurn(chatOnlyAgent, onebotTurn);') >= inboundRecoveryFinishPosition
    || finalInbound.indexOf(recoveryInboundRegistration) < finalInbound.indexOf('documentTurn = getDocumentTurn(chatOnlyAgent);')
    || finalInbound.indexOf(recoveryInboundRegistration) > finalInbound.indexOf('chatOnlyAgent.followup(message);')
    ) {
    throw new Error(`Chat-only patch: inbound recovery wiring is outside the safe turn lifecycle (history=${historyGuardPosition}/${historyFilterPosition}, idle=${inboundIdlePosition}, image=${inboundImageClearPosition}, end=${inboundDocumentEndPosition}, recovery=${inboundRecoveryFinishPosition}, close=${finalInbound.indexOf('await closeMergeBatch(replyBatch);')}, registration=${finalInbound.indexOf(recoveryInboundRegistration)}, binding=${finalInbound.indexOf('documentTurn = getDocumentTurn(chatOnlyAgent);')}, followup=${finalInbound.indexOf('chatOnlyAgent.followup(message);')})`);
}
const finalBootstrap = await finalText('gateway/bootstrap.js');
assertOnce(finalBootstrap, '// Chat-only merge batch reply adapter v1.', 'early merge sender adapter');
assertOnce(finalBootstrap, 'setupMiddlewares(bot, config, manager, logger, sender, directRouter, onebotService);', 'merge sender, direct router, and log capture injection');
assertOnce(finalBootstrap, '// Chat-only QQ delivery logging v1.', 'native QQ delivery logging hook');
assertOnce(finalBootstrap, '// Chat-only native OneBot delivery integration v1.', 'native OneBot delivery integration migration');
assertOnce(finalBootstrap, '    let onebotService;', 'shared OneBot service declaration');
assertOnce(finalBootstrap, '    let generationSender;', 'shared generation sender declaration');
assertOnce(finalBootstrap, '    let detachOnebotDeliveryObserver;', 'delivery observer disposal declaration');
if (finalBootstrap.includes('const onebotService = registerOnebotCommandTool(ctx, {'))
    throw new Error('Chat-only patch: obsolete OneBot service declaration conflicts with delivery integration');
assertOnce(finalBootstrap, `import { attachOnebotDeliveryObserver } from '${onebotLogPolicy}';`, 'QQ send observer import');
assertOnce(finalBootstrap, 'detachOnebotDeliveryObserver = attachOnebotDeliveryObserver(bot, onebotService);', 'QQ send observer registration');
assertOnce(finalBootstrap, 'detachOnebotDeliveryObserver();', 'QQ send observer shutdown');
assertOnce(finalBootstrap, 'generationSender = createGenerationSender({', 'generation file sender with delivery hook');
assertOnce(finalBootstrap, 'sendArtifactFile: (...args) => generationSender?.sendArtifactFile?.(...args),', 'artifact sender injection');
assertOnce(finalBootstrap, `import { registerOnebotCommandTool } from '${onebotPolicy}';`, 'native OneBot command import');
assertOnce(finalBootstrap, `import { setOnebotToolAvailable } from '${policy}';`, 'native OneBot availability import');
assertOnce(finalBootstrap, `import { createOnebotDirectRouter } from '${onebotDirectPolicy}';`, 'native OneBot direct router import');
assertOnce(finalBootstrap, "import { MediaApi, MessageApi, messagePath } from '@tencent-connect/qqbot-nodejs/protocol';", 'QQ proactive C2C route import');
assertOnce(finalBootstrap, '// Chat-only native OneBot command v1.', 'native OneBot command registration');
assertOnce(finalBootstrap, '// Chat-only native OneBot direct router v1.', 'native OneBot direct router registration');
assertOnce(finalBootstrap, 'const directRouter = createOnebotDirectRouter({', 'native OneBot direct router construction');
assertOnce(finalBootstrap, 'service: onebotService,', 'direct router OneBot service binding');
assertOnce(finalBootstrap, 'await directRouter.stop();', 'native OneBot direct router shutdown');
assertOnce(finalBootstrap, "await onebotService.stop();", 'native OneBot shutdown');
if (finalBootstrap.indexOf('// Chat-only merge batch reply adapter v1.') > finalBootstrap.indexOf('setupMiddlewares(bot, config, manager, logger, sender, directRouter, onebotService);')
    || finalBootstrap.includes('const replyLimiter = new ReplyLimiter({ limit: 4 });', finalBootstrap.indexOf('setupMiddlewares(bot, config, manager, logger, sender, directRouter, onebotService);'))) {
    throw new Error('Chat-only patch: merge overflow sender is not initialized before inbound middleware');
}
const nativeServicePosition = finalBootstrap.indexOf('onebotService = registerOnebotCommandTool(ctx, {');
const directRouterPosition = finalBootstrap.indexOf('const directRouter = createOnebotDirectRouter({');
const setupMiddlewaresPosition = finalBootstrap.indexOf('setupMiddlewares(bot, config, manager, logger, sender, directRouter, onebotService);');
const directRouterStopPosition = finalBootstrap.indexOf('await directRouter.stop();');
const onebotServiceStopPosition = finalBootstrap.indexOf('await onebotService.stop();');
if (nativeServicePosition < finalBootstrap.indexOf('const bot = new QQBot({')
    || nativeServicePosition <= finalBootstrap.indexOf('const sender = {')
    || directRouterPosition <= nativeServicePosition
    || setupMiddlewaresPosition <= directRouterPosition
    || directRouterStopPosition < 0 || onebotServiceStopPosition <= directRouterStopPosition
    || finalBootstrap.includes('setupMiddlewares(bot, config, manager, logger, sender);')) {
    throw new Error('Chat-only patch: native OneBot direct router must bind after its service and sender, before middleware setup, and stop before its service');
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
