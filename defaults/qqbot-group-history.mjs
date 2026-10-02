import { AsyncLocalStorage } from 'node:async_hooks';
import {
    getHistorySnapshotEpoch,
    isHistoryStoreSuppressed,
    markHistorySnapshot,
} from './qqbot-session-recovery.mjs';

/**
 * By default, keep group model requests scoped to the current batch and explicit
 * quote context; QQBOT_GROUP_CURRENT_ONLY=false restores group history reads.
 * The SDK history middleware's append/skip semantics remain intact.
 */
export function createGroupHistoryBuffer(historyBuffer, options, env = process.env) {
    const groupCurrentOnlyValue = env?.QQBOT_GROUP_CURRENT_ONLY;
    if (groupCurrentOnlyValue !== undefined && groupCurrentOnlyValue !== ''
        && groupCurrentOnlyValue !== 'true' && groupCurrentOnlyValue !== 'false') {
        throw new Error('QQBOT_GROUP_CURRENT_ONLY must be true or false.');
    }
    const groupCurrentOnly = groupCurrentOnlyValue !== 'false';
    // HistoryBuffer's store callbacks run asynchronously. Keep per-message
    // state in an AsyncLocalStorage so overlapping peers cannot leak one
    // another's group key into a history read.
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
            if (tracksGroup) {
                if (!groupCurrentOnly && isHistoryStoreSuppressed(sourceStore, key)) return [];
                const epoch = getHistorySnapshotEpoch(sourceStore, key);
                if (groupCurrentOnly) {
                    // Keep the generation marker on the empty snapshot so a
                    // reset that races this middleware can still invalidate it.
                    return markHistorySnapshot([], sourceStore, key, epoch);
                }
                // Restore the persisted group history on opt-out, while binding
                // the result to the epoch captured before the asynchronous read.
                const history = await sourceStore.list(...args);
                return markHistorySnapshot(history, sourceStore, key, epoch);
            }
            const history = await sourceStore.list(...args);
            return history;
        },
        async append(...args) {
            return sourceStore.append(...args);
        },
        async clear(...args) { return sourceStore.clear?.(...args); },
    };
    const middleware = historyBuffer({ ...options, store });
    return (ctx, next) => storage.run(ctx, () => middleware(ctx, next));
}
