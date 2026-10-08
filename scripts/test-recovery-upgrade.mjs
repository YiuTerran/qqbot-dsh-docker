// Run inside an existing image with current defaults/enforcer bind-mounted.
// QQBOT_ADAPTER_DIST must point to an already-current patched adapter.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const sourceDist = process.env.QQBOT_ADAPTER_DIST;
const integration = sourceDist ? test : test.skip;
const enforcer = process.env.QQBOT_ENFORCER_SCRIPT ?? '/usr/local/lib/enforce-chat-only.mjs';
const fixture = process.env.QQBOT_PRE_RECOVERY_FIXTURE
    ?? fileURLToPath(new URL('./prepare-pre-recovery-fixture.mjs', import.meta.url));
const concurrencyFixture = process.env.QQBOT_PRE_CONCURRENCY_FIXTURE
    ?? fileURLToPath(new URL('./prepare-pre-concurrency-fixture.mjs', import.meta.url));

async function run(script, args = []) {
    return execute(process.execPath, [script, ...args], { timeout: 30_000, maxBuffer: 256 * 1024 });
}

async function isolatedAdapter(t) {
    const temporary = await mkdtemp(join(tmpdir(), 'qqbot-recovery-upgrade-'));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const copiedDist = join(temporary, 'dist');
    await cp(resolve(sourceDist), copiedDist, { recursive: true });
    await cp(join(dirname(resolve(sourceDist)), 'package.json'), join(temporary, 'package.json'));
    return copiedDist;
}

async function hashes(root, relative = '') {
    const result = {};
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        const name = join(relative, entry.name);
        if (entry.isDirectory()) Object.assign(result, await hashes(root, name));
        else if (entry.isSymbolicLink()) result[name] = `symlink:${await readlink(join(root, name))}`;
        else result[name] = createHash('sha256').update(await readFile(join(root, name))).digest('hex');
    }
    return result;
}

