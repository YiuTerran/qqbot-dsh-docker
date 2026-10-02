import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
const { logContextInbound, logContextBinding, logContextProjection } = await import('/opt/qqbot-defaults/qqbot-context-diagnostics.mjs');
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
    const previousDebug = process.env.QQBOT_CONTEXT_DEBUG;
    const originalInfo = console.info;
    const diagnosticLines = [];
    process.env.QQBOT_CONTEXT_DEBUG = 'true';
    console.info = (...args) => {
        const line = args.join(' ');
        if (line.startsWith('[qqbot-context-debug] ')) diagnosticLines.push(line);
        else originalInfo(...args);
    };
    const runtime = new Context();
    const instructionHome = await mkdtemp(join(tmpdir(), 'qqbot-instructions-'));
    try {
        await writeFile(join(instructionHome, 'AGENTS.md'), 'You are the blue fish persona.');
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
        assert.match(JSON.stringify(requests[0].messages), /blue fish persona/);
        for (const [index, content] of ['First batch', 'Second batch'].entries()) {
            await handleInbound({
                message: { kind: 'group', groupOpenid: 'test-group', senderId: 'member',
                    senderName: 'Member', messageId: `msg-${index}`, content,
                    ...(index === 1 ? {
                        refMsgIdx: 'SENSITIVE_REFERENCE_ID',
                        msgElements: [{ content: 'SENSITIVE_ELEMENT_BODY' }],
                        raw: { msg_elements: [{ content: 'https://private.example/SENSITIVE_TOKEN' }] },
                    } : {}) },
                state: { history: [], mention: { wasMentioned: true },
                    ...(index === 1 ? { quote: { source: 'msg_elements', refKey: 'SENSITIVE_REFERENCE_ID',
                        text: 'Explicit quote text SENSITIVE_QUOTE_BODY' } } : {}) },
                bot: {},
            }, manager, { appId: 'fixture' }, logger);
        }
        assert.deepEqual(errors, []);
        assert.equal(requests.length, 4);
        const first = JSON.stringify(requests[1].messages);
        const second = JSON.stringify(requests[2].messages);
        const afterTool = JSON.stringify(requests[3].messages);
        assert.match(first, /First batch/);
        assert.match(first, /blue fish persona/);
        assert.doesNotMatch(first, /Old group question|answer-1/);
        assert.match(second, /Second batch/);
        assert.match(second, /blue fish persona/);
        assert.match(second, /Explicit quote text/);
        assert.doesNotMatch(second, /Old group question|First batch|answer-1|answer-2/);
        assert.match(afterTool, /Second batch/);
        assert.match(afterTool, /blue fish persona/);
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
        const diagnostics = diagnosticLines.map((line) => JSON.parse(line.slice('[qqbot-context-debug] '.length)));
        const inbound = diagnostics.filter((entry) => entry.stage === 'inbound');
        const bounds = diagnostics.filter((entry) => entry.stage === 'bound');
        const projections = diagnostics.filter((entry) => entry.stage === 'projection' && entry.state === 'applied');
        assert.equal(inbound.length, 5, 'each QQ inbound emits one metadata-only record');
        assert.equal(bounds.length, 5, 'each QQ inbound binds its final request body');
        assert.deepEqual(bounds.map((entry) => entry.assembledBody.hmac),
            inbound.map((entry) => entry.assembledBody.hmac),
            'the bound event can be matched to its original inbound event');
        assert.equal(projections.length, 3, 'each guarded model request emits one projection record');
        assert.equal(inbound[1].explicitQuote, true);
        assert.equal(inbound[1].quote.source, 'msg_elements');
        assert.equal(inbound[1].msgElements.count, 1);
        assert.equal(inbound[1].rawMsgElements.count, 1);
        assert.equal(inbound[1].assembledBody.quoteStart, 1);
        assert.equal(inbound[1].assembledBody.historyStart, 0);
        for (const [index, projection] of projections.entries()) {
            const actual = requests[index + 1].messages;
            const bound = bounds[index === 0 ? 0 : 1];
            assert.equal(projection.sessionHmac, bound.sessionHmac);
            assert.ok(projection.messages.some((entry) => entry.role === 'user' && entry.hmac === bound.body.hmac),
                'the final bound QQ body appears in the provider request');
            assert.ok(projection.inputCount >= projection.outputCount);
            assert.equal(projection.outputCount, actual.length);
            assert.deepEqual(projection.messages.map((entry) => entry.role), actual.map((entry) => entry.role));
            assert.deepEqual(projection.messages.map((entry) => entry.length), actual.map((entry) =>
                entry.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').length));
            assert.ok(projection.messages.every((entry) => /^[0-9a-f]{20}$/u.test(entry.hmac)));
        }
        assert.ok(projections[0].droppedOldEventCount >= 2);
        assert.ok(projections.every((entry) => entry.retainedInstructionCount === 1));
        assert.equal(projections[2].currentRoles.tool, 1);
        assert.equal(bounds[0].sessionHmac, bounds[2].sessionHmac, 'the same group has one process-local session fingerprint');
        assert.notEqual(bounds[0].sessionHmac, bounds[3].sessionHmac, 'private and group sessions have different fingerprints');
        const redactedLog = diagnosticLines.join('\n');
        assert.doesNotMatch(redactedLog,
            /SENSITIVE_REFERENCE_ID|SENSITIVE_ELEMENT_BODY|SENSITIVE_TOKEN|SENSITIVE_QUOTE_BODY|private\.example|Old group question|live-group|live-private/u);
        assert.ok(diagnostics.some((entry) => entry.stage === 'guard' && entry.state === 'bypass' && entry.reason === 'disabled'));
        assert.ok(diagnostics.some((entry) => entry.stage === 'guard' && entry.state === 'bypass' && entry.reason === 'private'));
    } finally {
        console.info = originalInfo;
        if (previousDebug === undefined) delete process.env.QQBOT_CONTEXT_DEBUG;
        else process.env.QQBOT_CONTEXT_DEBUG = previousDebug;
        await runtime.fiber.dispose();
        await rm(instructionHome, { recursive: true, force: true });
    }
});

