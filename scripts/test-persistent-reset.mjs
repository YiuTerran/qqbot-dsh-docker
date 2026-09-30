import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';

const mode = process.argv[2];
const root = '/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist';
try {
    await symlink('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
        '/data/profiles/qqbot/node_modules/@deepseek-ai', 'dir');
} catch (error) { if (error.code !== 'EEXIST') throw error; }
const [{ PrefsStore }, { ModelResolver }, { SessionManager }] = await Promise.all([
    import(`${root}/model/prefs-store.js`),
    import(`${root}/model/model-resolver.js`),
    import(`${root}/session/session-manager.js`),
]);
const prefs = new PrefsStore();
assert.equal(prefs.prefsPath, '/data/qqbot-model-prefs.json');
const manager = Object.create(SessionManager.prototype);
manager.config = { appId: 'persistent-reset-fixture' };
manager.sessions = new Map();
manager.logger = { info() {}, warn() {} };
manager.modelResolver = Object.create(ModelResolver.prototype);
manager.modelResolver.prefs = prefs;
const scope = 'group';
const peerId = 'persistent-group';
const key = manager.sessionKey(scope, peerId);
const marker = '/data/.persistent-reset-session-id';
const oldEvents = '/data/sessions/persistent-reset-old.events';
const route = { provider: 'fixture-provider', model: 'fixture-model' };
if (mode === 'reset') {
    prefs.setOverride(key, route);
    prefs.setPreset(key, 'fixture-preset');
    prefs.setSessionId(key, 'persistent-reset-old', { strict: true });
    await mkdir('/data/sessions', { recursive: true });
    await writeFile(oldEvents, 'persistent old session history');
    const record = { agent: { cancel() {} }, sessionId: 'persistent-reset-old', handle: { async dispose() {} } };
    manager.sessions.set(key, record);
    assert.equal(await manager.remove(scope, peerId, {
        expectedRecord: record, expectedAgent: record.agent, expectedSessionId: record.sessionId,
        requirePersisted: true,
    }), true);
    assert.notEqual(prefs.getSessionId(key), 'persistent-reset-old');
    await writeFile(marker, prefs.getSessionId(key));
} else if (mode === 'verify') {
    assert.equal(prefs.getSessionId(key), await readFile(marker, 'utf8'));
} else throw new Error('expected reset or verify mode');
assert.deepEqual(prefs.getOverride(key), route);
assert.equal(prefs.getPreset(key), 'fixture-preset');
assert.equal(await readFile(oldEvents, 'utf8'), 'persistent old session history');
process.stdout.write(`Persistent default prefs ${mode} probe passed.\n`);