async function assertCurrentPatch(root) {
    const expected = {
        'gateway/bootstrap.js': [
            '// Chat-only merge batch reply adapter v1.',
            '// Chat-only native OneBot delivery integration v1.',
            '    let onebotService;',
            '    let generationSender;',
            '    let detachOnebotDeliveryObserver;',
            'setupMiddlewares(bot, config, manager, logger, sender, directRouter, onebotService);',
            "import { attachOnebotDeliveryObserver } from '/opt/qqbot-defaults/qqbot-onebot-log.mjs';",
            'detachOnebotDeliveryObserver = attachOnebotDeliveryObserver(bot, onebotService);',
            'detachOnebotDeliveryObserver();',
            "import { createOnebotDirectRouter } from '/opt/qqbot-defaults/qqbot-onebot-direct.mjs';",
            '// Chat-only native OneBot command v1.',
            '// Chat-only native OneBot direct router v1.',
            'const directRouter = createOnebotDirectRouter({',
            'service: onebotService,',
            'await directRouter.stop();',
            'await onebotService.stop();',
        ],
        'gateway/middleware-setup.js': [
            'export function setupMiddlewares(bot, config, manager, logger, sender, directRouter, onebotService) {',
            '// Chat-only OneBot log capture after access policy v1.',
            'bot.use(createOnebotLogCaptureMiddleware(onebotService));',
            '// Chat-only OneBot /new cancellation v1.',
            "if (ctx.message.content?.trim() === '/new') await directRouter?.cancelConversation(ctx);",
            '// Chat-only OneBot direct router middleware v1.',
            'if (directRouter) bot.use(directRouter.middleware);',
            "import { createMergeConcurrencyGuard, sendMergeQueueFullNotice, sendMergeThinkingNotice } from '/opt/qqbot-defaults/qqbot-concurrency.mjs';",
            "import { createHistorySnapshotBuffer } from '/opt/qqbot-defaults/qqbot-history-snapshot.mjs';",
            '// Chat-only history snapshot epoch guard v1.',
            'bot.use(createHistorySnapshotBuffer(historyBuffer, {',
            '// Chat-only serialized merge guard v1.',
            '// Chat-only idle group thinking notice v1.',
            'onStart: async (startedCtx) => {',
            'await sendMergeThinkingNotice(sender, startedCtx);',
            'maxQueue: config.maxQueue ?? 20,',
            'await sendMergeQueueFullNotice(sender, droppedCtx);',
        ],
        'transport/inbound.js': [
            '// Chat-only content-risk recovery context v1.',
            '// Chat-only history snapshot epoch guard v1.',
            '// Chat-only safe inbound errors v1.',
            "import { renderDeferredImagePromptMetadata } from '/opt/qqbot-defaults/qqbot-pending-images.mjs';",
            '// Chat-only batch cancellation and reply binding v1.',
            '// Chat-only safe batch finalization v1.',
            '// Chat-only generation provenance v1.',
            '// Chat-only lazy quoted image grants v1.',
            'media: config.media,',
            '// Chat-only generation cleanup v1.',
            "import { beginOnebotTurn, endOnebotTurn, renderOnebotRequestMetadata } from '/opt/qqbot-defaults/qqbot-onebot-scope.mjs';",
            "import { setCurrentImages, clearCurrentImages, isOnebotToolAvailable } from '/opt/qqbot-defaults/qqbot-chat-policy.mjs';",
            '// Chat-only OneBot provenance v1.',
            'const onebotToolAvailable = isOnebotToolAvailable();',
            'if (onebotToolAvailable) onebotTurn = beginOnebotTurn(',
            "const onebotMetadata = onebotTurn ? renderOnebotRequestMetadata(onebotTurn) : '';",
            "const currentLogDiagnosticMetadata = renderCurrentLogSourceDiagnostics(getMergedGenerationRequests(ctx), { appId: config.appId, logger, toolAvailable: onebotToolAvailable });",
            'const deferredImagePromptMetadata = renderDeferredImagePromptMetadata(getMergedGenerationRequests(ctx));',
            'generationTurn = beginGenerationTurn(',
            'const generationMetadata = renderGenerationRequestMetadata(generationTurn);',
            "const requestBody = [documentBody, deferredImagePromptMetadata, generationMetadata, onebotMetadata, currentLogDiagnosticMetadata, onebotFallbackMetadata].filter(Boolean).join('\\n\\n');",
            '// Chat-only OneBot direct fallback v1.',
            'renderOnebotDirectFallbackMetadata(getMergedGenerationRequests(ctx))',
            'if (generationTurn) await endGenerationTurn(chatOnlyAgent, generationTurn);',
            'if (onebotTurn) await endOnebotTurn(chatOnlyAgent, onebotTurn);',
            'await closeMergeBatch(replyBatch);',
            'if (documentTurn) await finishContentRiskRecovery(documentTurn);',
        ],
        'transport/outbound.js': [
            '// Chat-only content-risk turn recovery v1.',
            '// Chat-only friendly provider errors v1.',
            '// Chat-only batch-bound outbound routing v1.',
            '// Chat-only generation outbound v1.',
            '// Chat-only deferred tool failures v1.',
            "import { captureMergeBatchReply, enqueueMergeBatchSend, noteMergeBatchTurnStart } from '/opt/qqbot-defaults/qqbot-concurrency.mjs';",
            'captureMergeBatchReply(record, { sessionId, turnId: raw?.data?.turn, seq: raw?.seq })',
            "enqueueMergeBatchSend(originRecord, () => this.send(record, formatProviderFailure(failure), 'sendTurnEndError'));",
            'this.toolFailureTurns.set(originRecord, { toolFailed: true, hasAnswer: false, streamAfterFailure: false });',
            "event.reason.kind === 'completed' && turn?.toolFailed && !turn.hasAnswer && !completedStreamAnswer",
        ],
        'transport/attachment.js': [
            '// Chat-only current-image downloads v3.',
            '// Chat-only attachment source URL v2.',
            "import { downloadCurrentQQImage } from '/opt/qqbot-defaults/qqbot-web-pages.mjs';",
            'const buf = await downloadCurrentQQImage(parsed.href, maxBytes);',
            'results.push({ filename: att.filename, contentType, localPath, sourceUrl: att.url });',
        ],
        'middleware/attachment.js': [
            '// Chat-only quoted-image downloads v2.',
            '// Chat-only generation quote image downloads v1.',
            '// Chat-only independent merged quote downloads v2.',
            '// Chat-only lazy quoted images v1.',
            'ctx.state.downloadedQuoteFiles = [];',
            'ctx.state.downloadedGenerationQuoteFiles = [];',
        ],
        'transport/streaming-writer.js': [
            '// Chat-only awaitable stream cancellation v1.',
        ],
        'transport/outbound-buffer.js': [
            '// Chat-only awaitable stream cancellation v1.',
            'this.flushPromise = completion;',
            'return Promise.all([this.flushPromise, completion].filter(Boolean));',
        ],
        'transport/events.js': ['// Chat-only structured provider failures v1.'],
        'model/prefs-store.js': ['// Chat-only persistent model prefs v1.'],
        'model/model-resolver.js': ['// Chat-only strict sessionId persistence v1.'],
        'session/session-manager.js': [
            '// Chat-only strict automatic session reset v1.',
            '// Chat-only committed reset disposal v1.',
            'recoveryOptions.onCommitted?.(record)',
        ],
    };
    const inbound = await readFile(join(root, 'transport/inbound.js'), 'utf8');
    const bootstrap = await readFile(join(root, 'gateway/bootstrap.js'), 'utf8');
    const middlewareSetup = await readFile(join(root, 'gateway/middleware-setup.js'), 'utf8');
    for (const obsolete of ['QQBOT_GROUP_CURRENT_ONLY', 'beginGroupModelContext', 'projectGroupModelMessages',
        'logContextInbound', 'logContextProjection', 'quoteFilter', 'createGroupHistoryBuffer']) {
        assert.equal(inbound.includes(obsolete) || middlewareSetup.includes(obsolete), false,
            `obsolete local group context behavior is absent: ${obsolete}`);
    }
    assert.equal(inbound.split("const requestBody = [documentBody, generationMetadata].filter(Boolean).join('\\n\\n');").length - 1, 0,
        'obsolete request body without OneBot provenance is absent');
    assert.equal(inbound.split("const requestBody = [documentBody, deferredImagePromptMetadata, generationMetadata, onebotMetadata, currentLogDiagnosticMetadata, onebotFallbackMetadata].filter(Boolean).join('\\n\\n');").length - 1, 1,
        'the availability-gated request body includes OneBot provenance exactly once');
    const servicePosition = bootstrap.indexOf('onebotService = registerOnebotCommandTool(ctx, {');
    const senderPosition = bootstrap.indexOf('const sender = {');
    const routerPosition = bootstrap.indexOf('const directRouter = createOnebotDirectRouter({');
    const setupPosition = bootstrap.indexOf('setupMiddlewares(bot, config, manager, logger, sender, directRouter, onebotService);');
    assert.ok(senderPosition < servicePosition && servicePosition < routerPosition && routerPosition < setupPosition,
        'the service and sender exist before the direct router is passed to middleware setup');
    assert.ok(bootstrap.indexOf('await directRouter.stop();') < bootstrap.indexOf('await onebotService.stop();'),
        'direct conversation scopes stop before the underlying OneBot service');
    const ratePosition = middlewareSetup.indexOf('bot.use(rateLimiter());');
    const cancelPosition = middlewareSetup.indexOf("if (ctx.message.content?.trim() === '/new') await directRouter?.cancelConversation(ctx);");
    const slashPosition = middlewareSetup.indexOf('bot.use(slash.middleware);');
    const routerMiddlewarePosition = middlewareSetup.indexOf('if (directRouter) bot.use(directRouter.middleware);');
    const qaPosition = middlewareSetup.indexOf('bot.use(questionAnswer(manager));');
    const attachmentPosition = middlewareSetup.indexOf('bot.use(attachmentProcessor(config, logger));');
    assert.ok(ratePosition < cancelPosition && cancelPosition < slashPosition
        && slashPosition < routerMiddlewarePosition && routerMiddlewarePosition < qaPosition
        && routerMiddlewarePosition < attachmentPosition,
    'sanitized /new cancels before slash handling and direct commands run after slash handling before QA and attachments');
    for (const [file, markers] of Object.entries(expected)) {
        const content = await readFile(join(root, file), 'utf8');
        for (const marker of markers) assert.equal(content.split(marker).length, 2, `${file}: exactly one ${marker}`);
        await run('--check', [join(root, file)]);
    }
}

