// Deterministic question-tool and channel lifecycle tests; no QQ or model calls.
import assert from 'node:assert/strict';
import { mkdir, symlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { test } from 'node:test';

const dshRoot = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/';
const profilePeers = '/data/profiles/qqbot/node_modules/@deepseek-ai';
await mkdir(dirname(profilePeers), { recursive: true });
try { await symlink(dshRoot, profilePeers, 'dir'); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
const { Context } = await import(`${dshRoot}cordis/lib/index.js`);
const { default: SystemPrompt } = await import(`${dshRoot}dsh-system-prompt/lib/index.js`);
const { default: ToolRuntime } = await import(`${dshRoot}dsh-tools/lib/index.js`);
const defaultsRoot = process.env.QQBOT_NATIVE_DEFAULTS_ROOT ?? '/opt/qqbot-defaults';
const questionModule = process.env.QQBOT_QUESTIONS_MODULE ?? `${defaultsRoot}/qqbot-questions.mjs`;
const { QQ_QUESTION_TOOL, questionToolSchema, validateQuestionToolCall, QuestionChannel, registerQuestionTool } = await import(questionModule);
const { beginGenerationTurn, endGenerationTurn, getGenerationTurn, generationRequestMetadata } = await import(`${defaultsRoot}/qqbot-generation-scope.mjs`);
const { beginDocumentTurn, getDocumentTurn, endDocumentTurn, runInDocumentExecution } = await import(`${defaultsRoot}/qqbot-document-scope.mjs`);
const { beginMergeBatch, closeMergeBatch } = await import(`${defaultsRoot}/qqbot-concurrency.mjs`);
const logger = { info() {}, warn() {}, debug() {}, error() {} };

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
    return { promise, resolve, reject };
}

function fakeTimers() {
    const timers = [];
    let now = 1_000;
    return {
        timers,
        now: () => now,
        setTimeout(callback, delay) {
            const timer = { callback, delay, active: true };
            timers.push(timer);
            return timer;
        },
        clearTimeout(timer) { timer.active = false; },
        fire(timer) { assert.ok(timer?.active); timer.active = false; timer.callback(); },
        advance(milliseconds) { now += milliseconds; },
    };
}

class FixedHarnessUserQuestionService {
    constructor(agent) {
        this.agent = agent;
        this.provider = undefined;
        this.calls = [];
    }

    async ask(request) {
        const scope = getGenerationTurn(request?.agent);
        if (!request || request.agent !== this.agent || !scope?.active || scope.agent !== request.agent
            || !Array.isArray(request.questions) || !request.signal) {
            throw new Error('The fixed harness rejects a non-root or stale question request.');
        }
        this.calls.push(request);
        assert.equal(typeof this.provider, 'function', 'question provider is installed before requests start');
        return this.provider({ ...request, agent: request.agent }, async () => {
            throw new Error('Unexpected question provider fallthrough.');
        });
    }
}

async function questionHarness(t, { sender, timeoutMs = 300_000, requireMention = true, originalRequests } = {}) {
    const ctx = new Context();
    t.after(() => ctx.fiber.dispose());
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime, { mode: 'native' });
    ctx.on('tools/execute', (exec, next) => runInDocumentExecution(exec, next));

    const agent = { session: { seq: 0 } };
    const service = new FixedHarnessUserQuestionService(agent);
    const providers = [];
    const originalGet = ctx.get.bind(ctx);
    ctx.get = (name) => name === 'userQuestions' ? service : originalGet(name);
    const originalOn = ctx.on.bind(ctx);
    ctx.on = (name, callback, options) => {
        if (name === 'user-questions/request') {
            providers.unshift(callback);
            service.provider = callback;
            return ctx;
        }
        return originalOn(name, callback, options);
    };

    const target = { scope: 'group', targetId: 'group-a', msgId: 'original-message' };
    const record = {
        sessionKey: 'group:group-a', scope: 'group', peerId: target.targetId, agent,
        sessionId: 'session-a', replyTarget: target,
        enqueueSend: (operation) => operation(),
    };
    const manager = {
        questionChannel: undefined,
        getSessionRecord(scope, peerId) { return scope === record.scope && peerId === record.peerId ? record : undefined; },
        findBySessionId(sessionId) { return sessionId === record.sessionId ? record : undefined; },
    };
    const fakeClock = fakeTimers();
    const sendCalls = [];
    const actualSender = sender ?? {
        async sendQuestionMarkdown(request, content, keyboard, signal) {
            sendCalls.push({ request, content, keyboard, signal });
            return { sent: true, messageId: `question-message-${sendCalls.length}` };
        },
    };
    const channel = new QuestionChannel(manager, actualSender,
        { appId: 'fixture-app', requireMention, askTimeoutMs: timeoutMs }, logger, fakeClock);
    manager.questionChannel = channel;
    channel.install(ctx);
    registerQuestionTool(ctx, channel);

    const batch = beginMergeBatch(record, target);
    beginDocumentTurn(agent, { content: 'Need one missing choice.' });
    const documentScope = getDocumentTurn(agent);
    const generationScope = beginGenerationTurn(agent, originalRequests ?? [{
        ownerId: 'owner-a', replyTarget: target, text: 'Please make the requested change.',
    }], [], {
        documentScope, record, enqueueSend: record.enqueueSend,
        isCurrentRecord: () => manager.getSessionRecord('group', target.targetId) === record,
    });
    const requestId = generationRequestMetadata(generationScope)[0]?.requestId;
    assert.ok(requestId);
    t.after(async () => {
        channel.uninstall();
        await closeMergeBatch(batch);
        await endGenerationTurn(agent, generationScope);
        await endDocumentTurn(agent, documentScope);
    });
    return { ctx, agent, service, providers, target, record, manager, channel, fakeClock,
        sendCalls, generationScope, documentScope, requestId };
}

