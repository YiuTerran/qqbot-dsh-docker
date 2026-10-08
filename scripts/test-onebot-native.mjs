import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultsRoot = process.env.QQBOT_ONEBOT_MODULE_ROOT ?? fileURLToPath(new URL('../defaults', import.meta.url));
const onebotModule = await import(pathToFileURL(join(defaultsRoot, 'qqbot-onebot.mjs')).href);
const scopeModule = await import(pathToFileURL(join(defaultsRoot, 'qqbot-onebot-scope.mjs')).href);
const patcherSource = process.env.QQBOT_ONEBOT_PATCHER_SOURCE ?? new URL('./enforce-chat-only.mjs', import.meta.url);
const sdkClientCandidates = [
    process.env.QQBOT_SDK_API_CLIENT_MODULE,
    '/data/profiles/qqbot/node_modules/@tencent-connect/qqbot-nodejs/dist/protocol/api/api-client.js',
].filter(Boolean);
let sdkApiClientModule;
for (const path of sdkClientCandidates) {
    try {
        await access(path);
        sdkApiClientModule = await import(pathToFileURL(path).href);
        break;
    }
    catch { /* Try the other known SDK install location. */ }
}
if (!sdkApiClientModule?.ApiClient) throw new Error('Pinned qqbot-nodejs 1.0.4 ApiClient is required for this regression test.');

const {
    createOnebotFriendRegistry,
    createOnebotPrivateSender,
    ONEBOT_COMMAND_TOOL,
    readOnebotConfig,
    registerOnebotCommandTool,
    validateOnebotCommand,
    OnebotMcpSession,
} = onebotModule;

const {
    beginOnebotTurn,
    bindOnebotExecution,
    endOnebotTurn,
    onebotRequestMetadata,
    renderOnebotRequestMetadata,
} = scopeModule;

const { captureCurrentLogSource, isCurrentLogSource } = await import(pathToFileURL(join(defaultsRoot, 'qqbot-sealdice-policy.mjs')).href);
const appId = '123456789';
const config = (hiddenEnabled = false, masterUsers = [], logEnabled = false) => ({
    enabled: true,
    logEnabled,
    hiddenEnabled,
    url: new URL('http://onebot.test/mcp'),
    backendIds: Object.freeze(['sealdice']),
    masterUsers,
    mcpToken: 'test-mcp-token',
    internalToken: 'test-internal-token',
});
const groupOriginal = (ownerId = 'member-a', groupId = 'group-a', groupRole = 'unknown') => ({
    ownerId,
    groupRole,
    replyTarget: { scope: 'group', targetId: groupId, msgId: 'group-message-id' },
    text: '请掷一个骰子',
});
function logOriginal(text, role = 'owner', ownerId = 'member-a', groupId = 'group-a', extra = {}) {
    const original = { ...groupOriginal(ownerId, groupId, role), text, ...extra };
    const message = { kind: 'group', senderId: ownerId, groupOpenid: groupId,
        messageId: original.replyTarget.msgId, replyTarget: original.replyTarget,
        raw: { id: original.replyTarget.msgId, group_openid: groupId,
            author: { member_openid: ownerId }, content: `<@!${appId}> ${text}` } };
    original.currentLogSource = captureCurrentLogSource(message, message.replyTarget, appId);
    return original;
}
const privateOriginal = (ownerId = 'member-a') => ({
    ownerId,
    replyTarget: { scope: 'c2c', targetId: ownerId },
    text: '请掷一个骰子',
});

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function setup({ hidden = false, resultForCall, friendRegistry, testSender = false, sendPrivateText, backendCapabilities = [], masterUsers = [],
    resolveHiddenRecipient, verifyProactiveEligibility, session, fetchImpl, bot, registerError,
    onAvailability, logger, logEnabled = false, logCapture, sendArtifactFile } = {}) {
    let descriptor;
    const registrations = [];
    const ctx = { get: (name) => name === 'tools' ? { register(tool) {
        if (registerError) throw registerError;
        registrations.push(tool.name);
        descriptor = tool;
    } } : undefined };
    let calls = 0;
    const callArguments = [];
    const mockSession = session ?? {
        async listTools() { return [{ name: 'call_ws' }]; },
        async callWs(args, signal, onDispatch) {
            if (signal?.aborted || await onDispatch() !== true) throw new Error('dispatch denied');
            calls++;
            callArguments.push(args);
            return resultForCall ? resultForCall(args, calls) : bridgeResult(args, { outputs: ['1d1 = 1'] });
        },
    };
    const fallbackFetch = async (url, init = {}) => {
        const path = new URL(url).pathname;
        if (path === '/internal/backends') return json({ backends: [{ id: 'sealdice', ready: true, version: 1, capabilities: backendCapabilities }] });
        if (path === '/internal/private/claim') return json({ delivery_id: 'delivery-1', outputs: [{ target_id: 17, message: 'PRIVATE_SENTINEL' }] });
        if (path === '/internal/private/ack') return json({ ok: true });
        throw new Error(`unexpected URL ${path}`);
    };
    const service = registerOnebotCommandTool(ctx, {
        appId,
        config: config(hidden, masterUsers, logEnabled),
        session: mockSession,
        fetchImpl: fetchImpl ?? fallbackFetch,
        friendRegistry,
        resolveHiddenRecipient,
        verifyProactiveEligibility,
        sendPrivateText,
        logCapture,
        sendArtifactFile,
        testOnlyProactiveC2C: testSender,
        bot,
        logger,
        onAvailability,
        refreshIntervalMs: 60_000,
    });
    return {
        service,
        get descriptor() { return descriptor; },
        registrations,
        get calls() { return calls; },
        callArguments,
    };
}