for (const version of ['pre-thinking', 'pre-concurrency', 'pre-recovery', 'recovery-v1', 'onebot-v10.2', 'onebot-v11.2']) {
    integration(`${version} adapter upgrades completely and a second patch pass changes no file hashes`, async (t) => {
        const root = await isolatedAdapter(t);
        if (version === 'pre-thinking') await run(concurrencyFixture, [root, 'thinking-only']);
        else if (version === 'pre-concurrency') await run(concurrencyFixture, [root]);
        else if (version === 'onebot-v10.2') await run(concurrencyFixture, [root, 'direct-only']);
        else if (version === 'onebot-v11.2') {
            await run(concurrencyFixture, [root, 'log-only']);
            const bootstrap = await readFile(join(root, 'gateway/bootstrap.js'), 'utf8');
            assert.equal(bootstrap.split('// Chat-only native OneBot direct router v1.').length, 2,
                'the released v0.11.2 direct-router marker survives the fixture');
            assert.equal(bootstrap.includes('const onebotService = registerOnebotCommandTool(ctx, {'), true,
                'the released service declaration is retained before upgrading');
        }
        else await run(fixture, [root, ...(version === 'recovery-v1' ? ['recovery-v1'] : [])]);
        const before = await hashes(root);
        await run(enforcer, [root]);
        await assertCurrentPatch(root);
        const upgraded = await hashes(root);
        assert.notDeepEqual(upgraded, before, 'the old layout was actually upgraded');
        await run(enforcer, [root]);
        assert.deepEqual(await hashes(root), upgraded, 'the full dist is byte-for-byte unchanged on repeat startup');
    });
}

