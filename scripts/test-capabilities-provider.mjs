// Offline provider-boundary test: real Harness requests, no QQ or paid API.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installChatPolicy } from '/opt/qqbot-defaults/qqbot-chat-policy.mjs';
import { beginDocumentTurn, getDocumentTurn, endDocumentTurn } from '/opt/qqbot-defaults/qqbot-document-scope.mjs';
import { beginOnebotTurn, endOnebotTurn, renderOnebotRequestMetadata } from '/opt/qqbot-defaults/qqbot-onebot-scope.mjs';
const runtimeRoot = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const { Context } = await import(`${runtimeRoot}/cordis/lib/index.js`);
const { createUserMessage } = await import(`${runtimeRoot}/dsh-llm/lib/index.js`);

test('actual provider requests receive current snapshots and matching tools at every model step', async (t) => {
    const ctx = new Context();
    t.after(() => ctx.fiber.dispose());
    for (const name of ['dsh-session-projection', 'dsh-session', 'dsh-agent', 'dsh-system-prompt', 'dsh-llm', 'dsh-tools', 'dsh-agent-loop', 'dsh-web']) {
        const { default: Plugin } = await import(`${runtimeRoot}/${name}/lib/index.js`);
        const config = name === 'dsh-tools' ? { mode: 'native' }
            : name === 'dsh-agent-loop' ? { agents: [] } : name === 'dsh-web' ? { fetchProvider: 'qqbot-pages' } : {};
        await ctx.plugin(Plugin, config);
    }
    let capabilities;
    await ctx.plugin({ inject: ['tools', 'web', 'systemPrompt'], apply(child) { capabilities = installChatPolicy(child); } });
    let enabled = false;
    capabilities.setOnebotProvider(() => enabled ? {
        configured: 'enabled', reason: 'ready', registered: true, available: true, verifiedAt: Date.now(),
        bridge: { readiness: 'ready', checkedAt: Date.now() }, mcp: { readiness: 'ready', checkedAt: Date.now() },
        backends: [{ id: 'sealdice', ready: true, supported: true, capabilities: [] }],
    } : { configured: 'disabled', reason: 'config-disabled' });
    ctx.tools.register({ name: 'qqbot_onebot_command', description: 'test', parameters: { type: 'object' },
        output: { schema: { type: 'object' }, render: () => [] }, execute() { throw new Error('must not call OneBot'); } });
    const requests = [];
    const errors = [];
    ctx.on('agent/error', ({ error }) => errors.push(error));
    ctx.llm.prepareCall = async (config) => ({ config, stream: async function* (request) {
        requests.push(request);
        if (requests.length === 3) {
            enabled = false;
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'local-read-probe',
                name: 'qqbot_read_document', arguments: { attachmentId: 'unavailable-fixture' } } };
        } else yield { type: 'text-delta', index: 0, text: 'fixture response' };
        yield { type: 'finish', reason: { kind: 'stop' } };
    } });
    const agent = await ctx.agentLoop.create('capability-provider-fixture', { provider: 'fixture', model: 'fixture' });
    const send = async (text) => {
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
        await agent.whenIdle();
    };
    await send('.userid');
    enabled = true;
    await send('你有哪些能力');
    beginDocumentTurn(agent, { content: '.userid' });
    const doc = getDocumentTurn(agent);
    const turn = beginOnebotTurn(agent, [{ ownerId: 'owner', text: '.userid', replyTarget: { scope: 'c2c', targetId: 'owner', msgId: 'm' } }],
        { appId: '123', documentScope: doc });
    try { await send(`.userid\n${renderOnebotRequestMetadata(turn)}`); }
    finally { await endOnebotTurn(agent, turn); endDocumentTurn(agent, doc); }
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 4);
    const texts = requests.map((request) => request.messages.flatMap((message) => message.content.map((block) => block.text ?? '')).join('\n'));
    assert.match(texts[0], /"reason":"config-disabled"/u);
    assert.match(texts[1], /"reason":"turn-not-authorized"/u);
    assert.match(texts[2], /"toolAvailable":true,"reason":"ready"/u);
    assert.match(texts[3], /"reason":"config-disabled"/u);
    for (let index = 0; index < requests.length; index++) {
        const tools = requests[index].tools ?? [];
        assert.equal(tools.some((tool) => tool.name === 'qqbot_onebot_command'), index === 2);
    }
});
