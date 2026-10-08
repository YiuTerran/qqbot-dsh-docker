import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultsRoot = process.env.QQBOT_ONEBOT_MODULE_ROOT ?? fileURLToPath(new URL('../defaults', import.meta.url));
const directModule = await import(pathToFileURL(join(defaultsRoot, 'qqbot-onebot-direct.mjs')).href);
const scopeModule = await import(pathToFileURL(join(defaultsRoot, 'qqbot-onebot-scope.mjs')).href);
const onebotModule = await import(pathToFileURL(join(defaultsRoot, 'qqbot-onebot.mjs')).href);
const { matchOnebotDirectCommand, createOnebotDirectRouter } = directModule;
const { beginOnebotTurn, endOnebotTurn, getOnebotBridgeRequestId, getOnebotTurn, onebotRequestMetadata,
    getOnebotDirectFallback, bindOnebotExecution, renderOnebotDirectFallbackMetadata } = scopeModule;
const { registerOnebotCommandTool } = onebotModule;

const APP_ID = '1234567890123456';
const USER_ID = 'user_123';
const GROUP_ID = 'group_456';

function context({
    content = '.r2d7/card',
    senderId = USER_ID,
    scope = 'group',
    targetId = GROUP_ID,
    msgId = 'msg_1',
    attachments = [],
    quoteAttachments = [],
} = {}) {
    return {
        message: {
            kind: scope,
            content,
            senderId,
            attachments,
            replyTarget: { scope, targetId, msgId },
        },
        state: { quote: { attachments: quoteAttachments } },
    };
}

