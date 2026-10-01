import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2];
const recoveryV1Only = process.argv[3] === 'recovery-v1';
if (!root) throw new Error('usage: prepare-pre-recovery-fixture.mjs <dsh-qqbot-dist-directory>');

// Newer source fixtures include the merge-batch patch. Reverse that layer
// first so this historical recovery fixture continues to describe the exact
// pre-recovery layout it was written for. The helper is bind-mounted in image
// tests; on the host, use the sibling script by default.
const currentOutbound = await readFile(join(root, 'transport/outbound.js'), 'utf8');
if (currentOutbound.includes("from '/opt/qqbot-defaults/qqbot-concurrency.mjs';")) {
    const mountedFixture = '/tmp/prepare-pre-concurrency-fixture.mjs';
    const concurrencyFixture = process.env.QQBOT_PRE_CONCURRENCY_FIXTURE
        ?? (existsSync(mountedFixture)
            ? mountedFixture
            : fileURLToPath(new URL('./prepare-pre-concurrency-fixture.mjs', import.meta.url)));
    const result = spawnSync(process.execPath, [concurrencyFixture, root], { stdio: 'inherit' });
    if (result.error || result.status !== 0) {
        throw result.error ?? new Error('pre-concurrency fixture failed');
    }
}

function replaceOnce(source, before, after, label) {
    const parts = source.split(before);
    if (parts.length !== 2) throw new Error(`pre-recovery fixture expected one ${label}`);
    return parts[0] + after + parts[1];
}

async function edit(file, operation) {
    const path = join(root, file);
    await writeFile(path, operation(await readFile(path, 'utf8')));
}

await edit('transport/inbound.js', (source) => {
    source = replaceOnce(source,
        "        // Chat-only safe inbound errors v1.\n        logger.warn('whenIdle/followup rejected');",
        '        logger.warn(`whenIdle/followup rejected: ${err instanceof Error ? err.message : String(err)}`);', 'safe inbound log');
    if (recoveryV1Only) return source;
    source = replaceOnce(source,
        "import { finishContentRiskRecovery, getHistorySnapshot, isHistorySnapshotCurrent, registerRecoveryContext } from '/opt/qqbot-defaults/qqbot-session-recovery.mjs';\n",
        '', 'inbound recovery import');
    source = replaceOnce(source, [
        '    // Chat-only group-history epoch guard v1.',
        '    const historySnapshot = getHistorySnapshot(mwState.history);',
        '    if (historySnapshot && !isHistorySnapshotCurrent(mwState.history)) mwState.history = [];',
    ].join('\n'), '', 'inbound history epoch guard');
    const contextBlocks = ['', '        '].map((indent) => [
        `${indent}// Chat-only content-risk recovery context v1.`,
        '        registerRecoveryContext(documentTurn, { manager, scope, peerId, appId: config.appId, record, agent: chatOnlyAgent, sessionId: record.sessionId, replyTarget, historySnapshot, logger });',
        '',
    ].join('\n'));
    const matchingContextBlocks = contextBlocks.filter((block) => source.includes(`\n${block}`));
    if (matchingContextBlocks.length !== 1) throw new Error('pre-recovery fixture expected one supported inbound recovery context layout');
    source = replaceOnce(source, matchingContextBlocks[0], '', 'inbound recovery context');
    return replaceOnce(source,
        '        if (documentTurn) await finishContentRiskRecovery(documentTurn);\n',
        '', 'inbound recovery completion');
});