function json(value) {
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

function bridgeResult(args, { outputs = [], privateReceipt, privateCount } = {}) {
    return { content: [{ type: 'text', text: JSON.stringify({
        request_id: args.request_id,
        backend_id: args.backend_id,
        audience: args.audience,
        status: 'ok',
        outputs: outputs.map((message) => ({
            action: args.audience === 'group' ? 'send_group_msg' : 'send_private_msg',
            audience: args.audience,
            target_id: 17,
            message,
        })),
        ...(privateReceipt ? { private_receipt: privateReceipt, private_count: privateCount } : {}),
    }) }] };
}

function boundExec(originals = [groupOriginal()]) {
    const agent = {};
    const scope = beginOnebotTurn(agent, originals, { appId });
    const exec = { agent, signal: new AbortController().signal };
    bindOnebotExecution(exec);
    return { agent, scope, exec, metadata: onebotRequestMetadata(scope) };
}

test('log capture defaults on only with valid enabled OneBot config and can be disabled explicitly', () => {
    const env = {
        QQBOT_ONEBOT_ENABLED: 'true',
        QQBOT_ONEBOT_MCP_URL: 'http://onebot.test/mcp',
        QQBOT_ONEBOT_BACKENDS: 'sealdice',
        QQBOT_ONEBOT_MCP_TOKEN: 'test-mcp-token',
        QQBOT_ONEBOT_INTERNAL_TOKEN: 'test-internal-token',
    };
    assert.equal(readOnebotConfig(env).logEnabled, true);
    assert.equal(readOnebotConfig({ ...env, QQBOT_ONEBOT_LOG_ENABLED: 'true' }).logEnabled, true);
    assert.equal(readOnebotConfig({ ...env, QQBOT_ONEBOT_LOG_ENABLED: 'false' }).logEnabled, false);
    assert.equal(readOnebotConfig({ ...env, QQBOT_ONEBOT_ENABLED: 'false' }).logEnabled, false);
});

test('native log export claims and sends one validated artifact, then reuses the cached result', async () => {
    const bytes = Buffer.from('# Current group session\n', 'utf8');
    const receipt = {
        receipt: 'receipt-1', filename: 'session.md', media_type: 'text/markdown',
        size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    const network = [];
    const sent = [];
    const logCapture = {
        enabled: true, setBackends() {}, setUnavailable() {}, stop() {},
        async barrier() { return true; },
    };
    const service = setup({
        logEnabled: true, logCapture,
        backendCapabilities: ['log-capture-v1', 'artifact-v1', 'group-role-v1'],
        resultForCall(args) {
            return { content: [{ type: 'text', text: JSON.stringify({
                request_id: args.request_id, backend_id: args.backend_id,
                audience: 'group', status: 'ok', outputs: [], artifact_receipts: [receipt],
            }) }] };
        },
        async fetchImpl(url, init) {
            const path = new URL(String(url)).pathname;
            network.push([path, init?.body ? JSON.parse(init.body) : undefined]);
            if (path === '/internal/backends') return json({ backends: [{
                id: 'sealdice', ready: true, version: 1,
                capabilities: ['log-capture-v1', 'artifact-v1', 'group-role-v1'],
            }] });
            if (path === '/internal/artifacts/claim') return json({
                ...receipt, delivery_id: 'delivery-1', bytes_base64: bytes.toString('base64'),
            });
            if (path === '/internal/artifacts/ack') return json({ ok: true });
            throw new Error(`unexpected artifact URL ${path}`);
        },
        async sendArtifactFile(request, content, filename, mediaType, signal) {
            assert.equal(request.isActive('artifact'), true);
            assert.equal(signal.aborted, false);
            sent.push({ content: content.toString('utf8'), filename, mediaType, target: request.replyTarget });
            return { sent: true };
        },
    });
    const { agent, scope, exec, metadata } = boundExec([logOriginal('.log export')]);
    try {
        await service.service.ready;
        const args = { requestId: metadata[0].requestId, backend: 'sealdice', command: '.log export' };
        const first = await service.descriptor.execute(args, exec);
        const cached = await service.descriptor.execute(args, exec);
        assert.equal(first.status, 'ok');
        assert.deepEqual(first.artifactDelivery, [{
            receipt: 'receipt-1', filename: 'session.md', status: 'sent', acknowledged: true,
        }]);
        assert.deepEqual(cached, first);
        assert.equal(service.calls, 1);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].content, '# Current group session\n');
        assert.equal(sent[0].target.targetId, 'group-a');
        assert.equal(network.filter(([path]) => path === '/internal/artifacts/claim').length, 1);
        const ack = network.find(([path]) => path === '/internal/artifacts/ack')?.[1];
        assert.equal(ack.status, 'sent');
        assert.equal(ack.group_key, `${appId}:group-a`);
    }
    finally { await endOnebotTurn(agent, scope); await service.service.stop(); }
});

test('native log commands require the same case-sensitive original command, not prose', async () => {
    const service = setup({
        logEnabled: true,
        backendCapabilities: ['log-capture-v1'],
        logCapture: { enabled: true, setBackends() {}, setUnavailable() {}, stop() {}, async barrier() { return true; } },
    });
    try {
        await service.service.ready;
        for (const [original, command] of [
            ['.log get Alpha', '.log get alpha'],
            ['请解释.log get Alpha', '.log get Alpha'],
        ]) {
            const { agent, scope, exec, metadata } = boundExec([logOriginal(original, 'member')]);
            try {
                const result = await service.descriptor.execute({
                    requestId: metadata[0].requestId, backend: 'sealdice', command,
                }, exec);
                assert.equal(result.failureReason, 'log_exact_source_required', original);
                assert.equal(service.calls, 0, 'no backend call for a changed or invented command');
            }
            finally { await endOnebotTurn(agent, scope); }
        }
    }
    finally { await service.service.stop(); }
});