function fakeService({ backends = ['sealdice'], ready = backends, execute, registered = true } = {}) {
    const runtime = {
        config: { enabled: true, backendIds: [...backends] },
        readyBackends: new Set(ready),
        stopped: false,
        registered,
        available: registered,
    };
    return {
        enabled: true,
        runtime,
        diagnostics() { return { reason: runtime.registered ? 'ready' : 'register-failed' }; },
        async execute(args, exec) {
            return execute ? await execute(args, exec) : { status: 'ok', outputs: ['2d7 = 9'] };
        },
    };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

test('SeaDice direct matcher accepts only safe full-line forms and keeps compact boundaries clear', () => {
    assert.deepEqual(matchOnebotDirectCommand('.r2d7/card'), { command: '.r 2d7/card' });
    assert.deepEqual(matchOnebotDirectCommand('.rhD100'), { issue: 'hidden_disabled' });
    assert.deepEqual(matchOnebotDirectCommand('.ra力量'), { command: '.ra 力量' });
    assert.deepEqual(matchOnebotDirectCommand('.rc敏捷'), { command: '.rc 敏捷' });
    assert.deepEqual(matchOnebotDirectCommand('.st意志'), { command: '.st 意志' });
    assert.deepEqual(matchOnebotDirectCommand('.en敏捷'), { command: '.en 敏捷' });
    assert.deepEqual(matchOnebotDirectCommand('.set coc7'), { command: '.set coc7' });
    assert.deepEqual(matchOnebotDirectCommand('.pc show'), { command: '.pc show' });
    assert.deepEqual(matchOnebotDirectCommand('.r malformed-dice'), { command: '.r malformed-dice' },
        'the backend owns ordinary dice-parameter parsing');
    assert.equal(matchOnebotDirectCommand('.log 还有啥指令'), undefined, 'a help question is not a command attempt');
    assert.equal(matchOnebotDirectCommand('.log help'), undefined, 'help remains ordinary chat');
    assert.deepEqual(matchOnebotDirectCommand('.log on --format=txt'), { issue: 'command_not_allowed' });
    assert.deepEqual(matchOnebotDirectCommand('.master add QQ:1234567890123456'), { issue: 'command_not_allowed' });
    assert.deepEqual(matchOnebotDirectCommand('.set clr'), { issue: 'command_not_allowed' });
    assert.deepEqual(matchOnebotDirectCommand('.ww set'), { issue: 'command_not_allowed' });
    assert.deepEqual(matchOnebotDirectCommand('.coc 11'), { issue: 'command_not_allowed' });
    assert.deepEqual(matchOnebotDirectCommand('.find Alice --num=11'), { issue: 'command_not_allowed' });
    for (const content of [
        '.random', '.rdelete', '.rdata', '.pcshow', '.scskill',
        '.r 1d100\nplease explain', 'plain text',
    ]) assert.equal(matchOnebotDirectCommand(content), undefined, content);
});

test('log help questions reach the LLM while unsupported operations hand off without tool execution', async () => {
    const sent = [];
    const executed = [];
    const service = fakeService({ execute(args) {
        executed.push(args);
        return { status: 'ok', outputs: ['should not run'] };
    } });
    const router = createOnebotDirectRouter({
        service, appId: APP_ID,
        sender: { async sendMarkdown(_target, text) { sent.push(text); } },
        env: { QQBOT_ONEBOT_ENABLED: 'true' },
    });
    const question = context({ content: '@蓝色大肥鱼 .log 还有啥指令', msgId: 'log-help-question' });
    let modelHandoffs = 0;
    await router.middleware(question, async () => { modelHandoffs++; });
    assert.equal(modelHandoffs, 1);
    assert.equal(executed.length, 0, 'help is answered in the model path without a backend call');
    assert.equal(sent.length, 0, 'the direct router does not send a fixed refusal for help');
    assert.equal(getOnebotDirectFallback(question), undefined, 'ordinary help is not a failed backend attempt');

    for (const [index, text, expectedReason] of [
        [0, '.rh 1d20', 'hidden_disabled'],
        [1, '.master add QQ:1234567890123456', 'command_not_allowed'],
        [2, '.set clr', 'command_not_allowed'],
        [3, '.log on --format=txt', 'command_not_allowed'],
    ]) {
        const blocked = context({ content: text, msgId: `blocked-policy-${index}` });
        await router.middleware(blocked, async () => { modelHandoffs++; });
        assert.equal(getOnebotDirectFallback(blocked)?.reason, expectedReason);
    }
    assert.equal(modelHandoffs, 5, 'blocked operations are handed to the LLM for explanation');
    assert.equal(executed.length, 0, 'policy handoffs never dispatch to OneBot');
    assert.equal(sent.length, 0, 'the user receives the model explanation instead of a fixed direct reply');
    router.stop();
});

test('direct log commands get an artifact delivery deadline without extending ordinary dice commands', async () => {
    const observed = [];
    const service = fakeService({ execute(args, exec) {
        observed.push([args.command, getOnebotTurn(exec.agent)?.expiryTimer?._idleTimeout]);
        return { status: 'ok', outputs: ['done'] };
    } });
    const router = createOnebotDirectRouter({
        service, appId: APP_ID,
        sender: { async sendMarkdown() { return { id: 'sent' }; } },
        env: { QQBOT_ONEBOT_ENABLED: 'true' },
    });
    try {
        await router.middleware(context({ content: '.log list', msgId: 'log-deadline' }));
        await router.middleware(context({ content: '.r 1d20', msgId: 'dice-deadline' }));
        assert.deepEqual(observed, [
            ['.log list', 145_000 + 4 * 10_000 + 1000],
            ['.r 1d20', 35_000 + 4 * 10_000 + 1000],
        ]);
    }
    finally { await router.stop(); }
});

test('backend policies resolve unique matches, explicit defaults, conflicts, and unavailable defaults without failover', async () => {
    const sent = [];
    const executed = [];
    const service = fakeService({ backends: ['alpha', 'beta'], ready: ['alpha', 'beta'], execute(args) {
        executed.push(args.backend);
        return { status: 'ok', outputs: [args.backend] };
    } });
    const policies = {
        alpha: { family: 'test-alpha', match(text) {
            return ['.alpha', '.both'].includes(text) ? { command: text } : undefined;
        } },
        beta: { family: 'test-beta', match(text) {
            return ['.both', '.beta'].includes(text) ? { command: text } : undefined;
        } },
    };
    const router = createOnebotDirectRouter({
        service, appId: APP_ID, sender: { async sendMarkdown(_target, text) { sent.push(text); } },
        env: { QQBOT_ONEBOT_ENABLED: 'true' }, policies,
    });
    await router.middleware(context({ content: '.alpha', msgId: 'policy-unique' }), async () => assert.fail('policy command must be intercepted'));
    const conflict = context({ content: '.both', msgId: 'policy-conflict' });
    let handoffs = 0;
    await router.middleware(conflict, async () => { handoffs++; });
    assert.deepEqual(executed, ['alpha']);
    assert.equal(sent[0], 'alpha');
    assert.equal(handoffs, 1);
    assert.equal(getOnebotDirectFallback(conflict).reason, 'backend_conflict');
    assert.equal(sent.length, 1);
    router.stop();

    const defaulted = createOnebotDirectRouter({
        service, appId: APP_ID, sender: { async sendMarkdown(_target, text) { sent.push(text); } },
        env: { QQBOT_ONEBOT_ENABLED: 'true', QQBOT_ONEBOT_DEFAULT_BACKEND: 'beta' }, policies,
    });
    await defaulted.middleware(context({ content: '.both', msgId: 'policy-default' }), async () => assert.fail('defaulted policy command must be intercepted'));
    assert.deepEqual(executed, ['alpha', 'beta']);
    assert.equal(sent[1], 'beta');
    defaulted.stop();

    service.runtime.readyBackends = new Set(['alpha']);
    const unavailableDefault = createOnebotDirectRouter({
        service, appId: APP_ID, sender: { async sendMarkdown(_target, text) { sent.push(text); } },
        env: { QQBOT_ONEBOT_ENABLED: 'true', QQBOT_ONEBOT_DEFAULT_BACKEND: 'beta' }, policies,
    });
    const unready = context({ content: '.both', msgId: 'policy-default-unready' });
    await unavailableDefault.middleware(unready, async () => { handoffs++; });
    assert.deepEqual(executed, ['alpha', 'beta'], 'the router does not fail over to another matching ready backend');
    assert.equal(handoffs, 2);
    assert.equal(getOnebotDirectFallback(unready).reason, 'backend_not_ready');
    assert.equal(sent.length, 2);
    unavailableDefault.stop();
});

test('direct call uses one fresh private scope, shared execute arguments, stable event ID, and duplicate suppression', async () => {
    const sent = [];
    const calls = [];
    const service = fakeService({
        registered: false,
        execute(args, exec) {
            const scope = getOnebotTurn(exec.agent);
            const metadata = onebotRequestMetadata(scope)[0];
            calls.push({ args, exec, scope, metadata, bridgeId: getOnebotBridgeRequestId(scope, metadata.requestId, args.backend) });
            return { status: 'ok', outputs: ['2d7 = 9'] };
        },
    });
    const router = createOnebotDirectRouter({
        service,
        appId: APP_ID,
        sender: { async sendMarkdown(target, content) { sent.push({ target, content }); } },
        env: { QQBOT_ONEBOT_ENABLED: 'true' },
    });
    const llmAgent = {};
    const llmScope = beginOnebotTurn(llmAgent, [{
        ownerId: USER_ID,
        replyTarget: { scope: 'group', targetId: GROUP_ID, msgId: 'llm_msg' },
        text: 'existing model turn',
    }], { appId: APP_ID });
    const original = context();
    let nextCalls = 0;
    await router.middleware(original, async () => { nextCalls++; });
    assert.equal(nextCalls, 0);
    assert.equal(calls.length, 1, 'a ready backend remains directly usable when MCP tool registration failed');
    assert.deepEqual(Object.keys(calls[0].args).sort(), ['backend', 'command', 'requestId']);
    assert.deepEqual(calls[0].args, {
        requestId: calls[0].metadata.requestId,
        backend: 'sealdice',
        command: '.r 2d7/card',
    });
    assert.equal(calls[0].exec.agent === llmAgent, false);
    assert.equal(calls[0].scope.direct, true);
    assert.deepEqual(calls[0].scope.directAuthorization, { backend: 'sealdice', command: '.r 2d7/card' });
    assert.equal(getOnebotTurn(llmAgent), llmScope, 'direct calls leave the LLM turn untouched');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], {
        target: { scope: 'group', targetId: GROUP_ID, msgId: 'msg_1' },
        content: '2d7 = 9',
    });

    const sameEventDifferentText = context({ content: '.r9d20', msgId: 'msg_1' });
    await router.middleware(sameEventDifferentText, async () => { nextCalls++; });
    assert.equal(calls.length, 1, 'message ID cache ignores changed command text for the same original event');
    assert.equal(sent.length, 1, 'duplicate event does not deliver a second result');

    const secondHolder = {};
    const sameSourceScope = beginOnebotTurn(secondHolder, [{
        ownerId: USER_ID,
        replyTarget: { scope: 'group', targetId: GROUP_ID, msgId: 'msg_1' },
        text: '.r9d20',
    }], { appId: APP_ID, direct: true });
    const secondMeta = onebotRequestMetadata(sameSourceScope)[0];
    assert.equal(getOnebotBridgeRequestId(sameSourceScope, secondMeta.requestId, 'sealdice'), calls[0].bridgeId,
        'bridge invocation identity is based on trusted event fields, not the command');
    await endOnebotTurn(secondHolder, sameSourceScope);
    await endOnebotTurn(llmAgent, llmScope);
    router.stop();
});

