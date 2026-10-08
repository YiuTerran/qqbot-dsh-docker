// Run inside the built image; exercise the pinned QQ middleware and bootstrap
// without connecting to QQ, OneBot, SeaDice, or a paid model API.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';

const appId = '123456789';
const logger = { info() {}, warn() {}, debug() {}, error() {} };
const dshRoot = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/';
const profilePeers = process.env.QQBOT_PROFILE_PEERS ?? '/data/profiles/qqbot/node_modules/@deepseek-ai';
await mkdir(join(profilePeers, '..'), { recursive: true });
try {
    await symlink(dshRoot, profilePeers, 'dir');
}
catch (error) {
    if (error.code !== 'EEXIST') throw error;
}

const adapterRoot = resolve(process.env.QQBOT_ADAPTER_DIST
    ?? '/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist');
const sdkRoot = resolve(process.env.QQBOT_SDK_ROOT
    ?? '/data/profiles/qqbot/node_modules/@tencent-connect/qqbot-nodejs/dist');
const directModulePath = process.env.QQBOT_ONEBOT_DIRECT_MODULE
    ?? '/opt/qqbot-defaults/qqbot-onebot-direct.mjs';
const defaultsRoot = process.env.QQBOT_NATIVE_DEFAULTS_ROOT ?? '/opt/qqbot-defaults';
const { setupMiddlewares } = await import(pathToFileURL(join(adapterRoot, 'gateway/middleware-setup.js')).href);
const { QQBot } = await import(pathToFileURL(join(sdkRoot, 'QQBot.js')).href);
const { dispatchEvent } = await import(pathToFileURL(join(sdkRoot, 'protocol/gateway/event-dispatcher.js')).href);
const { createOnebotDirectRouter } = await import(pathToFileURL(directModulePath).href);
const { attachOnebotDeliveryObserver } = await import(new URL('./qqbot-onebot-log.mjs', pathToFileURL(directModulePath)).href);
const { registerOnebotCommandTool } = await import(new URL('./qqbot-onebot.mjs', pathToFileURL(directModulePath)).href);
const { getMergedGenerationRequests } = await import(new URL('./qqbot-concurrency.mjs', pathToFileURL(directModulePath)).href);
const { beginOnebotTurn, endOnebotTurn, onebotRequestMetadata, bindOnebotExecution, getBoundOnebotExecution, getBoundOnebotRequest, getOnebotDirectFallback, renderOnebotDirectFallbackMetadata, renderCurrentLogSourceDiagnostics } = await import(new URL('./qqbot-onebot-scope.mjs', pathToFileURL(directModulePath)).href);

