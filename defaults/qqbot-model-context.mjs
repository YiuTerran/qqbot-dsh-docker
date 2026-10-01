import { logContextGuard, logContextProjection } from './qqbot-context-diagnostics.mjs';

const groupGuards = new WeakMap();
const bypassReasons = new WeakMap();

export function beginGroupModelContext(agent, scope, turn, enabled = process.env.QQBOT_GROUP_CURRENT_ONLY !== 'false') {
    if (scope !== 'group' || !enabled) {
        groupGuards.delete(agent);
        const reason = scope !== 'group' ? 'private' : 'disabled';
        bypassReasons.set(agent, reason);
        logContextGuard({ agent, state: 'bypass', reason, enabled: false });
        return null;
    }
    const session = agent?.session;
    if (!session || !Number.isSafeInteger(session.seq) || session.seq < 0) {
        logContextGuard({ agent, state: 'rejected', reason: 'invalid-session', enabled: true });
        throw new Error('Group model context requires a live agent session.');
    }
    const guard = { session, floor: session.seq, turn, active: true };
    groupGuards.set(agent, guard);
    bypassReasons.delete(agent);
    logContextGuard({ agent, state: 'active', reason: 'group', enabled: true, floor: guard.floor });
    return guard;
}

export function endGroupModelContext(agent, guard) {
    if (guard && groupGuards.get(agent) === guard) {
        guard.active = false;
        logContextGuard({ agent, state: 'ended', reason: 'group', enabled: true, floor: guard.floor });
    }
}

export function isGroupModelContextGuarded(agent) {
    return groupGuards.has(agent);
}

export function projectGroupModelMessages(agent, boundaryMessages) {
    const guard = groupGuards.get(agent);
    if (!guard) {
        logContextProjection({ agent, state: 'bypass', reason: bypassReasons.get(agent) ?? 'unbound',
            input: boundaryMessages, output: boundaryMessages });
        return boundaryMessages;
    }
    if (!guard.active || !guard.turn?.active || agent.session !== guard.session) {
        logContextProjection({ agent, state: 'rejected',
            reason: agent.session !== guard.session ? 'session-changed' : 'expired',
            input: boundaryMessages });
        throw new Error('Group model context is no longer active.');
    }
    const session = guard.session;
    const current = [];
    let latestSystem = null;
    let index = 0;
    let droppedOldEventCount = 0;
    let droppedOldLineageCount = 0;
    let droppedCheckpointCount = 0;
    const oldLineage = new Map();
    const citesOldEvent = (event) => {
        if (oldLineage.has(event.seq)) return oldLineage.get(event.seq);
        const result = event.sourceEventSeqs?.some((sourceSeq) => {
            if (sourceSeq < guard.floor) return true;
            const source = session.eventAt(sourceSeq);
            if (!source) {
                logContextProjection({ agent, state: 'rejected', reason: 'missing-surface', input: boundaryMessages });
                throw new Error('Group model context source event is missing.');
            }
            return citesOldEvent(source);
        }) ?? false;
        oldLineage.set(event.seq, result);
        return result;
    };
    for (const seq of session.surface.nodes) {
        const event = session.eventAt(seq);
        if (!event) {
            logContextProjection({ agent, state: 'rejected', reason: 'missing-surface', input: boundaryMessages });
            throw new Error('Group model context surface contains a missing event.');
        }
        const message = session.deriveEventMessage(event);
        if (message === null) continue;
        if (boundaryMessages[index] !== message) {
            logContextProjection({ agent, state: 'rejected', reason: 'projection-mismatch', input: boundaryMessages });
            throw new Error('Group model context projection does not match the session surface.');
        }
        index += 1;
        if (event.type === 'system/message') {
            if (message.content.some((block) => block.type !== 'text' || block.text.trim() !== '')) latestSystem = message;
        } else if (seq < guard.floor) {
            droppedOldEventCount += 1;
        } else if (message.source?.kind === 'compact-checkpoint') {
            droppedCheckpointCount += 1;
        } else if (citesOldEvent(event)) {
            droppedOldLineageCount += 1;
        } else {
            current.push(message);
        }
    }
    if (index !== boundaryMessages.length) {
        logContextProjection({ agent, state: 'rejected', reason: 'projection-mismatch', input: boundaryMessages });
        throw new Error('Group model context projection has unmatched messages.');
    }
    const output = latestSystem ? [latestSystem, ...current] : current;
    logContextProjection({ agent, state: 'applied', reason: 'group', input: boundaryMessages, output, current,
        retainedSystemCount: latestSystem ? 1 : 0,
        droppedOldEventCount, droppedOldLineageCount, droppedCheckpointCount });
    return output;
}