test('attachments and disabled direct mode pass through; not-ready service hands off without dispatch', async () => {
    let executions = 0;
    let nextCalls = 0;
    const sent = [];
    const sender = { async sendMarkdown(_target, content) { sent.push(content); } };
    const service = fakeService({ execute() { executions++; return { status: 'ok', outputs: ['done'] }; } });
    const router = createOnebotDirectRouter({ service, appId: APP_ID, sender, env: { QQBOT_ONEBOT_ENABLED: 'true' } });
    await router.middleware(context({ attachments: [{}] }), async () => { nextCalls++; });
    await router.middleware(context({ quoteAttachments: [{}] }), async () => { nextCalls++; });
    assert.equal(nextCalls, 2);
    assert.equal(executions, 0);

    const disabled = createOnebotDirectRouter({
        service,
        appId: APP_ID,
        sender,
        env: { QQBOT_ONEBOT_ENABLED: 'true', QQBOT_ONEBOT_DIRECT_ENABLED: 'false' },
    });
    await disabled.middleware(context({ msgId: 'disabled' }), async () => { nextCalls++; });
    assert.equal(nextCalls, 3);
    disabled.stop();

    service.runtime.readyBackends.clear();
    await router.middleware(context({ msgId: 'not_ready' }), async () => { nextCalls++; });
    assert.equal(nextCalls, 4, 'unready backend is explained through the LLM');
    assert.equal(sent.length, 0);
    assert.equal(executions, 0);
    router.stop();
});

