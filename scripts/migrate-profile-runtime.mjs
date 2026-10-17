// Offline replacement of image-managed dependencies only. User state never enters the transaction.
import { cp, mkdir, readFile, writeFile, rename, rm, lstat, readdir, lchown, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const files = ['node_modules', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
const plugin = '@tencent-connect/dsh-qqbot';
const sdk = '@tencent-connect/qqbot-nodejs';
const targetVersion = '0.5.2';
const supported = new Set(['0.5.0', targetVersion]);
const journalName = '.qqbot-runtime-migration.json';
const exists = async path => { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } };
const json = async path => JSON.parse(await readFile(path, 'utf8'));

async function withRuntimeLock(profile, operation) {
    // flock(2) belongs to the open file description, shared with child fd 3.
    // Keep the parent handle open after flock exits: no PID records, helper process,
    // or stale-lock cleanup is needed, even across container namespaces or SIGKILL.
    const lock = join(profile, '.qqbot-runtime.lock');
    const handle = await open(lock, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
        await new Promise((acquired, reject) => {
            const holder = spawn('flock', ['--exclusive', '--timeout', '120', '3'],
                { stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
            holder.once('error', reject);
            holder.once('close', code => code === 0 ? acquired()
                : reject(new Error(`Cannot acquire QQ runtime migration lock (exit ${code}).`)));
        });
        return await operation();
    } finally { await handle.close(); }
}

async function regular(path, directory = false) {
    const stat = await exists(path);
    if (!stat || stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
        throw new Error(`Managed runtime requires a real ${directory ? 'directory' : 'file'}: ${path}`);
    }
    return stat;
}
async function durableJson(path, value) {
    const temporary = `${path}.tmp`;
    const handle = await open(temporary, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
}
function checkManifest(manifest) {
    if (manifest.name !== 'dsh-profile-qqbot' || manifest.private !== true
        || Object.keys(manifest.dependencies ?? {}).join() !== plugin
        || !supported.has(manifest.dependencies[plugin])
        || ['devDependencies', 'optionalDependencies', 'peerDependencies'].some(key => Object.keys(manifest[key] ?? {}).length)
        || manifest.pnpm !== undefined
        || JSON.stringify(manifest.dsh?.profile?.bundles) !== JSON.stringify(['@deepseek-ai/dsh-base', plugin])) {
        throw new Error('Unrecognized or customized QQ profile dependency manifest; preserve the volume and migrate custom dependencies separately.');
    }
}
async function checkWorkspace(profile, seed) {
    const require = createRequire(join(seed, 'package.json'));
    const yaml = require('js-yaml');
    const config = yaml.load(await readFile(join(profile, 'pnpm-workspace.yaml'), 'utf8'));
    if (!config || JSON.stringify(config.packages) !== '["."]' || config.nodeLinker !== 'hoisted'
        || config.autoInstallPeers !== false
        || Object.keys(config).some(key => !['packages', 'nodeLinker', 'autoInstallPeers', 'overrides'].includes(key))
        || (config.overrides !== undefined && (Object.keys(config.overrides).join() !== sdk || config.overrides[sdk] !== '1.0.5'))) {
        throw new Error('Unrecognized QQ profile workspace settings; refusing to overwrite custom dependency policy.');
    }
}
async function checkRuntime(profile, version) {
    for (const file of files) await regular(join(profile, file), file === 'node_modules');
    const installed = await json(join(profile, 'node_modules', plugin, 'package.json'));
    if (installed.version !== version) throw new Error('QQ profile manifest and installed adapter version disagree.');
    const installedSdk = await json(join(profile, 'node_modules', sdk, 'package.json'));
    if (!(version === targetVersion ? installedSdk.version === '1.0.5' : ['1.0.4', '1.0.5'].includes(installedSdk.version))) {
        throw new Error('Unrecognized QQ SDK version; refusing to guess an upgrade.');
    }
    const peers = join(profile, 'node_modules/@deepseek-ai');
    const peerStat = await exists(peers);
    if (peerStat && (!peerStat.isSymbolicLink()
        || await realpath(peers) !== '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')) {
        throw new Error('Profile-local DSH core dependencies are unsupported; use the image-owned runtime.');
    }
    const dist = join(profile, 'node_modules', plugin, 'dist');
    for (const [file, anchor] of [['index.js', 'export async function apply(ctx, config) {'],
        ['gateway/bootstrap.js', 'export async function bootstrapGateway(ctx, agents, config, logger) {'],
        ['transport/inbound.js', 'export async function handleInbound(']]) {
        await regular(join(dist, file));
        if ((await readFile(join(dist, file), 'utf8')).split(anchor).length !== 2) throw new Error('Unrecognized QQ adapter source layout.');
    }
}
async function ownership(path, owner) {
    const stat = await lstat(path);
    if (stat.isDirectory()) for (const name of await readdir(path)) await ownership(join(path, name), owner);
    if (process.getuid?.() === 0) await lchown(path, owner.uid, owner.gid);
}
function validateStage(stage) {
    const dist = join(stage, 'node_modules', plugin, 'dist');
    for (const script of ['enforce-chat-only.mjs', 'instrument-qqbot-startup.mjs']) {
        execFileSync(process.execPath, [join('/usr/local/lib', script), dist], { stdio: 'pipe' });
    }
    for (const file of ['index.js', 'gateway/bootstrap.js', 'transport/inbound.js']) {
        execFileSync(process.execPath, ['--check', join(dist, file)], { stdio: 'pipe' });
    }
}
async function recover(profile) {
    const path = join(profile, journalName);
    if (!await exists(path)) return;
    await regular(path);
    const journal = await json(path);
    if (journal.version !== 1 || !['preparing', 'swapping', 'restored', 'committed'].includes(journal.phase)
        || !/^\.qqbot-runtime-stage-[0-9a-f-]{36}$/.test(journal.stage ?? '')
        || !/^\.qqbot-runtime-backup-[0-9a-f-]{36}$/.test(journal.backup ?? '')) throw new Error('Unrecognized runtime migration journal; manual recovery required.');
    const backup = join(profile, journal.backup);
    if (journal.phase === 'swapping') {
        await regular(backup, true);
        for (const file of files) {
            if (await exists(join(backup, file))) {
                await rm(join(profile, file), { force: true, recursive: true });
                await rename(join(backup, file), join(profile, file));
            }
        }
        journal.phase = 'restored';
        await durableJson(path, journal);
        console.log('[entrypoint] Restored interrupted QQ dependency migration');
    }
    await rm(join(profile, journal.stage), { force: true, recursive: true });
    // A completed backup stays available for operator inspection; it is not a data-volume snapshot.
    if (journal.phase !== 'committed') await rm(backup, { force: true, recursive: true });
    await rm(path);
}

export async function migrateProfileRuntime(profilePath, seedPath, { checkpoint = () => {} } = {}) {
    const profile = resolve(profilePath);
    const seed = resolve(seedPath);
    await regular(profile, true);
    if (await realpath(profile) !== profile) throw new Error('QQ profile path must not traverse symlinks.');
    return withRuntimeLock(profile, async () => {
        await recover(profile);
        const manifest = await json(join(profile, 'package.json'));
        checkManifest(manifest);
        await checkWorkspace(profile, seed);
        await checkRuntime(profile, manifest.dependencies[plugin]);
        await checkRuntime(seed, targetVersion);
        if (manifest.dependencies[plugin] === targetVersion) return false;
        const token = randomUUID();
        const journal = { version: 1, phase: 'preparing', stage: `.qqbot-runtime-stage-${token}`, backup: `.qqbot-runtime-backup-${token}` };
        const path = join(profile, journalName);
        const stage = join(profile, journal.stage);
        const backup = join(profile, journal.backup);
        await durableJson(path, journal);
        try {
            await mkdir(stage, { mode: 0o700 });
            await mkdir(backup, { mode: 0o700 });
            for (const file of files) await cp(join(seed, file), join(stage, file), { recursive: true, verbatimSymlinks: true });
            // Keep all non-dependency metadata of a recognized profile.
            manifest.dependencies[plugin] = targetVersion;
            await writeFile(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
            await checkRuntime(stage, targetVersion);
            validateStage(stage);
            await ownership(stage, await lstat(join(seed, 'node_modules')));
            await checkpoint('prepared');
            journal.phase = 'swapping';
            await durableJson(path, journal);
            for (const file of files) {
                await rename(join(profile, file), join(backup, file));
                await checkpoint(`saved:${file}`);
                await rename(join(stage, file), join(profile, file));
                await checkpoint(`installed:${file}`);
            }
            await checkRuntime(profile, targetVersion);
            journal.phase = 'committed';
            await durableJson(path, journal);
            await recover(profile);
            console.log(`[entrypoint] QQ dependencies upgraded to ${targetVersion}; previous dependency files retained in ${basename(backup)}`);
            return true;
        } catch (error) {
            await recover(profile);
            throw error;
        }
    });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.length !== 4) throw new Error('usage: migrate-profile-runtime.mjs <persistent-profile> <image-seed-profile>');
    await migrateProfileRuntime(process.argv[2], process.argv[3]);
}
