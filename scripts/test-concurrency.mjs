import assert from 'node:assert/strict';
import { mkdir, readlink, symlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const concurrencyUrl = process.env.QQBOT_CONCURRENCY_MODULE
    ?? new URL('../defaults/qqbot-concurrency.mjs', import.meta.url).href;
const {
    beginMergeBatch,
    captureMergeBatchReply,
    closeMergeBatch,
    createMergeConcurrencyGuard,
    formatQueueFullNotice,
    getMergedGenerationRequests,
    noteMergeBatchTurnStart,
    sendMergeQueueFullNotice,
    sendMergeThinkingNotice,
    trackMergeBatchSend,
} = await import(concurrencyUrl);
const adapterDist = process.env.QQBOT_ADAPTER_DIST;
const integration = adapterDist
    ? (name, run) => test(name, { timeout: 20000 }, run)
    : test.skip;

const pause = (milliseconds = 5) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

async function waitFor(predicate, description) {
    const until = Date.now() + 1500;
    while (Date.now() < until) {
        if (predicate()) return;
        await pause();
    }
    assert.fail(`timed out waiting for ${description}`);
}

function message(id, content, { scope = 'group', targetId = 'group-a', senderId = `member-${id}`, attachments = [] } = {}) {
    return {
        kind: scope === 'c2c' ? 'c2c' : 'group',
        messageId: id,
        replyTarget: { scope, targetId, msgId: id },
        senderId,
        content,
        attachments,
    };
}

function context(msg, state = {}) {
    const controller = new AbortController();
    const stopped = [];
    return {
        message: msg,
        state,
        signal: controller.signal,
        abort(reason) { controller.abort(reason); },
        stop(reason) { stopped.push(reason); },
        stopped,
        log: { debug() {}, info() {}, warn() {}, error() {} },
    };
}

function submit(guard, ctx, downstream) {
    return guard(ctx, () => downstream(ctx));
}

async function prepareAdapterPeers() {
    const dshRoot = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/';
    const profilePeers = '/data/profiles/qqbot/node_modules/@deepseek-ai';
    await mkdir(dirname(profilePeers), { recursive: true });
    try { await symlink(dshRoot, profilePeers, 'dir'); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        assert.equal(resolve(dirname(profilePeers), await readlink(profilePeers)), resolve(dshRoot));
    }
}

test('merge guard waits for each survivor and preserves FIFO batches without overlap', async () => {
    const guard = createMergeConcurrencyGuard({ maxQueue: 10, maxProcessingMs: 0 });
    const aGate = deferred();
    const bGate = deferred();
    const dGate = deferred();
    const starts = [];
    let active = 0;
    let peak = 0;

    const downstream = async (ctx) => {
        active++;
        peak = Math.max(peak, active);
        starts.push({ content: ctx.message.content, senderId: ctx.message.senderId, attachments: ctx.message.attachments });
        try {
            if (ctx.message.content === 'A') await aGate.promise;
            else if (ctx.message.content === 'B\nC') await bGate.promise;
            else if (ctx.message.content === 'D') await dGate.promise;
        }
        finally {
            active--;
        }
    };

    const runA = submit(guard, context(message('a', 'A')), downstream);
    await waitFor(() => starts.some((entry) => entry.content === 'A'), 'A to start');
    const runB = submit(guard, context(message('b', 'B', { attachments: [{ filename: 'b.txt' }] })), downstream);
    const runC = submit(guard, context(message('c', 'C', { attachments: [{ filename: 'c.txt' }] })), downstream);
    aGate.resolve();
    await waitFor(() => starts.some((entry) => entry.content === 'B\nC'), 'merged B+C to start');

    const runD = submit(guard, context(message('d', 'D')), downstream);
    await pause(20);
    assert.deepEqual(starts.map((entry) => entry.content), ['A', 'B\nC'],
        'D must wait while the B+C survivor is still processing');
    assert.equal(starts[1].senderId, 'member-b', 'the first buffered message remains the survivor');
    assert.deepEqual(starts[1].attachments, [{ filename: 'b.txt' }, { filename: 'c.txt' }],
        'attachments from the merged messages remain attached to the survivor');

    bGate.resolve();
    await waitFor(() => starts.some((entry) => entry.content === 'D'), 'D to start as the next batch');
    assert.equal(peak, 1, 'same-key downstream work never overlaps');
    dGate.resolve();
    await Promise.all([runA, runB, runC, runD]);
    assert.deepEqual(starts.map((entry) => entry.content), ['A', 'B\nC', 'D'],
        'every accepted message is handled exactly once in arrival order');
    assert.equal(peak, 1);
});

test('different group keys continue processing independently', async () => {
    const guard = createMergeConcurrencyGuard({ maxQueue: 2, maxProcessingMs: 0 });
    const gateA = deferred();
    const gateB = deferred();
    const starts = [];
    let active = 0;
    let peak = 0;
    const downstream = async (ctx) => {
        active++;
        peak = Math.max(peak, active);
        starts.push(ctx.message.replyTarget.targetId);
        await (ctx.message.replyTarget.targetId === 'group-a' ? gateA.promise : gateB.promise);
        active--;
    };
    const runA = submit(guard, context(message('a', 'A', { targetId: 'group-a' })), downstream);
    const runB = submit(guard, context(message('b', 'B', { targetId: 'group-b' })), downstream);
    await waitFor(() => starts.length === 2, 'both groups to start');
    assert.equal(peak, 2, 'independent groups are not serialized behind one global lock');
    gateA.resolve();
    gateB.resolve();
    await Promise.all([runA, runB]);
});

test('merge guard snapshots every original sender, target, current attachment, and quote before defaultMerge mutates the survivor', async () => {
    const firstGate = deferred();
    const merged = [];
    const guard = createMergeConcurrencyGuard({ maxQueue: 4, maxProcessingMs: 0 });
    const downstream = async (ctx) => {
        if (ctx.message.messageId === 'generation-first') {
            await firstGate.promise;
            return;
        }
        merged.push({ ctx, requests: getMergedGenerationRequests(ctx) });
    };

    const firstCtx = context(message('generation-first', 'First', {
        targetId: 'group-generation', senderId: 'user-first',
    }));
    const first = submit(guard, firstCtx, downstream);
    await waitFor(() => getMergedGenerationRequests(firstCtx).length > 0, 'first generation provenance');

    const quoteB = { url: 'https://cdn.example.test/quote-b.png', filename: 'same.png', content_type: 'image/png' };
    const quoteC = { url: 'https://cdn.example.test/quote-c.png', filename: 'same.png', content_type: 'image/png' };
    const currentB = { url: 'https://cdn.example.test/current-b.png', filename: 'b.png', content_type: 'image/png' };
    const currentC = { url: 'https://cdn.example.test/current-c.png', filename: 'c.png', content_type: 'image/png' };
    const ctxB = context(message('generation-b', 'B', {
        targetId: 'group-generation', senderId: 'user-b', attachments: [currentB],
    }), { quote: { attachments: [quoteB] } });
    const ctxC = context(message('generation-c', 'C', {
        targetId: 'group-generation', senderId: 'user-c', attachments: [currentC],
    }), { quote: { attachments: [quoteC] } });
    const runB = submit(guard, ctxB, downstream);
    const runC = submit(guard, ctxC, downstream);
    firstGate.resolve();
    await waitFor(() => merged.length === 1, 'the queued generation requests to merge');
    await Promise.all([first, runB, runC]);

    assert.equal(ctxB.message.content, 'B\nC');
    assert.deepEqual(ctxB.message.attachments, [currentB, currentC], 'the ordinary merged adapter view remains unchanged');
    const requests = merged[0].requests;
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((request) => request.ownerId), ['user-b', 'user-c']);
    assert.deepEqual(requests.map((request) => request.replyTarget.msgId), ['generation-b', 'generation-c']);
    assert.deepEqual(requests.map((request) => request.currentAttachments.map((attachment) => attachment.url)), [
        [currentB.url], [currentC.url],
    ]);
    assert.deepEqual(requests.map((request) => request.quotedAttachments.map((attachment) => attachment.url)), [
        [quoteB.url], [quoteC.url],
    ]);
    assert.deepEqual(ctxB.state.qqbotGenerationQuoteAttachments.map((attachment) => attachment.url), [quoteB.url, quoteC.url]);
    assert.ok(Object.isFrozen(requests) && requests.every((request) => Object.isFrozen(request)));
});