test('concurrent duplicate events are suppressed, and cancellation isolates group from C2C', async () => {
    const started = deferred();
    const gates = [];
    const calls = [];
    const service = fakeService({ execute(args, exec) {
        const gate = deferred();
        calls.push({ args, exec, gate });
        gates.push(gate);
        if (calls.length === 2) started.resolve();
        return gate.promise;
    } });
    const sent = [];
    const router = createOnebotDirectRouter({
        service,
        appId: APP_ID,
        sender: { async sendMarkdown(target, content) { sent.push({ target, content }); } },
        env: { QQBOT_ONEBOT_ENABLED: 'true' },
    });
    const groupCtx = context({ msgId: 'group-event' });
    const c2cCtx = context({ content: '.ra力量', senderId: 'peer_22', scope: 'c2c', targetId: 'peer_22', msgId: 'private-event' });
    const groupTask = router.middleware(groupCtx, async () => assert.fail('direct command must be intercepted'));
    const c2cTask = router.middleware(c2cCtx, async () => assert.fail('direct command must be intercepted'));
    await started.promise;
    const duplicate = await router.middleware(groupCtx, async () => assert.fail('duplicate must be suppressed'));
    assert.equal(duplicate, undefined);
    assert.equal(calls.length, 2);
    assert.equal(router.cancelConversation(groupCtx), 1);
    assert.equal(calls[0].exec.signal.aborted, true);
    assert.equal(calls[1].exec.signal.aborted, false, 'C2C execution has an independent scope');
    gates[0].resolve({ status: 'ok', outputs: ['late group roll'] });
    gates[1].resolve({ status: 'ok', outputs: ['private check'] });
    await Promise.all([groupTask, c2cTask]);
    assert.deepEqual(sent, [{
        target: { scope: 'c2c', targetId: 'peer_22', msgId: 'private-event' },
        content: 'private check',
    }]);
    router.stop();
});

test('stop suppresses in-flight results and never sends later direct requests to the LLM', async () => {
    const gate = deferred();
    const started = deferred();
    const calls = [];
    const sent = [];
    const service = fakeService({ execute(args, exec) {
        calls.push({ args, exec });
        started.resolve();
        return gate.promise;
    } });
    const router = createOnebotDirectRouter({
        service,
        appId: APP_ID,
        sender: { async sendMarkdown(_target, content) { sent.push(content); } },
        env: { QQBOT_ONEBOT_ENABLED: 'true' },
    });
    const activeTask = router.middleware(context({ msgId: 'stop-active' }), async () => assert.fail('direct command must be intercepted'));
    await started.promise;
    router.stop();
    assert.equal(calls[0].exec.signal.aborted, true);
    let nextCalls = 0;
    await router.middleware(context({ msgId: 'after-stop' }), async () => { nextCalls++; });
    assert.equal(nextCalls, 0);
    gate.resolve({ status: 'ok', outputs: ['late result'] });
    await activeTask;
    assert.deepEqual(sent, []);
});

test('dispatched timeout and connection uncertainty are delivered without retry and logs contain only fixed metadata', async () => {
    let dispatches = 0;
    const sent = [];
    const logs = [];
    const service = registerOnebotCommandTool({ get() { return { register() {} }; } }, {
        appId: APP_ID,
        config: {
            enabled: true, hiddenEnabled: false, backendIds: ['sealdice'],
            url: new URL('http://bridge.example/mcp'), mcpToken: 'mcp-token', internalToken: 'internal-token',
        },
        refreshIntervalMs: 60_000,
        fetchImpl: async () => new Response(JSON.stringify({ backends: [{ id: 'sealdice', version: 1, ready: true }] }), {
            status: 200, headers: { 'content-type': 'application/json' },
        }),
        session: {
            async listTools() { return [{ name: 'call_ws' }]; },
            async callWs(_args, _signal, onDispatch) {
                dispatches++;
                assert.equal(await onDispatch(), true, 'the simulated remote call has crossed dispatch');
                const error = new Error('secret command and token must never be logged');
                if (dispatches === 1) error.name = 'TimeoutError';
                throw error;
            },
        },
    });
    assert.equal(await service.ready, true);
    const router = createOnebotDirectRouter({
        service,
        appId: APP_ID,
        sender: { async sendMarkdown(_target, content) { sent.push(content); } },
        env: { QQBOT_ONEBOT_ENABLED: 'true' },
        logger: { info(line) { logs.push(line); } },
    });
    const timeoutEvent = context({ msgId: 'uncertain-timeout', content: '.r7d99 secret-value' });
    let handoffs = 0;
    await router.middleware(timeoutEvent, async () => { handoffs++; });
    await router.middleware(timeoutEvent, async () => assert.fail('duplicate uncertain event must be suppressed'));
    const disconnectEvent = context({ msgId: 'uncertain-disconnect', content: '.r8d99' });
    await router.middleware(disconnectEvent, async () => { handoffs++; });
    assert.equal(dispatches, 2, 'same original event is never re-dispatched after an uncertain result');
    assert.equal(sent.length, 0);
    assert.equal(handoffs, 2);
    assert.equal(getOnebotDirectFallback(timeoutEvent).reason, 'timeout');
    assert.equal(getOnebotDirectFallback(disconnectEvent).reason, 'uncertain');
    assert.ok(logs.some((line) => line.includes('stage=fallback reason=timeout')));
    assert.ok(logs.some((line) => line.includes('stage=fallback reason=uncertain')));
    const serializedLogs = logs.join('\n');
    for (const secret of ['secret-value', '7d99', USER_ID, GROUP_ID, APP_ID, 'secret command', 'token']) {
        assert.equal(serializedLogs.includes(secret), false, `logs do not contain ${secret}`);
    }
    router.stop();
    await service.stop();
});