test('disabled registration makes no requests and produces no request metadata', async () => {
    let requests = 0;
    let registrations = 0;
    const service = registerOnebotCommandTool({ get: () => ({ register() { registrations++; } }) }, {
        env: { QQBOT_ONEBOT_ENABLED: 'false' },
        fetchImpl: async () => { requests++; throw new Error('must not connect'); },
    });
    assert.equal(service.enabled, false);
    assert.equal(await service.ready, false);
    assert.equal(renderOnebotRequestMetadata(undefined), '');
    assert.equal(requests, 0);
    assert.equal(registrations, 0);
    const inboundPatch = await readFile(patcherSource, 'utf8');
    assert.match(inboundPatch, /const onebotToolAvailable = isOnebotToolAvailable\(\);/u);
    assert.match(inboundPatch, /if \(onebotToolAvailable\) onebotTurn = beginOnebotTurn\(/u);
    assert.match(inboundPatch, /const onebotMetadata = onebotTurn \? renderOnebotRequestMetadata\(onebotTurn\) : '';/u);
    assert.match(inboundPatch, /renderCurrentLogSourceDiagnostics\(getMergedGenerationRequests\(ctx\), \{ appId: config\.appId, logger, toolAvailable: onebotToolAvailable \}\)/u);
    assert.match(inboundPatch, /generationMetadata, onebotMetadata, currentLogDiagnosticMetadata, onebotFallbackMetadata/u);
});

test('tool parser accepts bounded native commands and rejects generic/admin input', () => {
    for (const command of ['.r 1d20', 'ra 力量', 'rc 侦查', 'st show 力量', 'pc list', '.set coc7', '.set dnd5e']) {
        assert.equal(validateOnebotCommand(command), true, command);
    }
    for (const command of ['.run rm -rf /', '.rh\n1d20', '.set scripts', 'r'.repeat(4001)]) {
        assert.equal(validateOnebotCommand(command), false, command.slice(0, 20));
    }
    assert.deepEqual(readOnebotConfig({ QQBOT_ONEBOT_ENABLED: 'false' }).backendIds, []);
});

test('registration failure stays unavailable and never reports a ready tool', async () => {
    const availability = [];
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.map(String).join(' '));
    let service;
    try {
        service = setup({
            registerError: new Error('SECRET_TOKEN private-body https://private.example.test/mcp'),
            onAvailability: (value) => availability.push(value),
        });
        assert.equal(await service.service.ready, false);
        assert.ok(availability.length > 0 && availability.every((value) => value === false), 'availability must remain false around a failed register');
        assert.deepEqual(service.registrations, []);
        assert.equal(service.service.diagnostics().registered, false);
        assert.equal(service.service.diagnostics().toolAvailable, false);
        assert.equal(service.service.diagnostics().reason, 'register-failed');
        assert.ok(logs.some((line) => line === '[qqbot-onebot] register-failed backends=1 available=false'));
        assert.ok(logs.every((line) => !/SECRET_TOKEN|private-body|private\.example|https?:\/\//u.test(line)), 'registration error details leaked to logs');
    }
    finally {
        console.log = originalLog;
        await service?.service.stop();
    }
});

test('readiness transitions log fixed redacted states once and report tool visibility', async () => {
    const state = { backendReady: false, exposeCallWs: true };
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.map(String).join(' '));
    const session = {
        async listTools() { return state.exposeCallWs ? [{ name: 'call_ws' }] : []; },
        async callWs() { throw new Error('unused'); },
    };
    const fetchImpl = async (url) => {
        if (new URL(url).pathname !== '/internal/backends') throw new Error('unused');
        return json({ backends: [{ id: 'sealdice', version: 1, ready: state.backendReady }] });
    };
    let service;
    try {
        service = setup({ session, fetchImpl });
        assert.equal(await service.service.ready, false);
        assert.deepEqual(service.service.diagnostics(), {
            enabled: true,
            readyBackendCount: 0,
            registered: false,
            toolAvailable: false,
            reason: 'backend-not-ready',
            hiddenEnabled: false,
            proactivePermission: 'unsupported-by-platform',
        });
        await service.service.refresh();
        assert.equal(logs.filter((line) => line.includes('backend-not-ready')).length, 1, 'unchanged state was logged repeatedly');

        state.backendReady = true;
        assert.equal(await service.service.refresh(), true);
        assert.equal(service.service.diagnostics().toolAvailable, true);
        state.backendReady = false;
        assert.equal(await service.service.refresh(), false);
        assert.equal(service.service.diagnostics().registered, true, 'registered definition should remain in the Cordis registry');
        assert.equal(service.service.diagnostics().toolAvailable, false);

        state.backendReady = true;
        state.exposeCallWs = false;
        assert.equal(await service.service.refresh(), false);
        assert.equal(service.service.diagnostics().reason, 'call-ws-missing');
        assert.equal(service.service.diagnostics().readyBackendCount, 0);
        state.exposeCallWs = true;
        assert.equal(await service.service.refresh(), true);
        assert.equal(service.service.diagnostics().toolAvailable, true);
        assert.ok(logs.some((line) => line === '[qqbot-onebot] backend-not-ready backends=0 available=false'));
        assert.ok(logs.some((line) => line === '[qqbot-onebot] ready backends=1 available=true'));
        assert.ok(logs.some((line) => line === '[qqbot-onebot] call-ws-missing backends=1 available=false'));
        assert.ok(logs.every((line) => !/token|http|fixture-mcp|fixture-internal|private-body/iu.test(line)));
    }
    finally {
        console.log = originalLog;
        await service?.service.stop();
    }
});

test('merged messages have app-scoped opaque IDs and immutable per-original authorization', async () => {
    const { agent, scope, metadata } = boundExec([groupOriginal('member-a'), groupOriginal('member-b')]);
    assert.equal(metadata.length, 2);
    assert.notEqual(metadata[0].requestId, metadata[1].requestId);
    assert.ok(metadata.every((entry) => entry.audience === 'group'));
    assert.equal(scope.requests.get(metadata[0].requestId).userKey, `${appId}:member-a`);
    assert.equal(scope.requests.get(metadata[0].requestId).groupKey, `${appId}:group-a`);
    await endOnebotTurn(agent, scope);
    assert.equal(renderOnebotRequestMetadata(scope), '');
});

test('empty, attachment-only, whitespace-only, and mention-only messages create no command grants', async () => {
    const imageOnly = [{ url: 'https://media.example.test/image.png', content_type: 'image/png' }];
    for (const { text, currentAttachments = [] } of [
        { text: '' },
        { text: ' \t\n  ' },
        { text: '', currentAttachments: imageOnly },
        { text: `<@!${appId}>` },
        { text: '<@987654321>' },
        { text: `<@!${appId}> <@987654321>` },
    ]) {
        const agent = {};
        const scope = beginOnebotTurn(agent, [{
            ...groupOriginal(),
            text,
            currentAttachments,
        }], { appId });
        assert.equal(scope.requests.size, 0, JSON.stringify(text));
        assert.deepEqual(onebotRequestMetadata(scope), [], JSON.stringify(text));
        await endOnebotTurn(agent, scope);
    }

    const agent = {};
    const rawText = `<@!${appId}> .r 1d20`;
    const scope = beginOnebotTurn(agent, [{
        ...groupOriginal(),
        text: rawText,
        currentAttachments: [{ url: 'https://media.example.test/image.png', content_type: 'image/png' }],
    }], { appId });
    const metadata = onebotRequestMetadata(scope);
    assert.equal(metadata.length, 1, 'substantive direct text remains eligible when an image is attached');
    assert.equal(scope.requests.get(metadata[0].requestId).text, rawText, 'authorization checks must preserve raw source text in metadata');
    await endOnebotTurn(agent, scope);
});

test('same original command shares a call and unsupported production rh never dispatches', async () => {
    const service = setup({ hidden: true });
    assert.equal(await service.service.ready, true);
    assert.deepEqual(service.registrations, [ONEBOT_COMMAND_TOOL]);
    const { agent, scope, exec, metadata } = boundExec();
    const requestId = metadata[0].requestId;
    const args = { requestId, backend: 'sealdice', command: '.r 1d1' };
    const [first, duplicate] = await Promise.all([
        service.descriptor.execute(args, exec),
        service.descriptor.execute(args, exec),
    ]);
    assert.deepEqual(first, duplicate);
    assert.equal(service.calls, 1);
    const rendered = service.descriptor.output.render(args, first);
    assert.deepEqual(rendered, [{ type: 'text', text: JSON.stringify(first) }]);
    assert.match(rendered[0].text, /1d1 = 1/u, 'public Dice output is available to the model');
    assert.doesNotMatch(rendered[0].text, /PRIVATE_SENTINEL|private-body/u, 'rendered content contains no private body');
    const hidden = await service.descriptor.execute({ ...args, command: '.rh 1d1' }, exec);
    assert.equal(hidden.status, 'failed');
    assert.match(hidden.notice, /不支持暗骰/u);
    assert.equal(service.calls, 1, 'production hidden roll must be rejected before backend dispatch');
    await endOnebotTurn(agent, scope);
    await service.service.stop();
});

test('group .set writes require the original bound owner or admin and a capable backend', async () => {
    const rolesSent = [];
    const service = setup({
        backendCapabilities: ['group-role-v1'],
        masterUsers: [`${appId}:member-a`],
        resultForCall(args) {
            rolesSent.push(args.group_role);
            return bridgeResult(args, { outputs: ['rule changed'] });
        },
    });
    await service.service.ready;
    const invoke = async ({ audience = 'group', role = 'unknown', text = '.set coc7', command = '.set coc7' } = {}) => {
        const agent = {};
        const original = audience === 'private'
            ? { ...privateOriginal('member-a'), groupRole: role, text }
            : { ...groupOriginal('member-a', 'group-a', role), text };
        const scope = beginOnebotTurn(agent, [original], { appId });
        try {
            const requestId = onebotRequestMetadata(scope)[0].requestId;
            return await service.descriptor.execute({ requestId, backend: 'sealdice', command }, { agent });
        }
        finally { await endOnebotTurn(agent, scope); }
    };
    try {
        for (const role of ['owner', 'admin']) assert.equal((await invoke({ role })).status, 'ok', role);
        assert.deepEqual(rolesSent, ['owner', 'admin'], 'only SDK-bound roles reach a role-capable bridge');

        const originalWarn = console.warn;
        const logs = [];
        console.warn = (...values) => logs.push(values.map(String).join(' '));
        try {
            for (const role of ['member', 'Owner', 'invented', undefined]) {
                const denied = await invoke({ role });
                assert.equal(denied.status, 'failed');
                assert.equal(denied.failureReason, role === 'member' ? 'group_role_denied' : 'group_role_unknown');
            }
            const privateDenied = await invoke({ audience: 'private', role: 'owner' });
            assert.equal(privateDenied.failureReason, 'group_state_private');
        }
        finally { console.warn = originalWarn; }
        assert.ok(logs.some((line) => line.includes('"stage":"authorize"') && line.includes('"code":"group_role_denied"')));
        assert.ok(logs.every((line) => !/member-a|group-a|\.set|owner|admin/u.test(line)), 'authorization diagnostics must omit sender, group, command, and role');

        const memberInfo = await invoke({ role: 'member', command: '.set info', text: '.set info' });
        assert.equal(memberInfo.status, 'ok', '.set info remains a query for regular members');
        const forgedAgent = {};
        const forgedScope = beginOnebotTurn(forgedAgent, [groupOriginal('member-a', 'group-a', 'member')], { appId });
        try {
            const requestId = onebotRequestMetadata(forgedScope)[0].requestId;
            const forged = await service.descriptor.execute({ requestId, backend: 'sealdice', command: '.set coc7', group_role: 'owner' }, { agent: forgedAgent });
            assert.equal(forged.status, 'failed', 'tool arguments cannot provide identity or group role');
        }
        finally { await endOnebotTurn(forgedAgent, forgedScope); }
        assert.equal(service.calls, 3, 'only owner/admin writes and the ordinary info query dispatch');
    }
    finally { await service.service.stop(); }

    const legacy = setup({ backendCapabilities: [] });
    await legacy.service.ready;
    try {
        const agent = {};
        const scope = beginOnebotTurn(agent, [{ ...groupOriginal('member-a', 'group-a', 'owner'), text: '.set dnd' }], { appId });
        try {
            const result = await legacy.service.execute({ requestId: onebotRequestMetadata(scope)[0].requestId,
                backend: 'sealdice', command: '.set dnd' }, { agent });
            assert.equal(result.failureReason, 'group_role_unsupported');
            assert.equal(legacy.calls, 0, 'legacy backend rejects only group state writes before dispatch');
        }
        finally { await endOnebotTurn(agent, scope); }
    }
    finally { await legacy.service.stop(); }
});

test('a merged member request cannot borrow an unrelated owner request ID for a group write', async () => {
    const service = setup({ backendCapabilities: ['group-role-v1'] });
    await service.service.ready;
    const { agent, scope, exec, metadata } = boundExec([
        { ...groupOriginal('owner-a', 'group-a', 'owner'), text: '今天怎么样' },
        { ...groupOriginal('member-b', 'group-a', 'member'), text: '.set coc7' },
        { ...groupOriginal('admin-c', 'group-a', 'admin'), text: '.set dnd' },
    ]);
    try {
        const call = (index, command) => service.descriptor.execute({ requestId: metadata[index].requestId,
            backend: 'sealdice', command }, exec);
        assert.equal((await call(0, '.set coc7')).failureReason, 'group_state_source_mismatch');
        assert.equal((await call(1, '.set coc7')).failureReason, 'group_role_denied');
        assert.equal((await call(2, '.set coc7')).failureReason, 'group_state_source_mismatch');
        assert.equal(service.calls, 0, 'mismatched originals never dispatch');
        assert.equal((await call(2, '.set dnd')).status, 'ok');
        assert.equal(service.calls, 1, 'only the admin own explicit command dispatches');
    } finally { await endOnebotTurn(agent, scope); await service.service.stop(); }
});

test('natural-language group rule changes require one raw original and the trusted owner or admin role', async () => {
    const service = setup({ backendCapabilities: ['group-role-v1'] });
    await service.service.ready;
    try {
        for (const role of ['owner', 'admin', 'member', 'unknown']) {
            const original = { ...groupOriginal('speaker', 'group-a', role), text: '请把这个群切换为 DND 规则' };
            const { agent, scope, exec, metadata } = boundExec([original]);
            try {
                assert.equal(metadata[0].groupStateWriteRequiresExactCommand, false);
                const result = await service.descriptor.execute({ requestId: metadata[0].requestId,
                    backend: 'sealdice', command: '.set dnd' }, exec);
                assert.equal(result.status, ['owner', 'admin'].includes(role) ? 'ok' : 'failed');
            } finally { await endOnebotTurn(agent, scope); }
        }
        const { agent, scope, exec, metadata } = boundExec([
            { ...groupOriginal('owner-a', 'group-a', 'owner'), text: '请把这个群切换为 DND 规则' },
            { ...groupOriginal('member-b', 'group-a', 'member'), text: '' },
        ]);
        try {
            assert.equal(metadata.length, 1, 'empty text has no tool authorization');
            assert.equal(scope.originalRequestCount, 2, 'batch count includes filtered raw originals');
            assert.equal(metadata[0].groupStateWriteRequiresExactCommand, true);
            assert.throws(() => { scope.originalRequestCount = 1; }, TypeError);
            const rejected = await service.descriptor.execute({ requestId: metadata[0].requestId,
                backend: 'sealdice', command: '.set dnd' }, exec);
            assert.equal(rejected.failureReason, 'group_state_source_mismatch');
        } finally { await endOnebotTurn(agent, scope); }
        assert.equal(service.calls, 2, 'only single-original owners/admins dispatch natural requests');
    } finally { await service.service.stop(); }
});

test('group capability is rechecked after per-original queue wait and immediately before dispatch', async () => {
    for (const stage of ['queue', 'dispatch']) {
        const gate = deferred();
        const started = deferred();
        let dispatched = 0;
        const session = {
            async listTools() { return [{ name: 'call_ws' }]; },
            async callWs(args, signal, onDispatch) {
                if (stage === 'dispatch') { started.resolve(); await gate.promise; }
                if (await onDispatch() !== true) throw new Error('dispatch denied');
                dispatched++;
                if (stage === 'queue' && args.payload === '.r 1d1') { started.resolve(); await gate.promise; }
                return bridgeResult(args, { outputs: ['completed'] });
            },
        };
        const service = setup({ backendCapabilities: ['group-role-v1'], session });
        await service.service.ready;
        const { agent, scope, exec, metadata } = boundExec([{ ...groupOriginal('owner-a', 'group-a', 'owner'), text: '.set coc7' }]);
        const args = { requestId: metadata[0].requestId, backend: 'sealdice', command: '.set coc7' };
        try {
            const initial = stage === 'queue' ? service.descriptor.execute({ ...args, command: '.r 1d1' }, exec)
                : service.descriptor.execute(args, exec);
            await started.promise;
            const queued = stage === 'queue' ? service.descriptor.execute(args, exec) : initial;
            service.service.runtime.groupRoleBackends.clear();
            gate.resolve();
            const result = await queued;
            assert.equal(result.failureReason, 'group_role_unsupported', stage);
            if (stage === 'queue') await initial;
            assert.equal(dispatched, stage === 'queue' ? 1 : 0, 'revoked-capability write was dispatched');
        } finally { gate.resolve(); await endOnebotTurn(agent, scope); await service.service.stop(); }
    }
});

test('same original dedupes prefix and command-name case but preserves argument whitespace', async () => {
    const payloads = [];
    const service = setup({ resultForCall(args) {
        payloads.push(args.payload);
        return bridgeResult(args, { outputs: ['character sheet'] });
    } });
    assert.equal(await service.service.ready, true);
    const { agent, scope, exec, metadata } = boundExec();
    const requestId = metadata[0].requestId;
    try {
        const first = await service.descriptor.execute({ requestId, backend: 'sealdice', command: '.PC create Alice   Smith' }, exec);
        const identical = await service.descriptor.execute({ requestId, backend: 'sealdice', command: 'pc create Alice   Smith' }, exec);
        assert.deepEqual(first, identical, 'optional dot prefix and command-name case normalize to the same invocation');
        assert.equal(service.calls, 1);

        await service.descriptor.execute({ requestId, backend: 'sealdice', command: '.pc create Alice Smith' }, exec);
        assert.equal(service.calls, 2, 'different interior argument whitespace remains a distinct invocation');
        assert.deepEqual(payloads, ['.pc create Alice   Smith', '.pc create Alice Smith']);
    }
    finally {
        await endOnebotTurn(agent, scope);
        await service.service.stop();
    }
});

test('private SDK sender isolates body logging, uses SDK credentials, and never inherits a group message ID', async () => {
    const forwardedLogs = [];
    const sharedLogger = {
        debug: (...values) => forwardedLogs.push(values),
        info: (...values) => forwardedLogs.push(values),
        warn: (...values) => forwardedLogs.push(values),
        error: (...values) => forwardedLogs.push(values),
    };
    const { ApiClient } = sdkApiClientModule;
    const bot = {
        apiClient: new ApiClient({ baseUrl: 'https://api.example.test', userAgent: 'qqbot-test', logger: sharedLogger }),
        tokenManager: { async getAccessToken(app, secret) { assert.equal(app, appId); assert.equal(secret, 'sdk-secret'); return 'sdk-token'; } },
        creds: { appId, clientSecret: 'sdk-secret' },
    };
    const originalFetch = globalThis.fetch;
    const originalRequest = ApiClient.prototype.request;
    let wireRequest;
    let isolatedClient;
    let isolatedLogger;
    let sdkArguments;
    globalThis.fetch = async (url, init) => {
        wireRequest = { url: String(url), init, body: JSON.parse(init.body) };
        return json({ id: 'accepted-id', content: 'PRIVATE_RESPONSE_SENTINEL' });
    };
    ApiClient.prototype.request = function (...args) {
        isolatedClient = this;
        isolatedLogger = this.logger;
        sdkArguments = args;
        return originalRequest.apply(this, args);
    };
    try {
        const sender = createOnebotPrivateSender({ bot, messagePath: (scope, id) => `/v2/users/${scope}/${id}/messages` });
        const allowed = await sender({ scope: 'c2c', targetId: 'private-user' }, 'PRIVATE_SENTINEL', { beforeDispatch: () => true });
        assert.equal(allowed.id, 'accepted-id');
        assert.equal(isolatedClient === bot.apiClient, false);
        assert.notEqual(isolatedLogger, sharedLogger);
        assert.equal(isolatedLogger.debug('must remain private'), undefined, 'isolated SDK logger drops debug bodies');
        assert.equal(forwardedLogs.length, 0);
        assert.equal(sdkArguments[0], 'sdk-token');
        assert.equal(sdkArguments[1], 'POST');
        assert.deepEqual(sdkArguments[3], { msg_type: 0, msg_seq: 1, content: 'PRIVATE_SENTINEL' });
        assert.deepEqual(sdkArguments[4], { timeoutMs: 10_000, redactBodyKeys: ['content'] });
        assert.equal(sdkArguments[2], '/v2/users/c2c/private-user/messages');
        assert.equal(wireRequest.url, 'https://api.example.test/v2/users/c2c/private-user/messages');
        assert.equal(wireRequest.body.content, 'PRIVATE_SENTINEL');
        assert.equal(wireRequest.init.headers.Authorization, 'QQBot sdk-token');
        assert.equal(JSON.stringify(forwardedLogs).includes('PRIVATE_SENTINEL'), false);
        assert.equal(JSON.stringify(forwardedLogs).includes('PRIVATE_RESPONSE_SENTINEL'), false);
        await assert.rejects(sender({ scope: 'c2c', targetId: 'private-user', msgId: 'group-id' }, 'hidden'), /target is invalid/u);
        assert.equal(forwardedLogs.length, 0);
    }
    finally {
        ApiClient.prototype.request = originalRequest;
        globalThis.fetch = originalFetch;
    }
});

test('bridge session restart recovers through single-flight initialize/list without replaying tools/call', async () => {
    let currentSessionId = 'bridge-session-1';
    let initializeCalls = 0;
    let toolCallRequests = 0;
    let rejectNextToolCall = false;
    const fetchImpl = async (url, init = {}) => {
        const pathname = new URL(url).pathname;
        if (pathname === '/internal/backends') return json({ backends: [{ id: 'sealdice', ready: true, version: 1 }] });
        if (pathname !== '/mcp') throw new Error(`unexpected MCP URL ${pathname}`);
        const rpc = JSON.parse(init.body);
        const requestSessionId = init.headers['MCP-Session-Id'];
        const rpcResponse = (result, sessionId = currentSessionId) => new Response(JSON.stringify({
            jsonrpc: '2.0', id: rpc.id, result,
        }), { status: 200, headers: { 'content-type': 'application/json', 'Mcp-Session-Id': sessionId } });
        if (rpc.method === 'initialize') {
            initializeCalls++;
            return rpcResponse({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } });
        }
        if (rpc.method === 'notifications/initialized') {
            assert.equal(requestSessionId, currentSessionId);
            return new Response(null, { status: 202, headers: { 'Mcp-Session-Id': currentSessionId } });
        }
        if (requestSessionId !== currentSessionId) {
            return new Response('expired session', { status: 404, headers: { 'content-type': 'text/plain' } });
        }
        if (rpc.method === 'tools/list') return rpcResponse({ tools: [{ name: 'call_ws' }] });
        if (rpc.method === 'tools/call') {
            toolCallRequests++;
            if (rejectNextToolCall) {
                rejectNextToolCall = false;
                return new Response('expired during call', { status: 404, headers: { 'content-type': 'text/plain' } });
            }
            return rpcResponse(bridgeResult(rpc.params.arguments, { outputs: ['1d1 = 1'] }));
        }
        throw new Error(`unexpected RPC ${rpc.method}`);
    };
    const mcp = new OnebotMcpSession({ url: new URL('http://onebot.test/mcp'), token: 'test-mcp-token', fetchImpl });
    await Promise.all([mcp.initialize(), mcp.initialize()]);
    assert.equal(initializeCalls, 1, 'parallel callers share one initialize handshake');
    let descriptor;
    const available = [];
    const ctx = { get: (name) => name === 'tools' ? { register(tool) { descriptor = tool; } } : undefined };
    const service = registerOnebotCommandTool(ctx, {
        appId,
        config: config(),
        session: mcp,
        fetchImpl,
        onAvailability: (value) => available.push(value),
        refreshIntervalMs: 60_000,
    });
    assert.equal(await service.ready, true);
    const first = boundExec([privateOriginal('member-a')]);
    rejectNextToolCall = true;
    const uncertain = await descriptor.execute({ requestId: first.metadata[0].requestId, backend: 'sealdice', command: '.r 1d1' }, first.exec);
    assert.equal(uncertain.status, 'unknown');
    assert.equal(toolCallRequests, 1, 'a failed tools/call is never automatically replayed');
    assert.equal(initializeCalls, 1, 'tools/call failure alone does not silently repeat a handshake');
    await endOnebotTurn(first.agent, first.scope);

    currentSessionId = 'bridge-session-2';
    assert.equal(await service.refresh(), true, 'health refresh reinitializes a restarted bridge session');
    assert.equal(initializeCalls, 2);
    assert.equal(toolCallRequests, 1, 'health recovery performs only initialize/list');
    assert.equal(service.runtime.readyBackends.has('sealdice'), true);
    assert.ok(available.includes(true));

    const second = boundExec([privateOriginal('member-b')]);
    const recovered = await descriptor.execute({ requestId: second.metadata[0].requestId, backend: 'sealdice', command: '.r 1d1' }, second.exec);
    assert.equal(recovered.status, 'ok');
    assert.equal(toolCallRequests, 2);
    await endOnebotTurn(second.agent, second.scope);
    await service.stop();
});

