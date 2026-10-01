// Deterministic, offline regression tests for the bounded QQ dice tool.
// Run on the host with `node --test scripts/test-dice.mjs`, or in the image
// with QQBOT_DICE_MODULE=/opt/qqbot-defaults/qqbot-dice.mjs.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const diceModuleUrl = process.env.QQBOT_DICE_MODULE
    ? pathToFileURL(resolve(process.env.QQBOT_DICE_MODULE)).href
    : new URL('../defaults/qqbot-dice.mjs', import.meta.url).href;
const diceModule = await import(diceModuleUrl);
const scopeModule = await import(new URL('./qqbot-document-scope.mjs', diceModuleUrl));
const {
    parseDiceExpression,
    rollDice,
    executeDiceTool,
    validateDiceToolCall,
    normalizeDiceCommandContent,
    isDiceCommandCandidate,
    createDiceCommandMiddleware,
    createDiceAwareHistoryBuffer,
} = diceModule;
const {
    beginDocumentTurn,
    endDocumentTurn,
    getDocumentTurn,
    runInDocumentExecution,
} = scopeModule;

function sequenceRandom(values) {
    let index = 0;
    const calls = [];
    const randomInt = (minimum, maximum) => {
        calls.push([minimum, maximum]);
        assert.ok(index < values.length, 'deterministic random sequence exhausted');
        const value = values[index++];
        assert.ok(value >= minimum && value < maximum, `fixture ${value} must fit [${minimum}, ${maximum})`);
        return value;
    };
    return { randomInt, calls, consumed: () => index };
}

function withTurn(operation) {
    const agent = {};
    beginDocumentTurn(agent, { content: 'Roll tabletop dice.' });
    try {
        return operation(agent);
    }
    finally {
        endDocumentTurn(agent);
    }
}

function execute(agent, callId, args, signal = new AbortController().signal) {
    const exec = { agent, callId, arguments: args, signal };
    return runInDocumentExecution(exec, () => executeDiceTool(args, exec));
}

function diceCommandContext({ kind = 'group', senderId, groupOpenid, content = '.r d1', appId = '123' }) {
    const sends = [];
    const context = {
        message: { kind, senderId, groupOpenid, content, replyTarget: { id: 'fixture-target' } },
        bot: {
            appId,
            async sendMarkdown(_target, text) { sends.push(text); },
        },
        replyTarget: { id: 'fixture-target' },
        stop(reason) { context.stopReason = reason; },
    };
    return { context, sends };
}

test('group history reads are empty while private history reads and current appends remain available', async () => {
    const listCalls = [];
    const appendCalls = [];
    const sourceStore = {
        async list(...args) {
            listCalls.push(args);
            return [{ senderId: 'private-old', content: 'private history' }];
        },
        async append(...args) {
            appendCalls.push(args);
        },
    };
    const fakeHistoryBuffer = ({ store }) => async (ctx, next) => {
        const key = ctx.message.kind === 'group'
            ? `test-app:${ctx.message.groupOpenid}`
            : `private:${ctx.message.senderId}`;
        ctx.state.history = await store.list(key, 10);
        await store.append(key, { content: ctx.message.content }, 10);
        return next();
    };
    const wrapped = createDiceAwareHistoryBuffer(fakeHistoryBuffer, { store: sourceStore });
    const group = {
        bot: { appId: 'test-app' },
        message: { kind: 'group', groupOpenid: 'group-a', senderId: 'member-a', content: 'current group text' },
        state: {},
    };
    const privateChat = {
        bot: { appId: 'test-app' },
        message: { kind: 'c2c', senderId: 'peer-a', content: 'current private text' },
        state: {},
    };
    await wrapped(group, async () => {});
    await wrapped(privateChat, async () => {});

    assert.deepEqual(group.state.history, [], 'group input excludes persisted history');
    assert.deepEqual(privateChat.state.history, [{ senderId: 'private-old', content: 'private history' }],
        'private input keeps persisted history');
    assert.deepEqual(listCalls, [['private:peer-a', 10]], 'only private history reaches the source store');
    assert.deepEqual(appendCalls, [
        ['test-app:group-a', { content: 'current group text' }, 10],
        ['private:peer-a', { content: 'current private text' }, 10],
    ], 'current messages continue to be recorded for both scopes');
});

