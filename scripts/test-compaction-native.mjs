import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, symlink } from 'node:fs/promises';
import { installChatPolicy } from '/opt/qqbot-defaults/qqbot-chat-policy.mjs';
const root = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const { Context } = await import(`${root}/cordis/lib/index.js`);
const { LlmAdapter, createUserMessage } = await import(`${root}/dsh-llm/lib/index.js`);
await mkdir('/data/profiles/qqbot/node_modules', { recursive: true });
try { await symlink(root, '/data/profiles/qqbot/node_modules/@deepseek-ai', 'dir'); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
const { SessionManager } = await import(`${process.env.QQBOT_ADAPTER_DIST}/session/session-manager.js`);

test('QQ manual compaction preserves the session and refreshes current capabilities afterwards', async t => {
    const ctx = new Context();
    t.after(() => ctx.fiber.dispose());
    for (const name of ['dsh-session-projection', 'dsh-session', 'dsh-agent', 'dsh-system-prompt',
        'dsh-llm', 'dsh-tools', 'dsh-agent-loop', 'dsh-web', 'dsh-token-meter', 'dsh-compaction-basic']) {
        const loaded = await import(`${root}/${name}/lib/index.js`);
        await ctx.plugin(loaded.default ?? loaded, name === 'dsh-agent-loop' ? { agents: [] }
            : name === 'dsh-compaction-basic' ? { auto: false } : {});
    }
    let capabilities;
    await ctx.plugin({ inject: ['tools', 'web', 'systemPrompt'], apply(child) { capabilities = installChatPolicy(child); } });
    capabilities.setOnebotProvider(() => ({ configured: 'disabled', reason: 'config-disabled' }));
    const requests = [];
    let summarizing = false;
    class Adapter extends LlmAdapter {
        async resolveModel(provider, id) { return { provider, id, name: id, context: { contextWindow: 1_000_000 }, defaultMaxTokens: 4096 }; }
        async *stream(request) {
            requests.push(request);
            yield { type: 'text-delta', index: 0, text: summarizing ? 'COMPACT_SUMMARY_SENTINEL: retain the conversation topic.' : 'fixture answer' };
            yield { type: 'finish', reason: { kind: 'stop' } };
        }
    }
    ctx.llm.registerAdapter(['fixture'], new Adapter());
    const agent = await ctx.agentLoop.create('compact-native-fixture', { provider: 'fixture', model: 'fixture' });
    const errors = [];
    ctx.on('agent/error', ({ error }) => errors.push(error));
    const send = async text => {
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
        await agent.whenIdle();
    };
    await send('A historical topic. '.repeat(100));
    await send('More historical context. '.repeat(100));
    const manager = Object.create(SessionManager.prototype);
    Object.assign(manager, { ctx, sessions: new Map([['c2c:owner', { agent }]]),
        sessionKey: (scope, peer) => `${scope}:${peer}`, getPresetsService: () => undefined,
        modelResolver: { getEffectiveRoute: () => ({ provider: 'fixture', model: 'fixture' }) }, logger: { warn() {}, error() {} } });
    assert.deepEqual(await manager.compact('c2c', 'missing'), { ok: false, reason: 'no-session' });
    summarizing = true;
    const result = await manager.compact('c2c', 'owner');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.shadowed > 0, 'manual compaction must replace historical surface events');
    summarizing = false;
    await send('Current capability question after compaction');
    assert.deepEqual(errors, []);
    const text = requests.at(-1).messages.flatMap(message => message.content.map(block => block.text ?? '')).join('\n');
    assert.match(text, /COMPACT_SUMMARY_SENTINEL/u);
    assert.match(text, /"reason":"config-disabled"/u);
    assert.equal(agent.session.id, 'compact-native-fixture');
});