await edit('transport/outbound.js', (source) => {
    source = replaceOnce(source,
        '                this.logger.error(`im-qqbot: ${tag} failed to send reply`);',
        '                this.logger.error(`im-qqbot: ${tag} failed: ${err instanceof Error ? err.message : String(err)}`);', 'safe outbound log');
    source = replaceOnce(source,
        "import { formatProviderFailure, formatToolFailure } from '/opt/qqbot-defaults/qqbot-provider-errors.mjs';\n",
        '', 'friendly errors import');
    source = replaceOnce(source, '                this.onToolResult(record, event, raw);',
        '                this.onToolResult(record, event);', 'friendly tool dispatch');
    source = replaceOnce(source,
        '    onToolResult(record, event, raw) {\n        // Chat-only friendly provider errors v1.',
        '    onToolResult(record, event) {', 'friendly tool handler');
    source = replaceOnce(source, [
        '        const resultBlocks = raw?.data?.message?.content;',
        "        const failed = event.error !== undefined || (Array.isArray(resultBlocks) && resultBlocks.some((block) => block?.type === 'tool-result' && block.isError === true));",
        '        if (failed) {',
        "            void this.send(record, formatToolFailure(), 'sendToolResultError');",
        '            return;',
        '        }',
        '        if (!this.config.showToolResults)',
        '            return;',
    ].join('\n'), [
        '        if (event.error === undefined && !this.config.showToolResults)',
        '            return;',
    ].join('\n'), 'friendly tool gate');
    source = replaceOnce(source,
        "                void this.send(record, formatProviderFailure(failure), 'sendTurnEndError');",
        '                void this.send(record, `⚠️ 本轮异常结束\\n\\`${failure.code}\\`: ${failure.message}`, \'sendTurnEndError\');', 'friendly turn notice');
    if (recoveryV1Only) return source;
    source = replaceOnce(source,
        "import { isContentRiskFailure, markContentRiskFailure, noteRecoveryTurnStart } from '/opt/qqbot-defaults/qqbot-session-recovery.mjs';\n",
        '', 'outbound recovery import');
    source = replaceOnce(source, [
        '    route(session, raw) {',
        '        // Chat-only content-risk turn recovery v1.',
        "        if (raw?.type === 'turn/start') {",
        '            const sessionId = session.header.id;',
        '            const startRecord = this.manager.findBySessionId(sessionId);',
        '            if (startRecord) noteRecoveryTurnStart({ record: startRecord, sessionId, turnId: raw.data?.turn });',
        '            return;',
        '        }',
        '        const event = parseEvent(raw);',
    ].join('\n'), [
        '    route(session, raw) {',
        '        const event = parseEvent(raw);',
    ].join('\n'), 'outbound turn/start binding');
    source = replaceOnce(source,
        '                this.onTurnEnd(session.header.id, record, event, raw.data?.turn);',
        '                this.onTurnEnd(session.header.id, record, event);', 'outbound turn/end binding');
    const start = source.indexOf('    onTurnEnd(sessionId, record, event, turnId) {');
    const end = source.indexOf('    /** 统一发送：切分 + 逐 chunk 发送 + 错误记录 */', start);
    if (start < 0 || end < 0) throw new Error('pre-recovery fixture expected the content-risk onTurnEnd handler');
    const originalHandler = [
        '    onTurnEnd(sessionId, record, event) {',
        '        const buffer = this.buffers.get(sessionId);',
        '        if (buffer !== undefined) {',
        '            if (buffer.text.trim()) {',
        '                void buffer.flush();',
        '            }',
        '            else {',
        '                buffer.cancel();',
        '            }',
        '            this.buffers.delete(sessionId);',
        '        }',
        '        const failure = extractTurnError(event.reason);',
        "        if (failure !== undefined && !SILENT_TURN_ERROR_CODES.has(failure.code)) {",
        '            void this.send(record, `⚠️ 本轮异常结束\\n\\`${failure.code}\\`: ${failure.message}`, \'sendTurnEndError\');',
        '        }',
        '        this.logger.debug(`im-qqbot: turn/end sessionId=${sessionId}`);',
        '    }',
    ].join('\n');
    return source.slice(0, start) + originalHandler + '\n' + source.slice(end);
});

await edit('transport/events.js', (source) => replaceOnce(source, [
    '        // Chat-only structured provider failures v1.',
    '        status: detail?.status ?? reason.status,',
    '        type: detail?.type ?? reason.type,',
    '        error: detail?.error,',
].join('\n'), '', 'structured event error fields'));