test('parses d20, mixed dice and modifiers, and canonicalizes ASCII spacing and case', () => {
    assert.deepEqual(parseDiceExpression('d20'), {
        terms: [{ sign: 1, kind: 'dice', count: 1, sides: 20, keepMode: undefined, keepCount: undefined }],
        totalDice: 1,
        canonical: 'd20',
    });
    const parsed = parseDiceExpression(' 2D6 + d4 - 3 + 1D8 ');
    assert.equal(parsed.canonical, '2d6+d4-3+d8');
    assert.equal(parsed.totalDice, 4);
    assert.deepEqual(parsed.terms.map(({ sign, kind }) => [sign, kind]), [
        [1, 'dice'], [1, 'dice'], [-1, 'modifier'], [1, 'dice'],
    ]);
});

test('kh and kl keep the requested dice and break equal-value ties by original order', () => {
    const high = sequenceRandom([4, 6, 6, 2]);
    const keptHigh = rollDice('4d6kh2', 1, high.randomInt);
    assert.equal(keptHigh.results[0].total, 12);
    assert.match(keptHigh.text, /4d6kh2\[4×,6,6,2×\]/);

    const low = sequenceRandom([2, 1, 1, 5]);
    const keptLow = rollDice('4d6kl2', 1, low.randomInt);
    assert.equal(keptLow.results[0].total, 2);
    assert.match(keptLow.text, /4d6kl2\[2×,1,1,5×\]/);

    const cutoffTie = sequenceRandom([6, 6, 6, 1]);
    const tiedHigh = rollDice('4d6kh2', 1, cutoffTie.randomInt);
    assert.equal(tiedHigh.results[0].total, 12);
    assert.match(tiedHigh.text, /4d6kh2\[6,6,6×,1×\]/, 'earlier equal dice win at the keep cutoff');
});

test('deterministically rolls batches, returns each total, and formats discarded dice readably', () => {
    const source = sequenceRandom([1, 6, 3, 2, 5, 4]);
    const result = rollDice('2d6kh1+1', 3, source.randomInt);
    assert.deepEqual(result.results.map(({ total }) => total), [7, 4, 6]);
    assert.equal(result.totalDice, 6);
    assert.match(result.text, /^1\) 2d6kh1\+1: 2d6kh1\[1×,6\] \+1 = 7\n2\)/);
    assert.match(result.text, /2d6kh1\[3,2×\] \+1 = 4/);
    assert.equal(source.consumed(), 6);
    assert.ok(source.calls.every(([minimum, maximum]) => minimum === 1 && maximum === 7));
});

test('accepts the upper valid bounds and subtracts dice groups into a negative total', () => {
    assert.equal(parseDiceExpression(`d1${' '.repeat(126)}`).canonical, 'd1', 'raw 128-character expressions may contain trailing ASCII spaces');
    assert.equal(parseDiceExpression('d1+1+1+1+1+1+1+1').terms.length, 8);
    assert.equal(rollDice('d1000000', 1, () => 999999).results[0].total, 999_999);
    assert.equal(rollDice('d1+1000000', 1, () => 1).results[0].total, 1_000_001);
    assert.equal(rollDice('100d1', 1, () => 1).totalDice, 100);
    assert.equal(rollDice('5d1', 20, () => 1).totalDice, 100);
    const negative = rollDice('d1-2d1-5', 1, sequenceRandom([1, 1, 1]).randomInt);
    assert.equal(negative.results[0].total, -6);
    assert.match(negative.text, /-2d1\[1,1\] -5 = -6/);
});

test('enforces grammar and all expression, modifier, face, repeat, and dice-count bounds', () => {
    const invalid = [
        '', '  ', '3+2d6', 'd6*2', 'd6/2', 'd6^2', 'd6; process.exit()',
        'd6 + (2)', 'd6 + -2', 'd6+', 'd6 + 1.5', 'd6\t+1',
        '0d6', '101d6', 'd0', 'd1000001', 'd6kh0', '2d6kh3', '4d6kl5',
        'd6+1000001', 'd6-1000001', 'd6+d6+d6+d6+d6+d6+d6+d6+d6',
        'd6'.padEnd(129, ' '),
    ];
    for (const expression of invalid) {
        assert.throws(() => parseDiceExpression(expression), undefined, JSON.stringify(expression));
    }
    for (const repeat of [0, -1, 1.5, 21, NaN, '2', null]) {
        assert.throws(() => rollDice('d6', repeat, () => 1), undefined, `repeat ${String(repeat)}`);
    }
    assert.throws(() => rollDice('10d6', 11, () => 1));
});