test('onStart receives only idle group owners; private and pre-aborted contexts skip it', async () => {
    const gateA = deferred();
    const gateB = deferred();
    const notices = [];
    const starts = [];
    const guard = createMergeConcurrencyGuard({
        maxProcessingMs: 0,
        onStart(ctx) { notices.push(ctx.message.replyTarget.targetId); },
    });
    const downstream = async (ctx) => {
        starts.push(ctx.message.replyTarget.targetId);
        if (ctx.message.replyTarget.targetId === 'group-a') await gateA.promise;
        if (ctx.message.replyTarget.targetId === 'group-b') await gateB.promise;
    };
    const runA = submit(guard, context(message('group-a', 'A', { targetId: 'group-a' })), downstream);
    const runB = submit(guard, context(message('group-b', 'B', { targetId: 'group-b' })), downstream);
    const runPrivate = submit(guard, context(message('private', 'P', { scope: 'c2c', targetId: 'private-peer' })), downstream);
    const preAborted = context(message('pre-aborted', 'X', { targetId: 'group-x' }));
    preAborted.abort('already cancelled');
    await submit(guard, preAborted, downstream);
    await waitFor(() => starts.length === 3, 'both groups and the private request to reach downstream');
    assert.deepEqual(notices.sort(), ['group-a', 'group-b'], 'only group contexts that own an idle target run onStart');
    assert.deepEqual(starts.sort(), ['group-a', 'group-b', 'private-peer'], 'private work remains unaffected');
    gateA.resolve();
    gateB.resolve();
    await Promise.all([runA, runB, runPrivate]);
});

test('thinking notice snapshots the group reply target and sends the exact fixed text without a mention', async () => {
    const sendGate = deferred();
    const sent = [];
    const ctx = context(message('thinking-id', 'user prompt', { targetId: 'original-group' }));
    const sending = sendMergeThinkingNotice({
        async sendMarkdown(target, text) {
            sent.push({ target, text });
            await sendGate.promise;
        },
    }, ctx);
    ctx.message.replyTarget = { scope: 'group', targetId: 'mutated-group', msgId: 'mutated-id' };
    await waitFor(() => sent.length === 1, 'the fixed thinking notice to be sent');
    assert.deepEqual(sent[0], {
        target: { scope: 'group', targetId: 'original-group', msgId: 'thinking-id' },
        text: '收到啦，主人，本鱼正在思考中…',
    });
    assert.equal(sent[0].text.includes('qqbot-at-user'), false);
    assert.equal(sent[0].text.includes('user prompt'), false);
    sendGate.resolve();
    await sending;

    const ignored = [];
    await sendMergeThinkingNotice({ async sendMarkdown(...args) { ignored.push(args); } },
        context(message('private-thinking', 'private prompt', { scope: 'c2c', targetId: 'private-peer' })));
    await sendMergeThinkingNotice({ async sendMarkdown(...args) { ignored.push(args); } }, {
        message: { kind: 'group', replyTarget: { scope: 'c2c', targetId: 'private-peer' } },
    });
    await sendMergeThinkingNotice({ async sendMarkdown(...args) { ignored.push(args); } }, {
        message: { kind: 'group' },
    });
    await sendMergeThinkingNotice({ async sendMarkdown(...args) { ignored.push(args); } }, {
        message: { kind: 'group', replyTarget: { scope: 'group', targetId: '' } },
    });
    assert.deepEqual(ignored, [], 'private messages and missing, invalid, or non-group targets never receive this notice');
});

test('idle group prompt runs once before the first entry, not for buffered batches, and again after idle', async () => {
    const firstNoticeGate = deferred();
    const firstDownstreamGate = deferred();
    const mergedDownstreamGate = deferred();
    const notices = [];
    const starts = [];
    const guard = createMergeConcurrencyGuard({
        maxQueue: 5,
        maxProcessingMs: 0,
        async onStart(ctx) {
            notices.push(ctx.message.messageId);
            if (ctx.message.messageId === 'a') await firstNoticeGate.promise;
        },
    });
    const downstream = async (ctx) => {
        starts.push(ctx.message.content);
        if (ctx.message.content === 'A') await firstDownstreamGate.promise;
        if (ctx.message.content === 'B\nC') await mergedDownstreamGate.promise;
    };

    const runA = submit(guard, context(message('a', 'A')), downstream);
    await waitFor(() => notices.length === 1, 'A notice to start');
    const runB = submit(guard, context(message('b', 'B')), downstream);
    const runC = submit(guard, context(message('c', 'C')), downstream);
    await pause(20);
    assert.deepEqual(starts, [], 'queued messages cannot enter downstream before the idle owner notice settles');
    firstNoticeGate.resolve();
    await waitFor(() => starts.includes('A'), 'A downstream work to start');
    firstDownstreamGate.resolve();
    await waitFor(() => starts.includes('B\nC'), 'the merged B+C downstream work to start');
    const runD = submit(guard, context(message('d', 'D')), downstream);
    await pause(20);
    assert.deepEqual(starts, ['A', 'B\nC'], 'D waits behind the merged downstream work');
    assert.deepEqual(notices, ['a'], 'buffered B+C and waiting D do not send another notice');
    mergedDownstreamGate.resolve();
    await waitFor(() => starts.includes('D'), 'D downstream work to start');
    await Promise.all([runA, runB, runC, runD]);

    const runE = submit(guard, context(message('e', 'E')), downstream);
    await runE;
    assert.deepEqual(starts, ['A', 'B\nC', 'D', 'E']);
    assert.deepEqual(notices, ['a', 'e'], 'a later idle owner gets a fresh notice');
});

