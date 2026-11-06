import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

// Supply an unpatched @tencent-connect/dsh-qqbot@0.5.5 package directory.
const source = process.argv[2];
assert.ok(source, 'usage: test-qqbot-055-patches.mjs <qqbot-package-directory>');
const scripts = fileURLToPath(new URL('.', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'qqbot-055-patches-'));
try {
    const pkg = join(temp, 'package');
    await cp(resolve(source), pkg, { recursive: true });
    const lib = join(pkg, 'lib');
    const apply = () => {
        for (const script of ['enforce-chat-only.mjs', 'instrument-qqbot-startup.mjs'])
            execFileSync(process.execPath, [join(scripts, script), lib]);
    };
    const snapshot = async () => {
        const files = await readdir(lib, { recursive: true });
        const result = {};
        for (const file of files.filter(file => file.endsWith('.js')).sort()) {
            result[file] = await readFile(join(lib, file), 'utf8');
            execFileSync(process.execPath, ['--check', join(lib, file)]);
        }
        return result;
    };
    apply();
    const first = await snapshot();
    apply();
    assert.deepEqual(await snapshot(), first, 'patches must be byte-idempotent');
    const gateway = first['gateway/bootstrap.js'];
    const outbound = first['transport/outbound.js'];
    assert.ok(!gateway.includes('DeliverablesDeliverer'));
    assert.ok(!outbound.includes("case 'deliverables/presented':"));
    assert.ok(!outbound.includes('this.deliverer.deliver('));
    assert.ok(!gateway.includes('    registerSendFileTool(ctx,'));
    assert.ok(gateway.includes('registerGenerationTools(ctx,'), 'dedicated generation tools remain');
    assert.ok(first['session/session-manager.js'].includes('mintSessionId(), { strict: true }'));
    assert.ok(first['model/prefs-store.js'].includes('this.mergeDisk(this.readDiskState())'));
    assert.ok(first['model/prefs-store.js'].includes('if (wasDeleted) this.deleted.sessionIds.add(sessionKey)'));
    assert.ok(first['transport/outbound-buffer.js'].includes('this.sourceRedactor = createImageSourceRedactor();'));

    // Exercise the actual patched transient-stream method without loading optional
    // runtime services. A stale frame must never inherit another batch's target.
    let currentBatch = {};
    const record = { sessionId: 'session-test', agent: {}, replyTarget: {} };
    const context = vm.createContext({
        captureMergeBatchReply: () => currentBatch ? { batch: currentBatch, replyRecord: record } : undefined,
    });
    const runnable = outbound.replace(/^import .*;\n/gm, '').replace(/^export \{.*;\n/gm, '')
        .replace('export function createOutboundHandler', 'function createOutboundHandler');
    vm.runInContext(`${runnable}\nglobalThis.Router = OutboundRouter;`, context);
    const router = new context.Router({ findBySessionId: () => record }, {}, {}, {}, undefined, {
        deliver() { assert.fail('generic file delivery must never run'); },
    });
    const chunks = [];
    router.appendChunk = (...args) => chunks.push(args);
    router.routeStreamFrame(record.sessionId, { kind: 'text-delta', attemptId: 'old', text: 'unbound' });
    assert.equal(chunks.length, 0);
    router.routeStreamFrame(record.sessionId, { kind: 'attempt-start', attemptId: 'a' });
    router.routeStreamFrame(record.sessionId, { kind: 'text-delta', attemptId: 'a', text: 'valid' });
    assert.equal(chunks.length, 1);
    currentBatch = {};
    router.routeStreamFrame(record.sessionId, { kind: 'text-delta', attemptId: 'a', text: 'late' });
    assert.equal(chunks.length, 1);
    router.routeStreamFrame(record.sessionId, { kind: 'attempt-start', attemptId: 'b' });
    record.agent = {};
    router.routeStreamFrame(record.sessionId, { kind: 'text-delta', attemptId: 'b', text: 'replaced agent' });
    assert.equal(chunks.length, 1);
    currentBatch = undefined;
    router.routeStreamFrame(record.sessionId, { kind: 'text-delta', attemptId: 'b', text: 'closed' });
    assert.equal(chunks.length, 1);
    console.log('QQ adapter 0.5.5 patches: syntax, idempotence, file isolation, persistence and stream isolation passed');
} finally {
    await rm(temp, { recursive: true, force: true });
}
