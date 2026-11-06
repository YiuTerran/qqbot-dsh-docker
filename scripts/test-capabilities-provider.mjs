// Offline provider-boundary test: real Harness requests, no QQ or paid API.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installChatPolicy } from '/opt/qqbot-defaults/qqbot-chat-policy.mjs';
import { beginDocumentTurn, getDocumentTurn, endDocumentTurn } from '/opt/qqbot-defaults/qqbot-document-scope.mjs';
import { beginOnebotTurn, endOnebotTurn, renderOnebotRequestMetadata } from '/opt/qqbot-defaults/qqbot-onebot-scope.mjs';
const runtimeRoot = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const { Context } = await import(`${runtimeRoot}/cordis/lib/index.js`);
const { createUserMessage, LlmAdapter } = await import(`${runtimeRoot}/dsh-llm/lib/index.js`);

for (const toolUpdate of [undefined, 'addition-only', 'in-history']) test(`actual provider requests retain capability/tool alignment with ${toolUpdate ?? 'ordinary'} updates`, async (t) => {
    const ctx = new Context();
    t.after(() => ctx.fiber.dispose());
    for (const name of ['dsh-session-projection', 'dsh-session', 'dsh-agent', 'dsh-system-prompt', 'dsh-llm', 'dsh-tools', 'dsh-tool-executor-native', 'dsh-agent-loop', 'dsh-web']) {
        const loaded = await import(`${runtimeRoot}/${name}/lib/index.js`);
        const config = name === 'dsh-agent-loop' ? { agents: [] } : name === 'dsh-web' ? { fetchProvider: 'qqbot-pages' } : {};
        await ctx.plugin(loaded.default ?? loaded, config);
    }
    let capabilities;
    await ctx.plugin({ inject: ['tools', 'web', 'systemPrompt'], apply(child) { capabilities = installChatPolicy(child); } });
    ctx.systemPrompt.suppressRuntimeContext();
    let enabled = false;
    capabilities.setOnebotProvider(() => enabled ? {
        configured: 'enabled', reason: 'ready', registered: true, available: true, verifiedAt: Date.now(),
        bridge: { readiness: 'ready', checkedAt: Date.now() }, mcp: { readiness: 'ready', checkedAt: Date.now() },
        backends: [{ id: 'sealdice', ready: true, supported: true, capabilities: [] }],
    } : { configured: 'disabled', reason: 'config-disabled' });
    ctx.tools.register({ name: 'qqbot_onebot_command', description: 'test', parameters: { type: 'object' },
        output: { schema: { type: 'object' }, render: () => [] }, execute() { throw new Error('must not call OneBot'); } });
    ctx.tools.register({ name: 'untrusted-plugin', description: 'test', parameters: { type: 'object' },
        output: { schema: { type: 'object' }, render: () => [] }, execute() { throw new Error('unsafe plugin ran'); } });
    ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'untrusted-provider', description: 'test', parameters: { type: 'object' } }] }));
    const requests = [];
    const errors = [];
    ctx.on('agent/error', ({ error }) => errors.push(error));
    class FixtureAdapter extends LlmAdapter {
        async resolveModel(provider, id) { return { provider, id, name: id, toolUpdate, systemPromptUpdate: 'in-history' }; }
        async *stream(request) {
        requests.push(request);
        if (requests.length === 3) {
            enabled = false;
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'local-read-probe',
                name: 'qqbot_read_document', arguments: { attachmentId: 'unavailable-fixture' } } };
        } else yield { type: 'text-delta', index: 0, text: 'fixture response' };
        yield { type: 'finish', reason: { kind: 'stop' } };
        }
    }
    ctx.llm.registerAdapter(['fixture'], new FixtureAdapter());
    const agent = await ctx.agentLoop.create('capability-provider-fixture', { provider: 'fixture', model: 'fixture' });
    agent.ctx.tools.register({ name: 'untrusted-scoped', description: 'test', parameters: { type: 'object' },
        output: { schema: { type: 'object' }, render: () => [] }, execute() { throw new Error('unsafe scoped tool ran'); } });
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
        assert.equal(tools.some(tool => tool.name.startsWith('untrusted-')), false, 'plugin, scoped and provider declarations stay off the model wire');
    }
});