test('FRIEND and C2C reject/receive events are separate; receive never clears a quota denial', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'onebot-friend-state-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const filePath = join(dir, 'friends.json');
    const registry = createOnebotFriendRegistry({ appId, filePath });
    assert.equal(registry.record('FRIEND_ADD', { openid: 'member-a', timestamp: 1 }), true);
    registry.recordGroupMessage({ kind: 'group', senderId: 'member-a', groupOpenid: 'group-a' });
    const source = { appId, audience: 'group', sdkUserId: 'member-a', sdkGroupId: 'group-a' };
    assert.equal(registry.resolveGroupMember(source).proven, true);
    assert.equal(registry.record('C2C_MSG_REJECT', { openid: 'member-a', timestamp: 2 }), true);
    assert.equal(registry.isKnown('member-a'), true, 'reject does not revoke friendship');
    assert.equal(registry.isFriend('member-a'), false);
    assert.equal(registry.resolveGroupMember(source), undefined);
    await registry.flush();

    const restored = createOnebotFriendRegistry({ appId, filePath });
    assert.equal(await restored.load(), true);
    assert.equal(restored.isFriend('member-a'), false, 'reject survives process restart');
    assert.equal(restored.record('C2C_MSG_RECEIVE', { openid: 'member-a', timestamp: 3 }), true);
    assert.equal(restored.isFriend('member-a'), true);
    restored.markIneligible('member-a', 429);
    restored.record('FRIEND_ADD', { openid: 'member-a', timestamp: 4 });
    restored.record('C2C_MSG_RECEIVE', { openid: 'member-a', timestamp: 4 });
    assert.equal(restored.isFriend('member-a'), false, 'friend and receive events must not erase the quota denial');
    assert.equal(restored.diagnostics().ineligibleCount, 1);
    assert.equal(restored.diagnostics().c2cRejectedCount, 0);
    await restored.flush();
});