function deferred() {
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function gatewayConfig({ requireMention = false, groupAllow = ['busy-group', 'direct-group', 'cancel-group', 'quote-group', 'history-group', 'attachment-group'] } = {}) {
    return {
        appId,
        debug: false,
        access: { c2cMode: 'open', c2cAllow: [], groupMode: 'allowlist', groupAllow },
        requireMention,
        historyLimit: 16,
        maxQueue: 8,
        processingTimeoutMs: 0,
        textChunkLimit: 2000,
        media: { enabled: false, maxMB: 10 },
        vision: {},
    };
}

function makeService(execute) {
    return {
        runtime: {
            config: { enabled: true, backendIds: ['sealdice'] },
            readyBackends: new Set(['sealdice']),
            stopped: false,
        },
        diagnostics() { return { reason: 'ready' }; },
        execute,
        async stop() { this.runtime.stopped = true; },
    };
}

function assembleProductionChain({ service, groupAllow, requireMention = false, sender, manager, env = {}, logger: testLogger = logger } = {}) {
    const directRouter = createOnebotDirectRouter({
        service,
        appId,
        sender,
        env,
        logger: testLogger,
    });
    const layers = [];
    const actualManager = manager ?? { questionChannel: { tryAnswer() { return false; } }, async remove() {} };
    setupMiddlewares({ use(middleware) { layers.push(middleware); } },
        gatewayConfig({ groupAllow, requireMention }), actualManager, testLogger, sender, directRouter, service);
    return { directRouter, layers, manager: actualManager };
}

function makeContext({
    group = 'direct-group',
    senderId = 'member-direct',
    messageId,
    content,
    attachments = [],
    refMsgIdx,
    msgElements,
    rawEventType,
    memberRole,
    raw,
    state = {},
} = {}, replies = []) {
    const replyTarget = { scope: 'group', targetId: group, msgId: messageId };
    const controller = new AbortController();
    const ctx = {
        message: {
            kind: 'group',
            groupOpenid: group,
            senderId,
            senderName: 'native fixture',
            messageId,
            msgIdx: messageId,
            content,
            attachments,
            timestamp: new Date().toISOString(),
            replyTarget,
            ...(rawEventType ? { rawEventType } : {}),
            ...(raw ? { raw } : memberRole ? { raw: {
                group_openid: group,
                author: { member_openid: senderId, member_role: memberRole },
            } } : {}),
            ...(refMsgIdx ? { refMsgIdx } : {}),
            ...(msgElements ? { msgElements } : {}),
        },
        state,
        replyTarget,
        get signal() { return controller.signal; },
        abort(reason) { controller.abort(reason); ctx.stopped = true; ctx.stopReason = reason; },
        log: logger,
        bot: {
            appId,
            async sendMarkdown(target, text) { replies.push({ source: 'bot', target, text }); },
            async sendText(target, text) { replies.push({ source: 'bot', target, text }); },
            async sendTyping() {},
        },
        async reply(text) { replies.push({ source: 'slash', target: replyTarget, text }); },
        stop(reason) { ctx.stopped = true; ctx.stopReason = reason; },
    };
    return ctx;
}

async function runChain(layers, ctx, terminal = async () => {}) {
    let index = 0;
    const next = async () => {
        if (ctx.stopped) return;
        const middleware = layers[index++];
        if (middleware) await middleware(ctx, next);
        else await terminal(ctx);
    };
    await next();
}

async function waitFor(predicate, label) {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

test('native fallback reaches model once with original provenance and sanitized error, bypassing pending answers', async (t) => {
    const sent = [];
    const sender = { async sendMarkdown(target, text) { sent.push({ target, text }); } };
    let attempts = 0;
    let answers = 0;
    const service = makeService(async () => { attempts++; return { status: 'failed', outputs: ['参数不适用 https://secret.invalid/path'] }; });
    const manager = { questionChannel: { tryAnswer() { answers++; return true; } }, async remove() {} };
    const { layers, directRouter } = assembleProductionChain({ service, sender, manager });
    t.after(() => directRouter.stop());
    const ctx = makeContext({ messageId: 'native-fallback', content: '.r2d7' }, sent);
    let models = 0;
    let captured;
    await runChain(layers, ctx, async (modelContext) => {
        models++;
        captured = getMergedGenerationRequests(modelContext);
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].text, '.r2d7', 'sanitized SDK current text is preserved before envelope formatting');
    assert.equal(getOnebotDirectFallback(ctx).reason, 'backend_rejected');
    const metadata = renderOnebotDirectFallbackMetadata(captured);
    assert.ok(metadata.includes('参数不适用'));
    assert.equal(metadata.includes('secret.invalid'), false);
    assert.equal(sent.some(({ text }) => text.includes('未能完成')), false, 'no backend failure notice before model');
    await runChain(layers, makeContext({ messageId: 'native-fallback', content: '.r2d7' }, sent), async () => { models++; });
    assert.equal(attempts, 1);
    assert.equal(models, 1);
    assert.equal(answers, 0, 'a pending tool answer cannot swallow trusted fallback diagnostics');
    const inbound = await readFile(join(adapterRoot, 'transport/inbound.js'), 'utf8');
    assert.ok(inbound.includes('const onebotFallbackMetadata = renderOnebotDirectFallbackMetadata(getMergedGenerationRequests(ctx));'));
});

test('native QQ middleware preserves a current .log capability in the no-quote/no-attachment app-bound snapshot', async (t) => {
    const sender = { async sendMarkdown() {} };
    const service = makeService(async () => assert.fail('direct routing is disabled for this capture-path test'));
    const authLogs = [];
    const testLogger = { info(value) { authLogs.push(value); }, warn(value) { authLogs.push(value); }, debug(value) { authLogs.push(value); } };
    const { layers, directRouter } = assembleProductionChain({ service, sender, logger: testLogger, env: { QQBOT_ONEBOT_DIRECT_ENABLED: 'false' } });
    t.after(() => directRouter.stop());
    const ctx = makeContext({ messageId: 'native-log-current', content: '.log on', raw: {
        id: 'native-log-current', group_openid: 'direct-group',
        author: { member_openid: 'member-direct', member_role: 'owner' },
        content: `<@!${appId}> .log on`,
    } });
    let captured;
    await runChain(layers, ctx, async (modelContext) => { captured = getMergedGenerationRequests(modelContext); });
    assert.equal(ctx.message.replyTarget.targetId, 'direct-group');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].replyTarget.msgId, 'native-log-current');
    assert.equal(captured[0].hasQuote, false);
    assert.equal(captured[0].hasAttachments, false);
    const agent = {};
    const scope = beginOnebotTurn(agent, captured, { appId });
    try {
        const request = onebotRequestMetadata(scope)[0];
        assert.equal(request.currentLogCommand, '.log on');
        assert.deepEqual(request.currentLogSourceStatus,
            { status: 'ready', reason: 'ready', credentialPresent: true,
                rawEventBound: true, selfMentionCount: 0, hasUnresolvedMarkdownMention: false });
        const diagnostics = renderCurrentLogSourceDiagnostics(captured, { appId, toolAvailable: false });
        assert.match(diagnostics, /"status":"ready"/u);
        assert.match(diagnostics, /"onebotToolAvailable":false/u);
        assert.match(diagnostics, /"directRouteReason":"direct_disabled"/u);
        assert.ok(authLogs.some((entry) => entry.includes('[qqbot-onebot-auth]')
            && entry.includes('"stage":"route"') && entry.includes('"reason":"direct_disabled"')));
        assert.ok(authLogs.every((entry) => !entry.includes('native-log-current') && !entry.includes('member-direct')));
    }
    finally { await endOnebotTurn(agent, scope); }
});

