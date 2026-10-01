import assert from 'node:assert/strict';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

const sessionModule = process.env.QQBOT_SESSION_MODULE;
const llmModule = process.env.QQBOT_LLM_MODULE;
const runtimeRoot = process.env.QQBOT_RUNTIME_ROOT;
const adapterDist = process.env.QQBOT_ADAPTER_DIST;
const compactionModule = process.env.QQBOT_COMPACTION_MODULE;
const policyModule = process.env.QQBOT_MODEL_CONTEXT_MODULE;
if (!sessionModule || !llmModule || !runtimeRoot || !adapterDist || !compactionModule || !policyModule) {
    throw new Error('Model context test requires runtime module paths.');
}
const { Session } = await import(sessionModule);
const { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage } = await import(llmModule);
const { Context } = await import(`${runtimeRoot}/cordis/lib/index.js`);
const profilePeers = '/data/profiles/qqbot/node_modules/@deepseek-ai';
await mkdir(join(profilePeers, '..'), { recursive: true });
try {
    await symlink(`${runtimeRoot}/`, profilePeers, 'dir');
} catch (error) {
    if (error.code !== 'EEXIST') throw error;
}
const { handleInbound } = await import(`${adapterDist}/transport/inbound.js`);
const { BasicCompactionEngine } = await import(compactionModule);
const {
    beginGroupModelContext,
    endGroupModelContext,
    isGroupModelContextGuarded,
    projectGroupModelMessages,
} = await import(policyModule);

function add(session, type, message, options = {}) {
    return session.append(type, type === 'user/message' ? message : { message, ...options.data }, {
        surfaceOp: options.surfaceOp ?? 'append',
        ...options.sourceEventSeqs ? { sourceEventSeqs: options.sourceEventSeqs } : {},
    });
}

function message(role, text, source = { kind: 'user' }) {
    const content = [{ type: 'text', text }];
    if (role === 'system') return createSystemMessage(text);
    if (role === 'assistant') return createAssistantMessage({ content, source });
    if (role === 'tool') return createToolResultMessage({ callId: source.callId, content, isError: false });
    return createUserMessage({ content, source });
}

function texts(messages) {
    return messages.map((item) => item.content.map((block) => block.text ?? block.type).join(' '));
}