test('friend-state load merges events arriving during a stale read and persists the merged snapshot', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'onebot-friend-race-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const filePath = join(dir, 'friends.json');
    const original = JSON.stringify({ version: 1, appId, friends: [
        { openid: 'member-a', active: true }, { openid: 'member-b', active: true },
    ], ineligible: [] });
    await writeFile(filePath, original);
    const entered = deferred();
    const release = deferred();
    const registry = createOnebotFriendRegistry({ appId, filePath, readFile: async () => {
        entered.resolve();
        await release.promise;
        return original;
    } });
    const loading = registry.load();
    await entered.promise;
    registry.record('FRIEND_ADD', { openid: 'member-c', timestamp: 5 });
    await registry.flush();
    release.resolve();
    assert.equal(await loading, true);
    await registry.flush();
    const reloaded = createOnebotFriendRegistry({ appId, filePath });
    assert.equal(await reloaded.load(), true);
    for (const user of ['member-a', 'member-b', 'member-c']) assert.equal(reloaded.isFriend(user), true, user);
});

test('a FRIEND_DEL during MCP listTools prevents dispatch, while a separate original request remains usable', async () => {
    const enteredList = deferred();
    const releaseList = deferred();
    const states = new Map([['member-a', true], ['member-b', true]]);
    const friendRegistry = {
        async load() { return true; },
        async flush() { return true; },
        record(type, data) { if (type === 'FRIEND_DEL') states.set(data.openid, false); return true; },
        isFriend(user) { return states.get(user) === true; },
        markIneligible() {},
    };
    let listCalls = 0;
    let dispatched = 0;
    const session = {
        async listTools() {
            listCalls++;
            if (listCalls === 2) { enteredList.resolve(); await releaseList.promise; }
            return [{ name: 'call_ws' }];
        },
        async callWs(args, signal, onDispatch) {
            await this.listTools(signal);
            if (await onDispatch() !== true) throw new Error('dispatch denied');
            dispatched++;
            return bridgeResult(args, { outputs: ['1d1 = 1'] });
        },
    };
    const service = setup({ hidden: true, session, friendRegistry, testSender: true,
        resolveHiddenRecipient: ({ sdkUserId }) => ({ proven: true, userOpenId: sdkUserId }),
        verifyProactiveEligibility: ({ userOpenId }) => friendRegistry.isFriend(userOpenId),
        sendPrivateText: async () => ({ id: 'sent' }),
    });
    assert.equal(await service.service.ready, true);
    const { agent, scope, exec, metadata } = boundExec([groupOriginal('member-a'), groupOriginal('member-b')]);
    const pending = service.descriptor.execute({ requestId: metadata[0].requestId, backend: 'sealdice', command: '.rh 1d1' }, exec);
    await enteredList.promise;
    friendRegistry.record('FRIEND_DEL', { openid: 'member-a' });
    releaseList.resolve();
    assert.equal((await pending).status, 'failed');
    assert.equal(dispatched, 0);
    const other = await service.descriptor.execute({ requestId: metadata[1].requestId, backend: 'sealdice', command: '.r 1d1' }, exec);
    assert.equal(other.status, 'ok');
    assert.equal(dispatched, 1);
    await endOnebotTurn(agent, scope);
    await service.service.stop();
});

