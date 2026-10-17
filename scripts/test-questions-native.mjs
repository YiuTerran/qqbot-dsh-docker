// Exercise question delivery through the pinned QQ MessageApi with fake HTTP.
// No QQ credentials, remote requests, or model calls are used.
import assert from 'node:assert/strict';
import { mkdir, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const defaultsRoot = process.env.QQBOT_NATIVE_DEFAULTS_ROOT ?? '/opt/qqbot-defaults';
const senderModule = await import(`${defaultsRoot}/qqbot-generation-sender.mjs`);
const { createGenerationSender } = senderModule;
const { QQ_QUESTION_TOOL, QuestionChannel, registerQuestionTool } = await import(
    process.env.QQBOT_QUESTIONS_MODULE ?? `${defaultsRoot}/qqbot-questions.mjs`);
const dshRoot = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/';
const profilePeers = '/data/profiles/qqbot/node_modules/@deepseek-ai';
await mkdir(dirname(profilePeers), { recursive: true });
try { await symlink(dshRoot, profilePeers, 'dir'); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
const sdkRoot = process.env.QQBOT_QQ_SDK_API_ROOT
    ?? '/data/profiles/qqbot/node_modules/@tencent-connect/qqbot-nodejs/dist/protocol/api';
const sdkDist = process.env.QQBOT_SDK_ROOT
    ?? '/data/profiles/qqbot/node_modules/@tencent-connect/qqbot-nodejs/dist';
const adapterDist = process.env.QQBOT_ADAPTER_DIST
    ?? '/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist';
const { MessageApi } = await import(`${sdkRoot}/messages.js`);
const { MediaApi } = await import(`${sdkRoot}/media.js`);
const { QQBot } = await import(pathToFileURL(join(sdkDist, 'QQBot.js')).href);
const { dispatchEvent } = await import(pathToFileURL(join(sdkDist, 'protocol/gateway/event-dispatcher.js')).href);
const { setupMiddlewares } = await import(pathToFileURL(join(adapterDist, 'gateway/middleware-setup.js')).href);
const { createOnebotDirectRouter } = await import(`${defaultsRoot}/qqbot-onebot-direct.mjs`);
const { Context } = await import(`${dshRoot}cordis/lib/index.js`);
const { default: SystemPrompt } = await import(`${dshRoot}dsh-system-prompt/lib/index.js`);
const { default: ToolRuntime } = await import(`${dshRoot}dsh-tools/lib/index.js`);
const { default: WebRuntime } = await import(`${dshRoot}dsh-web/lib/index.js`);
const { installChatPolicy } = await import(`${defaultsRoot}/qqbot-chat-policy.mjs`);
const { resolveReplyTarget, sendResolvedMarkdown } = await import(`${adapterDist}/transport/reply-target.js`);
const { createOutboundHandler } = await import(`${adapterDist}/transport/outbound.js`);
const { UserQuestionService } = await import(`${dshRoot}dsh-user-questions/lib/index.js`);
const { beginGenerationTurn, endGenerationTurn, generationRequestMetadata, getGenerationTurn } = await import(`${defaultsRoot}/qqbot-generation-scope.mjs`);
const { beginDocumentTurn, getDocumentTurn, endDocumentTurn } = await import(`${defaultsRoot}/qqbot-document-scope.mjs`);
const { beginMergeBatch, closeMergeBatch, bindMergeBatchQuestionReply, noteMergeBatchTurnStart } = await import(`${defaultsRoot}/qqbot-concurrency.mjs`);
const logger = { info() {}, warn() {}, debug() {}, error() {} };
const appId = '123456789';

function questionKeyboard() {
    return {
        content: {
            rows: [{
                buttons: [{
                    id: 'choice-a',
                    render_data: { label: 'A', visited_label: 'A', style: 0 },
                    action: {
                        type: 1,
                        permission: { type: 2 },
                        data: JSON.stringify({ t: 'question', q: 'pick', token: 'opaque-token-a', i: 0 }),
                        unsupport_tips: '请回复选项文字',
                    },
                }],
            }],
        },
    };
}

function makeSender({ fetchImpl, tokenManager = { async getAccessToken() { return 'fixture-access-token'; } }, active = () => true } = {}) {
    const requests = [];
    const limiterEvents = [];
    const sender = createGenerationSender({
        bot: { tokenManager },
        replyLimiter: {
            checkLimit(id) { limiterEvents.push(['check', id]); return { allowed: true }; },
            record(id) { limiterEvents.push(['record', id]); },
        },
        sdk: { MessageApi, MediaApi },
        credentials: { appId: 'fixture-app-id', clientSecret: 'fixture-app-secret' },
        fetchImpl: async (url, init) => {
            requests.push({ url: String(url), ...init });
            return fetchImpl(url, init);
        },
    });
    const request = {
        ownerId: 'owner-a',
        replyTarget: { scope: 'group', targetId: 'group-a', msgId: 'message-a' },
        enqueueSend: (operation) => operation(),
        isActive: active,
    };
    return { sender, request, requests, limiterEvents };
}

const ack = (id = 'question-message-1') => new Response(JSON.stringify({ id }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
});

function toolValue(output) {
    assert.equal(output.isError, false, JSON.stringify(output));
    if (Object.hasOwn(output, 'value')) return output.value;
    const text = output.content?.find((part) => part.type === 'text')?.text;
    assert.equal(typeof text, 'string', 'native tools runtime must return rendered tool output');
    return JSON.parse(text);
}

function gatewayConfig() {
    return {
        appId, debug: false,
        access: { c2cMode: 'open', c2cAllow: [], groupMode: 'allowlist', groupAllow: ['group-a'] },
        requireMention: true, historyLimit: 16, maxQueue: 8, processingTimeoutMs: 0,
        textChunkLimit: 2000, media: { enabled: false, maxMB: 10 }, vision: {},
    };
}

function makeRawGroupEvent({ id, senderId, text, mention = false }) {
    const mentionText = '[@蓝色大肥鱼](mqqapi://markdown/mention?at_type=1&at_tinyid=4011912066)';
    const content = mention ? `${mentionText} ${text}` : text;
    return {
        id, timestamp: new Date().toISOString(), group_openid: 'group-a',
        author: { member_openid: senderId, username: 'native fixture', bot: false, member_role: 'member' },
        content,
        mentions: mention ? [{ member_openid: '4011912066', id: '4011912066', user_openid: '4011912066', is_you: true }] : [],
        attachments: [],
    };
}

async function dispatchGroupText(bot, event, mutateContext) {
    const dispatch = dispatchEvent(event.mentions?.length ? 'GROUP_AT_MESSAGE_CREATE' : 'GROUP_MESSAGE_CREATE',
        event, appId, logger);
    assert.equal(dispatch.action, 'message');
    assert.equal(dispatch.msg.raw, event, 'the native QQ dispatcher preserves the SDK event object');
    mutateContext?.(dispatch.msg);
    await bot.handleInboundMessage(dispatch.msg);
}

async function waitFor(predicate, label) {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

test('pinned QQ MessageApi sends a v2-compatible callback keyboard and returns only its ACK', async () => {
    const harness = makeSender({ fetchImpl: async () => ack() });
    assert.equal(typeof MessageApi, 'function', 'test imports the pinned QQ SDK MessageApi');
    const result = await harness.sender.sendQuestionMarkdown(
        harness.request, '请选择一个选项。', questionKeyboard(), new AbortController().signal,
    );
    assert.deepEqual(result, { sent: true, messageId: 'question-message-1' });
    assert.equal(harness.requests.length, 1);
    const request = harness.requests[0];
    assert.equal(request.url, 'https://api.sgroup.qq.com/v2/groups/group-a/messages');
    assert.equal(request.method, 'POST');
    const body = JSON.parse(request.body);
    assert.equal(body.msg_type, 2);
    assert.deepEqual(body.markdown, { content: '请选择一个选项。' });
    assert.equal(body.msg_id, 'message-a');
    assert.deepEqual(body.keyboard.content.rows[0].buttons[0].action.permission,
        { type: 2 });
    const limiterRecords = harness.limiterEvents.filter(([kind]) => kind === 'record');
    assert.deepEqual(limiterRecords, [['record', 'message-a']], 'one acknowledged message records the original reply limit once');
    assert.ok(harness.limiterEvents.filter(([kind]) => kind === 'check')
        .every(([, id]) => id === 'message-a'), 'all limiter checks use the bound original reply id');
});

test('only QQ 304037 returns keyboard-unsupported; ambiguous HTTP outcomes are not retried', async () => {
    const unsupported = makeSender({ fetchImpl: async () => new Response(JSON.stringify({ code: 304037 }), {
        status: 400, headers: { 'content-type': 'application/json' },
    }) });
    assert.deepEqual(await unsupported.sender.sendQuestionMarkdown(
        unsupported.request, '请选择。', questionKeyboard(), new AbortController().signal,
    ), { sent: false, reason: 'keyboard-unsupported' });
    assert.equal(unsupported.requests.length, 1);

    const otherRejection = makeSender({ fetchImpl: async () => new Response(JSON.stringify({ code: 123456 }), {
        status: 400, headers: { 'content-type': 'application/json' },
    }) });
    assert.deepEqual(await otherRejection.sender.sendQuestionMarkdown(
        otherRejection.request, '请选择。', questionKeyboard(), new AbortController().signal,
    ), { sent: false, reason: 'failed' });
    assert.equal(otherRejection.requests.length, 1, 'other QQ rejections are not retried as text');

    const unknown = makeSender({ fetchImpl: async () => { throw new Error('transport lost after POST'); } });
    assert.deepEqual(await unknown.sender.sendQuestionMarkdown(
        unknown.request, '请选择。', questionKeyboard(), new AbortController().signal,
    ), { sent: false, reason: 'unknown' });
    assert.equal(unknown.requests.length, 1, 'unknown delivery is never reposted');
});

test('cancellation while QQ token lookup is pending prevents a late message POST', async () => {
    let tokenRequestedResolve;
    const tokenRequested = new Promise((resolve) => { tokenRequestedResolve = resolve; });
    let tokenResolve;
    const tokenValue = new Promise((resolve) => { tokenResolve = resolve; });
    const harness = makeSender({
        tokenManager: { getAccessToken() { tokenRequestedResolve(); return tokenValue; } },
    });
    const controller = new AbortController();
    const pending = harness.sender.sendQuestionMarkdown(
        harness.request, '请选择。', questionKeyboard(), controller.signal,
    );
    await tokenRequested;
    controller.abort(new Error('fixture cancellation'));
    tokenResolve('fixture-access-token');
    assert.deepEqual(await pending, { sent: false, reason: 'expired' });
    assert.deepEqual(harness.requests, [], 'the active check after token lookup blocks a late POST');
});

test('pinned UserQuestionService and native Tools runtime deliver a real bound question and renew only its live reply batch', async (t) => {
    const ctx = new Context();
    t.after(() => ctx.fiber.dispose());
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime, { mode: 'native' });
    await ctx.plugin(WebRuntime, { fetchProvider: 'qqbot-pages' });
    await ctx.plugin({ inject: ['tools', 'web', 'systemPrompt'], apply: installChatPolicy });

    const agent = { id: 'live-root', session: { seq: 0 } };
    const childAgent = { id: 'live-child', session: { seq: 0 } };
    const liveAgents = new Map([[agent.id, agent], [childAgent.id, childAgent]]);
    const agentsRegistry = {
        get(id) { return liveAgents.get(id); },
        roots() { return [agent]; },
    };
    await ctx.provide('agents', agentsRegistry);
    await ctx.plugin(UserQuestionService, {});
    const record = {
        sessionKey: 'group:group-a', scope: 'group', peerId: 'group-a', agent, sessionId: 'native-session',
        replyTarget: { scope: 'group', targetId: 'group-a', msgId: 'original-message' },
        enqueueSend: (operation) => operation(),
    };
    let sessionActive = true;
    let scope;
    const manager = {
        questionChannel: undefined,
        getSessionRecord(scope, targetId) { return sessionActive && scope === 'group' && targetId === 'group-a' ? record : undefined; },
        findBySessionId(sessionId) { return sessionActive && sessionId === record.sessionId ? record : undefined; },
        async remove() { sessionActive = false; scope?.controller.abort(new Error('fixture session removed')); },
    };
    agent.status = 'running';
    agent.cancel = () => scope?.controller.abort(new Error('fixture agent stopped'));
    const service = ctx.get('userQuestions');
    assert.ok(service instanceof UserQuestionService, 'fixture mounts the pinned service implementation');

    const fetchRequests = [];
    const harness = makeSender({ fetchImpl: async (_url, init) => {
        fetchRequests.push({ ...init, body: JSON.parse(init.body) });
        return ack(`question-message-${fetchRequests.length}`);
    } });
    const channel = new QuestionChannel(manager, harness.sender,
        { appId, requireMention: true, askTimeoutMs: 300_000 }, logger);
    manager.questionChannel = channel;
    channel.install(ctx);
    registerQuestionTool(ctx, channel);
    const directCalls = [];
    const directReplies = [];
    const messageSender = {
        async sendMarkdown(target, content) { directReplies.push({ target, content }); },
        async sendText(target, content) { directReplies.push({ target, content }); },
        async sendTyping() {},
    };
    const onebotService = {
        runtime: { config: { enabled: true, backendIds: ['sealdice'] }, readyBackends: new Set(['sealdice']), stopped: false },
        diagnostics() { return { reason: 'ready' }; },
        async execute(request) { directCalls.push(request); return { status: 'ok', outputs: ['2d7 = 9'] }; },
        async stop() { this.runtime.stopped = true; },
    };
    const directRouter = createOnebotDirectRouter({
        service: onebotService, appId, sender: messageSender, logger,
        env: { QQBOT_ONEBOT_DIRECT_ENABLED: 'true' },
    });
    t.after(() => directRouter.stop());
    const qqBot = new QQBot({ appId, appSecret: 'fixture-only-secret', logger });
    const modelMessages = [];
    qqBot.on('message', (messageContext) => { modelMessages.push(messageContext.message); });
    const interactions = [];
    qqBot.on('interaction', (context, event) => {
        assert.equal(context.event, event);
        interactions.push(channel.handleInteraction(event));
    });
    setupMiddlewares(qqBot, gatewayConfig(), manager, logger, messageSender, directRouter, onebotService);
    let batch = beginMergeBatch(record, record.replyTarget);
    beginDocumentTurn(agent, { content: 'Need a choice from the user.' });
    let documentScope = getDocumentTurn(agent);
    scope = beginGenerationTurn(agent, [{
        ownerId: 'owner-a', replyTarget: record.replyTarget, text: 'Continue with the original request.',
    }], [], { documentScope, record, enqueueSend: record.enqueueSend, isCurrentRecord: () => true });
    const requestId = generationRequestMetadata(scope)[0]?.requestId;
    assert.ok(requestId, 'requestId comes from the original generation request');
    t.after(async () => {
        channel.uninstall();
        await closeMergeBatch(batch);
        await endGenerationTurn(agent, scope);
        await endDocumentTurn(agent, documentScope);
    });

    const catalog = await ctx.systemPrompt.assemble();
    assert.ok(catalog.tools.some((tool) => tool.name === QQ_QUESTION_TOOL), 'native model catalog exposes the tool');
    const args = { requestId, questions: [{
        id: 'pick', header: 'Question one', question: 'Choose one', options: [{ label: 'A' }, { label: 'B' }],
    }, { id: 'next', question: 'Choose another', options: [{ label: 'X' }, { label: 'Y' }],
    }] };
    await assert.rejects(() => service.ask({
        questions: args.questions, agent: { id: 'live-root' }, signal: new AbortController().signal,
    }), (error) => error.code === 'CALLER_NOT_LIVE', 'the service rejects a different object with the same agent id');
    await assert.rejects(() => service.ask({
        questions: args.questions, agent: childAgent, signal: new AbortController().signal,
    }), (error) => error.code === 'DELEGATED_CALLER', 'the service rejects a live delegated child');
    assert.ok(getGenerationTurn(agent), 'the generation scope retains the exact root agent object');
    let blockedBodyCalls = 0;
    let approvalCalls = 0;
    ctx.tools.register({ name: 'bash', description: 'Blocked fixture', parameters: { type: 'object' },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute() { blockedBodyCalls++; return 'forbidden'; } });
    ctx.on('tools/pre-execute', () => { approvalCalls++; return { kind: 'allow' }; });
    assert.equal((await ctx.tools.execute({ name: 'bash', arguments: {}, agent, callId: 'blocked-shell', signal: new AbortController().signal })).isError, true);
    assert.equal(blockedBodyCalls, 0, 'mounting questions does not expose shell execution');
    assert.equal(approvalCalls, 0, 'the actual chat guard refuses shell before approval');
    for (const [invalidAgent, invalidRequestId, callId] of [
        [childAgent, requestId, 'delegated-tool'], [agent, 'unbound-request', 'unbound-tool'],
    ]) {
        const denied = await ctx.tools.execute({ name: QQ_QUESTION_TOOL,
            arguments: { ...args, requestId: invalidRequestId }, agent: invalidAgent, callId, signal: new AbortController().signal });
        assert.equal(denied.isError, true, 'native pre-execution refuses unbound or delegated question tools');
    }
    assert.equal(fetchRequests.length, 0, 'unauthorized tool calls never reach QQ transport');
    const exec = { name: QQ_QUESTION_TOOL, arguments: args, agent, callId: 'native-call', signal: new AbortController().signal };
    const resultPromise = ctx.tools.execute({ ...exec });
    const firstSendOrResult = await Promise.race([
        waitFor(() => fetchRequests.length > 0, 'the initial native question send').then(() => 'sent'),
        resultPromise.then((result) => ({ returned: result })),
    ]);
    assert.equal(firstSendOrResult, 'sent', `question tool ended before its first send: ${JSON.stringify(firstSendOrResult)}`);
    assert.equal(fetchRequests.length, 1);
    assert.equal(fetchRequests[0].body.msg_id, 'original-message');
    assert.match(fetchRequests[0].body.markdown.content, /Question one/u);
    assert.match(fetchRequests[0].body.markdown.content, /1\. A[\s\S]*2\. B/u, 'option order is retained in the rendered question');
    assert.deepEqual(fetchRequests[0].body.keyboard.content.rows[0].buttons[0].action.permission,
        { type: 2 });
    await dispatchGroupText(qqBot, makeRawGroupEvent({ id: 'foreign-question-text', senderId: 'foreign-member', text: '2', mention: true }));
    assert.equal(channel.pending.size, 1, 'a same-group member cannot answer the original owner\'s question');
    assert.equal(modelMessages.length, 1, 'foreign ordinary chat continues through the native QQ middleware chain');
    await dispatchGroupText(qqBot, makeRawGroupEvent({ id: 'spoofed-author', senderId: 'foreign-member', text: '2', mention: true }),
        (message) => { message.senderId = 'owner-a'; });
    await dispatchGroupText(qqBot, makeRawGroupEvent({ id: 'spoofed-group', senderId: 'owner-a', text: '2', mention: true }),
        (message) => { message.raw.group_openid = 'foreign-group'; });
    await dispatchGroupText(qqBot, makeRawGroupEvent({ id: 'spoofed-message-id', senderId: 'owner-a', text: '2', mention: true }),
        (message) => { message.raw.id = 'different-raw-id'; });
    assert.equal(channel.pending.size, 1, 'mismatched raw owner, group, or message id cannot authorize an answer');
    assert.equal(modelMessages.length, 4, 'invalid identity messages proceed through the regular native message path');
    await dispatchGroupText(qqBot, makeRawGroupEvent({ id: 'owner-unmentioned', senderId: 'owner-a', text: '2' }));
    assert.equal(channel.pending.size, 1, 'unmentioned group text cannot answer while @bot is required');
    await dispatchGroupText(qqBot, makeRawGroupEvent({ id: 'owner-direct-command', senderId: 'owner-a', text: '.r2d7', mention: true }));
    assert.equal(directCalls.length, 1, 'a direct native command keeps its normal route while a question is pending');
    assert.ok(directReplies.some(({ content }) => content.includes('2d7 = 9')),
        'the native direct command receives its fake backend response while the tool question remains pending');
    assert.equal(channel.pending.size, 1, 'direct command input is not consumed as a question answer');
    await dispatchGroupText(qqBot, makeRawGroupEvent({ id: 'raw-owner-answer', senderId: 'owner-a', text: '2', mention: true }));
    await waitFor(() => fetchRequests.length >= 2, 'the sequential native question send');
    assert.equal(fetchRequests.length, 2);
    assert.equal(fetchRequests[1].body.msg_id, 'raw-owner-answer', 'the accepted raw QQ message becomes the next reply credential');
    assert.deepEqual(fetchRequests[1].body.keyboard.content.rows[0].buttons[0].action.permission, { type: 2 });
    const secondButton = JSON.parse(fetchRequests[1].body.keyboard.content.rows[0].buttons[0].action.data);
    const interaction = {
        id: 'interaction-2', scene: 'group', chat_type: 1, group_openid: 'group-a',
        group_member_openid: 'owner-a', data: { resolved: { button_data: JSON.stringify(secondButton) } },
    };
    for (const foreign of [{ ...interaction, id: 'foreign-button-user', group_member_openid: 'foreign-member' },
        { ...interaction, id: 'foreign-button-chat', group_openid: 'other-group' }]) {
        const dispatched = dispatchEvent('INTERACTION_CREATE', foreign, appId, logger);
        await qqBot.emit('interaction', { bot: qqBot, event: dispatched.event, state: {} }, dispatched.event);
    }
    assert.equal(channel.pending.size, 1, 'platform-clickable buttons still reject another sender or chat');
    const dispatchedInteraction = dispatchEvent('INTERACTION_CREATE', interaction, appId, logger);
    assert.equal(dispatchedInteraction.action, 'interaction');
    assert.equal(dispatchedInteraction.event, interaction);
    await qqBot.emit('interaction', { bot: qqBot, event: dispatchedInteraction.event, state: {} }, dispatchedInteraction.event);
    assert.deepEqual(interactions, [false, false, true], 'the pinned dispatcher and QQBot callback deliver the raw owner button');
    assert.deepEqual(toolValue(await resultPromise), { status: 'answered', answers: [
        { id: 'pick', selected: ['B'] }, { id: 'next', selected: ['X'] },
    ] });

    const { captureMergeBatchReply } = await import(`${defaultsRoot}/qqbot-concurrency.mjs`);
    const accepted = captureMergeBatchReply(record, { agent, sessionId: record.sessionId });
    assert.deepEqual(accepted.replyRecord.replyTarget, {
        scope: 'group', targetId: 'group-a', eventId: 'INTERACTION_CREATE:interaction-2', questionEvent: true,
    });
    const finalPosts = [];
    // Keep the native QQBot.send and MessageApi body construction; stub only HTTP and token IO.
    qqBot.messageApi = new MessageApi({ async request(token, method, path, body) {
        assert.equal(token, 'fixture-access-token');
        finalPosts.push({ method, path, body });
        return { id: `final-chunk-${finalPosts.length}` };
    } }, { async getAccessToken() { return 'fixture-access-token'; } }, {});
    const finalLimiter = { checkLimit() { return { allowed: true }; }, record() {} };
    const outbound = createOutboundHandler(manager, {
        async sendMarkdown(target, content) {
            return sendResolvedMarkdown(qqBot, resolveReplyTarget(target, finalLimiter, true), content);
        },
    }, { appId, streaming: false, textChunkLimit: 21, showToolResults: false }, logger, {});
    outbound({ header: { id: record.sessionId } }, { type: 'turn/start', seq: 1, data: { turn: 1 } });
    outbound({ header: { id: record.sessionId } }, {
        type: 'assistant/message', seq: 2,
        data: { turn: 1, message: { content: [{ type: 'text', text: 'Final answer part one\nFinal answer part two' }] } },
    });
    await waitFor(() => finalPosts.length === 2, 'the native final reply chunks');
    assert.deepEqual(finalPosts.map(({ method, path, body }) => ({ method, path, ...body })), [
        { method: 'POST', path: '/v2/groups/group-a/messages', msg_type: 2,
            markdown: { content: 'Final answer part one' }, event_id: 'INTERACTION_CREATE:interaction-2', msg_seq: 1 },
        { method: 'POST', path: '/v2/groups/group-a/messages', msg_type: 2,
            markdown: { content: 'Final answer part two' }, event_id: 'INTERACTION_CREATE:interaction-2', msg_seq: 2 },
    ], 'actual final reply chunks share the accepted event credential with distinct QQ message sequences');

    const stopExec = { name: QQ_QUESTION_TOOL,
        arguments: { requestId, questions: [{ id: 'stop-wait', question: 'Waiting for /stop.' }] },
        agent, callId: 'native-stop-call', signal: new AbortController().signal };
    const stopPromise = ctx.tools.execute({ ...stopExec });
    await waitFor(() => fetchRequests.length >= 3, 'the question cancelled by /stop');
    assert.equal(fetchRequests.length, 3, 'a second request is genuinely waiting in the native QQ tool path');
    await dispatchGroupText(qqBot, makeRawGroupEvent({ id: 'native-stop-control', senderId: 'owner-a', text: '/stop', mention: true }));
    assert.deepEqual(toolValue(await stopPromise), { status: 'cancelled', answers: [] },
        'the native /stop command aborts the scoped request signal and releases the pending question');
    assert.equal(channel.pending.size, 0);

    await closeMergeBatch(batch);
    const sendsBeforeLateEvent = finalPosts.length;
    outbound({ header: { id: record.sessionId } }, {
        type: 'assistant/message', seq: 20,
        data: { turn: 1, message: { content: [{ type: 'text', text: 'Late final reply after stop' }] } },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finalPosts.length, sendsBeforeLateEvent,
        'the native outbound handler suppresses late model replies after the question batch closes');
    await endGenerationTurn(agent, scope);
    await endDocumentTurn(agent, documentScope);
    sessionActive = true;
    batch = beginMergeBatch(record, record.replyTarget);
    beginDocumentTurn(agent, { content: 'Need a fresh choice before /new.' });
    documentScope = getDocumentTurn(agent);
    scope = beginGenerationTurn(agent, [{
        ownerId: 'owner-a', replyTarget: record.replyTarget, text: 'Start a fresh request.',
    }], [], { documentScope, record, enqueueSend: record.enqueueSend, isCurrentRecord: () => true });
    const newRequestId = generationRequestMetadata(scope)[0]?.requestId;
    assert.ok(newRequestId);
    const newExec = { name: QQ_QUESTION_TOOL,
        arguments: { requestId: newRequestId, questions: [{ id: 'new-wait', question: 'Waiting for /new.' }] },
        agent, callId: 'native-new-call', signal: new AbortController().signal };
    const newPromise = ctx.tools.execute({ ...newExec });
    await waitFor(() => fetchRequests.length >= 4, 'the question cancelled by /new');
    assert.equal(fetchRequests.length, 4, 'the fresh question is pending before /new is dispatched');
    await dispatchGroupText(qqBot, makeRawGroupEvent({ id: 'native-new-control', senderId: 'owner-a', text: '/new', mention: true }));
    assert.deepEqual(toolValue(await newPromise), { status: 'cancelled', answers: [] },
        'the native /new command removes the live session and releases its pending question');
    assert.equal(channel.pending.size, 0);

    assert.equal(bindMergeBatchQuestionReply(record, {}, record.sessionId, record.replyTarget), false,
        'a foreign agent cannot bind a reply-renewal capability');
    const staleRenewal = bindMergeBatchQuestionReply(record, agent, record.sessionId, record.replyTarget);
    assert.equal(typeof staleRenewal, 'function');
    await closeMergeBatch(batch);
    const nextBatch = beginMergeBatch(record, record.replyTarget);
    assert.equal(noteMergeBatchTurnStart(record, { sessionId: record.sessionId, turnId: 2, seq: 21 }), true);
    assert.equal(staleRenewal({ scope: 'group', targetId: 'group-a', msgId: 'late-answer' }), false,
        'a delayed answer capability cannot renew a later inbound batch');
    assert.deepEqual(captureMergeBatchReply(record, { agent, sessionId: record.sessionId }).replyRecord.replyTarget,
        record.replyTarget, 'a stale answer leaves the newer batch on its own original credential');
    await closeMergeBatch(nextBatch);
    assert.equal(harness.requests.length, 4, 'only the requested question sends reach the fake QQ transport');
});


test('native C2C raw messages and callbacks bind the peer owner without a group mention', async (t) => {
    const ctx = new Context();
    t.after(() => ctx.fiber.dispose());
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime, { mode: 'native' });
    await ctx.plugin(WebRuntime, { fetchProvider: 'qqbot-pages' });
    await ctx.plugin({ inject: ['tools', 'web', 'systemPrompt'], apply: installChatPolicy });
    const agent = { id: 'c2c-root', session: { seq: 0 } };
    await ctx.provide('agents', { get(id) { return id === agent.id ? agent : undefined; }, roots() { return [agent]; } });
    await ctx.plugin(UserQuestionService, {});
    const target = { scope: 'c2c', targetId: 'owner-c2c', msgId: 'original-c2c' };
    const record = { sessionKey: 'c2c:owner-c2c', scope: 'c2c', peerId: 'owner-c2c', agent,
        sessionId: 'c2c-session', replyTarget: target, enqueueSend: (operation) => operation() };
    const manager = {
        getSessionRecord(scope, peerId) { return scope === 'c2c' && peerId === 'owner-c2c' ? record : undefined; },
        findBySessionId(id) { return id === record.sessionId ? record : undefined; },
    };
    const harness = makeSender({ fetchImpl: async () => ack(`c2c-question-${harness.requests.length}`) });
    const channel = new QuestionChannel(manager, harness.sender, { appId, requireMention: true }, logger);
    manager.questionChannel = channel;
    channel.install(ctx);
    registerQuestionTool(ctx, channel);
    const bot = new QQBot({ appId, appSecret: 'fixture-secret', logger });
    setupMiddlewares(bot, gatewayConfig(), manager, logger, { async sendTyping() {} });
    const batch = beginMergeBatch(record, target);
    beginDocumentTurn(agent, { content: 'Need two private choices.' });
    const documentScope = getDocumentTurn(agent);
    const scope = beginGenerationTurn(agent, [{ ownerId: 'owner-c2c', replyTarget: target, text: 'Private request' }], [],
        { documentScope, record, enqueueSend: record.enqueueSend, isCurrentRecord: () => true });
    t.after(async () => {
        channel.uninstall();
        await closeMergeBatch(batch);
        await endGenerationTurn(agent, scope);
        await endDocumentTurn(agent, documentScope);
    });
    const requestId = generationRequestMetadata(scope)[0].requestId;
    const result = ctx.tools.execute({ name: QQ_QUESTION_TOOL, agent, callId: 'private-question', signal: new AbortController().signal,
        arguments: { requestId, questions: [
            { id: 'private-one', question: 'Pick A or B', options: [{ label: 'A' }, { label: 'B' }] },
            { id: 'private-two', question: 'Pick X or Y', options: [{ label: 'X' }, { label: 'Y' }] },
        ] } });
    await waitFor(() => harness.requests.length === 1, 'the first private question');
    assert.equal(harness.requests[0].url, 'https://api.sgroup.qq.com/v2/users/owner-c2c/messages');
    const firstBody = JSON.parse(harness.requests[0].body);
    assert.equal(firstBody.msg_id, 'original-c2c');
    const raw = { id: 'private-answer-one', author: { user_openid: 'owner-c2c' }, content: '2',
        timestamp: new Date().toISOString(), attachments: [] };
    const dispatched = dispatchEvent('C2C_MESSAGE_CREATE', raw, appId, logger);
    assert.equal(dispatched.msg.raw, raw);
    await bot.handleInboundMessage(dispatched.msg);
    await waitFor(() => harness.requests.length === 2, 'the second private question');
    assert.equal(JSON.parse(harness.requests[1].body).msg_id, 'private-answer-one');
    const button = JSON.parse(harness.requests[1].body).keyboard.content.rows[0].buttons[0].action.data;
    const event = { id: 'private-button', scene: 'c2c', chat_type: 2, user_openid: 'owner-c2c',
        data: { resolved: { button_data: button } } };
    assert.equal(channel.handleInteraction({ ...event, group_openid: 'group-a' }), false,
        'mixed group and C2C identities cannot authorize a private answer');
    assert.equal(channel.handleInteraction({ ...event, user_openid: 'other-peer' }), false);
    let accepted;
    bot.on('interaction', (_ctx, callback) => { accepted = channel.handleInteraction(callback); });
    const callback = dispatchEvent('INTERACTION_CREATE', event, appId, logger);
    await bot.emit('interaction', { bot, event: callback.event, state: {} }, callback.event);
    assert.equal(accepted, true);
    assert.deepEqual(toolValue(await result), { status: 'answered', answers: [
        { id: 'private-one', selected: ['B'] }, { id: 'private-two', selected: ['X'] },
    ] });
});


test('native outbound hides question answers and errors even when tool results are enabled', async (t) => {
    for (const outcome of ['answered', 'failed-status', 'execution-error']) {
        const agent = { session: { seq: 0 } };
        const target = { scope: 'group', targetId: 'receipt-group', msgId: `receipt-source-${outcome}` };
        const record = { sessionKey: 'group:receipt-group', scope: 'group', peerId: 'receipt-group', agent,
            sessionId: `receipt-session-${outcome}`, replyTarget: target };
        const manager = { findBySessionId(id) { return id === record.sessionId ? record : undefined; } };
        const batch = beginMergeBatch(record, target);
        t.after(() => closeMergeBatch(batch));
        const sent = [];
        const handler = createOutboundHandler(manager, {
            async sendMarkdown(actualTarget, content) { sent.push({ target: actualTarget, content }); },
        }, { appId, streaming: false, textChunkLimit: 2000, showToolResults: true }, logger, {});
        const session = { header: { id: record.sessionId } };
        const emit = (type, seq, data) => handler(session, { type, seq, data: { turn: 1, ...data } });
        const callId = `question-receipt-${outcome}`;
        const value = outcome === 'answered'
            ? { status: 'answered', answers: [{ id: 'private-choice', selected: ['B'], custom: 'private user answer' }] }
            : { status: 'failed', answers: [] };
        emit('turn/start', 1, {});
        emit('tool/call', 2, { callId, name: QQ_QUESTION_TOOL, arguments: '{}' });
        emit('tool/result', 3, {
            ...(outcome === 'execution-error' ? { error: { code: 'UNKNOWN', message: 'private question error' } } : {}),
            message: { source: { callId }, content: [{ type: 'tool-result',
                isError: outcome === 'execution-error', content: [{ type: 'text', text: JSON.stringify(value) }],
            }] },
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(sent, [], `${outcome}: the raw question receipt is not shown as a QQ message`);
        emit('turn/end', 4, { reason: { kind: 'completed' } });
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(sent, [], `${outcome}: question errors do not trigger an extra generic tool-failure notice`);
        handler(session, { type: 'turn/start', seq: 5, data: { turn: 2 } });
        handler(session, { type: 'assistant/message', seq: 6, data: { turn: 2,
            message: { content: [{ type: 'text', text: '普通最终回复' }] },
        } });
        handler(session, { type: 'turn/end', seq: 7, data: { turn: 2, reason: { kind: 'completed' } } });
        await closeMergeBatch(batch);
        assert.deepEqual(sent, [{ target, content: '普通最终回复' }],
            `${outcome}: the real outbound handler still delivers an ordinary assistant reply`);
    }
});