test('a failed thinking notice logs one fixed warning and still enters downstream once', async () => {
    const warnings = [];
    let attempts = 0;
    const starts = [];
    const ctx = context(message('failed-notice', 'prompt'));
    ctx.log.warn = (value) => warnings.push(value);
    const guard = createMergeConcurrencyGuard({
        maxProcessingMs: 0,
        async onStart() { attempts++; throw new Error('private transport detail'); },
    });
    await submit(guard, ctx, async () => { starts.push(ctx.message.messageId); });
    assert.equal(attempts, 1, 'a failed thinking notice is never retried');
    assert.deepEqual(warnings, ['[concurrency:merge] thinking notice failed']);
    assert.deepEqual(starts, ['failed-notice'], 'notice failure does not suppress the admitted message');
});

test('cancellation and processing timeout during a pending thinking notice hold the key and skip that entry', async () => {
    for (const mode of ['cancel', 'timeout']) {
        const noticeGate = deferred();
        const starts = [];
        const notices = [];
        let owner;
        const guard = createMergeConcurrencyGuard({
            maxQueue: 2,
            maxProcessingMs: mode === 'timeout' ? 25 : 0,
            onStart(ctx) {
                notices.push(ctx.message.messageId);
                if (ctx.message.messageId === 'owner') {
                    owner = ctx;
                    return noticeGate.promise;
                }
            },
        });
        const runOwner = submit(guard, context(message('owner', 'A')), async (ctx) => starts.push(ctx.message.messageId));
        await waitFor(() => owner, `${mode} owner notice to start`);
        const runQueued = submit(guard, context(message('queued', 'B')), async (ctx) => starts.push(ctx.message.messageId));
        if (mode === 'cancel') owner.abort('cancel during prompt');
        else await waitFor(() => owner.signal.aborted, 'processing timeout to abort the pending notice owner');
        await pause(20);
        assert.deepEqual(starts, [], 'the lock stays held while the pending notice send has not settled');
        noticeGate.resolve();
        await Promise.all([runOwner, runQueued]);
        assert.deepEqual(starts, ['queued'], 'the aborted first entry skips downstream and the queued entry proceeds');
        assert.deepEqual(notices, ['owner'], 'the queued survivor is not treated as a new idle owner');
    }
});

test('onStart rejects non-functions', () => {
    assert.throws(() => createMergeConcurrencyGuard({ onStart: true }), /onStart must be a function/u);
});

test('downstream rejection releases the owner only after its finally path, then drains the buffered batch', async () => {
    const guard = createMergeConcurrencyGuard({ maxQueue: 2, maxProcessingMs: 0 });
    const failA = deferred();
    const starts = [];
    let active = 0;
    let peak = 0;
    const downstream = async (ctx) => {
        active++;
        peak = Math.max(peak, active);
        starts.push(ctx.message.content);
        try {
            if (ctx.message.content === 'A') {
                await failA.promise;
                throw new Error('fixture failure');
            }
        }
        finally {
            active--;
        }
    };
    const runA = submit(guard, context(message('a', 'A')), downstream);
    await waitFor(() => starts.length === 1, 'A to start');
    const runB = submit(guard, context(message('b', 'B')), downstream);
    failA.resolve();
    const [resultA] = await Promise.allSettled([runA, runB]);
    assert.equal(resultA.status, 'rejected', 'the active chain keeps its downstream failure');
    assert.deepEqual(starts, ['A', 'B'], 'the buffered batch still runs after the active chain fails');
    assert.equal(peak, 1, 'failure does not open a same-key overlap window');
});

test('a thrown falsy reason remains a rejection instead of being treated as success', async () => {
    const guard = createMergeConcurrencyGuard({ maxQueue: 1, maxProcessingMs: 0 });
    const releaseA = deferred();
    const started = [];
    const downstream = async (ctx) => {
        started.push(ctx.message.content);
        if (ctx.message.content === 'A') {
            await releaseA.promise;
            throw undefined;
        }
    };
    const runA = submit(guard, context(message('a', 'A')), downstream);
    await waitFor(() => started.length === 1, 'A to start');
    const runB = submit(guard, context(message('b', 'B')), downstream);
    releaseA.resolve();
    const [resultA] = await Promise.allSettled([runA, runB]);
    assert.equal(resultA.status, 'rejected');
    assert.equal(resultA.reason, undefined, 'falsy thrown values must not disappear during batch handoff');
    assert.deepEqual(started, ['A', 'B']);
});

test('a cancelled queued context is omitted while other live messages in the batch still proceed', async () => {
    const guard = createMergeConcurrencyGuard({ maxQueue: 3, maxProcessingMs: 0 });
    const releaseA = deferred();
    const starts = [];
    let active = 0;
    let peak = 0;
    const downstream = async (ctx) => {
        active++;
        peak = Math.max(peak, active);
        starts.push(ctx.message.content);
        try {
            if (ctx.message.content === 'A') await releaseA.promise;
        }
        finally {
            active--;
        }
    };
    const runA = submit(guard, context(message('a', 'A')), downstream);
    await waitFor(() => starts.length === 1, 'A to start');
    const cancelled = context(message('b', 'B'));
    const runB = submit(guard, cancelled, downstream);
    const runC = submit(guard, context(message('c', 'C')), downstream);
    cancelled.abort('message no longer active');
    releaseA.resolve();
    await Promise.all([runA, runB, runC]);
    assert.deepEqual(starts, ['A', 'C'], 'a canceled buffered message is not submitted in the next merged prompt');
    assert.equal(peak, 1);
});

test('an explicit abort completes the active downstream cleanup before the next batch starts', async () => {
    const guard = createMergeConcurrencyGuard({ maxQueue: 2, maxProcessingMs: 0 });
    const starts = [];
    let active = 0;
    let peak = 0;
    let aContext;
    const downstream = async (ctx) => {
        active++;
        peak = Math.max(peak, active);
        starts.push(ctx.message.content);
        try {
            if (ctx.message.content === 'A') {
                aContext = ctx;
                await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
                await pause(15);
            }
        }
        finally {
            active--;
        }
    };
    const runA = submit(guard, context(message('a', 'A')), downstream);
    await waitFor(() => aContext, 'A to start');
    const runB = submit(guard, context(message('b', 'B')), downstream);
    aContext.abort('fixture cancellation');
    await Promise.all([runA, runB]);
    assert.deepEqual(starts, ['A', 'B']);
    assert.equal(peak, 1, 'the next batch waits for cancellation cleanup to finish');
});

