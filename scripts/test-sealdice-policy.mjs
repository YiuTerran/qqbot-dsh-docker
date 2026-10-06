import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const root = process.env.QQBOT_ONEBOT_MODULE_ROOT ? pathToFileURL(`${process.env.QQBOT_ONEBOT_MODULE_ROOT}/`) : new URL('../defaults/', import.meta.url);
const { captureOnebotGroupRole, inspectSeaDiceCommand, readOnebotMasterUsers } = await import(new URL('qqbot-sealdice-policy.mjs', root));
const { validateOnebotCommand, registerOnebotCommandTool, readOnebotConfig } = await import(new URL('qqbot-onebot.mjs', root));
const { matchOnebotDirectCommand } = await import(new URL('qqbot-onebot-direct.mjs', root));
const { beginOnebotTurn, onebotRequestMetadata, renderOnebotRequestMetadata, endOnebotTurn } = await import(new URL('qqbot-onebot-scope.mjs', root));

const fixture = process.env.QQBOT_SEALDICE_POLICY_FIXTURE ?? new URL('../third_party/sealdice-core/dice/testdata/onebot-bridge-policy.json', import.meta.url);
const { allowed, denied } = JSON.parse(readFileSync(fixture, 'utf8'));

test('shared tool and direct policy agrees on permitted commands, aliases and per-call limits', () => {
    for (const command of allowed) {
        assert.equal(validateOnebotCommand(command), true, command);
        assert.deepEqual(matchOnebotDirectCommand(command), { command: inspectSeaDiceCommand(command).command }, command);
    }
    for (const command of denied) assert.equal(validateOnebotCommand(command), false, command);
    for (const command of ['.random', '.rdata', '.pcshow', '.scskill', '解释 .r 1d1']) assert.equal(matchOnebotDirectCommand(command), undefined);
    for (const command of ['.rhD100', '.rxh 1d1', '.rah 侦查', '.drlh']) assert.deepEqual(matchOnebotDirectCommand(command), { issue: 'hidden_disabled' });
});

test('only exact supported .set rule choices are classified as group state writes', () => {
    for (const command of ['.set dnd', '.set dnd5e', '.set coc', '.set coc7']) {
        assert.equal(inspectSeaDiceCommand(command).groupStateWrite, true, command);
    }
    for (const command of ['.set info', '.set 100', '.set scripts', '.setcoc', '.setcoc details', '.pc create Alice']) {
        assert.notEqual(inspectSeaDiceCommand(command)?.groupStateWrite, true, command);
    }
});

test('group role capture requires an exact SDK role bound to this sender and group', () => {
    const message = (role = 'member') => ({
        kind: 'group', senderId: 'member-openid', groupOpenid: 'group-openid',
        replyTarget: { scope: 'group', targetId: 'group-openid' },
        raw: { group_openid: 'group-openid', author: { member_openid: 'member-openid', member_role: role } },
    });
    for (const role of ['owner', 'admin', 'member']) assert.equal(captureOnebotGroupRole(message(role)), role);
    for (const role of ['Owner', ' ADMIN ', 'master', '', null, 1]) assert.equal(captureOnebotGroupRole(message(role)), undefined);
    const wrongSender = message('owner'); wrongSender.raw.author.member_openid = 'other-member';
    assert.equal(captureOnebotGroupRole(wrongSender), undefined);
    const wrongGroup = message('owner'); wrongGroup.raw.group_openid = 'other-group';
    assert.equal(captureOnebotGroupRole(wrongGroup), undefined);
    const wrongSdkGroup = message('owner'); wrongSdkGroup.groupOpenid = 'other-group';
    assert.equal(captureOnebotGroupRole(wrongSdkGroup), undefined);
    const noSdkGroupField = message('owner'); delete noSdkGroupField.groupOpenid;
    assert.equal(captureOnebotGroupRole(noSdkGroupField), 'owner', 'the raw group must match the reply target even when the SDK omits groupOpenid');
    const noReplyTarget = message('owner'); delete noReplyTarget.replyTarget;
    assert.equal(captureOnebotGroupRole(noReplyTarget), 'owner', 'the raw group must also bind to SDK groupOpenid when replyTarget is supplied by the context');
    assert.equal(captureOnebotGroupRole(noSdkGroupField, { scope: 'group', targetId: 'other-group' }), undefined);
    const wrongTargetScope = message('owner'); wrongTargetScope.replyTarget.scope = 'c2c';
    assert.equal(captureOnebotGroupRole(wrongTargetScope), undefined);
    assert.equal(captureOnebotGroupRole({ ...message('owner'), kind: 'c2c' }), undefined);
    assert.equal(captureOnebotGroupRole({ ...message('owner'), raw: undefined }), undefined);
});