integration('a partial released direct-router delivery upgrade fails before any adapter write', async (t) => {
    const root = await isolatedAdapter(t);
    await run(concurrencyFixture, [root, 'log-only']);
    const bootstrapPath = join(root, 'gateway/bootstrap.js');
    const bootstrap = await readFile(bootstrapPath, 'utf8');
    const registration = '    const onebotService = registerOnebotCommandTool(ctx, {';
    assert.equal(bootstrap.split(registration).length, 2, 'fixture has the released service declaration');
    await writeFile(bootstrapPath, bootstrap.replace(registration, '    const onebotService = alteredOnebotCommandTool(ctx, {'));
    const before = await hashes(root);
    await assert.rejects(run(enforcer, [root]), (error) => {
        assert.notEqual(error.code, 0);
        assert.match(error.stderr, /native OneBot delivery integration layout is incomplete/u);
        return true;
    });
    assert.deepEqual(await hashes(root), before, 'legacy layout rejection performs zero adapter writes');
});

integration('a partial committed callback fails strict validation without changing any dist file', async (t) => {
    const root = await isolatedAdapter(t);
    const managerPath = join(root, 'session/session-manager.js');
    const manager = await readFile(managerPath, 'utf8');
    const callback = '            try { recoveryOptions.onCommitted?.(record); } catch { }';
    assert.equal(manager.split(callback).length, 2, 'fixture begins with exactly one committed callback');
    await writeFile(managerPath, manager.replace(callback, ''));
    const before = await hashes(root);
    await assert.rejects(run(enforcer, [root]), (error) => {
        assert.notEqual(error.code, 0);
        assert.match(error.stderr, /strict session reset atomic commit ordering is incomplete/u);
        return true;
    });
    assert.deepEqual(await hashes(root), before, 'strict rejection performs zero adapter writes');
});

integration('a partial overflow guard fails strict validation without changing any dist file', async (t) => {
    const root = await isolatedAdapter(t);
    const middlewarePath = join(root, 'gateway/middleware-setup.js');
    const middleware = await readFile(middlewarePath, 'utf8');
    const notice = '                await sendMergeQueueFullNotice(sender, droppedCtx);';
    assert.equal(middleware.split(notice).length, 2, 'fixture begins with exactly one overflow notice call');
    await writeFile(middlewarePath, middleware.replace(notice, '                // fixture removed required overflow notification'));
    const before = await hashes(root);
    await assert.rejects(run(enforcer, [root]), (error) => {
        assert.notEqual(error.code, 0);
        assert.match(error.stderr, /serialized merge middleware, overflow notice, or ordering is incomplete/u);
        return true;
    });
    assert.deepEqual(await hashes(root), before, 'strict rejection performs zero adapter writes');
});

