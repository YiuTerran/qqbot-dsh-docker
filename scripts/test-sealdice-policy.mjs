import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const root = process.env.QQBOT_ONEBOT_MODULE_ROOT ? pathToFileURL(`${process.env.QQBOT_ONEBOT_MODULE_ROOT}/`) : new URL('../defaults/', import.meta.url);
const { inspectSeaDiceCommand, readOnebotMasterUsers } = await import(new URL('qqbot-sealdice-policy.mjs', root));
const { validateOnebotCommand, registerOnebotCommandTool, readOnebotConfig } = await import(new URL('qqbot-onebot.mjs', root));
const { matchOnebotDirectCommand } = await import(new URL('qqbot-onebot-direct.mjs', root));
const { beginOnebotTurn, onebotRequestMetadata, endOnebotTurn } = await import(new URL('qqbot-onebot-scope.mjs', root));

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
