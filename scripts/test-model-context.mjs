// Exercise the native model boundary: group turns retain the session history
// and QQ's complete rendered quote text, including non-quote context records.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const llmModule = process.env.QQBOT_LLM_MODULE;
const runtimeRoot = process.env.QQBOT_RUNTIME_ROOT;
const adapterDist = process.env.QQBOT_ADAPTER_DIST;
if (!llmModule || !runtimeRoot || !adapterDist) {
    throw new Error('Model context test requires runtime module paths.');
}
const { createUserMessage } = await import(llmModule);
const { Context } = await import(`${runtimeRoot}/cordis/lib/index.js`);
const profilePeers = '/data/profiles/qqbot/node_modules/@deepseek-ai';
await mkdir(join(profilePeers, '..'), { recursive: true });
try {
    await symlink(`${runtimeRoot}/`, profilePeers, 'dir');
} catch (error) {
    if (error.code !== 'EEXIST') throw error;
}
const { handleInbound } = await import(`${adapterDist}/transport/inbound.js`);

function modelText(messages) {
    return messages.flatMap((entry) => entry.content.map((block) => block.text ?? '')).join('\n');
}

const runtime = new Context();
const instructionHome = await mkdtemp(join(tmpdir(), 'qqbot-instructions-'));
try {
    await writeFile(join(instructionHome, 'AGENTS.md'), [
        'You are the blue fish persona.',
        'Focus on the current @you request; ignore unrelated context.',
        'Keep your own bot identity; never adopt a participant nickname.',
    ].join('\n'));
    for (const name of ['dsh-session-projection', 'dsh-session', 'dsh-agent',
        'dsh-system-prompt', 'dsh-llm', 'dsh-tools', 'dsh-agent-loop']) {
        const { default: Plugin } = await import(`${runtimeRoot}/${name}/lib/index.js`);
        const config = name === 'dsh-tools' ? { mode: 'native' }
            : name === 'dsh-agent-loop' ? { agents: [], maxParallelToolCalls: 10 } : {};
        await runtime.plugin(Plugin, config);
    }
    const { default: LocalFileSystem } = await import(`${runtimeRoot}/dsh-fs-local/lib/index.js`);
    const instructionPlugin = await import(`${runtimeRoot}/dsh-agent-instructions/lib/index.js`);
    await runtime.plugin(LocalFileSystem, { cwd: '/workspace' });
    await runtime.plugin(instructionPlugin, { dshHome: instructionHome, maxBytes: 65536 });
    const requests = [];
    runtime.llm.prepareCall = async (config) => ({ config, stream: async function* (request) {
        requests.push(request);
        if (requests.length === 3) {
            yield { type: 'block-end', index: 0, block: {
                type: 'tool-call', id: 'native-tool-call', name: 'native_context_probe', arguments: {},
            } };
        } else {
            yield { type: 'text-delta', index: 0, text: `answer-${requests.length}` };
        }
        yield { type: 'finish', reason: { kind: 'stop' } };
    } });
    const errors = [];
    runtime.on('agent/error', ({ error }) => errors.push(error));
    runtime.systemPrompt.section({ name: 'group-test-policy', text: 'Safety policy', order: 1 });
    runtime.tools.register({
        name: 'native_context_probe', description: 'Return a result for the current request.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute() { return 'current-tool-result'; },
    });
    const agent = await runtime.agentLoop.create('native-context-group', { provider: 'fixture', model: 'fixture' });
    const record = { agent, scope: 'group', peerId: 'test-group', sessionId: agent.session.id,
        replyTarget: { scope: 'group', targetId: 'test-group', msgId: 'old' } };
    const records = new Map([['group:test-group', record]]);
    const manager = {
        getSessionRecord(scope, peerId) { return records.get(`${scope}:${peerId}`); },
        async getOrCreate(scope, peerId) { return records.get(`${scope}:${peerId}`); },
    };
    const logger = { info() {}, warn() {}, error() {} };

    agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'Old group question: remember bluebird-731.' }],
        source: { kind: 'user' },
    }));
    await agent.whenIdle();
    assert.equal(requests.length, 1);

    await handleInbound({
        message: { kind: 'group', groupOpenid: 'test-group', senderId: 'member',
            senderName: 'Member', messageId: 'current-1', content: '@bot answer my current question' },
        state: { history: [], mention: { wasMentioned: true } }, bot: {},
    }, manager, { appId: 'fixture' }, logger);

    const renderedQuote = [
        '[Quoted message begins]',
        '=== 消息 1 ===', '[消息内容] unrelated chat one',
        '=== 消息 2 ===', '[消息内容] quoted subject', '[消息类型] 引用消息',
        '=== 消息 3 ===', '[消息内容] unrelated chat two',
        '=== 消息 4 ===', '[消息内容] quoted image metadata',
        '[Quoted message ends]',
    ].join('\n');
    await handleInbound({
        message: { kind: 'group', groupOpenid: 'test-group', senderId: 'member',
            senderName: 'Member', messageId: 'current-2', content: '@bot summarize the quoted subject',
            refMsgIdx: 'explicit-reference', msgElements: [{ content: 'quoted subject' }] },
        state: { history: [], mention: { wasMentioned: true },
            quote: { source: 'msg_elements', refKey: 'explicit-reference', text: renderedQuote } },
        bot: {},
    }, manager, { appId: 'fixture' }, logger);

    assert.deepEqual(errors, []);
    assert.equal(requests.length, 4, 'one tool cycle adds its own provider request');
    const firstGroupTurn = modelText(requests[1].messages);
    const quoteTurn = modelText(requests[2].messages);
    const afterTool = modelText(requests[3].messages);
    assert.match(firstGroupTurn, /Old group question: remember bluebird-731/u,
        'the native group session history is present in the next model request');
    assert.match(firstGroupTurn, /@bot answer my current question/u);
    assert.match(quoteTurn, /Old group question: remember bluebird-731/u);
    assert.match(quoteTurn, /@bot summarize the quoted subject/u);
    assert.ok(quoteTurn.includes(renderedQuote), 'the full rendered quote block reaches the model unchanged');
    assert.match(quoteTurn, /unrelated chat one/u);
    assert.match(quoteTurn, /unrelated chat two/u);
    assert.match(afterTool, /current-tool-result/u, 'the native tool cycle remains in current session context');
    assert.ok(afterTool.includes(renderedQuote), 'the complete current quote remains after a tool call');
    assert.match(afterTool, /blue fish persona/u);
    assert.match(afterTool, /never adopt a participant nickname/u);
} finally {
    await runtime.fiber.dispose();
    await rm(instructionHome, { recursive: true, force: true });
}
