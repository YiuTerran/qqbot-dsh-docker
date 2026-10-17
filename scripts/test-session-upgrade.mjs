// Write with the actual old runtime, then resume the same v4 log with the new one.
import assert from 'node:assert/strict';
const root = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const { Context } = await import(`${root}/cordis/lib/index.js`);
const { createUserMessage } = await import(`${root}/dsh-llm/lib/index.js`);
const ctx = new Context();
const mode = process.argv[2];
if (!['write', 'resume'].includes(mode) || !process.env.QQBOT_HISTORY_ROOT) throw new Error('Expected write/resume and QQBOT_HISTORY_ROOT.');
try {
    for (const name of ['dsh-session-projection', 'dsh-session', 'dsh-session-persistence-jsonl',
        'dsh-agent', 'dsh-system-prompt', 'dsh-llm', 'dsh-tools', 'dsh-agent-loop']) {
        const loaded = await import(`${root}/${name}/lib/index.js`);
        await ctx.plugin(loaded.default ?? loaded, name === 'dsh-session-persistence-jsonl'
            ? { root: process.env.QQBOT_HISTORY_ROOT } : name === 'dsh-agent-loop' ? { agents: [] } : {});
    }
    const requests = [];
    const errors = [];
    ctx.on('agent/error', ({ error }) => errors.push(error));
    ctx.llm.prepareCall = async config => ({ config, stream: async function* (request) {
        requests.push(request);
        yield { type: 'text-delta', index: 0, text: mode === 'write' ? 'OLD_ASSISTANT_SENTINEL' : 'NEW_ASSISTANT_SENTINEL' };
        yield { type: 'finish', reason: { kind: 'stop' } };
    } });
    const id = 'qqbot-real-history-upgrade';
    const handle = mode === 'write'
        ? await ctx.agents.create({ sessionId: id, agentOptions: { provider: 'fixture', model: 'fixture' }, meta: { cwd: '/workspace' } })
        : await ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'fixture', model: 'fixture' } });
    const agent = handle.agent;
    agent.followup(createUserMessage({ content: [{ type: 'text', text: mode === 'write' ? 'OLD_USER_SENTINEL' : 'NEW_USER_SENTINEL' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 1);
    if (mode === 'resume') {
        const text = requests[0].messages.flatMap(message => message.content.map(block => block.text ?? '')).join('\n');
        for (const sentinel of ['OLD_USER_SENTINEL', 'OLD_ASSISTANT_SENTINEL', 'NEW_USER_SENTINEL']) assert.ok(text.includes(sentinel), sentinel);
    }
    await ctx.sessionPersistence.flush();
    await handle.dispose();
    console.log(`Historical session ${mode} passed`);
} finally { await ctx.fiber.dispose(); }