test('processing timeout aborts the active context but does not release the key before actual settlement', async () => {
    const guard = createMergeConcurrencyGuard({ maxQueue: 2, maxProcessingMs: 25 });
    const releaseA = deferred();
    const starts = [];
    let active = 0;
    let peak = 0;
    let aContext;
    const downstream = async (ctx) => {
        active++;
        peak = Math.max(peak, active);
        starts.push(ctx.message.content);
        try {
            if (ctx.message.content === 'A') {
                aContext = ctx;
                await releaseA.promise;
            }
        }
        finally {
            active--;
        }
    };
    const runA = submit(guard, context(message('a', 'A')), downstream);
    await waitFor(() => starts.length === 1, 'A to start');
    const runB = submit(guard, context(message('b', 'B')), downstream);
    await waitFor(() => aContext?.signal.aborted, 'A to be aborted after its timeout');
    await pause(20);
    assert.deepEqual(starts, ['A'], 'timeout cannot start B while A is still executing');
    assert.equal(peak, 1);
    releaseA.resolve();
    await Promise.all([runA, runB]);
    assert.deepEqual(starts, ['A', 'B']);
    assert.equal(peak, 1);
});

test('queue limit counts waiting requests, reports one drop, and retains the default capacity of twenty', async () => {
    const dropped = [];
    const notices = [];
    const guard = createMergeConcurrencyGuard({
        maxProcessingMs: 0,
        onStart(ctx) { notices.push(ctx.message.messageId); },
        onDrop(ctx) { dropped.push(ctx); },
    });
    const releaseA = deferred();
    const starts = [];
    const downstream = async (ctx) => {
        starts.push(ctx.message.content);
        if (ctx.message.content === 'A') await releaseA.promise;
    };
    const runs = [submit(guard, context(message('a', 'A')), downstream)];
    await waitFor(() => starts.length === 1, 'A to start');
    for (let index = 1; index <= 20; index++) {
        runs.push(submit(guard, context(message(String(index), `Q${index}`)), downstream));
    }
    const refused = context(message('refused', 'REFUSED', { senderId: 'member-refused' }));
    await submit(guard, refused, downstream);
    assert.deepEqual(dropped, [refused], 'only the first request past the waiting capacity is dropped');
    assert.equal(refused.stopped.length, 1, 'a refused message is stopped at admission');
    assert.deepEqual(notices, ['a'], 'waiting and overflow messages do not receive idle-owner notices');
    assert.deepEqual(starts, ['A'], 'overflow does not call downstream or the model path');
    releaseA.resolve();
    await Promise.all(runs);
    assert.equal(starts.length, 2, 'all twenty waiting messages are merged into one survivor batch');
    assert.match(starts[1], /^Q1\nQ2/u);
    assert.match(starts[1], /Q20$/u);
});

test('queue-full notices mention only a validated group sender and fall back to plain text otherwise', () => {
    const plain = '主人，本鱼太忙啦，请等一会儿再来找本鱼吧。';
    assert.equal(formatQueueFullNotice({ kind: 'group', senderId: 'member_openid-123' }),
        `<qqbot-at-user id="member_openid-123" /> ${plain}`);
    assert.equal(formatQueueFullNotice({ kind: 'c2c', senderId: 'member_openid-123' }), plain);
    for (const senderId of ['', 'contains space', 'x" /> <@everyone', '中文', 'a'.repeat(129), undefined]) {
        assert.equal(formatQueueFullNotice({ kind: 'group', senderId }), plain, `unsafe sender ${String(senderId)} is not interpolated`);
    }
});

test('overflow adapter sends once to the refused request target and snapshots it before awaiting', async () => {
    const sendGate = deferred();
    const sent = [];
    const sender = {
        async sendMarkdown(target, text) {
            sent.push({ target, text });
            await sendGate.promise;
        },
    };
    const refused = context(message('refused-id', 'ignored content', {
        senderId: 'refused-member', targetId: 'the-original-group',
    }));
    const sending = sendMergeQueueFullNotice(sender, refused);
    refused.message.replyTarget = { scope: 'group', targetId: 'later-group', msgId: 'later-message' };
    await waitFor(() => sent.length === 1, 'one busy notice to be sent');
    assert.deepEqual(sent[0].target, { scope: 'group', targetId: 'the-original-group', msgId: 'refused-id' });
    assert.equal(sent[0].text, '<qqbot-at-user id="refused-member" /> 主人，本鱼太忙啦，请等一会儿再来找本鱼吧。');
    assert.equal(sent[0].text.includes('ignored content'), false, 'user supplied content is never interpolated');
    sendGate.resolve();
    await sending;
    assert.equal(sent.length, 1, 'the notifier does not retry after the one adapter call');

    const privateSent = [];
    await sendMergeQueueFullNotice({
        async sendMarkdown(actualTarget, text) { privateSent.push({ target: actualTarget, text }); },
    }, context(message('private-refused', 'ignored', { scope: 'c2c', targetId: 'private-user' })));
    assert.deepEqual(privateSent, [{
        target: { scope: 'c2c', targetId: 'private-user', msgId: 'private-refused' },
        text: '主人，本鱼太忙啦，请等一会儿再来找本鱼吧。',
    }], 'private busy notices are plain text and still use the refused request target');
});

test('batch replies keep their immutable target and close waits for pending sends before suppressing late events', async () => {
    const record = { sessionId: 'session', replyTarget: { scope: 'group', targetId: 'mutable-target', msgId: 'old' } };
    const batch = beginMergeBatch(record, { scope: 'group', targetId: 'original-target', msgId: 'message-a' });
    assert.ok(batch);
    const captured = captureMergeBatchReply(record);
    assert.equal(captured.batch, batch);
    record.replyTarget = { scope: 'group', targetId: 'next-target', msgId: 'message-b' };
    assert.deepEqual(captureMergeBatchReply(record).replyRecord.replyTarget,
        { scope: 'group', targetId: 'original-target', msgId: 'message-a' });

    const sendGate = deferred();
    const tracked = trackMergeBatchSend(record, sendGate.promise);
    let closed = false;
    const closing = closeMergeBatch(batch).then(() => { closed = true; });
    let secondCloseFinished = false;
    const secondClosing = closeMergeBatch(batch).then(() => { secondCloseFinished = true; });
    await pause(10);
    assert.equal(closed, false, 'the inbound owner waits while an outbound send is in flight');
    assert.equal(secondCloseFinished, false, 'repeated close callers await the same in-flight drain');
    assert.equal(captureMergeBatchReply(record), undefined, 'late events are suppressed as soon as the batch closes');
    sendGate.resolve();
    await Promise.all([tracked, closing, secondClosing]);
    assert.equal(closed, true);
    assert.equal(captureMergeBatchReply(record), undefined, 'a late event cannot adopt the next mutable reply target');
});