test('pinned SDK dispatchEvent and QQBot inbound handler preserve current .log diagnostics', async (t) => {
    const authLogs = [];
    const testLogger = { info(value) { authLogs.push(value); }, warn(value) { authLogs.push(value); }, debug(value) { authLogs.push(value); }, error(value) { authLogs.push(value); } };
    const sender = { async sendMarkdown() {}, async sendText() {} };
    const service = makeService(async () => assert.fail('direct routing is disabled for the SDK dispatch probe'));
    const bot = new QQBot({ appId, appSecret: 'fixture-only-secret', logger: testLogger });
    const directRouter = createOnebotDirectRouter({ service, appId, sender, env: { QQBOT_ONEBOT_DIRECT_ENABLED: 'false' }, logger: testLogger });
    t.after(() => directRouter.stop());
    const manager = { questionChannel: { tryAnswer() { return false; } }, async remove() {} };
    setupMiddlewares(bot, gatewayConfig({ groupAllow: ['direct-group'] }), manager, testLogger, sender, directRouter, service);
    let captured;
    bot.on('message', async (ctx) => { captured = getMergedGenerationRequests(ctx); });
    const rawEvent = {
        id: 'sdk-dispatch-log',
        timestamp: new Date().toISOString(),
        group_openid: 'direct-group',
        author: { member_openid: 'member-direct', username: 'SDK fixture', bot: false, member_role: 'owner' },
        content: '[@蓝色大肥鱼](mqqapi://markdown/mention?at_type=1&at_tinyid=4011912066) .log on',
        mentions: [{ member_openid: '4011912066', id: '4011912066', user_openid: '4011912066', is_you: true }],
        attachments: [],
    };
    const dispatch = dispatchEvent('GROUP_AT_MESSAGE_CREATE', rawEvent, appId, testLogger);
    assert.equal(dispatch.action, 'message');
    assert.equal(dispatch.msg.raw, rawEvent);
    await bot.handleInboundMessage(dispatch.msg);
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0].replyTarget, { scope: 'group', targetId: 'direct-group', msgId: 'sdk-dispatch-log' });
    assert.equal(captured[0].hasQuote, false);
    assert.equal(captured[0].hasAttachments, false);
    assert.equal(captured[0].text, '.log on', 'the SDK sanitizer and raw capture share the validated current self-mention rule');
    const agent = {};
    const scope = beginOnebotTurn(agent, captured, { appId });
    try {
        const request = onebotRequestMetadata(scope)[0];
        assert.equal(request.currentLogCommand, '.log on');
        assert.deepEqual(request.currentLogSourceStatus,
            { status: 'ready', reason: 'ready', credentialPresent: true,
                rawEventBound: true, selfMentionCount: 1, hasUnresolvedMarkdownMention: false });
        const diagnostic = renderCurrentLogSourceDiagnostics(captured, { appId, toolAvailable: false });
        assert.match(diagnostic, /"directRouteReason":"direct_disabled"/u);
        assert.match(diagnostic, /"onebotToolAvailable":false/u);
    }
    finally { await endOnebotTurn(agent, scope); }
    const safeRoute = authLogs.find((entry) => entry.includes('[qqbot-onebot-auth]') && entry.includes('"stage":"route"'));
    assert.match(safeRoute, /"reason":"direct_disabled"/u);
    assert.equal(authLogs.some((entry) => entry.includes('sdk-dispatch-log') || entry.includes('member-direct')
        || entry.includes('fixture-only-secret')), false);
});

test('pinned SDK dispatcher and QQBot handler route current self-mentioned .r2d7 and .log on without model fallback', async (t) => {
    const calls = [];
    const sent = [];
    const testLogger = { info() {}, warn() {}, debug() {}, error() {} };
    const sender = {
        async sendMarkdown(target, text) { sent.push({ target, text }); },
        async sendText(target, text) { sent.push({ target, text }); },
    };
    const service = makeService(async (args) => {
        calls.push(args);
        return { status: 'ok', outputs: [args.command === '.log on' ? 'recording enabled' : '2d7 = 9'] };
    });
    const bot = new QQBot({ appId, appSecret: 'fixture-only-secret', logger: testLogger });
    const directRouter = createOnebotDirectRouter({ service, appId, sender, logger: testLogger });
    t.after(() => directRouter.stop());
    const manager = { questionChannel: { tryAnswer() { return false; } }, async remove() {} };
    setupMiddlewares(bot, gatewayConfig({ groupAllow: ['direct-group'] }), manager, testLogger, sender, directRouter, service);
    let modelMessages = 0;
    bot.on('message', async () => { modelMessages++; });

    for (const [id, command, expected] of [
        ['sdk-dispatch-self-r2d7', '.r2d7', '.r 2d7'],
        ['sdk-dispatch-self-log', '.log on', '.log on'],
    ]) {
        const content = `[@蓝色大肥鱼](mqqapi://markdown/mention?at_type=1&at_tinyid=4011912066)${command.startsWith('.log') ? ' ' : ''}${command}`;
        const rawEvent = {
            id,
            timestamp: new Date().toISOString(),
            group_openid: 'direct-group',
            author: { member_openid: 'member-direct', username: 'SDK fixture', bot: false, member_role: 'owner' },
            content,
            mentions: [{ member_openid: '4011912066', id: '4011912066', user_openid: '4011912066', is_you: true }],
            attachments: [],
        };
        const dispatch = dispatchEvent('GROUP_AT_MESSAGE_CREATE', rawEvent, appId, testLogger);
        assert.equal(dispatch.action, 'message');
        assert.equal(dispatch.msg.raw, rawEvent);
        await bot.handleInboundMessage(dispatch.msg);
    }
    assert.deepEqual(calls.map(({ command }) => command), ['.r 2d7', '.log on']);
    assert.equal(modelMessages, 0, 'the SDK middleware stops both direct commands before model dispatch');
    assert.deepEqual(sent.map(({ text }) => text), ['2d7 = 9', 'recording enabled']);
});