test('validates before requesting randomness and propagates random-source failures without fallback', () => {
    let calls = 0;
    assert.throws(() => rollDice('d6 + (1)', 1, () => { calls++; return 1; }));
    assert.throws(() => rollDice('10d6', 11, () => { calls++; return 1; }));
    assert.equal(calls, 0, 'invalid requests must not invoke the random source');

    assert.throws(() => rollDice('d6', 1, () => { calls++; throw new Error('fixture random source failed'); }), /安全随机数生成失败/);
    assert.equal(calls, 1, 'a failed injected source is not replaced with production randomness');
    assert.throws(() => rollDice('d6', 1, () => 0), /安全随机数生成失败/);
});

test('a production crypto RNG failure is cached as failure without fallback or reroll', () => {
    const originalRandomInt = crypto.randomInt;
    let calls = 0;
    try {
        crypto.randomInt = () => { calls++; throw new Error('fixture crypto failure'); };
        syncBuiltinESMExports();
        withTurn((agent) => {
            let firstError;
            assert.throws(() => execute(agent, 'crypto-failure', { expression: 'd6' }), (error) => {
                firstError = error;
                return true;
            });
            assert.throws(() => execute(agent, 'crypto-failure', { expression: 'd6' }), (error) => {
                assert.equal(error.message, firstError.message);
                return true;
            });
            assert.equal(calls, 1, 'a cached RNG failure is not rerolled');
            assert.equal(getDocumentTurn(agent).diceCount, 1);
        });
    }
    finally {
        crypto.randomInt = originalRandomInt;
        syncBuiltinESMExports();
    }
});

test('rejects JavaScript-like input and unknown arguments before any roll', () => {
    for (const expression of [
        'd6;console.log(1)', 'd6 + globalThis.process', 'd6 + import("node:fs")',
        'd6 + (1+2)', 'd6 + 1e3', '__proto__.d6',
    ]) assert.throws(() => parseDiceExpression(expression));

    withTurn((agent) => {
        const args = { expression: 'd6', extra: 'must be rejected' };
        assert.throws(() => execute(agent, 'unknown-parameter', args));
        assert.equal(typeof validateDiceToolCall({ agent, callId: 'schema-unknown', arguments: args }), 'string');
    });
});

test('same call ID and arguments replay one cached result; changed arguments are rejected', () => {
    withTurn((agent) => {
        const first = execute(agent, 'replay-1', { expression: 'd1' });
        const expected = structuredClone(first);
        first.results[0].total = 99;
        const replay = execute(agent, 'replay-1', { expression: 'd1' });
        assert.notStrictEqual(replay, first, 'retry returns a fresh object');
        assert.deepEqual(replay, expected, 'mutating the first return cannot corrupt the idempotency cache');
        assert.throws(() => execute(agent, 'replay-1', { expression: 'd1+0' }));
        assert.equal(getDocumentTurn(agent).diceCount, 1, 'a retry does not charge the turn budget twice');
    });
});

test('overlapping retries share one result and consume the call budget only once', async () => {
    const agent = {};
    beginDocumentTurn(agent, { content: 'Concurrent retries.' });
    try {
        const args = { expression: '20d1' };
        const first = execute(agent, 'overlap', args);
        const [retryA, retryB] = await Promise.all([
            Promise.resolve().then(() => execute(agent, 'overlap', args)),
            Promise.resolve().then(() => execute(agent, 'overlap', args)),
        ]);
        assert.notStrictEqual(retryA, first);
        assert.notStrictEqual(retryB, first);
        assert.deepEqual(retryA, first);
        assert.deepEqual(retryB, first);
        assert.equal(getDocumentTurn(agent).diceCount, 20);
        assert.equal(getDocumentTurn(agent).diceCalls.size, 1);
    }
    finally {
        endDocumentTurn(agent);
    }
});

