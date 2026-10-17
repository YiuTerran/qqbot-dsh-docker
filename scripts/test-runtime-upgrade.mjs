import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, writeFile, readdir, rm, symlink, chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { migrateProfileRuntime } from '/usr/local/lib/migrate-profile-runtime.mjs';

const execute = promisify(execFile);
const legacy = process.env.QQBOT_LEGACY_PROFILE;
if (!legacy) throw new Error('QQBOT_LEGACY_PROFILE must name the actual v0.17.0 image seed, not a relabeled fixture.');
const seed = '/opt/dsh-seed/profiles/qqbot';
const pkg = 'node_modules/@tencent-connect/dsh-qqbot/package.json';
const version = async profile => JSON.parse(await readFile(join(profile, pkg), 'utf8')).version;
assert.equal(await version(legacy), '0.5.0');

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'qqbot-runtime-upgrade-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const profile = join(root, 'profile');
    await cp(legacy, profile, { recursive: true, verbatimSymlinks: true });
    await writeFile(join(root, 'AGENTS.md'), 'custom persona\n');
    await chmod(join(root, 'AGENTS.md'), 0o444);
    await writeFile(join(profile, 'custom-config.yml'), 'custom: true\n');
    await rm(join(profile, 'cordis.patch.yml'));
    await symlink('custom-config.yml', join(profile, 'cordis.patch.yml'));
    await mkdir(join(root, 'sessions'));
    await writeFile(join(root, 'sessions', 'old-session.jsonl'), 'historical session sentinel\n');
    await writeFile(join(profile, 'model-preferences.json'), '{"model":"custom-model"}\n');
    return { root, profile };
}
async function preserved({ root, profile }) {
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'custom persona\n');
    assert.equal((await lstat(join(root, 'AGENTS.md'))).mode & 0o777, 0o444);
    assert.ok((await lstat(join(profile, 'cordis.patch.yml'))).isSymbolicLink());
    assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), 'custom: true\n');
    assert.equal(await readFile(join(profile, 'model-preferences.json'), 'utf8'), '{"model":"custom-model"}\n');
    assert.equal(await readFile(join(root, 'sessions', 'old-session.jsonl'), 'utf8'), 'historical session sentinel\n');
}
const childCode = `import { migrateProfileRuntime } from '/usr/local/lib/migrate-profile-runtime.mjs';
await migrateProfileRuntime(process.env.PROFILE, process.env.SEED, {
 checkpoint(point) { if (point === process.env.CRASH_AT) process.kill(process.pid, 'SIGKILL'); }
});`;
const child = (profile, crashAt = '') => execute(process.execPath, ['--input-type=module', '-e', childCode], {
    env: { ...process.env, PROFILE: profile, SEED: seed, CRASH_AT: crashAt }, timeout: 60_000,
});

test('real old dependency tree upgrades offline, preserves user state and retains a rollback copy', async t => {
    const f = await fixture(t);
    assert.equal(await migrateProfileRuntime(f.profile, seed), true);
    assert.equal(await version(f.profile), '0.5.2');
    assert.equal(JSON.parse(await readFile(join(f.profile, 'node_modules/@tencent-connect/qqbot-nodejs/package.json'))).version, '1.0.5');
    const backups = (await readdir(f.profile)).filter(name => name.startsWith('.qqbot-runtime-backup-'));
    assert.equal(backups.length, 1);
    assert.equal(await version(join(f.profile, backups[0])), '0.5.0');
    assert.equal(await migrateProfileRuntime(f.profile, seed), false);
    assert.equal((await readdir(f.profile)).filter(name => name.startsWith('.qqbot-runtime-backup-')).length, 1);
    await preserved(f);
});
for (const point of ['prepared', ...['node_modules', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
    .flatMap(file => [`saved:${file}`, `installed:${file}`])]) {
    test(`SIGKILL at ${point} is recovered before the next upgrade`, async t => {
        const f = await fixture(t);
        await assert.rejects(child(f.profile, point), error => error.signal === 'SIGKILL');
        await child(f.profile);
        assert.equal(await version(f.profile), '0.5.2');
        await preserved(f);
    });
}
test('validation failure restores dependencies before returning', async t => {
    const f = await fixture(t);
    await assert.rejects(migrateProfileRuntime(f.profile, seed, { checkpoint(point) {
        if (point === 'installed:package.json') throw new Error('injected failure');
    } }), /injected failure/u);
    assert.equal(await version(f.profile), '0.5.0');
    assert.equal(JSON.parse(await readFile(join(f.profile, 'package.json'))).dependencies['@tencent-connect/dsh-qqbot'], '0.5.0');
    await preserved(f);
});
test('concurrent migrations serialize and commit once', async t => {
    const f = await fixture(t);
    await Promise.all([child(f.profile), child(f.profile)]);
    assert.equal(await version(f.profile), '0.5.2');
    assert.equal((await readdir(f.profile)).filter(name => name.startsWith('.qqbot-runtime-backup-')).length, 1);
});
for (const kind of ['custom-dependency', 'custom-workspace', 'unknown-version', 'unknown-layout', 'foreign-core']) {
    test(`${kind} stops without changing dependency versions or user data`, async t => {
        const f = await fixture(t);
        if (kind === 'custom-dependency') {
            const path = join(f.profile, 'package.json');
            const manifest = JSON.parse(await readFile(path));
            manifest.dependencies['custom-plugin'] = '1.0.0';
            await writeFile(path, JSON.stringify(manifest));
        } else if (kind === 'custom-workspace') await writeFile(join(f.profile, 'pnpm-workspace.yaml'), 'nodeLinker: isolated\n');
        else if (kind === 'unknown-version') {
            const path = join(f.profile, pkg);
            const manifest = JSON.parse(await readFile(path));
            manifest.version = '0.4.9';
            await writeFile(path, JSON.stringify(manifest));
        } else if (kind === 'unknown-layout') await writeFile(join(f.profile, 'node_modules/@tencent-connect/dsh-qqbot/dist/index.js'), '// unknown layout\n');
        else await mkdir(join(f.profile, 'node_modules/@deepseek-ai'));
        const before = await readFile(join(f.profile, 'package.json'), 'utf8');
        await assert.rejects(migrateProfileRuntime(f.profile, seed));
        assert.equal(await readFile(join(f.profile, 'package.json'), 'utf8'), before);
        assert.equal((await readdir(f.profile)).filter(name => name.startsWith('.qqbot-runtime-backup-')).length, 0);
        await preserved(f);
    });
}