test('native unavailable-backend fallback still renders diagnostics without an available tool', async (t) => {
    let executions = 0;
    const service = makeService(async () => { executions++; assert.fail('unready backend dispatched'); });
    service.runtime.readyBackends.clear();
    const sender = { async sendMarkdown() {} };
    const { layers, directRouter } = assembleProductionChain({ service, sender });
    t.after(() => directRouter.stop());
    let models = 0;
    let metadata;
    await runChain(layers, makeContext({ messageId: 'unready-fallback', content: '.r2d7' }), async (ctx) => {
        models++;
        metadata = renderOnebotDirectFallbackMetadata(getMergedGenerationRequests(ctx));
    });
    assert.equal(models, 1);
    assert.ok(metadata.includes('backend_not_ready'));
    assert.equal(executions, 0);
});

test('direct .set request carries only the role bound to its original SDK event', async (t) => {
    const roles = [];
    const service = makeService(async (args, exec) => {
        const scope = getBoundOnebotExecution(exec);
        roles.push(getBoundOnebotRequest(exec, args.requestId)?.groupRole);
        assert.ok(scope);
        return { status: 'ok', outputs: ['rule changed'] };
    });
    const sender = { async sendMarkdown() {} };
    const { layers, directRouter } = assembleProductionChain({ service, sender });
    t.after(() => directRouter.stop());

    await runChain(layers, makeContext({ messageId: 'direct-set-owner', content: '.set coc7', memberRole: 'owner' }));
    await runChain(layers, makeContext({ messageId: 'direct-set-invalid', content: '.set coc7', memberRole: 'Owner' }));
    assert.deepEqual(roles, ['owner', 'unknown'], 'direct requests keep their own strict SDK role snapshot');
});

test('queued native fallback is cancelled by /new or stop without cancelling the earlier model turn', async (t) => {
    for (const cancel of ['new', 'stop']) {
        const entered = deferred();
        const release = deferred();
        const sender = { async sendMarkdown() {} };
        const service = makeService(async () => ({ status: 'failed', outputs: ['参数不适用'] }));
        const { layers, directRouter } = assembleProductionChain({ service, sender });
        t.after(() => directRouter.stop());
        const busy = makeContext({ group: 'busy-group', messageId: `busy-${cancel}`, content: '普通聊天' });
        const earlier = runChain(layers, busy, async () => { entered.resolve(); await release.promise; });
        await entered.promise;
        const fallback = makeContext({ group: 'busy-group', messageId: `fallback-${cancel}`, content: '.r2d7' });
        let lateModels = 0;
        const queued = runChain(layers, fallback, async () => { lateModels++; });
        await waitFor(() => Boolean(getOnebotDirectFallback(fallback)), 'fallback queued');
        if (cancel === 'new') directRouter.cancelConversation(makeContext({ group: 'busy-group', messageId: 'reset', content: '/new' }));
        else directRouter.stop();
        assert.equal(fallback.signal.aborted, true, 'native getter signal is aborted using ctx.abort');
        assert.equal(busy.signal.aborted, false, 'independent direct lifecycle does not cancel the earlier model');
        release.resolve();
        await Promise.all([earlier, queued]);
        assert.equal(lateModels, 0);
    }
});