integration('a marked but incomplete deferred failure handler fails before any adapter write', async (t) => {
    const root = await isolatedAdapter(t);
    const outboundPath = join(root, 'transport/outbound.js');
    const outbound = await readFile(outboundPath, 'utf8');
    const capture = '            this.toolFailureTurns.set(originRecord, { toolFailed: true, hasAnswer: false, streamAfterFailure: false });';
    assert.equal(outbound.split(capture).length, 2, 'fixture begins with one deferred failure capture');
    await writeFile(outboundPath, outbound.replace(capture, '            // fixture removed deferred failure capture'));
    const before = await hashes(root);
    await assert.rejects(run(enforcer, [root]), (error) => {
        assert.notEqual(error.code, 0);
        assert.match(error.stderr, /deferred failure capture/u);
        return true;
    });
    assert.deepEqual(await hashes(root), before, 'strict rejection performs zero adapter writes');
});

integration('a marked but altered thinking hook fails strict validation without changing any dist file', async (t) => {
    const root = await isolatedAdapter(t);
    const middlewarePath = join(root, 'gateway/middleware-setup.js');
    const middleware = await readFile(middlewarePath, 'utf8');
    const hook = '            await sendMergeThinkingNotice(sender, startedCtx);';
    assert.equal(middleware.split(hook).length, 2, 'fixture begins with exactly one thinking hook call');
    await writeFile(middlewarePath, middleware.replace(hook, '            // await sendMergeThinkingNotice(sender, startedCtx);'));
    const before = await hashes(root);
    await assert.rejects(run(enforcer, [root]), (error) => {
        assert.notEqual(error.code, 0);
        assert.match(error.stderr, /serialized merge middleware, overflow notice, or ordering is incomplete/u);
        return true;
    });
    assert.deepEqual(await hashes(root), before, 'strict rejection performs zero adapter writes');
});

integration('a markerless partial thinking hook fails closed without changing any dist file', async (t) => {
    const root = await isolatedAdapter(t);
    const middlewarePath = join(root, 'gateway/middleware-setup.js');
    const middleware = await readFile(middlewarePath, 'utf8');
    const marker = '        // Chat-only idle group thinking notice v1.\n';
    assert.equal(middleware.split(marker).length, 2, 'fixture begins with exactly one thinking marker');
    await writeFile(middlewarePath, middleware.replace(marker, ''));
    const before = await hashes(root);
    await assert.rejects(run(enforcer, [root]), (error) => {
        assert.notEqual(error.code, 0);
        assert.match(error.stderr, /partial idle thinking notice/u);
        return true;
    });
    assert.deepEqual(await hashes(root), before, 'strict rejection performs zero adapter writes');
});

integration('a marked but incomplete OneBot router shutdown fails closed without changing any dist file', async (t) => {
    const root = await isolatedAdapter(t);
    const bootstrapPath = join(root, 'gateway/bootstrap.js');
    const bootstrap = await readFile(bootstrapPath, 'utf8');
    const stop = '            await directRouter.stop();';
    assert.equal(bootstrap.split(stop).length, 2, 'fixture begins with one direct router shutdown');
    await writeFile(bootstrapPath, bootstrap.replace(stop, '            // fixture removed direct router shutdown'));
    const before = await hashes(root);
    await assert.rejects(run(enforcer, [root]), (error) => {
        assert.notEqual(error.code, 0);
        assert.match(error.stderr, /native OneBot direct router shutdown is missing or duplicated/u);
        return true;
    });
    assert.deepEqual(await hashes(root), before, 'strict rejection performs zero adapter writes');
});

integration('a marked but incomplete OneBot /new hook fails closed without changing any dist file', async (t) => {
    const root = await isolatedAdapter(t);
    const middlewarePath = join(root, 'gateway/middleware-setup.js');
    const middleware = await readFile(middlewarePath, 'utf8');
    const cancellation = "        if (ctx.message.content?.trim() === '/new') await directRouter?.cancelConversation(ctx);";
    assert.equal(middleware.split(cancellation).length, 2, 'fixture begins with one direct cancellation call');
    await writeFile(middlewarePath, middleware.replace(cancellation, '        // fixture removed direct cancellation call'));
    const before = await hashes(root);
    await assert.rejects(run(enforcer, [root]), (error) => {
        assert.notEqual(error.code, 0);
        assert.match(error.stderr, /serialized merge middleware, overflow notice, or ordering is incomplete/u);
        return true;
    });
    assert.deepEqual(await hashes(root), before, 'strict rejection performs zero adapter writes');
});