test('a failed hidden private send blocks a queued different command in the same original but not another original', async () => {
    const enteredSend = deferred();
    const releaseSend = deferred();
    const friendRegistry = { async load() { return true; }, async flush() { return true; }, isFriend: () => true,
        markIneligible() {} };
    const service = setup({ hidden: true, friendRegistry, testSender: true,
        resolveHiddenRecipient: ({ sdkUserId }) => ({ proven: true, userOpenId: sdkUserId }),
        verifyProactiveEligibility: () => true,
        sendPrivateText: async (_target, _message, options) => {
            assert.equal(await options.beforeDispatch(), true);
            enteredSend.resolve();
            await releaseSend.promise;
            throw new Error('private transport outcome may be uncertain');
        },
        resultForCall(args) {
            if (args.payload.startsWith('.rh')) return bridgeResult(args, {
                outputs: ['public roll acknowledged'], privateReceipt: 'opaque-receipt-1', privateCount: 1,
            });
            return bridgeResult(args, { outputs: ['1d1 = 1'] });
        },
    });
    assert.equal(await service.service.ready, true);
    const { agent, scope, exec, metadata } = boundExec([groupOriginal('member-a'), groupOriginal('member-b')]);
    const firstId = metadata[0].requestId;
    const hidden = service.descriptor.execute({ requestId: firstId, backend: 'sealdice', command: '.rh 1d1' }, exec);
    await enteredSend.promise;
    const queued = service.descriptor.execute({ requestId: firstId, backend: 'sealdice', command: '.r 2d20' }, exec);
    releaseSend.resolve();
    const hiddenResult = await hidden;
    assert.equal(hiddenResult.privateDelivery, 'unknown');
    assert.equal((await queued).status, 'failed');
    assert.equal(service.calls, 1, 'queued expression did not reach Dice after uncertain private delivery');
    const otherOriginal = await service.descriptor.execute({ requestId: metadata[1].requestId, backend: 'sealdice', command: '.r 1d1' }, exec);
    assert.equal(otherOriginal.status, 'ok', 'a distinct actual original message keeps independent authorization');
    assert.equal(service.calls, 2);
    assert.equal(JSON.stringify(hiddenResult).includes('PRIVATE_SENTINEL'), false);
    await endOnebotTurn(agent, scope);
    await service.service.stop();
});