test('the real SDK chain routes .r2d7 directly while same-group model work is blocked', async (t) => {
    const calls = [];
    const sent = [];
    const sender = {
        async sendMarkdown(target, text) { sent.push({ target, text }); },
    };
    const service = makeService(async (args, exec) => {
        calls.push({ args, exec });
        return { status: 'ok', outputs: ['2d7 = 9'] };
    });
    const { layers, directRouter } = assembleProductionChain({ service, sender });
    t.after(() => directRouter.stop());

    const middlewareSource = await readFile(join(adapterRoot, 'gateway/middleware-setup.js'), 'utf8');
    const orderedCalls = [
        'bot.use(accessPolicy({',
        'bot.use(mentionGate({',
        'bot.use(contentSanitizer({',
        'bot.use(rateLimiter());',
        '// Chat-only OneBot /new cancellation v1.',
        'bot.use(slash.middleware);',
        '// Chat-only OneBot direct router middleware v1.',
        'bot.use(questionAnswer(manager));',
        '// Chat-only serialized merge guard v1.',
        'bot.use(attachmentProcessor(config, logger));',
    ].map((needle) => middlewareSource.indexOf(needle));
    assert.ok(orderedCalls.every((position) => position >= 0), 'the source contains the complete gated route order');
    assert.ok(orderedCalls.every((position, index) => index === 0 || position > orderedCalls[index - 1]),
        'access, mention, sanitization, rate, /new, slash, direct, QA, merge, and attachment middleware remain ordered');
    assert.ok(layers.includes(directRouter.middleware), 'the actual direct router middleware is installed in the production SDK chain');
    const directIndex = layers.indexOf(directRouter.middleware);
    const rateIndex = layers.findIndex((layer) => /rate-limit/u.test(layer.toString()));
    const mergeIndex = layers.findIndex((layer) => layer.name === 'mergeConcurrencyGuard');
    assert.ok(rateIndex >= 0 && rateIndex < directIndex, 'the native SDK rate limiter runs before direct routing');
    assert.ok(directIndex < mergeIndex, 'direct routing runs before the serialized chat merge guard');

    const modelStarted = deferred();
    const releaseModel = deferred();
    let modelCalls = 0;
    const blockedChat = runChain(layers, makeContext({
        group: 'busy-group', senderId: 'busy-member', messageId: 'busy-chat', content: 'ordinary chat request',
    }, sent), async () => {
        modelCalls++;
        modelStarted.resolve();
        await releaseModel.promise;
    });
    await modelStarted.promise;

    let directModelCalls = 0;
    await runChain(layers, makeContext({
        group: 'busy-group', senderId: 'busy-member', messageId: 'direct-r2d7',
        content: '[@蓝色大肥鱼](mqqapi://markdown/mention?at_type=1&at_tinyid=4011912066).r2d7',
        rawEventType: 'GROUP_AT_MESSAGE_CREATE',
        raw: { id: 'direct-r2d7', group_openid: 'busy-group',
            author: { member_openid: 'busy-member', member_role: 'owner' },
            content: '[@蓝色大肥鱼](mqqapi://markdown/mention?at_type=1&at_tinyid=4011912066).r2d7',
            mentions: [{ member_openid: '4011912066', id: '4011912066', user_openid: '4011912066', is_you: true }] },
    }, sent), async () => { directModelCalls++; });
    assert.equal(calls.length, 1, 'the current .r2d7 message makes exactly one OneBot service call');
    assert.equal(calls[0].args.backend, 'sealdice');
    assert.equal(calls[0].args.command, '.r 2d7');
    assert.equal(Object.hasOwn(calls[0].args, 'ownerId'), false, 'QQ identities are not copied into service arguments');
    assert.equal(Object.hasOwn(calls[0].args, 'replyTarget'), false, 'QQ reply targets are not copied into service arguments');
    assert.equal(directModelCalls, 0, 'the native direct command does not enter the downstream model handler');
    assert.deepEqual(sent.find(({ text }) => text === '2d7 = 9'), {
        target: { scope: 'group', targetId: 'busy-group', msgId: 'direct-r2d7' },
        text: '2d7 = 9',
    }, 'the OneBot result replies to the current SDK message while earlier same-group model work is blocked');
    assert.equal(modelCalls, 1, 'the blocked ordinary message remains the only model turn so far');

    await runChain(layers, makeContext({
        group: 'busy-group', senderId: 'busy-member', messageId: 'direct-log-on',
        content: '[@蓝色大肥鱼](mqqapi://markdown/mention?at_type=1&at_tinyid=4011912066) .log on',
        rawEventType: 'GROUP_AT_MESSAGE_CREATE',
        raw: { id: 'direct-log-on', group_openid: 'busy-group',
            author: { member_openid: 'busy-member', member_role: 'owner' },
            content: '[@蓝色大肥鱼](mqqapi://markdown/mention?at_type=1&at_tinyid=4011912066) .log on',
            mentions: [{ member_openid: '4011912066', id: '4011912066', user_openid: '4011912066', is_you: true }] },
    }, sent), async () => { directModelCalls++; });
    assert.equal(calls.length, 2, 'the current .log on message also makes exactly one service call');
    assert.equal(calls[1].args.command, '.log on');
    assert.equal(directModelCalls, 0, 'both current self-mention commands stay out of the downstream model');

    releaseModel.resolve();
    await blockedChat;
});