test('native turn IDs and sequence numbers reject stale or replayed events across successive batches', async () => {
    const record = { sessionId: 'native-session' };
    const first = beginMergeBatch(record, { scope: 'group', targetId: 'group-a', msgId: 'first' });
    assert.equal(captureMergeBatchReply(record, { sessionId: 'native-session', turnId: 1, seq: 39 }), undefined,
        'an initial assistant event cannot bind to a batch before its native turn/start');
    assert.equal(noteMergeBatchTurnStart(record, { sessionId: 'native-session', turnId: { id: 1 }, seq: 39 }), false,
        'a malformed native turn/start identifier is not admitted');
    assert.equal(noteMergeBatchTurnStart(record, { sessionId: 'native-session', turnId: 2, seq: 40 }), true);
    assert.equal(captureMergeBatchReply(record, { sessionId: 'native-session', turnId: 1, seq: 39 }), undefined,
        'an older turn/end cannot be routed to the active first batch');
    assert.equal(captureMergeBatchReply(record, { sessionId: 'native-session', turnId: 2, seq: 41 }).batch, first);
    assert.equal(captureMergeBatchReply(record, { sessionId: 'native-session', turnId: 2, seq: 41 }), undefined,
        'a replayed native sequence number cannot trigger a duplicate reply');
    assert.equal(captureMergeBatchReply(record, { sessionId: 'native-session', turnId: 2, seq: 45 }).batch, first);
    await closeMergeBatch(first);

    record.replyTarget = { scope: 'group', targetId: 'group-b', msgId: 'mutable-second' };
    const second = beginMergeBatch(record, { scope: 'group', targetId: 'group-b', msgId: 'second' });
    assert.equal(noteMergeBatchTurnStart(record, { sessionId: 'native-session', turnId: 2, seq: 40 }), false,
        'a previous turn/start replay cannot bind the new batch after its predecessor closes');
    assert.equal(captureMergeBatchReply(record, { sessionId: 'native-session', turnId: 2, seq: 46 }), undefined,
        'assistant events are ignored until this new batch receives its own native turn/start');
    assert.equal(noteMergeBatchTurnStart(record, { sessionId: 'native-session', turnId: 3, seq: 50 }), true);
    assert.equal(captureMergeBatchReply(record, { sessionId: 'native-session', turnId: 2, seq: 42 }), undefined,
        'a delayed event from the previous turn cannot adopt the second target');
    assert.equal(captureMergeBatchReply(record, { sessionId: 'native-session', turnId: 3, seq: 51 }).batch, second);
    assert.equal(captureMergeBatchReply(record, { sessionId: 'native-session', turnId: { id: 3 } }), undefined,
        'a malformed turn ID is not treated as an unsequenced current event');
    await closeMergeBatch(second);
});

integration('native group inbound/outbound handlers hold the shared-group lock through delayed send and keep each reply target', async () => {
    await prepareAdapterPeers();
    const adapter = `${resolve(adapterDist)}/`;
    const [{ handleInbound }, { createOutboundHandler }] = await Promise.all([
        import(`${adapter}transport/inbound.js`),
        import(`${adapter}transport/outbound.js`),
    ]);
    const sendStarted = deferred();
    const releaseFirstSend = deferred();
    const sent = [];
    const followups = [];
    let record;
    let outbound;
    let turn = 0;
    let seq = 1;
    const thinkingNotice = '收到啦，主人，本鱼正在思考中…';
    const bot = {
        async sendMarkdown(target, text) {
            sent.push({ target, text });
            if (target.msgId === 'message-a' && text !== thinkingNotice) {
                sendStarted.resolve();
                await releaseFirstSend.promise;
            }
        },
    };
    const agent = {
        followup(body) {
            followups.push(body);
            if (followups.length === 2) {
                outbound({ header: { id: record.sessionId } }, {
                    type: 'assistant/message', seq: 3, data: {
                        turn: 1,
                        message: { content: [{ type: 'text', text: 'stale-reply-from-A' }] },
                    },
                });
            }
        },
        async whenIdle() {
            const currentTurn = ++turn;
            outbound({ header: { id: record.sessionId } }, {
                type: 'turn/start', seq: currentTurn === 1 ? seq++ : 4, data: { turn: currentTurn },
            });
            outbound({ header: { id: record.sessionId } }, {
                type: 'assistant/message', seq: currentTurn === 1 ? seq++ : 5, data: {
                    turn: currentTurn,
                    message: { content: [{ type: 'text', text: `reply-${currentTurn}` }] },
                },
            });
        },
    };
    const manager = {
        getSessionRecord(scope, peerId) {
            return record?.scope === scope && record.peerId === peerId ? record : undefined;
        },
        findBySessionId(sessionId) { return record?.sessionId === sessionId ? record : undefined; },
        async getOrCreate(scope, peerId, senderId, replyTarget) {
            if (!record) {
                record = {
                    scope, peerId, senderId, sessionId: 'merge-native-session', agent,
                    replyTarget, handle: { async dispose() {} },
                };
            }
            record.replyTarget = replyTarget;
            return record;
        },
    };
    outbound = createOutboundHandler(manager, bot, {
        appId: 'test-app', textChunkLimit: 2000, streaming: false, showToolResults: false,
    }, { info() {}, debug() {}, warn() {}, error() {} }, {});
    const guard = createMergeConcurrencyGuard({
        maxQueue: 10,
        maxProcessingMs: 0,
        onStart: (startedCtx) => sendMergeThinkingNotice(bot, startedCtx),
    });
    const config = { appId: 'test-app', textChunkLimit: 2000, streaming: false, showToolResults: false, historyLimit: 10 };
    const logger = { info() {}, debug() {}, warn() {}, error() {} };
    const inbound = (id, content) => {
        const ctx = context({
            kind: 'group', groupOpenid: 'group-a', senderId: id === 'message-a' ? 'member-a' : 'member-b',
            messageId: id, content, attachments: [],
            replyTarget: { scope: 'group', targetId: 'group-a', msgId: id },
        });
        ctx.bot = bot;
        ctx.state = { mention: { wasMentioned: true } };
        return submit(guard, ctx, (accepted) => handleInbound(accepted, manager, config, logger));
    };

    const runA = inbound('message-a', 'question A');
    await sendStarted.promise;
    assert.deepEqual(sent.slice(0, 2), [
        { target: { scope: 'group', targetId: 'group-a', msgId: 'message-a' }, text: thinkingNotice },
        { target: { scope: 'group', targetId: 'group-a', msgId: 'message-a' }, text: 'reply-1' },
    ], 'the idle group notice settles against the inbound target before model work replies');
    const runB = inbound('message-b', 'question B');
    await pause(20);
    assert.equal(followups.length, 1, 'the next native inbound handler stays queued until A finishes sending');
    assert.equal(sent.length, 2, 'the queued group receives no thinking notice while A owns the target');
    releaseFirstSend.resolve();
    await Promise.all([runA, runB]);
    assert.equal(followups.length, 2);
    assert.deepEqual(sent.map(({ target }) => target), [
        { scope: 'group', targetId: 'group-a', msgId: 'message-a' },
        { scope: 'group', targetId: 'group-a', msgId: 'message-a' },
        { scope: 'group', targetId: 'group-a', msgId: 'message-b' },
    ], 'notices and native responses use the originating message target for each serialized batch');
    assert.deepEqual(sent.map(({ text }) => text), [thinkingNotice, 'reply-1', 'reply-2'],
        'the queued B request receives no second idle notice and a late native event from A is discarded');
});