test('same call ID and invalid arguments replay the recorded failure', () => {
    withTurn((agent) => {
        let firstError;
        let replayError;
        assert.throws(() => execute(agent, 'failed-replay', { expression: 'd6*2' }), (error) => {
            firstError = error;
            return true;
        });
        assert.throws(() => execute(agent, 'failed-replay', { expression: 'd6*2' }), (error) => {
            replayError = error;
            return true;
        });
        assert.equal(replayError.message, firstError.message);
        assert.throws(() => execute(agent, 'failed-replay', { expression: 'd6' }));
        assert.equal(typeof validateDiceToolCall({ agent, callId: 'bad-repeat', arguments: { expression: 'd6', repeat: 0 } }), 'string');
        assert.throws(() => execute(agent, 'bad-repeat', { expression: 'd6', repeat: 0 }));
    });
});

test('invalid argument shapes fail closed without charging dice or evaluating accessors', () => {
    const originalRandomInt = crypto.randomInt;
    let randomCalls = 0;
    try {
        crypto.randomInt = () => { randomCalls++; return 1; };
        syncBuiltinESMExports();
        withTurn((agent) => {
            let getterCalls = 0;
            const accessorArgs = Object.defineProperty({}, 'expression', {
                enumerable: true,
                get() { getterCalls++; throw new Error('accessor must not run'); },
            });
            const invalid = [null, [], accessorArgs, { expression: 'd6', [Symbol('extra')]: true }];
            for (const [index, args] of invalid.entries()) {
                const callId = `invalid-shape-${index}`;
                const validation = validateDiceToolCall({ agent, callId, arguments: args });
                assert.equal(typeof validation, 'string');
                assert.throws(() => execute(agent, callId, args));
                assert.throws(() => execute(agent, callId, args), /./, 'malformed shapes are rejected before idempotency caching');
            }
            assert.throws(() => execute(agent, 'same-malformed-shape', { expression: 'd6', extra: true }));
            assert.throws(() => execute(agent, 'same-malformed-shape', null), /./,
                'a malformed request cannot bind a call ID to an error for different arguments');
            assert.equal(getterCalls, 0);
            assert.equal(randomCalls, 0, 'invalid argument shapes never invoke the secure random source');
            assert.equal(getDocumentTurn(agent).diceCount, 0, 'invalid argument shapes consume no dice budget');
            assert.equal(getDocumentTurn(agent).diceCalls.size, 0, 'malformed shapes never enter the retry cache');
        });
    }
    finally {
        crypto.randomInt = originalRandomInt;
        syncBuiltinESMExports();
    }
});

test('turn limits cap unique calls at eight and generated dice at 200', () => {
    withTurn((agent) => {
        for (let index = 0; index < 8; index++) execute(agent, `call-${index}`, { expression: '5d1', repeat: 5 });
        assert.equal(getDocumentTurn(agent).diceCount, 200);
        assert.throws(() => execute(agent, 'ninth-call', { expression: 'd1' }));
    });

    withTurn((agent) => {
        for (let index = 0; index < 7; index++) execute(agent, `budget-${index}`, { expression: '5d1', repeat: 5 });
        assert.throws(() => execute(agent, 'over-budget', { expression: '5d1', repeat: 6 }));
        assert.equal(getDocumentTurn(agent).diceCount, 175, 'a denied call does not charge dice it never rolls');
    });
});

test('expired turns, cancelled calls, and calls from another agent are refused', () => {
    const firstAgent = {};
    const secondAgent = {};
    beginDocumentTurn(firstAgent, { content: 'first turn' });
    beginDocumentTurn(secondAgent, { content: 'second turn' });
    const boundExec = { agent: firstAgent, callId: 'bound-before-expiry', arguments: { expression: 'd1' }, signal: new AbortController().signal };
    runInDocumentExecution(boundExec, () => {});
    const crossAgentExec = { agent: firstAgent, callId: 'cross-agent', arguments: { expression: 'd1' }, signal: new AbortController().signal };
    runInDocumentExecution(crossAgentExec, () => {});
    crossAgentExec.agent = secondAgent;
    assert.throws(() => runInDocumentExecution(crossAgentExec, () => executeDiceTool(crossAgentExec.arguments, crossAgentExec)));
    endDocumentTurn(firstAgent);
    assert.throws(() => runInDocumentExecution(boundExec, () => executeDiceTool(boundExec.arguments, boundExec)));

    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));
    assert.throws(() => execute(secondAgent, 'cancelled', { expression: 'd1' }, controller.signal));
    endDocumentTurn(secondAgent);
});