test('real QQ inbound and AgentLoop stream receive only the current group batch', async () => {
    const runtime = new Context();
    try {
        for (const name of ['dsh-session-projection', 'dsh-session', 'dsh-agent',
            'dsh-system-prompt', 'dsh-llm', 'dsh-tools', 'dsh-agent-loop']) {
            const { default: Plugin } = await import(`${runtimeRoot}/${name}/lib/index.js`);
            const config = name === 'dsh-tools' ? { mode: 'native' }
                : name === 'dsh-agent-loop' ? { agents: [], maxParallelToolCalls: 10 } : {};
            await runtime.plugin(Plugin, config);
        }
        const requests = [];
        runtime.llm.prepareCall = async (config) => ({ config, stream: async function* (request) {
            requests.push(request);
            if (requests.length === 3) {
                yield { type: 'block-end', index: 0, block: {
                    type: 'tool-call', id: 'current-tool-call', name: 'current_probe_tool', arguments: {},
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
            name: 'current_probe_tool', description: 'Return current request data.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute() { return 'current-tool-result'; },
        });
        const agent = await runtime.agentLoop.create('live-group', { provider: 'fixture', model: 'fixture' });
        const record = { agent, scope: 'group', peerId: 'test-group', sessionId: agent.session.id,
            replyTarget: { scope: 'group', targetId: 'test-group', msgId: 'old' } };
        const records = new Map([['group:test-group', record]]);
        const manager = {
            getSessionRecord(scope, peerId) { return records.get(`${scope}:${peerId}`); },
            async getOrCreate(scope, peerId) { return records.get(`${scope}:${peerId}`); },
        };
        const logger = { info() {}, warn() {}, error() {} };
        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Old group question' }], source: { kind: 'user' } }));
        await agent.whenIdle();
        assert.equal(requests.length, 1);
        for (const [index, content] of ['First batch', 'Second batch'].entries()) {
            await handleInbound({
                message: { kind: 'group', groupOpenid: 'test-group', senderId: 'member',
                    senderName: 'Member', messageId: `msg-${index}`, content },
                state: { history: [], mention: { wasMentioned: true },
                    ...(index === 1 ? { quote: { text: 'Explicit quote text' } } : {}) },
                bot: {},
            }, manager, { appId: 'fixture' }, logger);
        }
        assert.deepEqual(errors, []);
        assert.equal(requests.length, 4);
        const first = JSON.stringify(requests[1].messages);
        const second = JSON.stringify(requests[2].messages);
        const afterTool = JSON.stringify(requests[3].messages);
        assert.match(first, /First batch/);
        assert.doesNotMatch(first, /Old group question|answer-1/);
        assert.match(second, /Second batch/);
        assert.match(second, /Explicit quote text/);
        assert.doesNotMatch(second, /Old group question|First batch|answer-1|answer-2/);
        assert.match(afterTool, /Second batch/);
        assert.match(afterTool, /Explicit quote text/);
        assert.match(afterTool, /current-tool-result/);
        assert.doesNotMatch(afterTool, /Old group question|First batch|answer-1|answer-2/);
        assert.equal(requests[3].messages.find((item) => item.role === 'tool')?.toolCallId, 'current-tool-call');
        assert.equal(requests[1].messages[0].role, 'system');
        assert.equal(requests[2].messages[0].role, 'system');
        assert.ok(agent.session.deriveMessages().length > requests[2].messages.length,
            'the shared session retains old messages while the provider request excludes them');
        const previousValue = process.env.QQBOT_GROUP_CURRENT_ONLY;
        process.env.QQBOT_GROUP_CURRENT_ONLY = 'false';
        try {
            await handleInbound({
                message: { kind: 'group', groupOpenid: 'test-group', senderId: 'member',
                    senderName: 'Member', messageId: 'history-enabled', content: 'History enabled' },
                state: { history: [], mention: { wasMentioned: true } }, bot: {},
            }, manager, { appId: 'fixture' }, logger);
        } finally {
            if (previousValue === undefined) delete process.env.QQBOT_GROUP_CURRENT_ONLY;
            else process.env.QQBOT_GROUP_CURRENT_ONLY = previousValue;
        }
        assert.equal(requests.length, 5);
        assert.match(JSON.stringify(requests[4].messages), /Old group question/);
        assert.match(JSON.stringify(requests[4].messages), /First batch/);
        assert.match(JSON.stringify(requests[4].messages), /History enabled/);
        const privateAgent = await runtime.agentLoop.create('live-private', { provider: 'fixture', model: 'fixture' });
        records.set('c2c:private-peer', { agent: privateAgent, scope: 'c2c', peerId: 'private-peer',
            sessionId: privateAgent.session.id, replyTarget: { scope: 'c2c', targetId: 'private-peer', msgId: 'private-1' } });
        for (const content of ['Private first turn', 'Private second turn']) {
            await handleInbound({
                message: { kind: 'c2c', senderId: 'private-peer', messageId: content, content },
                state: { history: [] }, bot: {},
            }, manager, { appId: 'fixture' }, logger);
        }
        assert.equal(requests.length, 7);
        const privateSecond = JSON.stringify(requests[6].messages);
        assert.match(privateSecond, /Private first turn/);
        assert.match(privateSecond, /Private second turn/);
        assert.match(privateSecond, /answer-6/);
    } finally {
        await runtime.fiber.dispose();
    }
});

test('group request projects current batch, explicit quote, and current tool result from a resumed session', async () => {
    const session = Session.create('old-group-session');
    add(session, 'system/message', message('system', 'Full safety prompt A', { kind: 'system-prompt' }));
    add(session, 'user/message', message('user', 'Old secret group question'));
    const resumed = Session.create('resumed-group', session.snapshotEvents());
    add(resumed, 'assistant/message', message('assistant', 'Old answer', { provider: 'fixture', model: 'fixture' }), { data: { turn: 1, step: 1 } });
    add(resumed, 'user/message', message('user', 'Old compact summary', { kind: 'compact-checkpoint', compactionId: 'old' }));
    const agent = { session: resumed };
    const turn = { active: true };
    const guard = beginGroupModelContext(agent, 'group', turn, true);
    add(resumed, 'user/message', message('user', '[Quoted message begins]\nexplicit photo\n[Quoted message ends]\nCurrent request'));
    add(resumed, 'assistant/message', message('assistant', 'Calling tool', { provider: 'fixture', model: 'fixture' }), { data: { turn: 2, step: 1 } });
    add(resumed, 'tool/result', message('tool', 'Current tool result', { callId: 'current-call' }), { data: { turn: 2, step: 1 } });
    const projected = projectGroupModelMessages(agent, resumed.deriveMessages());
    assert.deepEqual(texts(projected), ['Full safety prompt A', '[Quoted message begins]\nexplicit photo\n[Quoted message ends]\nCurrent request', 'Calling tool', 'Current tool result']);
    assert.equal(projected[0].role, 'system');
    assert.equal(projected.at(-1).role, 'tool');
    assert.equal(isGroupModelContextGuarded(agent), true);
    assert.equal(await BasicCompactionEngine.prototype.compactIfNeeded.call({}, agent, 'pressure'), null,
        'group compaction never replays excluded history into an auxiliary model request');
    endGroupModelContext(agent, guard);
    turn.active = false;
    assert.throws(() => projectGroupModelMessages(agent, resumed.deriveMessages()), /no longer active/);
    assert.equal(await BasicCompactionEngine.prototype.compactIfNeeded.call({}, agent, 'pressure'), null,
        'an expired group turn remains guarded');
});

test('current replacement checkpoint cannot reintroduce an old lineage', () => {
    const session = Session.create('checkpoint-group');
    add(session, 'system/message', message('system', 'Full safety prompt', { kind: 'system-prompt' }));
    const old = add(session, 'user/message', message('user', 'Old private detail'));
    const agent = { session };
    const guard = beginGroupModelContext(agent, 'group', { active: true }, true);
    add(session, 'user/message', message('user', 'Current question'));
    add(session, 'user/message', message('user', 'Summarized old detail', { kind: 'compact-checkpoint' }), {
        sourceEventSeqs: [old.seq],
    });
    assert.deepEqual(texts(projectGroupModelMessages(agent, session.deriveMessages())), ['Full safety prompt', 'Current question']);
    endGroupModelContext(agent, guard);
});

test('latest full system prompt survives an empty later system snapshot', () => {
    const session = Session.create('system-snapshots');
    add(session, 'system/message', message('system', 'Safety policy A'));
    add(session, 'user/message', message('user', 'Old request'));
    const agent = { session };
    const guard = beginGroupModelContext(agent, 'group', { active: true }, true);
    add(session, 'system/message', message('system', 'Safety policy B'));
    add(session, 'system/message', message('system', ''));
    add(session, 'user/message', message('user', 'Current request'));
    assert.deepEqual(texts(projectGroupModelMessages(agent, session.deriveMessages())),
        ['Safety policy B', 'Current request']);
    endGroupModelContext(agent, guard);
});

test('private and disabled group requests preserve native history and compaction', async () => {
    const session = Session.create('ordinary');
    add(session, 'user/message', message('user', 'Earlier question'));
    const agent = { session };
    assert.equal(beginGroupModelContext(agent, 'c2c', { active: true }), null);
    const privateMessages = session.deriveMessages();
    assert.equal(projectGroupModelMessages(agent, privateMessages), privateMessages);
    assert.equal(beginGroupModelContext(agent, 'group', { active: true }, false), null);
    const groupMessages = session.deriveMessages();
    assert.equal(projectGroupModelMessages(agent, groupMessages), groupMessages);
    assert.equal(isGroupModelContextGuarded(agent), false);
    assert.equal(await BasicCompactionEngine.prototype.compactIfNeeded.call({}, agent, 'pressure'), null,
        'unscoped compaction follows its native no-route path');
});

test('guards are isolated across concurrent group sessions and reject a superseded scope', () => {
    const first = { session: Session.create('group-one') };
    const second = { session: Session.create('group-two') };
    const firstTurn = { active: true };
    const secondTurn = { active: true };
    const firstGuard = beginGroupModelContext(first, 'group', firstTurn, true);
    const secondGuard = beginGroupModelContext(second, 'group', secondTurn, true);
    add(first.session, 'user/message', message('user', 'Group one current'));
    add(second.session, 'user/message', message('user', 'Group two current'));
    assert.deepEqual(texts(projectGroupModelMessages(first, first.session.deriveMessages())), ['Group one current']);
    assert.deepEqual(texts(projectGroupModelMessages(second, second.session.deriveMessages())), ['Group two current']);
    firstTurn.active = false;
    assert.throws(() => projectGroupModelMessages(first, first.session.deriveMessages()), /no longer active/);
    assert.deepEqual(texts(projectGroupModelMessages(second, second.session.deriveMessages())), ['Group two current']);
    endGroupModelContext(first, firstGuard);
    endGroupModelContext(second, secondGuard);
});