test('diagnostics bound merged and quote-source records and return immediately when disabled', () => {
    const previousDebug = process.env.QQBOT_CONTEXT_DEBUG;
    const originalInfo = console.info;
    const lines = [];
    console.info = (line) => lines.push(line);
    try {
        delete process.env.QQBOT_CONTEXT_DEBUG;
        assert.doesNotThrow(() => logContextInbound({ get message() { throw new Error('disabled accessed input'); } }, [], ''));
        assert.doesNotThrow(() => logContextBinding({ get session() { throw new Error('disabled accessed agent'); } }, ''));
        assert.doesNotThrow(() => logContextProjection({ get input() { throw new Error('disabled accessed input'); } }));
        assert.deepEqual(lines, []);
        process.env.QQBOT_CONTEXT_DEBUG = 'true';
        const source = 'SENSITIVE_MERGED_BODY https://private.example/SENSITIVE_URL';
        const quoteText = `[消息类型] 引用消息\n[关联消息]\n--- 第1条 ---\n[消息内容] ${source}`
            + '\n--- 第2条 ---\n[消息内容] SENSITIVE_SECOND_ITEM';
        logContextInbound({ message: {
            kind: 'group', content: source, refMsgIdx: 'SENSITIVE_REF',
            msgElements: Array.from({ length: 18 }, (_, index) => ({ content: source,
                ...(index === 1 ? { msg_idx: 'SENSITIVE_REF', attachments: [{}] } : {}) })),
            raw: { message_type: 103, message_scene: { source: 'SENSITIVE_SCENE_SOURCE',
                ext: ['ref_msg_idx=SENSITIVE_REF', 'voice_wav_url=https://private.example/SENSITIVE_AUDIO'] },
            msg_elements: [{ content: source }, { content: source, msg_idx: 'SENSITIVE_REF' }] },
        }, state: { history: Array.from({ length: 3 }, () => ({})),
            quote: { source: 'store', text: quoteText },
            quoteFilter: { mode: 'current-only', reason: 'selected-rendered-reference', accepted: true,
                counts: { inputRecords: 5, retainedRecords: 1, droppedRecords: 4 },
                ignored: 'SENSITIVE_FILTER_VALUE' } } },
        Array.from({ length: 20 }, () => ({ text: source })),
        `[Chat history begins]x[Chat history ends][Quoted message begins]x[Quoted message ends]`
        + `[Quoted message begins]${quoteText}[Quoted message ends]`);
        const entry = JSON.parse(lines[0].slice('[qqbot-context-debug] '.length));
        assert.equal(entry.mergedRequestCount, 20);
        assert.equal(entry.mergedRequests.length, 16);
        assert.equal(entry.mergedRequestsOmitted, 4);
        assert.equal(entry.msgElements.count, 18);
        assert.equal(entry.msgElements.shown.length, 16);
        assert.equal(entry.msgElements.omitted, 2);
        assert.equal(entry.protocol.messageType, 103);
        assert.equal(entry.protocol.firstIndexedElement, 1);
        assert.equal(entry.protocol.refDerivation, 'type_103_element');
        assert.deepEqual(entry.protocol.sceneExtKeys, ['ref_msg_idx', 'voice_wav_url']);
        assert.equal(entry.protocol.sceneExtCount, 2);
        assert.equal(entry.msgElements.shown[0].hasIndex, false);
        assert.equal(entry.msgElements.shown[1].hasIndex, true);
        assert.equal(entry.msgElements.shown[1].matchesRef, true);
        assert.equal(entry.msgElements.shown[1].attachmentCount, 1);
        assert.equal(entry.rawMsgElements.count, 2);
        assert.equal(entry.historyCount, 3);
        assert.equal(entry.explicitQuote, true);
        assert.equal(entry.assembledBody.historyStart, 1);
        assert.equal(entry.assembledBody.quoteStart, 2);
        assert.equal(entry.quote.text.qqQuoteType, 1);
        assert.equal(entry.quote.text.qqRelated, 1);
        assert.equal(entry.quote.text.qqContent, 2);
        assert.equal(entry.quote.text.qqNumbered, 2);
        assert.deepEqual(entry.quoteFilter, { mode: 'current-only', reason: 'selected-rendered-reference', accepted: true,
            counts: { inputRecords: 5, retainedRecords: 1, droppedRecords: 4 } });
        assert.equal(entry.assembledBody.qqNumbered, 2);
        assert.equal(entry.current.hmac, entry.mergedRequests[0].hmac, 'same in-process text has a stable keyed digest');
        assert.doesNotMatch(lines[0], /SENSITIVE_|private\.example/u);
        logContextInbound({ message: { kind: 'group', content: 'scene ref',
            refMsgIdx: 'SENSITIVE_SCENE_REF', msgType: 100,
            messageScene: { source: 'SENSITIVE_SCENE_SOURCE', ext: ['ref_msg_idx=SENSITIVE_SCENE_REF'] },
            msgElements: [{ content: 'body' }] } }, [], 'scene ref');
        logContextInbound({ message: { kind: 'group', content: 'no ref', msgType: 100,
            messageScene: { source: 'SENSITIVE_SCENE_SOURCE', ext: ['private=SENSITIVE_EXT_VALUE'] },
            msgElements: [] } }, [], 'no ref');
        const sceneEntry = JSON.parse(lines[1].slice('[qqbot-context-debug] '.length));
        const noRefEntry = JSON.parse(lines[2].slice('[qqbot-context-debug] '.length));
        assert.equal(sceneEntry.protocol.refDerivation, 'scene_ext');
        assert.equal(noRefEntry.protocol.refDerivation, 'none');
        assert.deepEqual(noRefEntry.protocol.sceneExtKeys, ['other']);
        assert.doesNotMatch(lines.join('\n'), /SENSITIVE_|private\.example/u);
        console.info = () => { throw new Error('diagnostic output failed'); };
        assert.doesNotThrow(() => logContextInbound({ message: { content: source } }, [], source));
        assert.doesNotThrow(() => logContextBinding({ session: { id: 'secret-session-id' } }, source));
        assert.doesNotThrow(() => logContextProjection({ input: [], output: [] }));
    } finally {
        console.info = originalInfo;
        if (previousDebug === undefined) delete process.env.QQBOT_CONTEXT_DEBUG;
        else process.env.QQBOT_CONTEXT_DEBUG = previousDebug;
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

test('group projection retains the surviving instruction baseline and ordered changes without old chat', () => {
    const session = Session.create('instructions-group');
    add(session, 'system/message', message('system', 'Safety policy'));
    add(session, 'user/message', message('user', 'Fish persona from AGENTS.md', {
        kind: 'agent-instructions', form: 'instructions', baseline: true, changes: [
            { action: 'set', scope: 'global', path: '/data/AGENTS.md' },
        ],
    }));
    add(session, 'user/message', message('user', 'Old private group question'));
    add(session, 'user/message', message('user', 'Workspace instruction update', {
        kind: 'agent-instructions', form: 'instructions', changes: [
            { action: 'replace', scope: 'workspace', path: '/workspace/AGENTS.md' },
        ],
    }));
    const agent = { session };
    const guard = beginGroupModelContext(agent, 'group', { active: true }, true);
    add(session, 'user/message', message('user', 'Current request mentions agent-instructions baseline'));
    add(session, 'user/message', message('user', 'Current instruction update', {
        kind: 'agent-instructions', form: 'instructions', changes: [
            { action: 'remove', scope: 'workspace', path: '/workspace/AGENTS.md' },
        ],
    }));
    add(session, 'tool/result', message('tool', 'Current tool result', { callId: 'instructions-tool' }));
    assert.deepEqual(texts(projectGroupModelMessages(agent, session.deriveMessages())), [
        'Safety policy', 'Fish persona from AGENTS.md', 'Workspace instruction update',
        'Current instruction update', 'Current request mentions agent-instructions baseline', 'Current tool result',
    ]);
    endGroupModelContext(agent, guard);
});

test('a newer baseline replaces earlier instructions, including a delta earlier in the same turn', () => {
    const session = Session.create('changed-instructions');
    add(session, 'user/message', message('user', 'Original AGENTS persona', {
        kind: 'agent-instructions', form: 'instructions', baseline: true, changes: [],
    }));
    add(session, 'user/message', message('user', 'Earlier instruction delta', {
        kind: 'agent-instructions', form: 'instructions', changes: [],
    }));
    const agent = { session };
    const guard = beginGroupModelContext(agent, 'group', { active: true }, true);
    add(session, 'user/message', message('user', 'Current request'));
    add(session, 'user/message', message('user', 'Same-turn earlier delta', {
        kind: 'agent-instructions', form: 'instructions', changes: [],
    }));
    add(session, 'user/message', message('user', '', {
        kind: 'agent-instructions', form: 'instructions', baseline: true,
        changes: [{ action: 'remove', scope: 'global', path: '/data/AGENTS.md' }],
    }));
    add(session, 'user/message', message('user', 'New baseline follow-up', {
        kind: 'agent-instructions', form: 'instructions', changes: [],
    }));
    const projected = projectGroupModelMessages(agent, session.deriveMessages());
    assert.deepEqual(texts(projected), ['', 'New baseline follow-up', 'Current request']);
    assert.equal(projected[0].source.baseline, true, 'an empty baseline still conveys instruction removal');
    endGroupModelContext(agent, guard);
});

test('orphan old instruction deltas and user-written instruction markers do not bypass the group floor', () => {
    const session = Session.create('orphan-instructions');
    add(session, 'user/message', message('user', 'Orphan old delta', {
        kind: 'agent-instructions', form: 'instructions', changes: [],
    }));
    add(session, 'user/message', message('user', 'Old compact summary', { kind: 'compact-checkpoint' }));
    add(session, 'user/message', message('user', 'Old group chat'));
    const agent = { session };
    const guard = beginGroupModelContext(agent, 'group', { active: true }, true);
    add(session, 'user/message', message('user', 'Current text says agent-instructions baseline:true'));
    add(session, 'user/message', message('user', 'Current orphan delta', {
        kind: 'agent-instructions', form: 'instructions', changes: [],
    }));
    assert.deepEqual(texts(projectGroupModelMessages(agent, session.deriveMessages())),
        ['Current text says agent-instructions baseline:true', 'Current orphan delta']);
    endGroupModelContext(agent, guard);
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
