// Run inside an existing image with current defaults/enforcer bind-mounted.
// QQBOT_ADAPTER_DIST must point to an already-current patched adapter.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const sourceDist = process.env.QQBOT_ADAPTER_DIST;
const integration = sourceDist ? test : test.skip;
const enforcer = process.env.QQBOT_ENFORCER_SCRIPT ?? '/usr/local/lib/enforce-chat-only.mjs';
const fixture = process.env.QQBOT_PRE_RECOVERY_FIXTURE
    ?? fileURLToPath(new URL('./prepare-pre-recovery-fixture.mjs', import.meta.url));

async function run(script, args = []) {
    return execute(process.execPath, [script, ...args], { timeout: 30_000, maxBuffer: 256 * 1024 });
}

async function isolatedAdapter(t) {
    const temporary = await mkdtemp(join(tmpdir(), 'qqbot-recovery-upgrade-'));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const copiedDist = join(temporary, 'dist');
    await cp(resolve(sourceDist), copiedDist, { recursive: true });
    await cp(join(dirname(resolve(sourceDist)), 'package.json'), join(temporary, 'package.json'));
    return copiedDist;
}

async function hashes(root, relative = '') {
    const result = {};
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        const name = join(relative, entry.name);
        if (entry.isDirectory()) Object.assign(result, await hashes(root, name));
        else if (entry.isSymbolicLink()) result[name] = `symlink:${await readlink(join(root, name))}`;
        else result[name] = createHash('sha256').update(await readFile(join(root, name))).digest('hex');
    }
    return result;
}

async function assertCurrentPatch(root) {
    const expected = {
        'transport/inbound.js': [
            '// Chat-only content-risk recovery context v1.',
            '// Chat-only group-history epoch guard v1.',
            '// Chat-only safe inbound errors v1.',
            'if (documentTurn) await finishContentRiskRecovery(documentTurn);',
        ],
        'transport/outbound.js': [
            '// Chat-only content-risk turn recovery v1.',
            '// Chat-only friendly provider errors v1.',
            "void this.send(record, formatProviderFailure(failure), 'sendTurnEndError');",
            "void this.send(record, formatToolFailure(), 'sendToolResultError');",
        ],
        'transport/events.js': ['// Chat-only structured provider failures v1.'],
        'model/prefs-store.js': ['// Chat-only persistent model prefs v1.'],
        'model/model-resolver.js': ['// Chat-only strict sessionId persistence v1.'],
        'session/session-manager.js': [
            '// Chat-only strict automatic session reset v1.',
            '// Chat-only committed reset disposal v1.',
            'recoveryOptions.onCommitted?.(record)',
        ],
    };
    for (const [file, markers] of Object.entries(expected)) {
        const content = await readFile(join(root, file), 'utf8');
        for (const marker of markers) assert.equal(content.split(marker).length, 2, `${file}: exactly one ${marker}`);
        await run('--check', [join(root, file)]);
    }
}

for (const version of ['pre-recovery', 'recovery-v1']) {
    integration(`${version} adapter upgrades completely and a second patch pass changes no file hashes`, async (t) => {
        const root = await isolatedAdapter(t);
        await run(fixture, [root, ...(version === 'recovery-v1' ? ['recovery-v1'] : [])]);
        const before = await hashes(root);
        await run(enforcer, [root]);
        await assertCurrentPatch(root);
        const upgraded = await hashes(root);
        assert.notDeepEqual(upgraded, before, 'the old layout was actually upgraded');
        await run(enforcer, [root]);
        assert.deepEqual(await hashes(root), upgraded, 'the full dist is byte-for-byte unchanged on repeat startup');
    });
}

integration('a partial committed callback fails strict validation without changing any dist file', async (t) => {
    const root = await isolatedAdapter(t);
    const managerPath = join(root, 'session/session-manager.js');
    const manager = await readFile(managerPath, 'utf8');
    const callback = '            try { recoveryOptions.onCommitted?.(record); } catch { }';
    assert.equal(manager.split(callback).length, 2, 'fixture begins with exactly one committed callback');
    await writeFile(managerPath, manager.replace(callback, ''));
    const before = await hashes(root);
    await assert.rejects(run(enforcer, [root]), (error) => {
        assert.notEqual(error.code, 0);
        assert.match(error.stderr, /strict session reset atomic commit ordering is incomplete/u);
        return true;
    });
    assert.deepEqual(await hashes(root), before, 'strict rejection performs zero adapter writes');
});
