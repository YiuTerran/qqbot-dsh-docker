// Offline tests for native QQ SDK history buffering and recovery snapshots.
// Run on the host with `node --test scripts/test-group-history.mjs`, or in the
// image with QQBOT_HISTORY_SNAPSHOT_MODULE=/opt/qqbot-defaults/qqbot-history-snapshot.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const historySnapshotModuleUrl = process.env.QQBOT_HISTORY_SNAPSHOT_MODULE
    ? pathToFileURL(resolve(process.env.QQBOT_HISTORY_SNAPSHOT_MODULE)).href
    : new URL('../defaults/qqbot-history-snapshot.mjs', import.meta.url).href;
const { createHistorySnapshotBuffer } = await import(historySnapshotModuleUrl);
const recoveryModule = await import(new URL('./qqbot-session-recovery.mjs', historySnapshotModuleUrl));
const { advanceHistorySnapshotEpoch, isHistorySnapshotCurrent } = recoveryModule;

test('native SDK buffer supplies stored history in group and private chats', async () => {
    const listCalls = [];
    const appendCalls = [];
    const sourceStore = {
        async list(...args) {
            listCalls.push(args);
            return [{ senderId: 'prior-peer', content: `history for ${args[0]}` }];
        },
        async append(...args) { appendCalls.push(args); },
    };
    const fakeHistoryBuffer = ({ limit, store }) => async (ctx, next) => {
        const key = ctx.message.kind === 'group'
            ? `${ctx.bot.appId}:${ctx.message.groupOpenid}`
            : `private:${ctx.message.senderId}`;
        ctx.state.history = await store.list(key, limit);
        await store.append(key, { content: ctx.message.content }, limit);
        await next();
    };
    const wrapped = createHistorySnapshotBuffer(fakeHistoryBuffer, {
        limit: 10,
        store: sourceStore,
        recordOnSkip: true,
        groupKey: (ctx) => ctx.message.kind === 'group' && ctx.message.groupOpenid
            ? `${ctx.bot.appId}:${ctx.message.groupOpenid}` : undefined,
    });
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

    assert.deepEqual(group.state.history, [{ senderId: 'prior-peer', content: 'history for test-app:group-a' }]);
    assert.deepEqual(privateChat.state.history, [{ senderId: 'prior-peer', content: 'history for private:peer-a' }]);
    assert.deepEqual(listCalls, [['test-app:group-a', 10], ['private:peer-a', 10]]);
    assert.deepEqual(appendCalls, [
        ['test-app:group-a', { content: 'current group text' }, 10],
        ['private:peer-a', { content: 'current private text' }, 10],
    ], 'current messages continue to use the SDK append contract');
});

test('a reset during asynchronous history read marks the returned snapshot stale', async () => {
    let notifyStarted;
    const readStarted = new Promise((resolve) => { notifyStarted = resolve; });
    let releaseRead;
    const pendingRead = new Promise((resolve) => { releaseRead = resolve; });
    const sourceStore = {
        async list() {
            notifyStarted();
            return pendingRead;
        },
        async append() {},
    };
    const fakeHistoryBuffer = ({ store }) => async (ctx, next) => {
        ctx.state.history = await store.list('test-app:history-reset-race', 8);
        await next();
    };
    const ctx = {
        bot: { appId: 'test-app' },
        message: { kind: 'group', groupOpenid: 'history-reset-race', senderId: 'member', content: 'current text' },
        state: {},
    };
    const wrapped = createHistorySnapshotBuffer(fakeHistoryBuffer, { store: sourceStore });
    const running = wrapped(ctx, async () => {});
    await readStarted;
    advanceHistorySnapshotEpoch(sourceStore, 'test-app:history-reset-race');
    releaseRead([{ senderId: 'prior-peer', content: 'stale persisted history' }]);
    await running;

    assert.deepEqual(ctx.state.history, [{ senderId: 'prior-peer', content: 'stale persisted history' }]);
    assert.equal(isHistorySnapshotCurrent(ctx.state.history), false,
        'the SDK snapshot retains its pre-reset epoch for the inbound guard to reject');
});