test('access, mention, current quote and history context keep direct-looking text out of OneBot', async (t) => {
    const calls = [];
    const sent = [];
    const sender = { async sendMarkdown(target, text) { sent.push({ target, text }); } };
    const service = makeService(async (args) => {
        calls.push(args);
        return { status: 'ok', outputs: ['unexpected direct result'] };
    });
    const { layers, directRouter } = assembleProductionChain({ service, sender });
    t.after(() => directRouter.stop());

    let modelCalls = 0;
    const denied = makeContext({ group: 'denied-group', messageId: 'denied-direct', content: '.r2d7' }, sent);
    await runChain(layers, denied, async () => { modelCalls++; });
    assert.match(denied.stopReason, /^access:/u);
    assert.equal(calls.length, 0, 'access policy blocks direct routing before the OneBot middleware');

    const quote = makeContext({
        group: 'quote-group',
        messageId: 'quoted-direct',
        content: 'What happened in this quote?',
        refMsgIdx: 'quoted-r2d7',
        msgElements: [{ content: '.r2d7', attachments: [{
            content_type: 'image/png', url: 'https://cdn.invalid/quoted.png', filename: 'quoted.png',
        }] }],
    }, sent);
    await runChain(layers, quote, async () => { modelCalls++; });
    assert.match(quote.state.quote?.text ?? '', /\.r2d7/u);
    assert.equal(calls.length, 0, 'a quoted command and quoted attachment do not become the current command');

    const historic = makeContext({
        group: 'history-group',
        messageId: 'history-text',
        content: 'Please explain the earlier roll.',
        state: { history: [{ content: '.r2d7' }] },
    }, sent);
    await runChain(layers, historic, async () => { modelCalls++; });
    assert.equal(calls.length, 0, 'a command in prior history does not execute for the current natural-language message');

    const attached = makeContext({
        group: 'attachment-group',
        messageId: 'attachment-direct',
        content: '.r2d7',
        attachments: [{ content_type: 'image/png', url: 'https://cdn.invalid/current.png', filename: 'current.png' }],
    }, sent);
    await runChain(layers, attached, async () => { modelCalls++; });
    assert.equal(calls.length, 0, 'a current message with attachments continues through normal chat processing');
    assert.equal(modelCalls, 3, 'quoted, historic, and attached inputs continue to downstream chat exactly once');
});

test('mention gating precedes direct routing and sanitized /new cancels the active conversation before slash handling', async (t) => {
    let executeCalls = 0;
    let pendingSignal;
    const started = deferred();
    const sender = { async sendMarkdown() {} };
    const service = makeService(async (_args, exec) => {
        executeCalls++;
        pendingSignal = exec.signal;
        started.resolve();
        return new Promise((_resolve, reject) => {
            exec.signal.addEventListener('abort', () => reject(exec.signal.reason ?? new Error('aborted')), { once: true });
        });
    });
    const gateChain = assembleProductionChain({ service, sender, requireMention: true });
    t.after(() => gateChain.directRouter.stop());
    const unmentioned = makeContext({ group: 'direct-group', messageId: 'unmentioned-direct', content: '.r2d7' });
    await runChain(gateChain.layers, unmentioned);
    assert.match(unmentioned.stopReason, /^mention-gate:/u);
    assert.equal(executeCalls, 0, 'a group command without the required mention never reaches OneBot');

    const slashCalls = [];
    const runChainForCancel = assembleProductionChain({
        service,
        sender,
        manager: {
            questionChannel: { tryAnswer() { return false; } },
            async remove(...args) { slashCalls.push(args); },
        },
    });
    t.after(() => runChainForCancel.directRouter.stop());
    const active = runChain(runChainForCancel.layers, makeContext({
        group: 'cancel-group', senderId: 'cancel-member', messageId: 'active-r2d7', content: '.r2d7',
    }));
    await started.promise;
    const newReply = [];
    await runChain(runChainForCancel.layers, makeContext({
        group: 'cancel-group', senderId: 'cancel-member', messageId: 'new-command', content: '/new',
        rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    }, newReply));
    await active;
    assert.equal(executeCalls, 1, 'the /new message is not mistaken for a second direct dice command');
    assert.equal(pendingSignal.aborted, true, 'the /new middleware aborts the active native execution before the slash command runs');
    assert.deepEqual(slashCalls, [['group', 'cancel-group']],
        'the real /new slash handler removes the current group session after cancellation');
    assert.ok(newReply.some(({ source, text }) => source === 'bot' && text === '已开启新会话 ✓'),
        'the native SDK sends the /new handler result through bot.sendText');
});