integration('native inbound carries real SDK quote image grants into generation metadata and revokes them after the turn', async () => {
    await prepareAdapterPeers();
    const adapter = `${resolve(adapterDist)}/`;
    const defaultsUrl = concurrencyUrl.startsWith('file:')
        ? concurrencyUrl
        : pathToFileURL(resolve(concurrencyUrl)).href;
    const policyUrl = new URL('./qqbot-chat-policy.mjs', defaultsUrl);
    const generationScopeUrl = new URL('./qqbot-generation-scope.mjs', defaultsUrl);
    const qqbotNode = '/data/profiles/qqbot/node_modules/@tencent-connect/qqbot-nodejs/dist/';
    const [
        { handleInbound },
        { createMiddlewareContext, runMiddlewareChain },
        { quoteRef },
        { createScopedQuoteRef },
        { getGenerationTurn, getGenerationImageAttachment, generationRequestMetadata },
    ] = await Promise.all([
        import(`${adapter}transport/inbound.js`),
        import(`${qqbotNode}middleware/types.js`),
        import(`${qqbotNode}middleware/quote-ref.js`),
        import(policyUrl.href),
        import(generationScopeUrl.href),
    ]);

    const sourceUrl = 'https://cdn.example.test/river.jpg';
    const localPath = '/data/qqbot-media/river.jpg';
    const warnings = [];
    const logger = { info() {}, debug() {}, warn(message) { warnings.push(message); }, error() {} };
    const bot = { async sendMarkdown() {} };
    const followups = [];
    let record;
    const agent = {
        followup(body) {
            const scope = getGenerationTurn(agent);
            const requests = generationRequestMetadata(scope);
            const request = scope && [...scope.requests.values()][0];
            const image = request?.images[0];
            const grant = image
                ? getGenerationImageAttachment(scope, request.requestId, image.imageAttachmentId)
                : undefined;
            const bodyText = typeof body === 'string' ? body
                : Array.isArray(body?.content)
                    ? body.content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n')
                    : JSON.stringify(body);
            followups.push({ body, bodyText, scope, requestId: request?.requestId, imageAttachmentId: image?.imageAttachmentId, grant,
                requestReplyTarget: request?.replyTarget, metadata: requests });
        },
        async whenIdle() {},
    };
    const manager = {
        getSessionRecord(scope, peerId) {
            return record?.scope === scope && record.peerId === peerId ? record : undefined;
        },
        findBySessionId(sessionId) { return record?.sessionId === sessionId ? record : undefined; },
        async getOrCreate(scope, peerId, senderId, replyTarget) {
            if (!record) record = {
                scope, peerId, senderId, sessionId: 'quoted-generation-session', agent,
                replyTarget, handle: { async dispose() {} },
            };
            record.replyTarget = replyTarget;
            return record;
        },
    };
    const config = { appId: 'test-app', textChunkLimit: 2000, streaming: false, showToolResults: false, historyLimit: 10 };
    const scopedQuoteRef = createScopedQuoteRef(quoteRef);
    const guard = createMergeConcurrencyGuard({ maxQueue: 2, maxProcessingMs: 0 });
    const targets = [
        { kind: 'group', peerField: 'groupOpenid', peerId: 'group-a', scope: 'group' },
        { kind: 'c2c', peerField: undefined, peerId: 'peer-a', scope: 'c2c' },
    ];

    for (const target of targets) {
        record = undefined;
        const messageId = 'ROBOT1.0.AB+/cd==';
        const rawMessage = {
            kind: target.kind,
            ...(target.peerField ? { [target.peerField]: target.peerId } : {}),
            senderId: target.kind === 'c2c' ? target.peerId : 'member-a',
            messageId,
            msgIdx: `current-${target.scope}`,
            refMsgIdx: `quoted-${target.scope}`,
            content: '请基于引用图片改图',
            msgElements: [{
                content: '江景',
                attachments: [{ content_type: 'image/jpeg', filename: 'river.jpg', url: sourceUrl }],
            }],
            attachments: [],
            replyTarget: { scope: target.scope, targetId: target.peerId, msgId: messageId },
        };
        const ctx = createMiddlewareContext({ bot, message: rawMessage, log: logger });
        if (target.scope === 'group') ctx.state.mention = { wasMentioned: true };
        const fixtureDownload = async (middlewareCtx, next) => {
            middlewareCtx.state.downloadedQuoteFiles = [{ sourceUrl, localPath, contentType: 'image' }];
            await next();
        };
        const guarded = (middlewareCtx, next) => guard(middlewareCtx, next);
        const inbound = (middlewareCtx, next) => handleInbound(middlewareCtx, manager, config, logger);
        await runMiddlewareChain([scopedQuoteRef, guarded, fixtureDownload, inbound], ctx);

        assert.equal(ctx.state.quote?.source, 'msg_elements', 'the SDK quote middleware resolves the explicit image quote');
        assert.equal(ctx.state.quote?.attachments?.[0]?.url, sourceUrl);
        assert.equal(ctx.state.quote?.attachments?.[0]?.filename, 'river.jpg');
        assert.equal(followups.length, targets.indexOf(target) + 1, 'the real inbound handler reaches the fake agent exactly once');
        const captured = followups.at(-1);
        assert.ok(captured.scope, 'generation scope is active while agent.followup receives the model body');
        assert.ok(captured.requestId, 'model input has an opaque request ID for this original QQ message');
        assert.ok(captured.imageAttachmentId, 'model input has an opaque image attachment ID for the quoted image');
        assert.equal(captured.grant?.requestId, captured.requestId);
        assert.equal(captured.grant?.imageAttachmentId, captured.imageAttachmentId);
        assert.equal(captured.grant?.quoted, true, 'the image grant is marked as quoted');
        assert.equal(captured.grant?.sourceUrl, sourceUrl, 'the successful fixture download is bound to the quoted source URL');
        assert.equal(captured.grant?.localPath, localPath, 'the image grant binds the fixture download path');
        assert.deepEqual(captured.requestReplyTarget,
            { scope: target.scope, targetId: target.peerId, msgId: messageId },
            'the grant request stays bound to the original punctuation-bearing message and reply target');
        assert.equal(record.replyTarget.msgId, messageId, 'the inbound session record keeps the original reply target');
        assert.equal(captured.metadata[0]?.requestId, captured.requestId);
        assert.deepEqual(captured.metadata[0]?.images, [{
            imageAttachmentId: captured.imageAttachmentId,
            filename: 'river.jpg',
            quoted: true,
        }], 'the model input contains only the opaque image grant metadata');
        const metadataStart = captured.bodyText.indexOf('[Untrusted QQ generation request IDs;');
        assert.notEqual(metadataStart, -1, 'the rendered model body includes scoped generation request metadata');
        const generationMetadata = captured.bodyText.slice(metadataStart);
        assert.ok(!generationMetadata.includes(sourceUrl), 'generation metadata does not expose the source URL');
        assert.ok(!generationMetadata.includes(localPath), 'generation metadata does not expose the local media path');
        const metadataJsonStart = generationMetadata.indexOf('\n');
        assert.notEqual(metadataJsonStart, -1, 'generation metadata separates its header from the JSON payload');
        assert.deepEqual(JSON.parse(generationMetadata.slice(metadataJsonStart + 1)), captured.metadata,
            'the actual followup body carries the active requestId and imageAttachmentId metadata');
        assert.deepEqual(warnings, [], 'the real inbound handler did not swallow an error while processing the quote');

        assert.equal(getGenerationTurn(agent), undefined, 'the active grant is removed when handleInbound completes');
        assert.equal(captured.scope.active, false, 'the completed scope is revoked');
        assert.equal(getGenerationImageAttachment(captured.scope, captured.requestId, captured.imageAttachmentId), undefined,
            'the previous image grant cannot be used after the inbound turn');
        assert.equal(captured.scope.requests.size, 0, 'request IDs are cleared when the turn is revoked');
    }
});