function questions(...items) {
    return items.map(({ id, multiSelect = false, options = ['A', 'B', 'C'] }) => ({
        id, question: `Choose ${id}`, options: options.map((label) => ({ label })), multi_select: multiSelect,
    }));
}

function callQuestion(harness, questionList, callId = 'question-call', agent = harness.agent, signal = new AbortController().signal) {
    const args = { requestId: harness.requestId, questions: questionList };
    const exec = { name: QQ_QUESTION_TOOL, arguments: args, agent, callId, signal };
    return runInDocumentExecution(exec, () => harness.ctx.tools.execute({
        name: QQ_QUESTION_TOOL, arguments: args, agent, callId, signal,
    }));
}

function outputValue(output) {
    assert.equal(output.isError, false, JSON.stringify(output));
    if (Object.hasOwn(output, 'value')) return output.value;
    const text = output.content?.find((part) => part.type === 'text')?.text;
    assert.equal(typeof text, 'string', 'native tools runtime must return rendered tool output');
    return JSON.parse(text);
}

async function requireSendBeforeToolResult(pending, sendStarted, label) {
    const outcome = await Promise.race([
        sendStarted.then(() => ({ sent: true })),
        pending.then((output) => ({ sent: false, output })),
    ]);
    assert.equal(outcome.sent, true, `${label}: tool completed before the question send: ${JSON.stringify(outcome.output)}`);
}