test('log source is current raw text, identity bound and immutable', () => {
    const target = { scope: 'group', targetId: 'group-a', msgId: 'current-id' };
    const fresh = (content = `<@!${appId}> .log on`) => ({ kind: 'group', senderId: 'owner-a',
        groupOpenid: 'group-a', messageId: 'current-id', replyTarget: target,
        content: '.log on', raw: { id: 'current-id', group_openid: 'group-a',
            author: { member_openid: 'owner-a' }, content } });
    assert.equal(captureCurrentLogSource(fresh(`<@!${appId}>\n.log on`), target, appId).command, '.log on');
    const message = fresh();
    message.raw.quote = { content: '.log off' };
    message.raw.attachments = [{ content_type: 'image/png' }];
    const source = captureCurrentLogSource(message, target, appId);
    const binding = { appId, ownerId: 'owner-a', groupId: 'group-a', messageId: 'current-id' };
    assert.equal(source.command, '.log on');
    assert.equal(Object.isFrozen(source), true);
    message.raw.content = '.log off';
    assert.equal(source.command, '.log on');
    assert.equal(isCurrentLogSource(source, binding), true);
    assert.equal(isCurrentLogSource({ ...source }, binding), false);
    for (const changed of [{ ownerId: 'member-b' }, { groupId: 'group-b' },
        { messageId: 'other-id' }, { appId: '999' }]) {
        assert.equal(isCurrentLogSource(source, { ...binding, ...changed }), false);
    }
    for (const content of ['请开启记录', '请解释 .log on', '', `<@!999> .log on`,
        '.log on\n.log off', '.log on' + ' '.repeat(4000)]) {
        assert.equal(captureCurrentLogSource(fresh(content), target, appId), undefined, content.slice(0, 50));
    }
    for (const changed of [{ messageId: 'other-id' }, { senderId: 'member-b' }, { groupOpenid: 'group-b' },
        { raw: undefined }, { kind: 'c2c' }]) {
        assert.equal(captureCurrentLogSource({ ...fresh(), ...changed }, target, appId), undefined);
    }
});