test('fallback keeps current text, scrubs public diagnostics, and blocks only its original across new commands and backends', async () => {
    const secret = 'test-service-secret';
    const source = context({ content: '.r 2d7 解释一下', msgId: 'failure-context' });
    let sends = 0;
    let handoffs = 0;
    let dispatches = 0;
    let descriptor;
    const service = registerOnebotCommandTool({ get() { return { register(tool) { descriptor = tool; } }; } }, {
        appId: APP_ID,
        config: { enabled: true, hiddenEnabled: false, backendIds: ['sealdice', 'other'],
            url: new URL('http://bridge.example/mcp'), mcpToken: secret, internalToken: 'internal-test' },
        refreshIntervalMs: 60000,
        fetchImpl: async () => new Response(JSON.stringify({ backends: ['sealdice', 'other'].map(id => ({ id, version: 1, ready: true })) }),
            { headers: { 'content-type': 'application/json' } }),
        session: {
            async listTools() { return [{ name: 'call_ws' }]; },
            async callWs(args, _signal, onDispatch) {
                assert.equal(await onDispatch(), true);
                dispatches++;
                return { content: [{ type: 'text', text: JSON.stringify({ request_id: args.request_id,
                    backend_id: args.backend_id, audience: args.audience, status: dispatches === 1 ? 'failed' : 'ok',
                    outputs: [{ action: 'send_group_msg', audience: 'group', target_id: '42',
                        message: dispatches === 1 ? `bad parameter ${secret} https://internal.example/secret token=abcdef` : '1d1=1' }],
                }) }] };
            },
        },
    });
    assert.equal(await service.ready, true);
    const router = createOnebotDirectRouter({ service, appId: APP_ID,
        env: { QQBOT_ONEBOT_DEFAULT_BACKEND: 'sealdice', QQBOT_ONEBOT_MCP_TOKEN: secret },
        sender: { async sendMarkdown() { sends++; } } });
    await router.middleware(source, async () => { handoffs++; });
    await router.middleware(source, async () => assert.fail('duplicate fallback'));
    assert.equal(handoffs, 1);
    assert.equal(sends, 0);
    assert.equal(source.message.content, '.r 2d7 解释一下');
    const fallback = getOnebotDirectFallback(source);
    assert.equal(fallback.reason, 'backend_rejected');
    const original = { ownerId: USER_ID, replyTarget: source.message.replyTarget, text: source.message.content,
        onebotDirectFallback: fallback };
    const rendered = renderOnebotDirectFallbackMetadata([original]);
    for (const forbidden of [secret, 'internal.example', 'abcdef']) assert.equal(rendered.includes(forbidden), false);
    assert.ok(rendered.includes('bad parameter'));
    const holder = {};
    const scope = beginOnebotTurn(holder, [original, { ownerId: 'otherUser', replyTarget: original.replyTarget, text: '掷1d1' }], { appId: APP_ID });
    const requests = onebotRequestMetadata(scope);
    const exec = { agent: holder };
    bindOnebotExecution(exec);
    for (const backend of ['sealdice', 'other']) {
        for (const command of ['.r 1d1', '.st 力量42']) {
            assert.equal((await descriptor.execute({ requestId: requests[0].requestId, backend, command }, exec)).status, 'failed');
        }
    }
    assert.equal(dispatches, 1, 'blocked original must never reach MCP again');
    assert.equal((await descriptor.execute({ requestId: requests[1].requestId, backend: 'sealdice', command: '.r 1d1' }, exec)).status, 'ok');
    assert.equal(dispatches, 2, 'another original keeps its authorization');
    await endOnebotTurn(holder, scope);
    router.stop();
    await service.stop();
});