test('question tool exposes a strict request-bound schema with small limits', () => {
    assert.equal(QQ_QUESTION_TOOL, 'ask_user_question');
    const schema = questionToolSchema();
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.ok(schema.required.includes('requestId'));
    assert.ok(schema.required.includes('questions'));
    assert.equal(schema.properties.requestId.type, 'string');

    const questionsSchema = schema.properties.questions;
    assert.equal(questionsSchema.type, 'array');
    assert.equal(questionsSchema.minItems, 1);
    assert.equal(questionsSchema.maxItems, 3);
    assert.equal(questionsSchema.items.additionalProperties, false);
    assert.ok(questionsSchema.items.required.includes('id'));
    assert.ok(questionsSchema.items.required.includes('question'));

    const questionProperties = questionsSchema.items.properties;
    assert.equal(questionProperties.options.type, 'array');
    assert.equal(questionProperties.options.maxItems, 6);
    assert.equal(questionProperties.options.items.additionalProperties, false);
    assert.ok(questionProperties.options.items.required.includes('label'));
    assert.equal(questionProperties.multi_select.type, 'boolean');

    const propertyNames = new Set();
    const visit = (value) => {
        if (!value || typeof value !== 'object') return;
        if (value.properties && typeof value.properties === 'object') {
            for (const key of Object.keys(value.properties)) propertyNames.add(key);
        }
        for (const child of Object.values(value)) visit(child);
    };
    visit(schema);
    assert.equal(propertyNames.has('role'), false);
    assert.equal(propertyNames.has('target'), false);
});

test('the provider tool-call id stays opaque and still delivers the question', async (t) => {
    const delivered = deferred();
    const harness = await questionHarness(t, { sender: {
        async sendQuestionMarkdown(request, content) {
            delivered.resolve({ request, content });
            return { sent: true, messageId: 'opaque-id-message' };
        },
    } });
    // dsh brands the model's call id as an opaque provider string. The pinned
    // pi-ai openai-responses adapter encodes a Responses function call as
    // "<call_id>|<item_id>", so the gate must not impose a bespoke alphabet on
    // it: a bounded, control-character-free id is the whole contract.
    const providerCallId = 'call_00_abc|fc_00_abc';
    const pending = callQuestion(harness, questions({ id: 'q' }), providerCallId);
    const outcome = await Promise.race([
        delivered.promise.then((sent) => ({ sent })),
        pending.then((output) => ({ output })),
    ]);
    assert.ok(outcome.sent, `a composite provider id reached QQ delivery: ${JSON.stringify(outcome.output)}`);
    assert.match(outcome.sent.content, /Choose q/u);
    assert.ok(harness.channel.pending.has(harness.record.sessionKey),
        'the delivered question waits for its answer');
    assert.equal(harness.channel.tryAnswer('group', 'group-a', 'owner-a', '1', 'opaque-id-answer', true), true);
    assert.deepEqual(outputValue(await pending), { status: 'answered', answers: [{ id: 'q', selected: ['A'] }] });

    const args = { requestId: harness.requestId, questions: questions({ id: 'q' }) };
    const exec = (callId) => ({ name: QQ_QUESTION_TOOL, arguments: args, callId, agent: harness.agent, signal: new AbortController().signal });
    assert.equal(validateQuestionToolCall(exec(providerCallId)), undefined, 'the composite provider id is authorized');
    for (const invalidCallId of ['', 'control\u0001id', `x${'y'.repeat(256)}`]) {
        assert.equal(validateQuestionToolCall(exec(invalidCallId)), 'A valid question tool-call id is required.',
            `${JSON.stringify(invalidCallId.slice(0, 24))} is not a usable call id`);
    }
});

test('native tools runtime exposes the question tool and fixed service rejects delegated roots', async (t) => {
    const harness = await questionHarness(t);
    const catalog = await harness.ctx.systemPrompt.assemble();
    assert.deepEqual(catalog.tools.map((tool) => tool.name), [QQ_QUESTION_TOOL]);
    assert.equal(harness.service.provider, harness.providers[0]);
    await assert.rejects(() => harness.service.ask({
        questions: questions({ id: 'q' }), agent: {}, signal: new AbortController().signal,
    }), /non-root or stale/u);
    assert.equal(harness.service.calls.length, 0);

    const delegatedOutput = outputValue(await callQuestion(harness, questions({ id: 'q' }), 'delegated-call', {}));
    assert.deepEqual(delegatedOutput, { status: 'failed', answers: [] });
    assert.equal(harness.service.calls.length, 0, 'a delegated tool call is refused before service.ask');
});