test('native log accepts full current command with quote context and prevents merged source borrowing', async () => {
    const service = setup({ logEnabled: true, backendCapabilities: ['log-capture-v1', 'group-role-v1'],
        logCapture: { enabled: true, setBackends() {}, setUnavailable() {}, stop() {}, async barrier() { return true; } } });
    await service.service.ready;
    const run = async (originals, index, command) => {
        const { agent, scope, exec, metadata } = boundExec(originals);
        try { return await service.descriptor.execute({ requestId: metadata[index].requestId,
            backend: 'sealdice', command }, exec); }
        finally { await endOnebotTurn(agent, scope); }
    };
    try {
        const original = logOriginal('.log on', 'owner', 'owner-a');
        const metadataScope = beginOnebotTurn({}, [original], { appId });
        assert.equal(onebotRequestMetadata(metadataScope)[0].currentLogCommand, '.log on');
        await endOnebotTurn(metadataScope.agent, metadataScope);
        assert.equal((await run([logOriginal('.log on', 'owner', 'owner-a', 'group-a', {
            hasQuote: true, hasAttachments: true, text: 'rendered envelope containing quote text',
        })], 0, '.log on')).status, 'ok');
        const member = logOriginal('.log on', 'member', 'member-b');
        assert.equal((await run([member], 0, '.log on')).failureReason, 'log_role_denied');
        const ownerProse = { ...groupOriginal('owner-a', 'group-a', 'owner'), text: '请开启记录' };
        assert.equal((await run([ownerProse, member], 0, '.log on')).failureReason, 'log_exact_source_required');
        assert.equal((await run([ownerProse, member], 1, '.log on')).failureReason, 'log_role_denied');
        const stolen = { ...ownerProse, currentLogSource: member.currentLogSource };
        assert.equal((await run([stolen], 0, '.log on')).failureReason, 'log_exact_source_required');
        assert.equal((await run([{ ...ownerProse, text: '.log on', hasQuote: true }], 0, '.log on')).failureReason,
            'log_exact_source_required', 'a rendered or quoted command cannot substitute for a raw current command');
        assert.equal(service.calls, 1);
    }
    finally { await service.service.stop(); }
});