test('QQ send failure emits only a fixed fallback and never repeats the command', async () => {
    let executions = 0;
    const attempts = [];
    const logs = [];
    const service = fakeService({ execute() {
        executions++;
        return { status: 'ok', outputs: ['secret dice value 42'] };
    } });
    const router = createOnebotDirectRouter({
        service,
        appId: APP_ID,
        sender: { async sendMarkdown(_target, content) {
            attempts.push(content);
            if (attempts.length === 1) throw new Error('SDK failure included secret token');
        } },
        env: { QQBOT_ONEBOT_ENABLED: 'true' },
        logger: { info(line) { logs.push(line); } },
    });
    await router.middleware(context({ msgId: 'send-failure', content: '.r2d7/private-command' }), async () => assert.fail('direct command must be intercepted'));
    await router.middleware(context({ msgId: 'send-failure', content: '.r9d20' }), async () => assert.fail('duplicate send failure must be suppressed'));
    assert.equal(executions, 1);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0], 'secret dice value 42');
    assert.match(attempts[1], /发送失败/u);
    assert.ok(logs.some((line) => line.includes('stage=send reason=send_failed')));
    assert.ok(logs.some((line) => line.includes('stage=route reason=send_failed')));
    const serializedLogs = logs.join('\n');
    for (const secret of ['private-command', '2d7', 'secret dice value', '42', USER_ID, GROUP_ID, APP_ID, 'SDK failure', 'token']) {
        assert.equal(serializedLogs.includes(secret), false, `logs do not contain ${secret}`);
    }
    router.stop();
});

test('cache saturation sends a fixed busy response without executing or evicting accepted events', async () => {
    let executions = 0;
    const sent = [];
    const service = fakeService({ execute() { executions++; return { status: 'ok', outputs: ['done'] }; } });
    const router = createOnebotDirectRouter({
        service,
        appId: APP_ID,
        sender: { async sendMarkdown(_target, content) { sent.push(content); } },
        env: { QQBOT_ONEBOT_ENABLED: 'true' },
        maxEventCache: 1,
    });
    await router.middleware(context({ msgId: 'first' }), async () => assert.fail('first call must be intercepted'));
    await router.middleware(context({ msgId: 'second' }), async () => assert.fail('saturated call must not fall through'));
    await router.middleware(context({ msgId: 'first' }), async () => assert.fail('cached event must be suppressed'));
    assert.equal(executions, 1);
    assert.equal(sent.length, 2);
    assert.equal(sent[0], 'done');
    assert.match(sent[1], /队列暂满/u);
    router.stop();
});

test('output respects QQ chunk size and sends one fixed failure instead of partial oversized output', async () => {
    const sent = [];
    const logs = [];
    const service = fakeService({ execute(_args, _exec) {
        return { status: 'ok', outputs: ['a'.repeat(7600)] };
    } });
    const router = createOnebotDirectRouter({
        service,
        appId: APP_ID,
        sender: { async sendMarkdown(_target, content) { sent.push(content); } },
        env: { QQBOT_ONEBOT_ENABLED: 'true' },
    });
    await router.middleware(context({ msgId: 'four-chunks' }), async () => assert.fail('direct command must be intercepted'));
    assert.equal(sent.length, 4);
    assert.ok(sent.every((chunk) => Array.from(chunk).length <= 2000));

    const oversizedRouter = createOnebotDirectRouter({
        service: fakeService({ execute() { return { status: 'ok', outputs: ['b'.repeat(8100)] }; } }),
        appId: APP_ID,
        sender: { async sendMarkdown(_target, content) { sent.push(content); } },
        env: { QQBOT_ONEBOT_ENABLED: 'true' },
        logger: { info(line) { logs.push(line); } },
    });
    await oversizedRouter.middleware(context({ msgId: 'too-large' }), async () => assert.fail('direct command must be intercepted'));
    assert.equal(sent.length, 5, 'no partial raw output is sent when the result exceeds the four-message quota');
    assert.match(sent.at(-1), /返回内容过长/u);
    assert.ok(logs.some((line) => line.includes('stage=route reason=result_too_large')));

    const emojiChunks = [];
    const emojiRouter = createOnebotDirectRouter({
        service: fakeService({ execute() { return { status: 'ok', outputs: ['😀'.repeat(4000)] }; } }),
        appId: APP_ID,
        sender: { async sendMarkdown(_target, content) { emojiChunks.push(content); } },
        env: { QQBOT_ONEBOT_ENABLED: 'true' },
    });
    await emojiRouter.middleware(context({ msgId: 'emoji-chunks' }), async () => assert.fail('direct command must be intercepted'));
    assert.equal(emojiChunks.length, 4);
    assert.ok(emojiChunks.every((chunk) => chunk.length <= 2000), 'SDK quota is measured in UTF-16 units');
    assert.ok(emojiChunks.every((chunk) => !/[\uD800-\uDBFF]$/u.test(chunk) && !/^[\uDC00-\uDFFF]/u.test(chunk)),
        'chunks never split a surrogate pair');
    router.stop();
    oversizedRouter.stop();
    emojiRouter.stop();
});