test('old execution cannot adopt a replacement turn; call IDs and agent scopes stay isolated', () => {
    const agent = {};
    const otherAgent = {};
    beginDocumentTurn(agent, { content: 'old turn' });
    const oldExec = { agent, callId: 'same-id', arguments: { expression: 'd1' }, signal: new AbortController().signal };
    runInDocumentExecution(oldExec, () => {});
    endDocumentTurn(agent);
    beginDocumentTurn(agent, { content: 'new turn' });
    assert.throws(() => runInDocumentExecution(oldExec, () => executeDiceTool(oldExec.arguments, oldExec)));

    beginDocumentTurn(otherAgent, { content: 'independent agent' });
    const first = execute(agent, 'same-id', { expression: 'd1' });
    const independent = execute(otherAgent, 'same-id', { expression: 'd1' });
    assert.notStrictEqual(independent, first);
    assert.equal(getDocumentTurn(agent).diceCount, 1);
    assert.equal(getDocumentTurn(otherAgent).diceCount, 1);
    for (const callId of ['', 'x'.repeat(257), undefined]) {
        assert.throws(() => execute(agent, callId, { expression: 'd1' }));
    }
    assert.equal(getDocumentTurn(agent).diceCount, 1, 'invalid IDs consume no dice budget');
    endDocumentTurn(agent);
    endDocumentTurn(otherAgent);
});

test('direct .r command recognition strips only the bot mention and defaults to d20', async () => {
    assert.equal(normalizeDiceCommandContent('<@!123> .r 2D6 x2', '123'), '.r 2D6 x2');
    assert.equal(isDiceCommandCandidate('<@123> .r', '123'), true);
    assert.equal(isDiceCommandCandidate('hello .r d20', '123'), false);

    const sends = [];
    let stopped;
    const middleware = createDiceCommandMiddleware();
    const ctx = {
        message: { kind: 'group', senderId: 'sender-1', groupOpenid: 'group-1', content: '<@123> .r', replyTarget: { id: 'target' } },
        bot: { appId: '123', async sendMarkdown(target, text) { sends.push({ target, text }); } },
        stop(reason) { stopped = reason; },
    };
    await middleware(ctx, async () => assert.fail('recognized .r must be handled directly'));
    assert.equal(stopped, 'qqbot-dice-command');
    assert.equal(sends.length, 1);
    assert.match(sends[0].text, /d20\[\d+\] = \d+/);

    sends.length = 0;
    stopped = undefined;
    ctx.message.content = '.r d1 x3';
    await middleware(ctx, async () => assert.fail('recognized repeated .r must be handled directly'));
    assert.equal(stopped, 'qqbot-dice-command');
    assert.match(sends[0].text, /1\) d1: d1\[1\] = 1\n2\) d1: d1\[1\] = 1\n3\) d1: d1\[1\] = 1/);

    sends.length = 0;
    ctx.message.content = '.r d0';
    await middleware(ctx, async () => assert.fail('invalid .r candidates receive usage feedback'));
    assert.match(sends[0].text, /面数/);
});

