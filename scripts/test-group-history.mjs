// Offline regression tests for group-history scoping (QQBOT_GROUP_CURRENT_ONLY).
// Run on the host with `node --test scripts/test-group-history.mjs`, or in the
// image with QQBOT_GROUP_HISTORY_MODULE=/opt/qqbot-defaults/qqbot-group-history.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const groupHistoryModuleUrl = process.env.QQBOT_GROUP_HISTORY_MODULE
    ? pathToFileURL(resolve(process.env.QQBOT_GROUP_HISTORY_MODULE)).href
    : new URL('../defaults/qqbot-group-history.mjs', import.meta.url).href;
const { createGroupHistoryBuffer } = await import(groupHistoryModuleUrl);
const recoveryModule = await import(new URL('./qqbot-session-recovery.mjs', groupHistoryModuleUrl));
const { advanceHistorySnapshotEpoch, isHistorySnapshotCurrent } = recoveryModule;

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
    const wrapped = createGroupHistoryBuffer(fakeHistoryBuffer, { store: sourceStore });
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

test('group history opt-out restores limited store reads, and empty or true environment values keep the default', async () => {
    const listCalls = [];
    const appendCalls = [];
    const clearCalls = [];
    const sourceStore = {
        async list(...args) {
            listCalls.push(args);
            return [{ senderId: 'prior-peer', content: 'prior group context' }];
        },
        async append(...args) { appendCalls.push(args); },
        async clear(...args) { clearCalls.push(args); },
    };
    let wrappedStore;
    const fakeHistoryBuffer = ({ limit, store }) => {
        wrappedStore = store;
        return async (ctx, next) => {
            const key = ctx.message.kind === 'group'
                ? `${ctx.bot.appId}:${ctx.message.groupOpenid}`
                : `private:${ctx.message.senderId}`;
            ctx.state.history = await store.list(key, limit);
            await store.append(key, { content: ctx.message.content }, limit);
            await next();
        };
    };
    const context = (kind = 'group') => ({
        bot: { appId: 'test-app' },
        message: {
            kind, groupOpenid: kind === 'group' ? 'history-toggle' : undefined,
            senderId: kind === 'group' ? 'member' : 'private-peer', content: `current ${kind} text`,
        },
        state: {},
    });

    for (const env of [{}, { QQBOT_GROUP_CURRENT_ONLY: '' }, { QQBOT_GROUP_CURRENT_ONLY: 'true' }]) {
        const ctx = context();
        const wrapped = createGroupHistoryBuffer(fakeHistoryBuffer, { limit: 6, store: sourceStore }, env);
        await wrapped(ctx, async () => {});
        assert.deepEqual(ctx.state.history, [], 'missing, empty, and true values use current-batch-only mode');
    }
    assert.deepEqual(listCalls, [], 'the default mode does not read the persisted group history');
    assert.equal(appendCalls.length, 3, 'default group messages are still appended to persisted history');

    const restored = context();
    const wrapped = createGroupHistoryBuffer(fakeHistoryBuffer, { limit: 6, store: sourceStore },
        { QQBOT_GROUP_CURRENT_ONLY: 'false' });
    await wrapped(restored, async () => {});
    assert.deepEqual(restored.state.history, [{ senderId: 'prior-peer', content: 'prior group context' }]);
    assert.deepEqual(listCalls, [['test-app:history-toggle', 6]], 'the original history limit reaches the source store');
    const privateChat = context('c2c');
    await wrapped(privateChat, async () => {});
    assert.deepEqual(privateChat.state.history, [{ senderId: 'prior-peer', content: 'prior group context' }],
        'private history remains available when the group-only setting is false');
    assert.deepEqual(listCalls, [['test-app:history-toggle', 6], ['private:private-peer', 6]]);
    assert.deepEqual(appendCalls.slice(-2), [
        ['test-app:history-toggle', { content: 'current group text' }, 6],
        ['private:private-peer', { content: 'current c2c text' }, 6],
    ], 'group and private appends preserve the SDK history middleware contract');
    await wrappedStore.clear('test-app:history-toggle');
    assert.deepEqual(clearCalls, [['test-app:history-toggle']], 'history clears continue to reach the source store');
    assert.throws(() => createGroupHistoryBuffer(fakeHistoryBuffer, { store: sourceStore },
        { QQBOT_GROUP_CURRENT_ONLY: 'yes' }), /QQBOT_GROUP_CURRENT_ONLY must be true or false/u);
});

test('restored group history snapshots become stale when reset commits during the asynchronous read', async () => {
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
    const wrapped = createGroupHistoryBuffer(fakeHistoryBuffer, { store: sourceStore },
        { QQBOT_GROUP_CURRENT_ONLY: 'false' });
    const running = wrapped(ctx, async () => {});
    await readStarted;
    advanceHistorySnapshotEpoch(sourceStore, 'test-app:history-reset-race');
    releaseRead([{ senderId: 'prior-peer', content: 'stale persisted history' }]);
    await running;
    assert.deepEqual(ctx.state.history, [{ senderId: 'prior-peer', content: 'stale persisted history' }]);
    assert.equal(isHistorySnapshotCurrent(ctx.state.history), false,
        'the read returns with its pre-reset epoch so recovery can drop its stale context');
});