test('shared runtime admission caps model and direct calls at 21, reports queue_full, and recovers after release', async () => {
    let descriptor;
    const started = deferred();
    const gates = [];
    const responseFor = (args) => ({ content: [{ type: 'text', text: JSON.stringify({
        request_id: args.request_id,
        backend_id: args.backend_id,
        audience: args.audience,
        status: 'ok',
        outputs: [{ action: 'send_group_msg', audience: 'group', target_id: '42', message: 'ok' }],
    }) }] });
    const service = registerOnebotCommandTool({
        get(name) { assert.equal(name, 'tools'); return { register(value) { descriptor = value; } }; },
    }, {
        appId: APP_ID,
        config: {
            enabled: true, hiddenEnabled: false, backendIds: ['sealdice'],
            url: new URL('http://bridge.example/mcp'), mcpToken: 'mcp-token', internalToken: 'internal-token',
        },
        refreshIntervalMs: 60_000,
        fetchImpl: async () => new Response(JSON.stringify({ backends: [{ id: 'sealdice', version: 1, ready: true }] }), {
            status: 200, headers: { 'content-type': 'application/json' },
        }),
        session: {
            async listTools() { return [{ name: 'call_ws' }]; },
            async callWs(args, _signal, onDispatch) {
                assert.equal(await onDispatch(), true);
                if (gates.length >= 21) return responseFor(args);
                const gate = deferred();
                gates.push({ args, gate });
                if (gates.length === 21) started.resolve();
                return gate.promise;
            },
        },
    });
    assert.equal(await service.ready, true);

    const scopes = [];
    const tasks = [];
    for (let index = 0; index < 22; index++) {
        const holder = {};
        const direct = index > 0;
        const original = {
            ownerId: USER_ID,
            replyTarget: { scope: 'group', targetId: GROUP_ID, msgId: `queue-${index}` },
            text: '.r 2d7',
        };
        const scope = beginOnebotTurn(holder, [original], {
            appId: APP_ID,
            ...(direct ? { direct: true, directAuthorization: { backend: 'sealdice', command: '.r 2d7' } } : {}),
        });
        scopes.push({ holder, scope });
        const metadata = onebotRequestMetadata(scope)[0];
        const args = { requestId: metadata.requestId, backend: 'sealdice', command: '.r 2d7' };
        const execute = direct ? service.execute.bind(service) : descriptor.execute.bind(descriptor);
        tasks.push(execute(args, { agent: holder, signal: scope.controller.signal }));
    }

    await started.promise;
    const overflow = await tasks[21];
    assert.equal(overflow.status, 'failed');
    assert.equal(overflow.failureReason, 'queue_full');
    assert.equal(gates.length, 21);
    assert.equal(service.runtime.inFlightByBackend.get('sealdice'), 21);

    for (const { args, gate } of gates) gate.resolve(responseFor(args));
    const results = await Promise.all(tasks.slice(0, 21));
    assert.ok(results.every((result) => result.status === 'ok'));
    assert.equal(service.runtime.inFlightByBackend.size, 0, 'all admission slots are released in finally');

    const recoveryHolder = {};
    const recoveryScope = beginOnebotTurn(recoveryHolder, [{
        ownerId: USER_ID, replyTarget: { scope: 'group', targetId: GROUP_ID, msgId: 'queue-recovery' }, text: '.r 2d7',
    }], { appId: APP_ID, direct: true, directAuthorization: { backend: 'sealdice', command: '.r 2d7' } });
    scopes.push({ holder: recoveryHolder, scope: recoveryScope });
    const recoveryMetadata = onebotRequestMetadata(recoveryScope)[0];
    const recovery = await service.execute({
        requestId: recoveryMetadata.requestId, backend: 'sealdice', command: '.r 2d7',
    }, { agent: recoveryHolder, signal: recoveryScope.controller.signal });
    assert.equal(recovery.status, 'ok', 'a later request is admitted after prior calls release their slots');

    await Promise.all(scopes.map(({ holder, scope }) => endOnebotTurn(holder, scope)));
    await service.stop();
});

