import { AsyncLocalStorage } from 'node:async_hooks';
import {
    getHistorySnapshotEpoch,
    isHistoryStoreSuppressed,
    markHistorySnapshot,
} from './qqbot-session-recovery.mjs';

/**
 * Preserve the QQ SDK's complete history behavior while tagging each scoped
 * group snapshot with the generation captured before its asynchronous read.
 * The tag lets inbound reject a stale read if /new or moderation recovery
 * clears that exact group's history while list() is in flight.
 */
export function createHistorySnapshotBuffer(historyBuffer, options) {
    const storage = new AsyncLocalStorage();
    const sourceStore = options.store;
    const store = {
        async list(...args) {
            const ctx = storage.getStore();
            const key = args[0];
            const groupId = ctx?.message?.groupOpenid ?? ctx?.message?.senderId;
            const expectedGroupKey = ctx?.message?.kind === 'group'
                && typeof ctx?.bot?.appId === 'string'
                && typeof groupId === 'string'
                ? `${ctx.bot.appId}:${groupId}`
                : undefined;
            const tracksGroup = expectedGroupKey !== undefined && key === expectedGroupKey;
            if (!tracksGroup) return sourceStore.list(...args);

            const epoch = getHistorySnapshotEpoch(sourceStore, key);
            if (isHistoryStoreSuppressed(sourceStore, key)) {
                return markHistorySnapshot([], sourceStore, key, epoch);
            }
            const history = await sourceStore.list(...args);
            return markHistorySnapshot(history, sourceStore, key, epoch);
        },
        async append(...args) {
            return sourceStore.append(...args);
        },
        async clear(...args) {
            return sourceStore.clear?.(...args);
        },
    };
    const middleware = historyBuffer({ ...options, store });
    return (ctx, next) => storage.run(ctx, () => middleware(ctx, next));
}
