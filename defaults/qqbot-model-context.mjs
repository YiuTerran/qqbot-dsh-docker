const groupGuards = new WeakMap();

export function beginGroupModelContext(agent, scope, turn, enabled = process.env.QQBOT_GROUP_CURRENT_ONLY !== 'false') {
    if (scope !== 'group' || !enabled) {
        groupGuards.delete(agent);
        return null;
    }
    const session = agent?.session;
    if (!session || !Number.isSafeInteger(session.seq) || session.seq < 0) {
        throw new Error('Group model context requires a live agent session.');
    }
    const guard = { session, floor: session.seq, turn, active: true };
    groupGuards.set(agent, guard);
    return guard;
}

export function endGroupModelContext(agent, guard) {
    if (guard && groupGuards.get(agent) === guard) guard.active = false;
}

export function isGroupModelContextGuarded(agent) {
    return groupGuards.has(agent);
}

export function projectGroupModelMessages(agent, boundaryMessages) {
    const guard = groupGuards.get(agent);
    if (!guard) return boundaryMessages;
    if (!guard.active || !guard.turn?.active || agent.session !== guard.session) {
        throw new Error('Group model context is no longer active.');
    }
    const session = guard.session;
    const current = [];
    let latestSystem = null;
    let index = 0;
    const oldLineage = new Map();
    const citesOldEvent = (event) => {
        if (oldLineage.has(event.seq)) return oldLineage.get(event.seq);
        const result = event.sourceEventSeqs?.some((sourceSeq) => {
            if (sourceSeq < guard.floor) return true;
            const source = session.eventAt(sourceSeq);
            if (!source) throw new Error('Group model context source event is missing.');
            return citesOldEvent(source);
        }) ?? false;
        oldLineage.set(event.seq, result);
        return result;
    };
    for (const seq of session.surface.nodes) {
        const event = session.eventAt(seq);
        if (!event) throw new Error('Group model context surface contains a missing event.');
        const message = session.deriveEventMessage(event);
        if (message === null) continue;
        if (boundaryMessages[index] !== message) {
            throw new Error('Group model context projection does not match the session surface.');
        }
        index += 1;
        if (event.type === 'system/message') {
            if (message.content.some((block) => block.type !== 'text' || block.text.trim() !== '')) latestSystem = message;
        } else if (seq >= guard.floor
            && message.source?.kind !== 'compact-checkpoint'
            && !citesOldEvent(event)) {
            current.push(message);
        }
    }
    if (index !== boundaryMessages.length) {
        throw new Error('Group model context projection has unmatched messages.');
    }
    return latestSystem ? [latestSystem, ...current] : current;
}