test('native @bot log commands use the current SDK sender through direct and model routes', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-native-log-'));
    const calls = [];
    const sent = [];
    const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    const service = registerOnebotCommandTool({ get() { return { register() {} }; } }, {
        appId,
        config: {
            enabled: true, logEnabled: true, hiddenEnabled: false, backendIds: ['sealdice'], masterUsers: [],
            url: new URL('http://native-log.test/mcp'), mcpToken: 'test-mcp', internalToken: 'test-internal',
        },
        fetchImpl: async () => json({ backends: [{ id: 'sealdice', ready: true, version: 1,
            capabilities: ['log-capture-v1', 'group-role-v1'] }] }),
        logCaptureOptions: { filePath: join(directory, 'queue.json'), fetchImpl: async () => json({ accepted: true }) },
        session: {
            async listTools() { return [{ name: 'call_ws' }]; },
            async callWs(args, signal, beforeDispatch) {
                assert.equal(signal.aborted, false);
                assert.equal(await beforeDispatch(), true);
                calls.push(args);
                return { content: [{ type: 'text', text: JSON.stringify({
                    request_id: args.request_id, backend_id: args.backend_id, audience: 'group', status: 'ok',
                    outputs: [{ action: 'send_group_msg', audience: 'group', target_id: 8_000_000_000_000_017,
                        message: 'recording enabled' }],
                }) }] };
            },
        },
        refreshIntervalMs: 60_000,
    });
    const routers = [];
    t.after(async () => {
        for (const router of routers) await router.stop();
        await service.stop();
        await rm(directory, { recursive: true, force: true });
    });
    await service.ready;
    const sender = { async sendMarkdown(target, text) { sent.push({ target, text }); } };
    for (const [index, mode] of [
        { direct: true, quoted: false, role: 'owner', text: '.log on', mentioned: true, allowed: true },
        { direct: false, quoted: true, role: 'owner', text: '.log on', mentioned: true, allowed: true },
        { direct: false, quoted: true, role: 'member', text: '.log on', mentioned: true, allowed: false },
        { direct: false, quoted: true, role: 'owner', text: '解释这条引用', mentioned: true, allowed: false },
        { direct: true, quoted: false, role: 'owner', text: '.log on', mentioned: false, allowed: false },
    ].entries()) {
        const chain = assembleProductionChain({ service, sender, requireMention: true,
            env: { QQBOT_ONEBOT_DIRECT_ENABLED: String(mode.direct) } });
        routers.push(chain.directRouter);
        const messageId = `native-log-${index}`;
        const wireText = `${mode.mentioned ? `<@!${appId}> ` : ''}${mode.text}`;
        const ctx = makeContext({ messageId, content: wireText,
            rawEventType: mode.mentioned ? 'GROUP_AT_MESSAGE_CREATE' : 'GROUP_MESSAGE_CREATE',
            state: mode.quoted ? { quote: { text: '.log on', attachments: [] } } : {},
        });
        ctx.message.raw = {
            id: messageId, timestamp: ctx.message.timestamp, content: wireText, group_openid: 'direct-group',
            author: { member_openid: 'member-direct', member_role: mode.role },
            ...(mode.quoted ? { message_reference: { message_id: 'quoted-log-message' } } : {}),
        };
        let modelCalls = 0;
        let toolResult;
        const before = calls.length;
        await runChain(chain.layers, ctx, async () => {
            modelCalls++;
            const agent = {};
            const scope = beginOnebotTurn(agent, getMergedGenerationRequests(ctx), { appId });
            try {
                const exec = { agent, signal: ctx.signal };
                bindOnebotExecution(exec);
                toolResult = await service.execute({ requestId: onebotRequestMetadata(scope)[0].requestId,
                    backend: 'sealdice', command: '.log on' }, exec);
            }
            finally { await endOnebotTurn(agent, scope); }
        });
        assert.equal(calls.length - before, mode.allowed ? 1 : 0);
        if (!mode.mentioned) assert.equal(modelCalls, 0, 'unmentioned commands retain the mention gate');
        else if (mode.direct && mode.allowed) assert.equal(modelCalls, 0, 'the direct bot route avoids the model');
        else assert.equal(toolResult.status, mode.allowed ? 'ok' : 'failed');
        if (mode.allowed) {
            assert.equal(calls.at(-1).payload, '.log on');
            assert.equal(calls.at(-1).user_key, `${appId}:member-direct`);
            assert.equal(calls.at(-1).group_key, `${appId}:direct-group`);
            assert.equal(calls.at(-1).group_role, 'owner');
        }
    }
});