test('fast first answer waits for its send ACK and the next question waits for its ACK too', async (t) => {
    const firstAck = deferred();
    const secondAck = deferred();
    const firstStarted = deferred();
    const secondStarted = deferred();
    let sendCount = 0;
    const sent = [];
    const harness = await questionHarness(t, { sender: {
        sendQuestionMarkdown(request, content, keyboard, signal) {
            const index = sendCount++;
            sent.push({ request, content, keyboard, signal });
            (index === 0 ? firstStarted : secondStarted).resolve();
            return index === 0 ? firstAck.promise : secondAck.promise;
        },
    } });
    const pending = callQuestion(harness, questions({ id: 'first' }, { id: 'second' }));
    await requireSendBeforeToolResult(pending, firstStarted.promise, 'initial question');
    assert.equal(harness.channel.pending.get(harness.record.sessionKey)?.phase, 'sending-initial');
    assert.equal(harness.channel.tryAnswer('group', 'group-a', 'foreign-member', '2', 'foreign-1', true), false);
    assert.equal(harness.channel.tryAnswer('group', 'group-a', 'owner-a', '1,2', 'invalid-multi', true), true);
    assert.equal(harness.channel.pending.get(harness.record.sessionKey)?.pendingAnswer, undefined,
        'numeric multi-selection is rejected for a single-choice question');
    assert.equal(harness.channel.tryAnswer('group', 'group-a', 'owner-a', '9', 'unknown-number', true), true);
    assert.equal(harness.channel.pending.get(harness.record.sessionKey)?.pendingAnswer, undefined,
        'an out-of-range numeric option cannot become a partial answer');
    assert.equal(harness.channel.tryAnswer('group', 'group-a', 'owner-a', '1', 'fast-answer-1', true), true);
    assert.equal(harness.channel.pending.get(harness.record.sessionKey)?.pendingAnswer?.answer.selected[0], 'A');
    assert.equal(harness.channel.tryAnswer('group', 'group-a', 'owner-a', '2', 'fast-answer-1', true), true);
    assert.equal(harness.channel.pending.get(harness.record.sessionKey)?.pendingAnswer?.answer.selected[0], 'A',
        'a duplicate raw message id cannot replace the original answer');
    assert.equal(sent.length, 1, 'the first answer cannot start question two before question one ACK');

    firstAck.resolve({ sent: true, messageId: 'question-1' });
    await requireSendBeforeToolResult(pending, secondStarted.promise, 'second question');
    assert.equal(harness.channel.pending.get(harness.record.sessionKey)?.phase, 'sending-next');
    assert.equal(sent.length, 2);
    assert.equal(harness.channel.tryAnswer('group', 'group-a', 'owner-a', '3', 'fast-answer-2', true), true);
    assert.equal(harness.channel.pending.get(harness.record.sessionKey)?.pendingAnswer, undefined,
        'answers are ignored while the next question is awaiting its delivery ACK');
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, 'question two cannot complete before its delivery ACK');
    secondAck.resolve({ sent: true, messageId: 'question-2' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.channel.tryAnswer('group', 'group-a', 'owner-a', '3', 'fast-answer-2', true), true);
    assert.equal(harness.channel.pending.get(harness.record.sessionKey)?.pendingAnswer, undefined,
        'an input consumed before ACK stays deduplicated after ACK');
    assert.equal(harness.channel.tryAnswer('group', 'group-a', 'owner-a', '3', 'fast-answer-2-after-ack', true), true);
    assert.deepEqual(outputValue(await pending), { status: 'answered', answers: [
        { id: 'first', selected: ['A'] }, { id: 'second', selected: ['C'] },
    ] });
    assert.equal(harness.channel.pending.size, 0);
    assert.equal(harness.fakeClock.timers.filter((timer) => timer.active).length, 0);
});

