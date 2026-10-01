// Offline rolling quota, concurrency, persistence, and fail-closed regressions.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const quotaUrl = process.env.QQBOT_GENERATION_QUOTA_MODULE
    ?? new URL('../defaults/qqbot-generation-quotas.mjs', import.meta.url).href;
const { createGenerationQuota } = await import(quotaUrl);

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-generation-quota-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return { directory, path: join(directory, 'quota.json') };
}

test('hourly reservations persist across store instances and contain only hashed identities and timestamps', async (t) => {
    const { path } = await fixture(t);
    let now = 1_800_000_000_000;
    const limits = { imageHourlyLimit: 2, markdownHourlyLimit: 3 };
    const first = createGenerationQuota({ path, appId: 'app-fixture', limits, now: () => now });
    assert.deepEqual(await first.reserve({ ownerId: 'openid-same-user', type: 'image' }), { ok: true });
    assert.deepEqual(await first.reserve({ ownerId: 'openid-same-user', type: 'image' }), { ok: true });
    assert.deepEqual(await first.reserve({ ownerId: 'openid-same-user', type: 'image' }), { ok: false, reason: 'quota' });
    assert.deepEqual(await first.reserve({ ownerId: 'openid-same-user', type: 'markdown' }), { ok: true },
        'image and Markdown have independent rolling limits');

    const persisted = await readFile(path, 'utf8');
    assert.ok(!persisted.includes('openid-same-user'));
    assert.match(persisted, /"version":1/u);
    assert.match(persisted, /"image":\[1800000000000,1800000000000\]/u);
    assert.equal((await stat(path)).mode & 0o777, 0o600, 'atomic quota state has owner-only permissions');
    assert.deepEqual((await readdir(join(path, '..'))).sort(), ['quota.json'], 'temporary atomic-write files are removed');

    const restarted = createGenerationQuota({ path, appId: 'app-fixture', limits, now: () => now });
    assert.deepEqual(await restarted.reserve({ ownerId: 'openid-same-user', type: 'image' }), { ok: false, reason: 'quota' },
        'restarting the process does not clear the stored hourly quota');
    assert.deepEqual(await restarted.reserve({ ownerId: 'different-user', type: 'image' }), { ok: true });

    const separateApp = createGenerationQuota({ path, appId: 'different-app', limits, now: () => now });
    assert.deepEqual(await separateApp.reserve({ ownerId: 'openid-same-user', type: 'image' }), { ok: true },
        'user keys include the QQ application identity');
});

test('rolling windows expire timestamps at the exact one-hour boundary', async (t) => {
    const { path } = await fixture(t);
    let now = 1_000;
    const quota = createGenerationQuota({ path, appId: 'app-fixture', limits: { imageHourlyLimit: 1 }, now: () => now });
    assert.deepEqual(await quota.reserve({ ownerId: 'member-a', type: 'image' }), { ok: true });
    now += 60 * 60 * 1000;
    assert.deepEqual(await quota.reserve({ ownerId: 'member-a', type: 'image' }), { ok: true });
    assert.deepEqual(await quota.reserve({ ownerId: 'member-a', type: 'image' }), { ok: false, reason: 'quota' });
});

test('concurrent reservations serialize atomically and only one caller spends the last quota', async (t) => {
    const { path } = await fixture(t);
    const quota = createGenerationQuota({ path, appId: 'app-fixture', limits: { imageHourlyLimit: 1 } });
    const results = await Promise.all(Array.from({ length: 12 }, () => quota.reserve({ ownerId: 'member-a', type: 'image' })));
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => result.reason === 'quota').length, 11);
    assert.ok(results.every((result) => result.ok || result.reason === 'quota'));
});

test('per-user and instance concurrency caps reject immediately and release idempotently', async () => {
    const quota = createGenerationQuota({
        appId: 'app-fixture',
        limits: { imageConcurrent: 2, markdownConcurrent: 1 },
    });
    const first = quota.tryAcquire({ ownerId: 'member-a', type: 'image' });
    assert.equal(first.ok, true);
    assert.deepEqual(quota.tryAcquire({ ownerId: 'member-a', type: 'image' }), { ok: false, reason: 'busy' },
        'one user cannot occupy two image slots');
    const second = quota.tryAcquire({ ownerId: 'member-b', type: 'image' });
    assert.equal(second.ok, true);
    assert.deepEqual(quota.tryAcquire({ ownerId: 'member-c', type: 'image' }), { ok: false, reason: 'busy' },
        'the process image-slot limit applies across owners');
    const markdown = quota.tryAcquire({ ownerId: 'member-a', type: 'markdown' });
    assert.equal(markdown.ok, true, 'image and Markdown concurrency are independent');
    first.release();
    first.release();
    const third = quota.tryAcquire({ ownerId: 'member-a', type: 'image' });
    assert.equal(third.ok, true);
    third.release();
    second.release();
    markdown.release();
});

test('corrupt, unknown-version, and symlinked quota state fail closed without overwriting it', async (t) => {
    const { directory, path } = await fixture(t);
    const quota = createGenerationQuota({ path, appId: 'app-fixture' });
    await writeFile(path, '{broken-json', 'utf8');
    assert.deepEqual(await quota.reserve({ ownerId: 'member-a', type: 'image' }), { ok: false, reason: 'state' });
    assert.equal(await readFile(path, 'utf8'), '{broken-json', 'corruption is preserved for operator recovery');

    await writeFile(path, JSON.stringify({ version: 99, entries: [] }), 'utf8');
    assert.deepEqual(await quota.reserve({ ownerId: 'member-a', type: 'image' }), { ok: false, reason: 'state' });

    const oversizedState = Buffer.alloc(1024 * 1024 + 1, 0x20);
    await writeFile(path, oversizedState);
    assert.deepEqual(await quota.reserve({ ownerId: 'member-a', type: 'image' }), { ok: false, reason: 'state' });
    assert.deepEqual(await readFile(path), oversizedState, 'oversized state is neither parsed nor overwritten');

    await rm(path);
    const outside = join(directory, 'outside.json');
    await writeFile(outside, JSON.stringify({ version: 1, entries: [] }), 'utf8');
    await symlink(outside, path);
    assert.deepEqual(await quota.reserve({ ownerId: 'member-a', type: 'image' }), { ok: false, reason: 'state' });
    assert.deepEqual(JSON.parse(await readFile(outside, 'utf8')), { version: 1, entries: [] },
        'symlink target is never read or overwritten');
});

test('an unavailable store or invalid identity fails closed without charging', async (t) => {
    const { directory } = await fixture(t);
    const unavailable = createGenerationQuota({ path: join(directory, 'missing', 'quota.json'), appId: 'app-fixture' });
    assert.deepEqual(await unavailable.reserve({ ownerId: 'member-a', type: 'markdown' }), { ok: false, reason: 'state' });

    const existing = createGenerationQuota({ path: join(directory, 'valid.json'), appId: 'app-fixture' });
    assert.throws(() => existing.tryAcquire({ ownerId: '', type: 'image' }));
    assert.throws(() => existing.reserve({ ownerId: 'member-a', type: 'unknown' }));
    assert.deepEqual(await existing.reserve({ ownerId: 'member-a', type: 'markdown' }), { ok: true });
});