test('OneBot metadata freezes a read-only role per original request and marks private or invalid roles unknown', async () => {
    const agent = {};
    const owner = { ownerId: 'owner', groupRole: 'owner', text: '.set coc7', replyTarget: { scope: 'group', targetId: 'group' } };
    const member = { ownerId: 'member', groupRole: 'member', text: 'hello', replyTarget: { scope: 'group', targetId: 'group' } };
    const invalid = { ownerId: 'invalid', groupRole: 'Owner', text: 'hello', replyTarget: { scope: 'group', targetId: 'group' } };
    const privateOwner = { ownerId: 'private', groupRole: 'owner', text: '.set coc7', replyTarget: { scope: 'c2c', targetId: 'private' } };
    const scope = beginOnebotTurn(agent, [owner, member, invalid, privateOwner], { appId: '123' });
    owner.groupRole = 'member';
    const metadata = onebotRequestMetadata(scope);
    assert.deepEqual(metadata.map(({ groupRole }) => groupRole), ['owner', 'member', 'unknown', 'unknown']);
    assert.ok(metadata.every((entry) => Object.hasOwn(entry, 'groupRole')));
    assert.match(renderOnebotRequestMetadata(scope), /"groupRole":"unknown"/u);
    await endOnebotTurn(agent, scope);
});

test('shared OneBot executor enforces group-role authorization before dispatch and forwards only the trusted snapshot', async () => {
    const calls = [];
    let capabilities = ['group-role-v1'];
    const service = registerOnebotCommandTool({ get: () => ({ register() {} }) }, {
        config: { enabled: true, backendIds: ['sealdice'], masterUsers: ['123:member'], hiddenEnabled: false,
            url: new URL('http://fixture.test/mcp'), mcpToken: 'fixture', internalToken: 'fixture' },
        session: {
            async listTools() { return [{ name: 'call_ws' }]; },
            async callWs(args, _signal, authorize) {
                assert.equal(await authorize(), true);
                calls.push(args);
                return { content: [{ type: 'text', text: JSON.stringify({ request_id: args.request_id,
                    backend_id: args.backend_id, audience: args.audience, status: 'ok', outputs: [] }) }] };
            },
        },
        fetchImpl: async () => new Response(JSON.stringify({ backends: [{ id: 'sealdice', version: 1, ready: true, capabilities }] }),
            { headers: { 'content-type': 'application/json' } }),
    });
    await service.ready;
    const run = async ({ audience = 'group', role = 'unknown', command = '.set dnd' } = {}) => {
        const agent = {};
        const original = audience === 'private'
            ? { ownerId: 'member', groupRole: role, text: command, replyTarget: { scope: 'c2c', targetId: 'member' } }
            : { ownerId: 'member', groupRole: role, text: command, replyTarget: { scope: 'group', targetId: 'group' } };
        const scope = beginOnebotTurn(agent, [original], { appId: '123' });
        try {
            return await service.execute({ requestId: onebotRequestMetadata(scope)[0].requestId,
                backend: 'sealdice', command }, { agent });
        }
        finally { await endOnebotTurn(agent, scope); }
    };
    try {
        assert.equal((await run({ role: 'owner' })).status, 'ok');
        assert.equal((await run({ role: 'admin' })).status, 'ok');
        assert.deepEqual(calls.map(({ group_role }) => group_role), ['owner', 'admin']);
        assert.equal((await run({ role: 'member' })).failureReason, 'group_role_denied', 'configured Master identity does not bypass the group role check');
        assert.equal((await run({ role: 'Owner' })).failureReason, 'group_role_unknown');
        assert.equal((await run({ audience: 'private', role: 'owner' })).failureReason, 'group_state_private');
        assert.equal((await run({ role: 'member', command: '.set info' })).status, 'ok');
        assert.equal(calls.length, 3, 'member queries remain available while every refused write avoids dispatch');
        assert.equal(calls[2].group_role, 'member');

        service.runtime.groupRoleBackends.clear();
        assert.equal((await run({ role: 'owner' })).failureReason, 'group_role_unsupported');
        assert.equal(calls.length, 3, 'an owner still cannot write when the backend has not negotiated role support');
    }
    finally { await service.stop(); }
});

test('group-role capability loss during call_ws preflight prevents a queued .set dispatch', async () => {
    const dispatched = [];
    let service;
    service = registerOnebotCommandTool({ get: () => ({ register() {} }) }, {
        config: { enabled: true, backendIds: ['sealdice'], masterUsers: [], hiddenEnabled: false,
            url: new URL('http://fixture.test/mcp'), mcpToken: 'fixture', internalToken: 'fixture' },
        session: {
            async listTools() { return [{ name: 'call_ws' }]; },
            async callWs(args, _signal, authorize) {
                service.runtime.groupRoleBackends.clear();
                if (await authorize() !== true) throw new Error('dispatch denied');
                dispatched.push(args);
                return { content: [{ type: 'text', text: JSON.stringify({ request_id: args.request_id,
                    backend_id: args.backend_id, audience: args.audience, status: 'ok', outputs: [] }) }] };
            },
        },
        fetchImpl: async () => new Response(JSON.stringify({ backends: [{ id: 'sealdice', version: 1, ready: true,
            capabilities: ['group-role-v1'] }] }), { headers: { 'content-type': 'application/json' } }),
    });
    await service.ready;
    const agent = {};
    const scope = beginOnebotTurn(agent, [{ ownerId: 'owner', groupRole: 'owner', text: '.set coc7',
        replyTarget: { scope: 'group', targetId: 'group' } }], { appId: '123' });
    try {
        const result = await service.execute({ requestId: onebotRequestMetadata(scope)[0].requestId,
            backend: 'sealdice', command: '.set coc7' }, { agent });
        assert.equal(result.failureReason, 'group_role_unsupported');
        assert.equal(dispatched.length, 0, 'a capability removed after call arguments are built still blocks dispatch');
    }
    finally {
        await endOnebotTurn(agent, scope);
        await service.stop();
    }
});