test('multi-select and free-text answers preserve the service contract', async (t) => {
    const harness = await questionHarness(t);
    const pending = callQuestion(harness, [
        ...questions({ id: 'multi', multiSelect: true }),
        { id: 'free', question: 'What should I call it?' },
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.sendCalls[0].keyboard, undefined, 'multi-select questions use numbered replies');
    assert.equal(harness.channel.tryAnswer('group', 'group-a', 'owner-a', '1, 3', 'multi-answer', true), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.sendCalls.length, 2);
    assert.equal(harness.channel.tryAnswer('group', 'group-a', 'owner-a', 'A custom name', 'free-answer', true), true);
    assert.deepEqual(outputValue(await pending), { status: 'answered', answers: [
        { id: 'multi', selected: ['A', 'C'] },
        { id: 'free', selected: [], custom: 'A custom name' },
    ] });
});

test('old button nonce is rejected after advancing to the next question', async (t) => {
    const harness = await questionHarness(t);
    const pending = callQuestion(harness, questions({ id: 'first' }, { id: 'second' }));
    await requireSendBeforeToolResult(pending, new Promise((resolve) => setImmediate(resolve)), 'initial question');
    const firstButton = JSON.parse(harness.sendCalls[0].keyboard.content.rows[0].buttons[0].action.data);
    assert.equal(harness.channel.handleInteraction({
        id: 'button-first', scene: 'group', chat_type: 1, group_openid: 'group-a', group_member_openid: 'owner-a',
        data: { resolved: { button_data: JSON.stringify(firstButton) } },
    }), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.sendCalls.length, 2);
    assert.equal(harness.channel.handleInteraction({
        id: 'button-stale', scene: 'group', chat_type: 1, group_openid: 'group-a', group_member_openid: 'owner-a',
        data: { resolved: { button_data: JSON.stringify(firstButton) } },
    }), false, 'a prior question token cannot answer the current question');
    const secondButton = JSON.parse(harness.sendCalls[1].keyboard.content.rows[0].buttons[1].action.data);
    assert.equal(harness.channel.handleInteraction({
        id: 'button-second', scene: 'group', chat_type: 1, group_openid: 'group-a', group_member_openid: 'owner-a',
        data: { resolved: { button_data: JSON.stringify(secondButton) } },
    }), true);
    assert.deepEqual(outputValue(await pending), { status: 'answered', answers: [
        { id: 'first', selected: ['A'] }, { id: 'second', selected: ['B'] },
    ] });
});

test('only a confirmed unsupported keyboard retries once as plain text', async (t) => {
    const attempts = [];
    const harness = await questionHarness(t, { sender: {
        async sendQuestionMarkdown(request, content, keyboard, signal) {
            attempts.push({ request, content, keyboard, signal });
            return attempts.length === 1
                ? { sent: false, reason: 'keyboard-unsupported' }
                : { sent: true, messageId: 'plain-question-ack' };
        },
    } });
    const pending = callQuestion(harness, questions({ id: 'fallback' }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts.length, 2);
    assert.ok(attempts[0].keyboard, 'the first delivery offers a keyboard');
    assert.equal(attempts[1].keyboard, undefined, 'the retry removes only the unsupported keyboard');
    assert.match(attempts[1].content, /1\. A[\s\S]*2\. B/u, 'the fallback includes numbered choices');
    assert.equal(harness.fakeClock.timers.filter((timer) => timer.active).length, 1,
        'the answer timeout starts only after the fallback is acknowledged');
    assert.equal(harness.channel.tryAnswer('group', 'group-a', 'owner-a', '2', 'fallback-answer', true), true);
    assert.deepEqual(outputValue(await pending), { status: 'answered', answers: [{ id: 'fallback', selected: ['B'] }] });

    const unknownAttempts = [];
    harness.channel.sender = { async sendQuestionMarkdown(...args) {
        unknownAttempts.push(args);
        return { sent: false, reason: 'unknown' };
    } };
    const unknown = callQuestion(harness, questions({ id: 'unknown-delivery' }), 'unknown-delivery-call');
    assert.deepEqual(outputValue(await unknown), { status: 'unknown', answers: [] });
    assert.equal(unknownAttempts.length, 1, 'an ambiguous delivery outcome is never resent');
});

test('group text requires the original owner and @bot; commands and other members continue', async (t) => {
    const harness = await questionHarness(t);
    const pending = callQuestion(harness, questions({ id: 'pick' }));
    await requireSendBeforeToolResult(pending, new Promise((resolve) => setImmediate(resolve)), 'initial question');

    const handled = [];
    const middleware = (await import(`${process.env.QQBOT_NATIVE_DEFAULTS_ROOT ?? '/opt/qqbot-defaults'}/qqbot-questions.mjs`))
        .questionAnswerMiddleware(harness.manager);
    const context = (senderId, content, mentioned, rawId) => ({
        message: { kind: 'group', senderId, content, messageId: rawId, replyTarget: harness.target,
            raw: { id: rawId, group_openid: 'group-a', author: { member_openid: senderId } } },
        replyTarget: harness.target,
        state: { mention: { wasMentioned: mentioned } },
        stop(reason) { handled.push(['stop', reason]); },
    });
    await middleware(context('owner-a', '/new', true, 'cmd-new'), async () => { handled.push(['next', 'new']); });
    await middleware(context('owner-a', '/stop', true, 'cmd-stop'), async () => { handled.push(['next', 'stop']); });
    await middleware(context('foreign', '2', true, 'foreign-text'), async () => { handled.push(['next', 'foreign']); });
    await middleware(context('owner-a', '2', false, 'unmentioned-text'), async () => { handled.push(['next', 'unmentioned']); });
    assert.deepEqual(handled, [
        ['next', 'new'], ['next', 'stop'], ['next', 'foreign'], ['next', 'unmentioned'],
    ]);
    await middleware(context('owner-a', '2', true, 'owner-answer'), async () => { handled.push(['next', 'answer']); });
    assert.deepEqual(handled.at(-1), ['stop', 'question-answer']);
    assert.deepEqual(outputValue(await pending), { status: 'answered', answers: [{ id: 'pick', selected: ['B'] }] });
});

test('timeout begins after ACK; cancellation, session replacement, and uninstall clean pending state', async (t) => {
    const sendAck = deferred();
    const sendStarted = deferred();
    const harness = await questionHarness(t, { timeoutMs: 250, sender: {
        async sendQuestionMarkdown() { sendStarted.resolve(); return sendAck.promise; },
    } });
    const pending = callQuestion(harness, questions({ id: 'pick' }));
    await requireSendBeforeToolResult(pending, sendStarted.promise, 'initial question');
    assert.equal(harness.fakeClock.timers.length, 0, 'the timer must not start before QQ confirms delivery');
    sendAck.resolve({ sent: true, messageId: 'question-ack' });
    await new Promise((resolve) => setImmediate(resolve));
    const timeout = harness.fakeClock.timers.find((timer) => timer.active);
    assert.equal(timeout.delay, 250);
    harness.fakeClock.fire(timeout);
    assert.deepEqual(outputValue(await pending), { status: 'timed-out', answers: [] });
    assert.equal(harness.channel.pending.size, 0);

    const generationCancel = callQuestion(harness, questions({ id: 'generation-cancel' }), 'generation-cancel-call');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.channel.cancelGeneration(harness.generationScope, harness.requestId, 'cancelled'), true);
    assert.deepEqual(outputValue(await generationCancel), { status: 'cancelled', answers: [] });

    const replacementAck = deferred();
    harness.channel.sender = { async sendQuestionMarkdown() { return replacementAck.promise; } };
    const replacementPending = callQuestion(harness, questions({ id: 'replace' }), 'replacement-call');
    await new Promise((resolve) => setImmediate(resolve));
    const getSessionRecord = harness.manager.getSessionRecord;
    harness.manager.findBySessionId = () => undefined;
    harness.manager.getSessionRecord = () => undefined;
    assert.equal(harness.channel.tryAnswer('group', 'group-a', 'owner-a', '1', 'stale-session-answer', true), false);
    harness.manager.getSessionRecord = getSessionRecord;
    harness.manager.findBySessionId = (sessionId) => sessionId === harness.record.sessionId ? harness.record : undefined;
    harness.channel.cancelPending(harness.record.sessionKey);
    assert.deepEqual(outputValue(await replacementPending), { status: 'cancelled', answers: [] });
    replacementAck.resolve({ sent: true, messageId: 'late-ack' });
    await Promise.resolve();
    assert.equal(harness.channel.pending.size, 0, 'late delivery completion cannot restore cancelled state');

    const uninstallAck = deferred();
    harness.channel.sender = { async sendQuestionMarkdown() { return uninstallAck.promise; } };
    const uninstallPending = callQuestion(harness, questions({ id: 'uninstall' }), 'uninstall-call');
    await new Promise((resolve) => setImmediate(resolve));
    harness.channel.uninstall();
    assert.deepEqual(outputValue(await uninstallPending), { status: 'cancelled', answers: [] });
    uninstallAck.resolve({ sent: true, messageId: 'late-uninstall-ack' });
    assert.equal(harness.channel.pending.size, 0);
});


test('three sequential questions and six options stay within the five-minute ACK-based limit', async (t) => {
    const harness = await questionHarness(t, { timeoutMs: 600_000 });
    const items = questions(...['one', 'two', 'three'].map((id) => ({ id, options: ['A', 'B', 'C', 'D', 'E', 'F'] })));
    const pending = callQuestion(harness, items);
    for (let index = 0; index < 3; index++) {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(harness.sendCalls.length, index + 1, 'only the current question is delivered');
        const buttons = harness.sendCalls[index].keyboard.content.rows.flatMap((row) => row.buttons);
        assert.equal(buttons.length, 6);
        assert.equal(harness.fakeClock.timers.find((timer) => timer.active).delay, 300_000);
        assert.equal(harness.channel.tryAnswer('group', 'group-a', 'owner-a', '6', `limit-answer-${index}`, true), true);
    }
    assert.deepEqual(outputValue(await pending), { status: 'answered', answers: [
        { id: 'one', selected: ['F'] }, { id: 'two', selected: ['F'] }, { id: 'three', selected: ['F'] },
    ] });
    for (const invalid of [
        [...items, { id: 'four', question: 'Not allowed' }],
        questions({ id: 'seven-options', options: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] }),
        [{ id: 'oversized', question: '中'.repeat(2000), options: [{ label: 'A' }] }],
    ]) {
        const result = await callQuestion(harness, invalid, `invalid-${invalid[0].id}`);
        assert.ok(result.isError || outputValue(result).status === 'failed');
    }
    assert.equal(harness.sendCalls.length, 3, 'invalid limits fail before any extra QQ delivery');
});

test('merged requests retain their original owners even when the other member owns the surviving context', async (t) => {
    const harness = await questionHarness(t, { originalRequests: [
        { ownerId: 'owner-a', replyTarget: { scope: 'group', targetId: 'group-a', msgId: 'owner-a-request' }, text: 'Request A' },
        { ownerId: 'owner-b', replyTarget: { scope: 'group', targetId: 'group-a', msgId: 'owner-b-request' }, text: 'Request B' },
    ] });
    const metadata = generationRequestMetadata(harness.generationScope);
    assert.equal(metadata.length, 2);
    harness.requestId = metadata[1].requestId;
    const pending = callQuestion(harness, questions({ id: 'owner-b-choice' }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.sendCalls[0].request.replyTarget.msgId, 'owner-b-request');
    assert.equal(harness.sendCalls[0].request.ownerId, 'owner-b');
    assert.equal(harness.channel.tryAnswer('group', 'group-a', 'owner-a', '1', 'wrong-merged-owner', true), false);
    assert.equal(harness.channel.tryAnswer('group', 'group-a', 'owner-b', '2', 'right-merged-owner', true), true);
    assert.deepEqual(outputValue(await pending), { status: 'answered', answers: [{ id: 'owner-b-choice', selected: ['B'] }] });
});