test('shared service.execute preserves model behavior while binding direct authorization and deterministic bridge IDs', async () => {
    let descriptor;
    const bridgeCalls = [];
    const service = registerOnebotCommandTool({
        get(name) {
            assert.equal(name, 'tools');
            return { register(value) { descriptor = value; } };
        },
    }, {
        config: {
            enabled: true,
            hiddenEnabled: false,
            backendIds: ['sealdice'],
            url: new URL('http://bridge.example/mcp'),
            mcpToken: 'mcp-test-token',
            internalToken: 'internal-test-token',
        },
        appId: APP_ID,
        refreshIntervalMs: 60_000,
        fetchImpl: async () => new Response(JSON.stringify({
            backends: [{ id: 'sealdice', version: 1, ready: true }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }),
        session: {
            async listTools() { return [{ name: 'call_ws' }]; },
            async callWs(args, _signal, onDispatch) {
                bridgeCalls.push(args);
                assert.equal(await onDispatch(), true);
                const status = bridgeCalls.length === 2 ? 'failed' : 'ok';
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            request_id: args.request_id,
                            backend_id: args.backend_id,
                            audience: args.audience,
                            status,
                            outputs: [{
                                action: 'send_group_msg', audience: 'group', target_id: '42',
                                message: bridgeCalls.length === 2 ? 'public error' : '2d7 = 9',
                            }],
                            ...(bridgeCalls.length === 2 ? { private_count: 1, private_receipt: 'receipt_1' } : {}),
                        }),
                    }],
                };
            },
        },
    });
    assert.equal(await service.ready, true);
    assert.equal(typeof service.execute, 'function');

    const directHolder = {};
    const directSource = {
        ownerId: USER_ID,
        replyTarget: { scope: 'group', targetId: GROUP_ID, msgId: 'bridge_event' },
        text: '.r 2d7',
    };
    const directScope = beginOnebotTurn(directHolder, [directSource], {
        appId: APP_ID,
        direct: true,
        directAuthorization: { backend: 'sealdice', command: '.r 2d7' },
    });
    const directMetadata = onebotRequestMetadata(directScope)[0];
    const directExec = { agent: directHolder, signal: directScope.controller.signal };
    const invalid = await service.execute({
        requestId: directMetadata.requestId,
        backend: 'sealdice',
        command: '.r 9d20',
    }, directExec);
    assert.equal(invalid.status, 'failed');
    assert.equal(bridgeCalls.length, 0, 'a direct request cannot change the command after policy matching');

    const directResult = await service.execute({
        requestId: directMetadata.requestId,
        backend: 'sealdice',
        command: '.r 2d7',
    }, directExec);
    assert.equal(directResult.status, 'ok');
    assert.equal(bridgeCalls[0].request_id, getOnebotBridgeRequestId(directScope, directMetadata.requestId, 'sealdice'));
    assert.equal(bridgeCalls[0].payload, '.r 2d7');

    const privateOutputHolder = {};
    const privateOutputScope = beginOnebotTurn(privateOutputHolder, [{
        ...directSource,
        replyTarget: { scope: 'group', targetId: GROUP_ID, msgId: 'private_event' },
    }], {
        appId: APP_ID,
        direct: true,
        directAuthorization: { backend: 'sealdice', command: '.r 2d7' },
    });
    const privateOutputMetadata = onebotRequestMetadata(privateOutputScope)[0];
    const privateFailure = await service.execute({
        requestId: privateOutputMetadata.requestId,
        backend: 'sealdice',
        command: '.r 2d7',
    }, { agent: privateOutputHolder, signal: privateOutputScope.controller.signal });
    assert.equal(privateFailure.status, 'failed');
    assert.deepEqual(privateFailure.outputs, [], 'failed group results with a private receipt never expose even validated public text');

    const modelHolder = {};
    const modelScope = beginOnebotTurn(modelHolder, [directSource], { appId: APP_ID });
    const modelMetadata = onebotRequestMetadata(modelScope)[0];
    const modelExec = { agent: modelHolder, signal: modelScope.controller.signal };
    const modelResult = await descriptor.execute({
        requestId: modelMetadata.requestId,
        backend: 'sealdice',
        command: '.r 2d7',
    }, modelExec);
    assert.equal(modelResult.status, 'ok');
    assert.equal(Object.hasOwn(modelResult, 'failureReason'), false, 'the model-facing successful result shape stays unchanged');
    assert.notEqual(bridgeCalls[2].request_id, getOnebotBridgeRequestId(modelScope, modelMetadata.requestId, 'sealdice'),
        'normal model tool invocations keep random bridge IDs');

    const customSent = [];
    const customRouter = createOnebotDirectRouter({
        service,
        appId: APP_ID,
        sender: { async sendMarkdown(_target, text) { customSent.push(text); } },
        env: { QQBOT_ONEBOT_ENABLED: 'true' },
        policies: { sealdice: { family: 'test-custom', match(text) { return text === '.echo' ? { command: '.echo' } : undefined; } } },
    });
    await customRouter.middleware(context({ content: '.echo', msgId: 'custom-ping' }), async () => assert.fail('registered custom command must be intercepted'));
    assert.equal(bridgeCalls.length, 4);
    assert.equal(bridgeCalls[3].payload, '.echo', 'a custom direct policy reaches the shared service executor');
    assert.equal(customSent.length, 1);
    const modelCustomResult = await descriptor.execute({
        requestId: modelMetadata.requestId,
        backend: 'sealdice',
        command: '.echo',
    }, modelExec);
    assert.equal(modelCustomResult.status, 'failed', 'custom direct authorization does not widen the model tool whitelist');
    assert.equal(bridgeCalls.length, 4);
    customRouter.stop();

    await Promise.all([
        endOnebotTurn(directHolder, directScope),
        endOnebotTurn(privateOutputHolder, privateOutputScope),
        endOnebotTurn(modelHolder, modelScope),
        service.stop(),
    ]);
});