test('Master identities use bounded app-scoped SDK keys, never nicknames or virtual IDs', () => {
    assert.deepEqual(readOnebotMasterUsers(), []);
    assert.deepEqual(readOnebotMasterUsers('["123:alice","123:alice"]'), ['123:alice']);
    for (const value of ['[8999999999999999]', '["alice"]', '["QQ:8999999999999999"]', '{}', '["123:a\\nb"]']) assert.throws(() => readOnebotMasterUsers(value));
    const config = readOnebotConfig({ QQBOT_ONEBOT_ENABLED: 'true', QQBOT_ONEBOT_MCP_URL: 'http://fixture.test/mcp',
        QQBOT_ONEBOT_MCP_TOKEN: 'fixture-token', QQBOT_ONEBOT_INTERNAL_TOKEN: 'fixture-token', QQBOT_ONEBOT_MASTER_USERS: 'bad-json' });
    assert.equal(config.enabled, true);
    assert.deepEqual(config.masterUsers, []);
    assert.equal(config.masterConfigInvalid, true);
});

test('shared executor independently checks original admin command, private sender, membership and negotiated ACL', async () => {
    let calls = 0;
    const service = registerOnebotCommandTool({ get: () => ({ register() {} }) }, {
        config: { enabled: true, backendIds: ['sealdice'], masterUsers: ['123:alice'], hiddenEnabled: false,
            url: new URL('http://fixture.test/mcp'), mcpToken: 'fixture', internalToken: 'fixture' },
        session: { async listTools() { return [{ name: 'call_ws' }]; }, async callWs(args, _signal, authorize) {
            assert.equal(await authorize(), true); calls++;
            return { content: [{ type: 'text', text: JSON.stringify({ request_id: args.request_id, backend_id: args.backend_id,
                audience: args.audience, status: 'ok', outputs: [] }) }] };
        } },
        fetchImpl: async () => new Response(JSON.stringify({ backends: [{ id: 'sealdice', version: 1, ready: true, capabilities: ['master-acl-v1'] }] }), { headers: { 'content-type': 'application/json' } }),
    });
    await service.ready;
    const run = async (user, audience, text, command = '.master backup', extra = {}) => {
        const agent = {};
        const scope = beginOnebotTurn(agent, [{ ownerId: user, text, ...extra,
            replyTarget: { scope: audience === 'private' ? 'c2c' : 'group', targetId: audience === 'private' ? user : 'group' } }], { appId: '123' });
        try { return await service.execute({ requestId: onebotRequestMetadata(scope)[0].requestId, backend: 'sealdice', command }, { agent }); }
        finally { await endOnebotTurn(agent, scope); }
    };
    try {
        assert.equal((await run('alice', 'private', '.master backup')).status, 'ok');
        for (const [user, audience, text] of [['mallory', 'private', '.master backup'], ['alice', 'group', '.master backup'],
            ['alice', 'private', '请解释 .master backup'], ['alice', 'private', '.master list'],
            ['alice', 'private', '.master backup' + ' '.repeat(4000) + 'extra text']]) {
            assert.equal((await run(user, audience, text)).status, 'failed');
        }
        for (const extra of [{ originalTextLength: 5000 }, { hasQuote: true },
            { currentAttachments: [{ url: 'https://fixture.test/a.png' }] },
            { quotedAttachments: [{ url: 'https://fixture.test/a.png' }] }]) {
            assert.equal((await run('alice', 'private', '.master backup', '.master backup', extra)).status, 'failed');
        }
        service.runtime.adminBackends.clear();
        assert.equal((await run('alice', 'private', '.master backup')).status, 'failed');
        assert.equal(calls, 1, 'all rejected admin attempts must remain before dispatch');
        for (const hidden of ['.rh 1d1', '.rxh 1d1', '.rah 侦查', '.drlh']) {
            const result = await run('alice', 'private', hidden, hidden);
            assert.equal(result.status, 'failed'); assert.match(result.notice, /不支持暗骰/);
        }
    } finally { await service.stop(); }
});