test('bootstrap executes with stubs and passes the registered service and sender to real middleware setup', async () => {
    const sourcePath = join(adapterRoot, 'gateway/bootstrap.js');
    const original = await readFile(sourcePath, 'utf8');
    const imports = new Map();
    const order = [];
    let lifecycleCleanup;
    let bootServiceOptions;
    let routerOptions;
    let bootBot;
    const observedDeliveries = [];

    const service = {
        observeBotDelivery(event) { observedDeliveries.push(event); },
        async stop() {
            assert.equal(bootBot.send, FakeBot.prototype.send, 'the QQ send observer detaches before service stop');
            order.push('service-stop');
        },
    };
    const fakeRouter = {
        middleware: async (_ctx, next) => next(),
        async cancelConversation() {},
        async stop() { order.push('router-stop'); },
    };
    class FakeBot {
        constructor(options) {
            this.options = options;
            this.middlewares = [];
            this.listeners = new Map();
            bootBot = this;
        }
        use(middleware) {
            if (this.middlewares.length === 0) order.push('middleware-setup');
            this.middlewares.push(middleware);
        }
        on(event, listener) { this.listeners.set(event, listener); return this; }
        openStream() { return {}; }
        async send() { return { id: 'observed-send-id' }; }
        async start() { order.push('bot-start'); }
        stop() { order.push('bot-stop'); }
    }
    class FakeManager {
        constructor() {
            this.questionChannel = { tryAnswer() { return false; } };
        }
        async disposeAll() { order.push('manager-dispose'); }
        async remove() {}
    }
    class FakeQuestionChannel { install() {} }
    class FakeApprovalChannel { install() {} }
    class FakeReplyLimiter { constructor() {} }

    imports.set(`${defaultsRoot}/qqbot-chat-policy.mjs`, {
        installChatPolicy() {}, setOnebotToolAvailable() {},
    });
    imports.set(`${defaultsRoot}/qqbot-onebot.mjs`, {
        registerOnebotCommandTool(_ctx, options) {
            order.push('service-register');
            bootServiceOptions = options;
            return service;
        },
    });
    imports.set(`${defaultsRoot}/qqbot-onebot-log.mjs`, { attachOnebotDeliveryObserver });
    imports.set(`${defaultsRoot}/qqbot-onebot-direct.mjs`, {
        createOnebotDirectRouter(options) {
            order.push('router-create');
            routerOptions = options;
            return fakeRouter;
        },
    });
    imports.set(`${defaultsRoot}/qqbot-generation.mjs`, {
        createGenerationSender() { return {}; },
        registerGenerationTools() {},
    });
    imports.set('@tencent-connect/qqbot-nodejs/protocol', { MediaApi: {}, MessageApi: {}, messagePath: '/messages' });
    imports.set('@tencent-connect/qqbot-nodejs', { QQBot: FakeBot });
    imports.set('../session/index.js', { SessionManager: FakeManager });
    imports.set('../transport/index.js', { handleInbound() {}, createOutboundHandler() { return async () => {}; } });
    imports.set('../transport/reply-limiter.js', { ReplyLimiter: FakeReplyLimiter });
    imports.set('../transport/msgid-cache.js', { cacheMsgId() {}, cacheEventId() {} });
    imports.set('../transport/reply-target.js', {
        resolveReplyTarget(_bot, target) { return target; },
        sendResolvedMarkdown: async () => {},
    });
    imports.set('../features/question-channel.js', { QuestionChannel: FakeQuestionChannel });
    imports.set('../features/approval-channel.js', { ApprovalChannel: FakeApprovalChannel });
    imports.set('../features/button-utils.js', { decodeButtonData() { return undefined; } });
    imports.set('../shared/index.js', { buildUserAgent() { return 'native-direct-test'; } });
    imports.set('./middleware-setup.js', {
        setupMiddlewares(bot, ...args) {
            assert.equal(args[5], service, 'bootstrap gives the registered service to capture middleware setup');
            return setupMiddlewares(bot, ...args);
        },
    });
    imports.set('../media/media-cleaner.js', { startMediaCleanup() {} });
    imports.set('../media/vision-tool.js', { ensureVisionInputModal() {}, registerDescribeImageTool() {} });
    imports.set('../media/send-file-tool.js', { registerSendFileTool() {} });

    const rewritten = original.replace(
        /^import\s+\{\s*([^}\n]+?)\s*\}\s+from\s+(['"])([^'"]+)\2;\s*$/gmu,
        (_match, names, _quote, specifier) => `const { ${names} } = globalThis.__imports.get(${JSON.stringify(specifier)});`,
    );
    assert.equal(/^import\s/mu.test(rewritten), false, 'the pinned bootstrap uses named imports that can be mapped to local stubs');
    const executable = rewritten.replace('export async function bootstrapGateway', 'async function bootstrapGateway')
        + '\nglobalThis.__bootstrapGateway = bootstrapGateway;';
    const vmContext = vm.createContext({
        __imports: imports,
        console,
        process: { env: {} },
        setTimeout,
        clearTimeout,
    });
    vm.runInContext(executable, vmContext, { filename: sourcePath });

    const ctx = {
        get() { return undefined; },
        on() { return this; },
        effect(callback) { lifecycleCleanup = callback(); },
    };
    const config = {
        appId,
        appSecret: 'fixture-secret',
        debug: false,
        access: { c2cMode: 'open', c2cAllow: [], groupMode: 'open', groupAllow: [] },
        historyLimit: 16,
        requireMention: false,
        maxQueue: 8,
        processingTimeoutMs: 0,
        media: { enabled: false, maxMB: 10 },
        vision: {},
    };
    await vmContext.__bootstrapGateway(ctx, {}, config, logger);

    assert.ok(bootServiceOptions?.bot === bootBot, 'bootstrap registers OneBot after constructing the QQ SDK bot');
    assert.notEqual(bootBot.send, FakeBot.prototype.send, 'bootstrap installs the QQ send observer');
    await bootBot.send({ target: { scope: 'group', targetId: 'observer-group' }, markdown: { content: 'confirmed output' } });
    assert.deepEqual(observedDeliveries, [{
        target: { scope: 'group', targetId: 'observer-group' }, status: 'sent',
        messageId: 'observed-send-id', text: 'confirmed output',
    }]);
    assert.ok(routerOptions?.service === service, 'bootstrap gives the registered OneBot service to the router');
    assert.ok(routerOptions?.sender && typeof routerOptions.sender.sendMarkdown === 'function',
        'bootstrap gives the reply sender to the router');
    assert.ok(bootBot.middlewares.includes(fakeRouter.middleware), 'the real setupMiddlewares call installs the router middleware');
    assert.ok(order.indexOf('service-register') < order.indexOf('router-create')
        && order.indexOf('router-create') < order.indexOf('middleware-setup'),
    'service registration and router construction happen before middleware setup');

    await lifecycleCleanup();
    assert.equal(bootBot.send, FakeBot.prototype.send, 'shutdown restores the original QQ send method');
    assert.ok(order.indexOf('router-stop') < order.indexOf('service-stop'),
        'shutdown awaits direct conversation cancellation before stopping the OneBot service');
});