if (!recoveryV1Only) {
await edit('model/prefs-store.js', (source) => {
    source = replaceOnce(source, [
        "import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';",
        "import { randomUUID } from 'node:crypto';",
        "import { resolve, dirname } from 'node:path';",
        "import { homedir } from 'node:os';",
    ].join('\n'), [
        "import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';",
        "import { resolve, dirname } from 'node:path';",
        "import { homedir } from 'node:os';",
    ].join('\n'), 'PrefsStore imports');
    const constructorStart = source.indexOf('    constructor(debugLog) {');
    const constructorEnd = source.indexOf('    // ── Override 操作 ──', constructorStart);
    if (constructorStart < 0 || constructorEnd < 0 || !source.slice(constructorStart, constructorEnd).includes('// Chat-only persistent model prefs v1.'))
        throw new Error('pre-recovery fixture expected persistent PrefsStore constructor');
    const originalConstructor = [
        '    constructor(debugLog) {',
        "        this.prefsPath = resolve(homedir(), '.dsh-qqbot', 'model-prefs.json');",
        '        this.debugLog = debugLog;',
        '        this.load();',
        '    }',
        '',
    ].join('\n');
    source = source.slice(0, constructorStart) + originalConstructor + source.slice(constructorEnd);
    source = replaceOnce(source, [
        '    setSessionId(sessionKey, sessionId, options = {}) {',
        '        const hadPrevious = this.sessionIds.has(sessionKey);',
        '        const previous = this.sessionIds.get(sessionKey);',
        '        this.sessionIds.set(sessionKey, sessionId);',
        '        const written = this.write();',
        '        if (options?.strict && !written) {',
        '            if (hadPrevious) this.sessionIds.set(sessionKey, previous);',
        '            else this.sessionIds.delete(sessionKey);',
        "            throw new Error('Unable to persist automatic session reset.');",
        '        }',
        '        return written;',
        '    }',
    ].join('\n'), [
        '    setSessionId(sessionKey, sessionId) {',
        '        this.sessionIds.set(sessionKey, sessionId);',
        '        this.write();',
        '    }',
    ].join('\n'), 'PrefsStore strict setter');
    const writeStart = source.indexOf('    write() {');
    const classEnd = source.indexOf('\n}\n//# sourceMappingURL', writeStart);
    if (writeStart < 0 || classEnd < 0 || !source.slice(writeStart, classEnd).includes('renameSync(tempPath, this.prefsPath);'))
        throw new Error('pre-recovery fixture expected atomic PrefsStore.write()');
    const originalWrite = [
        '    write() {',
        '        try {',
        '            mkdirSync(dirname(this.prefsPath), { recursive: true });',
        '            const data = {',
        '                overrides: Object.fromEntries(this.overrides.entries()),',
        '                sessionIds: Object.fromEntries(this.sessionIds.entries()),',
        '                presets: Object.fromEntries(this.presets.entries()),',
        '            };',
        "            writeFileSync(this.prefsPath, JSON.stringify(data, null, 2), 'utf8');",
        '        }',
        '        catch (err) {',
        '            this.debugLog?.(`writePrefs failed: ${err instanceof Error ? err.message : String(err)}`);',
        '        }',
        '    }',
    ].join('\n');
    return source.slice(0, writeStart) + originalWrite + source.slice(classEnd);
});

await edit('model/model-resolver.js', (source) => replaceOnce(source, [
    '    // Chat-only strict sessionId persistence v1.',
    '    setSessionId(sessionKey, sessionId, options) {',
    '        return this.prefs.setSessionId(sessionKey, sessionId, options);',
    '    }',
].join('\n'), [
    '    setSessionId(sessionKey, sessionId) {',
    '        this.prefs.setSessionId(sessionKey, sessionId);',
    '    }',
].join('\n'), 'ModelResolver strict setter'));

await edit('session/session-manager.js', (source) => {
    const start = source.indexOf('    // Chat-only strict automatic session reset v1.');
    const end = source.indexOf('    /**\n     * 原地压缩当前会话历史', start);
    if (start < 0 || end < 0) throw new Error('pre-recovery fixture expected strict SessionManager.remove()');
    const originalRemove = [
        '    async remove(scope, peerId) {',
        '        const key = this.sessionKey(scope, peerId);',
        '        const record = this.sessions.get(key);',
        '        this.modelResolver.setSessionId(key, randomUUID());',
        '        if (!record)',
        '            return;',
        '        this.sessions.delete(key);',
        "        record.agent.cancel({ kind: 'user' });",
        '        await record.handle.dispose().catch(() => { });',
        '        this.logger.info(`session removed: key=${key}`);',
        '    }',
        '',
    ].join('\n');
    return source.slice(0, start) + originalRemove + source.slice(end);
});
} else {
    await edit('session/session-manager.js', (source) => replaceOnce(source, [
        '            // Chat-only committed reset disposal v1.',
        "            try { await record.handle.dispose(); } catch { this.logger.warn('automatic session reset disposal failed'); }",
    ].join('\n'), '            await record.handle.dispose().catch(() => { });', 'committed safe disposal'));
}

process.stdout.write('Prepared pre-recovery adapter volume fixture.\n');