test('dice command rate limits enforce sender windows, fail closed without IDs, and expire without waiting', async () => {
    const originalRandomInt = crypto.randomInt;
    let fakeNow = 1_000;
    let randomCalls = 0;
    crypto.randomInt = () => { randomCalls++; return 1; };
    syncBuiltinESMExports();
    try {
        const middleware = createDiceCommandMiddleware({ now: () => fakeNow });
        let nextCalls = 0;
        const invoke = async (options) => {
            const { context, sends } = diceCommandContext(options);
            await middleware(context, async () => { nextCalls++; });
            return { context, sends };
        };

        const malformed = await invoke({ senderId: 'sender-a', groupOpenid: 'group-a', content: '.r d6*2' });
        assert.equal(malformed.context.stopReason, 'qqbot-dice-command');
        assert.equal(malformed.sends.length, 1, 'the malformed candidate receives one bounded parse response');
        assert.equal(randomCalls, 0);
        for (let index = 0; index < 9; index++) {
            const result = await invoke({ senderId: 'sender-a', groupOpenid: 'group-a' });
            assert.equal(result.context.stopReason, 'qqbot-dice-command');
        }
        const senderLimited = await invoke({ senderId: 'sender-a', groupOpenid: 'group-a' });
        assert.equal(senderLimited.context.stopReason, 'qqbot-dice-rate-limit');
        assert.equal(senderLimited.sends.length, 0, 'rate rejection is silent and cannot become a reply spam channel');
        assert.equal(randomCalls, 9, 'a sender rate hit does not request randomness');
        assert.equal(nextCalls, 0, 'direct dice and rate-rejected messages both short-circuit');

        fakeNow += 10_001;
        const afterWindow = await invoke({ senderId: 'sender-a', groupOpenid: 'group-a' });
        assert.equal(afterWindow.context.stopReason, 'qqbot-dice-command');
        assert.equal(randomCalls, 10, 'the sender can roll again after the sliding window expires');

        const missingGroupId = await invoke({ senderId: 'sender-b', groupOpenid: undefined });
        assert.equal(missingGroupId.context.stopReason, 'qqbot-dice-invalid-scope');
        assert.equal(missingGroupId.sends.length, 0);
        const missingPrivateSender = await invoke({ kind: 'c2c', senderId: undefined, groupOpenid: undefined });
        assert.equal(missingPrivateSender.context.stopReason, 'qqbot-dice-invalid-scope');
        assert.equal(randomCalls, 10, 'missing authoritative identities fail closed before random generation');
    }
    finally {
        crypto.randomInt = originalRandomInt;
        syncBuiltinESMExports();
    }
});

test('dice command group quota spans distinct peers while many groups run without an instance quota', async () => {
    const originalRandomInt = crypto.randomInt;
    let fakeNow = 2_000;
    let randomCalls = 0;
    crypto.randomInt = () => { randomCalls++; return 1; };
    syncBuiltinESMExports();
    try {
        const groupMiddleware = createDiceCommandMiddleware({ now: () => fakeNow });
        const groupInvoke = async (senderId) => {
            const { context, sends } = diceCommandContext({ senderId, groupOpenid: 'shared-group' });
            await groupMiddleware(context, async () => assert.fail('a dice attempt must short-circuit'));
            return { context, sends };
        };
        for (let index = 0; index < 30; index++) {
            assert.equal((await groupInvoke(`group-sender-${index}`)).context.stopReason, 'qqbot-dice-command');
        }
        const groupLimited = await groupInvoke('group-sender-30');
        assert.equal(groupLimited.context.stopReason, 'qqbot-dice-rate-limit');
        assert.equal(groupLimited.sends.length, 0);
        assert.equal(randomCalls, 30, 'the 31st distinct sender does not roll in a full group window');

        fakeNow += 10_001;
        const multiGroupMiddleware = createDiceCommandMiddleware({ now: () => fakeNow });
        const multiGroupInvoke = async (index) => {
            const groupIndex = Math.floor(index / 20);
            const { context, sends } = diceCommandContext({
                senderId: `multi-group-sender-${index}`,
                groupOpenid: `multi-group-${groupIndex}`,
            });
            await multiGroupMiddleware(context, async () => assert.fail('a dice attempt must short-circuit'));
            return { context, sends };
        };
        const concurrentResults = await Promise.all(Array.from({ length: 300 }, (_, index) => multiGroupInvoke(index)));
        assert.equal(concurrentResults.length, 300);
        assert.ok(concurrentResults.every(({ context }) => context.stopReason === 'qqbot-dice-command'),
            '300 attempts across 15 groups and 300 senders succeed in one window despite exceeding the former attempt and key caps');
        assert.ok(concurrentResults.every(({ sends }) => sends.length === 1));
        assert.equal(randomCalls, 330, 'all 300 high-volume attempts roll successfully');
    }
    finally {
        crypto.randomInt = originalRandomInt;
        syncBuiltinESMExports();
    }
});
