import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const root = process.env.QQBOT_CAPABILITY_ROOT ?? new URL('../defaults/', import.meta.url).href;
const { createCapabilityRegistry, CAPABILITY_TOOLS, ONEBOT_STATE_TTL_MS, renderCapabilityStatus, capabilityRuntimeContext } = await import(`${root}/qqbot-capabilities.mjs`);
const { registerOnebotCommandTool, readOnebotConfig } = await import(`${root}/qqbot-onebot.mjs`);
const { beginOnebotTurn, endOnebotTurn, onebotRequestMetadata } = await import(`${root}/qqbot-onebot-scope.mjs`);
const schemas = Object.values(CAPABILITY_TOOLS).map((name) => ({ name }));
const deployment = { view: 'deployment' };
function state(at = 100) {
    return { configured: 'enabled', reason: 'ready', registered: true, available: true, verifiedAt: at,
        bridge: { readiness: 'ready', checkedAt: at }, mcp: { readiness: 'ready', checkedAt: at },
        backends: [{ id: 'sealdice', ready: true, supported: true, capabilities: ['log-capture-v1', 'artifact-v1', 'group-role-v1', 'master-acl-v1'] }],
        bridgeCapabilities: ['log-capture-v1', 'artifact-v1'], logEnabled: true, managementConfigured: true };
}
test('every capability is explicit; unknown is distinct from disabled and schemas remain authoritative', () => {
    const registry = createCapabilityRegistry();
    registry.setConfigured('image_generation', 'disabled');
    const { snapshot } = registry.getSnapshot();
    assert.equal(Object.keys(snapshot.capabilities).length, 9);
    assert.equal(snapshot.capabilities.image_generation.configured, 'disabled');
    assert.equal(snapshot.capabilities.vision.configured, 'unknown');
    assert.equal(snapshot.capabilities.onebot.configured, 'unknown');
    const result = registry.getSnapshot({ toolSchemas: [...schemas, { name: 'bash' }] });
    assert.ok(!result.tools.some((tool) => tool.name === 'bash'));
    assert.equal(result.snapshot.capabilities.image_generation.toolAvailable, false);
    for (const [id, tool] of Object.entries(CAPABILITY_TOOLS)) {
        assert.equal(result.snapshot.capabilities[id].toolAvailable, result.tools.some((entry) => entry.name === tool));
    }
});
test('gateways, stale states, request admission and document restrictions are independent', () => {
    let now = 100;
    const registry = createCapabilityRegistry({ now: () => now });
    const other = createCapabilityRegistry({ now: () => now });
    registry.setOnebotProvider(() => state());
    const get = (requestContext) => registry.getSnapshot({ toolSchemas: schemas, requestContext });
    assert.equal(get(deployment).snapshot.capabilities.onebot.toolAvailable, true);
    assert.equal(other.isOnebotAvailable(), false);
    assert.equal(get({}).snapshot.capabilities.onebot.reason, 'turn-not-authorized');
    assert.equal(get({ onebotAuthorized: true }).snapshot.capabilities.onebot.toolAvailable, true);
    const protectedResult = get({ onebotAuthorized: true, documentMode: true });
    assert.equal(protectedResult.snapshot.capabilities.onebot.reason, 'document-protection');
    assert.equal(protectedResult.snapshot.capabilities.image_generation.toolAvailable, false);
    now += ONEBOT_STATE_TTL_MS + 1;
    assert.equal(registry.isOnebotAvailable(), false);
    assert.equal(get(deployment).snapshot.capabilities.onebot.reason, 'state-stale');
    assert.equal(get(deployment).snapshot.capabilities.onebot.bridge.readiness, 'unknown');
    registry.setOnebotProvider(() => state(now));
    assert.equal(get({}).snapshot.capabilities.onebot.toolAvailable, false, 'recovery cannot mint old-turn authorization');
    assert.equal(get({ onebotAuthorized: true }).snapshot.capabilities.onebot.toolAvailable, true);
});
test('backend features intersect bridge support, backend negotiation and local switches', () => {
    const registry = createCapabilityRegistry({ now: () => 100 });
    const observation = state();
    observation.backends.push({ id: 'old', ready: true, supported: true, capabilities: [] },
        { id: 'offline', ready: false, supported: true, capabilities: ['log-capture-v1'] });
    registry.setOnebotProvider(() => observation);
    const get = () => registry.getSnapshot({ toolSchemas: schemas, requestContext: deployment }).snapshot.capabilities.onebot;
    assert.equal(get().backends[0].features.log_export, true);
    assert.equal(get().backends[1].features.commands, true);
    assert.equal(get().backends[1].features.group_rules, false);
    assert.equal(get().backends[2].features.commands, false);
    observation.bridgeCapabilities = [];
    observation.managementConfigured = false;
    assert.equal(get().backends[0].features.log_capture, false);
    assert.equal(get().backends[0].features.management, false);
    observation.logEnabled = false;
    assert.equal(get().backends[0].features.log_export, false);
});
test('capability serialization excludes secrets and raw backend text', () => {
    const registry = createCapabilityRegistry({ now: () => 100 });
    const observation = { ...state(), secret: 'SECRET_SENTINEL', reason: 'SECRET_SENTINEL',
        bridge: { readiness: 'SECRET_SENTINEL', checkedAt: 100, url: 'SECRET_SENTINEL' } };
    observation.backends.push({ id: 'https://SECRET_SENTINEL', ready: true });
    observation.backends[0].capabilities.push('SECRET_SENTINEL');
    registry.setOnebotProvider(() => observation);
    const snapshot = registry.getSnapshot({ toolSchemas: schemas, requestContext: deployment }).snapshot;
    assert.doesNotMatch(JSON.stringify(snapshot), /SECRET_SENTINEL/u);
    assert.doesNotMatch(renderCapabilityStatus(snapshot), /SECRET_SENTINEL/u);
    assert.match(capabilityRuntimeContext(snapshot).text, /不能|不得/u);
});
function backendResponse(ready = true) {
    return new Response(JSON.stringify({ capabilities: ['log-capture-v1', 'artifact-v1'],
        backends: [{ id: 'sealdice', version: 1, ready, capabilities: ['log-capture-v1', 'artifact-v1'] }] }),
    { status: 200, headers: { 'content-type': 'application/json' } });
}
function fixture(t, { registerError = false, toolsService = true, config: override } = {}) {
    let now = 100;
    const controls = { bridge: true, mcp: true, callWs: true, ready: true, calls: 0 };
    const config = override ?? { enabled: true, backendIds: ['sealdice'], logEnabled: false, masterUsers: [],
        url: new URL('http://bridge.test/mcp'), mcpToken: 'secret', internalToken: 'secret' };
    const service = registerOnebotCommandTool({ get: () => toolsService ? { register() { if (registerError) throw new Error('fixture'); } } : undefined }, {
        config, now: () => now, refreshIntervalMs: 60_000,
        logCapture: { setBackends() {}, setUnavailable() {}, async stop() {} },
        fetchImpl: async () => {
            if (!controls.bridge) throw new Error('SECRET_SENTINEL');
            return controls.catalog === undefined ? backendResponse(controls.ready)
                : new Response(JSON.stringify(controls.catalog), { headers: { 'content-type': 'application/json' } });
        },
        session: { async listTools() { if (!controls.mcp) throw new Error('SECRET_SENTINEL'); return controls.callWs ? [{ name: 'call_ws' }] : []; },
            async callWs() { controls.calls++; throw new Error('must not dispatch stale operations'); } },
    });
    t.after(() => service.stop());
    const registry = createCapabilityRegistry({ now: () => now });
    registry.setOnebotProvider(service.capabilityState);
    return { service, registry, controls, advance: () => { now += ONEBOT_STATE_TTL_MS + 1; },
        get: () => registry.getSnapshot({ toolSchemas: schemas, requestContext: deployment }).snapshot.capabilities.onebot };
}
test('real service observations distinguish disabled, invalid and registration failures', async (t) => {
    for (const [config, reason] of [[readOnebotConfig({}), 'config-disabled'],
        [readOnebotConfig({ QQBOT_ONEBOT_ENABLED: 'true' }), 'config-invalid']]) {
        const f = fixture(t, { config });
        await f.service.ready;
        assert.equal(f.get().reason, reason);
    }
    for (const [options, reason] of [[{ registerError: true }, 'register-failed'], [{ toolsService: false }, 'tools-service-unavailable']]) {
        const f = fixture(t, options);
        await f.service.ready;
        assert.equal(f.get().reason, reason);
    }
});
test('independent probes, backend outage, missing call_ws, expiry and recovery', async (t) => {
    const f = fixture(t);
    await f.service.ready;
    assert.equal(f.get().toolAvailable, true);
    f.controls.ready = false;
    await f.service.refresh();
    assert.equal(f.get().reason, 'backend-not-ready');
    assert.equal(f.get().bridge.readiness, 'ready');
    f.controls.ready = true;
    f.controls.callWs = false;
    await f.service.refresh();
    assert.equal(f.get().reason, 'call-ws-missing');
    f.controls.callWs = true;
    f.controls.bridge = false;
    await f.service.refresh();
    assert.equal(f.get().reason, 'probe-failed');
    assert.equal(f.get().bridge.readiness, 'unknown');
    assert.equal(f.get().mcp.readiness, 'ready');
    f.controls.bridge = true;
    f.controls.mcp = false;
    await f.service.refresh();
    assert.equal(f.get().bridge.readiness, 'ready');
    assert.equal(f.get().mcp.readiness, 'unknown');
    f.controls.mcp = true;
    for (const catalog of [{ unexpected: [] }, { backends: [{ id: 'sealdice' }, { id: 'sealdice' }] }]) {
        f.controls.catalog = catalog;
        await f.service.refresh();
        assert.equal(f.get().reason, 'probe-failed');
        assert.equal(f.get().bridge.readiness, 'unknown');
    }
    f.controls.catalog = undefined;
    await f.service.refresh();
    f.advance();
    assert.equal(f.get().reason, 'state-stale');
    assert.equal(f.service.diagnostics().toolAvailable, false);
    const agent = {};
    const turn = beginOnebotTurn(agent, [{ ownerId: 'owner', text: '.userid', replyTarget: { scope: 'c2c', targetId: 'owner', msgId: 'm' } }], { appId: '123' });
    try {
        const result = await f.service.execute({ requestId: onebotRequestMetadata(turn)[0].requestId, backend: 'sealdice', command: '.userid' }, { agent });
        assert.equal(result.status, 'failed');
        assert.equal(f.controls.calls, 0);
    } finally { await endOnebotTurn(agent, turn); }
    await f.service.refresh();
    assert.equal(f.get().toolAvailable, true);
});
test('previous stock instructions are eligible for migration without changing the fixture', async () => {
    const fixture = new URL('./fixtures/agents-v0.16.1-stock.md', import.meta.url);
    // This assertion is useful both in the repository and when mounted as /repo/scripts.
    const hash = createHash('sha256').update(await readFile(fixture)).digest('hex');
    const entrypoint = await readFile(new URL('../docker-entrypoint.sh', import.meta.url), 'utf8');
    assert.ok(entrypoint.includes(hash));
});