integration('timed-out native turn cancels its captured agent and drains document grants before the next message', async () => {
    await prepareAdapterPeers();
    const adapter = `${resolve(adapterDist)}/`;
    const [{ handleInbound }, { createOutboundHandler }] = await Promise.all([
        import(`${adapter}transport/inbound.js`),
        import(`${adapter}transport/outbound.js`),
    ]);
    const scopePolicy = process.env.QQBOT_DOCUMENT_SCOPE_MODULE
        ? pathToFileURL(resolve(process.env.QQBOT_DOCUMENT_SCOPE_MODULE)).href
        : '/opt/qqbot-defaults/qqbot-document-scope.mjs';
    const { getDocumentTurn } = await import(scopePolicy);
    const idleGate = deferred();
    const firstStarted = deferred();
    const cancelled = deferred();
    const followups = [];
    let firstScope;
    let secondScope;
    let idleCalls = 0;
    let record;
    let outbound;
    const agent = {
        followup(body) {
            followups.push(body);
            if (followups.length === 1) {
                firstScope = getDocumentTurn(agent);
                assert.ok(firstScope?.documents.size, 'the quoted text document is authorized during the active request');
                firstStarted.resolve();
            }
            else {
                secondScope = getDocumentTurn(agent);
                assert.ok(secondScope?.documents.size === 1, 'B receives its own document grant while its request is active');
                assert.notEqual(secondScope, firstScope, 'B uses a fresh document scope after A is canceled');
                assert.equal(firstScope.active, false, 'the canceled turn has revoked its document scope before B starts');
                assert.equal(firstScope.documents.size, 0);
            }
        },
        cancel() { cancelled.resolve(); },
        async whenIdle() {
            idleCalls++;
            if (idleCalls === 1) await idleGate.promise;
        },
    };
    const manager = {
        getSessionRecord(scope, peerId) {
            return record?.scope === scope && record.peerId === peerId ? record : undefined;
        },
        findBySessionId(sessionId) { return record?.sessionId === sessionId ? record : undefined; },
        async getOrCreate(scope, peerId, senderId, replyTarget) {
            if (!record) record = { scope, peerId, senderId, sessionId: 'cancel-native-session', agent, replyTarget, handle: { async dispose() {} } };
            record.replyTarget = replyTarget;
            return record;
        },
    };
    const bot = { async sendMarkdown() { assert.fail('fixture turn must not send a response'); } };
    outbound = createOutboundHandler(manager, bot, {
        appId: 'test-app', textChunkLimit: 2000, streaming: false, showToolResults: false,
    }, { info() {}, debug() {}, warn() {}, error() {} }, {});
    const guard = createMergeConcurrencyGuard({ maxQueue: 2, maxProcessingMs: 25 });
    const config = { appId: 'test-app', historyLimit: 10 };
    const logger = { info() {}, debug() {}, warn() {}, error() {} };
    const inbound = (id) => {
        const ctx = context({
            kind: 'c2c', senderId: 'peer-a', messageId: id, content: `question ${id}`, attachments: [
                { filename: `${id}.txt`, content_type: 'text/plain', size: 12, url: `https://files.example/${id}.txt` },
            ],
            replyTarget: { scope: 'c2c', targetId: 'peer-a', msgId: id },
        });
        ctx.bot = bot;
        ctx.state = { mention: { wasMentioned: true } };
        return submit(guard, ctx, (accepted) => handleInbound(accepted, manager, config, logger));
    };
    const runA = inbound('cancel-a');
    await firstStarted.promise;
    const runB = inbound('cancel-b');
    await cancelled.promise;
    await pause(20);
    assert.equal(followups.length, 1, 'queued B waits until timed-out A actually leaves the inbound handler');
    assert.ok(firstScope.active, 'A grants are not revoked while its asynchronous handler still owns the lock');
    idleGate.resolve();
    await Promise.all([runA, runB]);
    assert.equal(followups.length, 2);
    assert.ok(secondScope, 'B entered its followup while its own scope was active');
    assert.equal(secondScope.active, false, 'B grants are revoked when its inbound turn finishes');
    assert.equal(secondScope.documents.size, 0, 'B document IDs are cleared at the end of its turn');
    assert.equal(getDocumentTurn(agent), undefined, 'no document authorization survives the complete A/B batch chain');
});

integration('native stream abort returns a promise that waits behind pending writer updates', async (t) => {
    await prepareAdapterPeers();
    const { StreamingWriter } = await import(`${resolve(adapterDist)}/transport/streaming-writer.js`);
    const releaseUpdate = deferred();
    const operations = [];
    const diagnostics = [];
    const writer = new StreamingWriter({
        bot: {
            openStream(target) {
                operations.push(['open', target]);
                return {
                    async update(text) {
                        operations.push(['update-start', text]);
                        await releaseUpdate.promise;
                        operations.push(['update-finish', text]);
                    },
                    async complete() { operations.push(['complete']); },
                };
            },
        },
        target: { scope: 'c2c', targetId: 'peer-a', msgId: 'stream-origin' },
        logger: { info() {}, debug() {}, warn(message) { diagnostics.push(message); }, error(message) { diagnostics.push(message); } },
        throttleMs: 1,
    });
    t.after(() => { releaseUpdate.resolve(); return writer.abort(); });
    writer.append('first chunk');
    await waitFor(() => operations.some(([name]) => name === 'update-start') || diagnostics.length > 0,
        'the native stream update to start');
    assert.deepEqual(diagnostics, [], 'the stream fixture respects the synchronous openStream contract');
    const aborting = writer.abort();
    assert.ok(aborting && typeof aborting.then === 'function', 'abort exposes the writer chain completion');
    let finished = false;
    void aborting.then(() => { finished = true; });
    await pause(10);
    assert.equal(finished, false, 'abort does not resolve while a prior stream update remains pending');
    releaseUpdate.resolve();
    await aborting;
    assert.deepEqual(operations.map(([name]) => name), ['open', 'update-start', 'update-finish', 'complete'],
        'complete remains ordered after pending update delivery');
    assert.deepEqual(diagnostics, [], 'stream update and abort complete without hidden failures');
});