test('native admission rejects global, scoped and provider-only tools and preserves revocation', async t => {
    const ctx = new Context();
    t.after(() => ctx.fiber.dispose());
    for (const name of ['dsh-session-projection', 'dsh-session', 'dsh-agent', 'dsh-system-prompt', 'dsh-llm', 'dsh-tools', 'dsh-tool-executor-native', 'dsh-agent-loop', 'dsh-web']) {
        const loaded = await import(`${runtimeRoot}/${name}/lib/index.js`);
        await ctx.plugin(loaded.default ?? loaded, name === 'dsh-agent-loop' ? { agents: [] } : {});
    }
    let capabilities;
    await ctx.plugin({ inject: ['tools', 'web', 'systemPrompt'], apply(child) { capabilities = installChatPolicy(child); } });
    capabilities.setOnebotProvider(() => ({ configured: 'disabled', reason: 'config-disabled' }));
    const agent = await ctx.agentLoop.create('admission-fixture', { provider: 'fixture', model: 'fixture' });
    let executed = 0;
    const definition = name => ({ name, description: 'same description', parameters: { type: 'object' },
        output: { schema: { type: 'object' }, render: () => [] }, execute() { executed++; return {}; } });
    ctx.tools.register(definition('unknown-global'));
    agent.ctx.tools.register(definition('unknown-scoped'));
    ctx.systemPrompt.tools(() => ({ schemas: [definition('provider-only')] }));
    const removeAllowed = ctx.tools.register(definition('web_search'));
    ctx.tools.register(definition('qqbot_generate_image'));
    capabilities.setConfigured('image_generation', 'disabled');
    ctx.systemPrompt.tools(() => ({ schemas: [
        { ...definition('web_search'), description: 'forged schema' },
        definition('qqbot_describe_image'),
        definition('qqbot_generate_image'),
    ] }));
    const direct = await ctx.systemPrompt.assemble({ agent, scope: agent });
    assert.equal(direct.tools.some(tool => tool.name === 'qqbot_describe_image'), false,
        'an allowlisted name without a native registration is not a capability');
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembly = await next();
        await Promise.resolve();
        capabilities.setConfigured('image_generation', 'enabled');
        return assembly;
    });
    const signal = new AbortController().signal;
    const selection = await ctx.tools.resolve({ agent, modelSelection: { provider: 'fixture', model: 'fixture' }, signal });
    const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent, toolSet: selection });
    assert.deepEqual(assembly.tools.map(tool => tool.name).sort(), ['qqbot_read_document', 'web_search']);
    assert.equal(assembly.tools.find(tool => tool.name === 'web_search').description, 'same description',
        'provider duplicate cannot replace the admitted native schema');
    const snapshot = JSON.parse(assembly.contexts.find(item => item.name === 'qqbot:capabilities').text.split('\n').at(-1));
    assert.equal(snapshot.capabilities.image_generation.toolAvailable, false,
        'state changes during awaited assembly cannot expand the accepted tool set');
    assert.deepEqual([...selection.view(agent).keys()].sort(), ['qqbot_read_document', 'web_search']);
    assert.equal(selection.view({}).size, 0, 'another scope cannot reuse this admission');
    ctx.on('tools/pre-execute', () => ({ kind: 'allow' }), { prepend: true });
    const execute = (name, toolSet) => ctx.tools.execute({ agent, toolSet, signal,
        calls: [{ type: 'tool-call', id: name, name, arguments: {} }] });
    for (const name of ['unknown-global', 'unknown-scoped', 'provider-only']) {
        assert.equal((await execute(name, selection)).results[0].result.isError, true);
        assert.equal((await execute(name)).results[0].result.isError, true, 'direct execution stays guarded');
    }
    removeAllowed();
    ctx.tools.register(definition('web_search'));
    assert.equal(selection.view(agent).has('web_search'), false, 'same-name replacement cannot inherit admission');
    assert.equal((await execute('web_search', selection)).results[0].result.isError, true);
    selection.dispose();
    assert.equal(selection.view(agent).size, 0);
    assert.equal(executed, 0);
});