integration('duplicate outbound flushes share one pending delivery and cancel waits for it', async () => {
    await prepareAdapterPeers();
    const { OutboundBuffer } = await import(`${resolve(adapterDist)}/transport/outbound-buffer.js`);
    const sendStarted = deferred();
    const releaseSend = deferred();
    const sends = [];
    const target = { scope: 'c2c', targetId: 'peer-a', msgId: 'buffer-origin' };
    const buffer = new OutboundBuffer({ replyTarget: target }, {
        async sendMarkdown(actualTarget, text) {
            sends.push({ target: actualTarget, text });
            sendStarted.resolve();
            await releaseSend.promise;
        },
    }, 2000, { info() {}, debug() {}, warn() {}, error() {} }, false);
    buffer.append('buffered reply');
    const firstFlush = buffer.flush();
    const duplicateFlush = buffer.flush();
    assert.equal(firstFlush, duplicateFlush, 'concurrent flush requests share one exact completion promise');
    await sendStarted.promise;
    const cancelling = buffer.cancel();
    let cancellationFinished = false;
    void cancelling.then(() => { cancellationFinished = true; });
    await pause(10);
    assert.equal(cancellationFinished, false, 'batch cancellation waits for a delivery already in progress');
    releaseSend.resolve();
    await Promise.all([firstFlush, duplicateFlush, cancelling]);
    assert.equal(sends.length, 1, 'duplicate flush events send the accumulated content only once');
    assert.deepEqual(sends[0], { target, text: 'buffered reply' });
    assert.equal(buffer.text, '');
});

integration('production middleware wires configured overflow to the existing sender and refuses model work', async () => {
    await prepareAdapterPeers();
    const adapter = `${resolve(adapterDist)}/`;
    const { setupMiddlewares } = await import(`${adapter}gateway/middleware-setup.js`);
    const layers = [];
    const notices = [];
    const sender = {
        async sendMarkdown(target, text) { notices.push({ target, text }); },
    };
    const manager = { questionChannel: { tryAnswer() { return false; } } };
    const config = {
        appId: 'test-app',
        debug: false,
        access: { c2cMode: 'open', c2cAllow: [], groupMode: 'open', groupAllow: [] },
        requireMention: true,
        historyLimit: 10,
        maxQueue: 1,
        processingTimeoutMs: 0,
        media: {},
    };
    setupMiddlewares({ use(middleware) { layers.push(middleware); } }, config, manager,
        { info() {}, debug() {}, warn() {}, error() {} }, sender);
    const guard = layers.find((middleware) => middleware.name === 'mergeConcurrencyGuard');
    assert.equal(typeof guard, 'function', 'the production chain installs the dedicated merge guard');
    const ownerGate = deferred();
    let modelCalls = 0;
    const owner = context(message('busy-owner', 'first', { targetId: 'shared-group' }));
    const waiting = context(message('busy-wait', 'second', { targetId: 'shared-group' }));
    const refused = context(message('busy-refused', 'third', { targetId: 'shared-group', senderId: 'refused-member' }));
    const ownerRun = submit(guard, owner, async () => { modelCalls++; await ownerGate.promise; });
    await waitFor(() => modelCalls === 1, 'the active request to reach downstream');
    const waitingRun = submit(guard, waiting, async () => { modelCalls++; });
    await submit(guard, refused, async () => { modelCalls++; });
    assert.deepEqual(notices, [{
        target: { scope: 'group', targetId: 'shared-group', msgId: 'busy-owner' },
        text: '收到啦，主人，本鱼正在思考中…',
    }, {
        target: { scope: 'group', targetId: 'shared-group', msgId: 'busy-refused' },
        text: '<qqbot-at-user id="refused-member" /> 主人，本鱼太忙啦，请等一会儿再来找本鱼吧。',
    }], 'only the idle owner and refused request receive notices, each at its own message target');
    assert.equal(modelCalls, 1, 'the full-queue request never enters attachment/model middleware');
    ownerGate.resolve();
    await Promise.all([ownerRun, waitingRun]);
    assert.equal(modelCalls, 2, 'the accepted waiter runs after the owner releases the group');
});

integration('a failed busy notice logs one fixed warning and never retries or enters model work', async () => {
    await prepareAdapterPeers();
    const { setupMiddlewares } = await import(`${resolve(adapterDist)}/gateway/middleware-setup.js`);
    const layers = [];
    const warnings = [];
    let sendAttempts = 0;
    let busyAttempts = 0;
    const sender = {
        async sendMarkdown(_target, text) {
            sendAttempts++;
            if (text === '收到啦，主人，本鱼正在思考中…') return;
            busyAttempts++;
            throw new Error('private send transport details');
        },
    };
    const config = {
        appId: 'test-app', debug: false,
        access: { c2cMode: 'open', c2cAllow: [], groupMode: 'open', groupAllow: [] },
        requireMention: true, historyLimit: 10, maxQueue: 1, processingTimeoutMs: 0, media: {},
    };
    setupMiddlewares({ use(middleware) { layers.push(middleware); } }, config,
        { questionChannel: { tryAnswer() { return false; } } },
        { info() {}, debug() {}, warn(value) { warnings.push(value); }, error() {} }, sender);
    const guard = layers.find((middleware) => middleware.name === 'mergeConcurrencyGuard');
    const gate = deferred();
    let modelCalls = 0;
    const owner = context(message('failure-owner', 'owner', { targetId: 'shared-group' }));
    const waiter = context(message('failure-waiter', 'waiter', { targetId: 'shared-group' }));
    const refused = context(message('failure-refused', 'must not enter model', { targetId: 'shared-group' }));
    const ownerRun = submit(guard, owner, async () => { modelCalls++; await gate.promise; });
    await waitFor(() => modelCalls === 1, 'owner model path to start');
    const waiterRun = submit(guard, waiter, async () => { modelCalls++; });
    await assert.doesNotReject(submit(guard, refused, async () => { modelCalls++; }));
    assert.equal(sendAttempts, 2, 'the owner acknowledgement and one overflow notice are each attempted once');
    assert.equal(busyAttempts, 1, 'the refused request gets one busy notice attempt');
    assert.deepEqual(warnings, ['[concurrency:merge] busy notice failed'], 'only one fixed diagnostic is recorded');
    assert.equal(modelCalls, 1, 'a failed busy notice does not submit the dropped message to the model');
    gate.resolve();
    await Promise.all([ownerRun, waiterRun]);
    assert.equal(modelCalls, 2);
    assert.equal(sendAttempts, 2, 'neither notice is retried after the send path settles');
    assert.equal(busyAttempts, 1);
});
