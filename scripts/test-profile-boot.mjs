// Offline integration probe for the complete qqbot Cordis profile.
//
// Run this inside the built image through docker-entrypoint.sh. The entrypoint
// seeds /data and applies its normal startup instrumentation; this probe adds
// only the immutable safety overlay explicitly so it also works when invoked
// directly with `node`. No QQ gateway or model request is made: the SDK class
// is wrapped before the profile is loaded and its start/stop lifecycle is local.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { createServer } from 'node:http';
import { access, readFile, unlink, writeFile } from 'node:fs/promises';

const dshRoot = '/usr/local/lib/node_modules/@deepseek-ai/dsh';
const profileRoot = '/data/profiles/qqbot';
const safetyOverlay = '/opt/qqbot-defaults/cordis.safety.patch.yml';
const sdkPackage = '@tencent-connect/qqbot-nodejs';
const wrapperPath = `/tmp/qqbot-profile-sdk-wrapper-${process.pid}.mjs`;
const onebotFixtureMode = process.env.QQBOT_TEST_ONEBOT_FIXTURE === 'true';
const onebotRealMode = process.env.QQBOT_TEST_ONEBOT_EXPECT_READY === 'true';
const onebotProbeEnabled = onebotFixtureMode || onebotRealMode;
const fixtureMcpToken = 'qqbot-profile-onebot-mcp-fixture-token';
const fixtureInternalToken = 'qqbot-profile-onebot-internal-fixture-token';
let onebotServer;
const wrapperSource = `
import * as realSdk from '${profileRoot}/node_modules/@tencent-connect/qqbot-nodejs/dist/index.js';
export * from '${profileRoot}/node_modules/@tencent-connect/qqbot-nodejs/dist/index.js';
export class QQBot extends realSdk.QQBot {
  async start() {
    await this.emit('ready', { probe: true });
  }
  stop() {}
}
`;

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function waitForOnebotCatalog(tools, systemPrompt, expectedVisible, timeoutMs = 15_000, expectedRegistered = expectedVisible) {
  const deadline = Date.now() + timeoutMs;
  let latest = { registered: false, visible: false };
  while (Date.now() < deadline) {
    const registryNames = tools.schemas().map((tool) => tool.name);
    const assembly = await systemPrompt.assemble();
    const modelNames = assembly.tools.map((tool) => tool.name);
    latest = {
      registered: registryNames.includes('qqbot_onebot_command'),
      visible: modelNames.includes('qqbot_onebot_command'),
    };
    if (latest.registered === expectedRegistered && latest.visible === expectedVisible) return latest;
    await pause(25);
  }
  assert.fail(`OneBot catalog did not become ${expectedVisible ? 'visible' : 'hidden'}: ${JSON.stringify(latest)}`);
}

await access(profileRoot);
await access(safetyOverlay);
await writeFile(wrapperPath, wrapperSource, { mode: 0o600 });

const originalOnebotEnv = Object.fromEntries([
  'QQBOT_ONEBOT_ENABLED', 'QQBOT_ONEBOT_MCP_URL', 'QQBOT_ONEBOT_MCP_TOKEN',
  'QQBOT_ONEBOT_INTERNAL_TOKEN', 'QQBOT_ONEBOT_BACKENDS', 'QQBOT_ONEBOT_HIDDEN_ENABLED',
].map((key) => [key, process.env[key]]));
let onebotFixtureState;
if (onebotFixtureMode) {
  onebotFixtureState = { backendReady: false, exposeCallWs: true, calls: 0, backendProbes: 0, toolLists: 0 };
  onebotServer = createServer(async (request, response) => {
    const sendJson = (status, value, headers = {}) => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(JSON.stringify(value));
    };
    const authorization = request.headers.authorization;
    if (request.url === '/internal/backends' && request.method === 'GET') {
      if (authorization !== `Bearer ${fixtureInternalToken}`) return sendJson(401, { error: 'unauthorized' });
      onebotFixtureState.backendProbes++;
      return sendJson(200, { backends: [{ id: 'sealdice', ready: onebotFixtureState.backendReady, version: 1 }] });
    }
    if (request.url !== '/mcp' || request.method !== 'POST') return sendJson(404, { error: 'not found' });
    if (authorization !== `Bearer ${fixtureMcpToken}`) return sendJson(401, { error: 'unauthorized' });
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof rpc.id !== 'string') {
      response.writeHead(202);
      response.end();
      return;
    }
    if (rpc.method === 'initialize') {
      return sendJson(200, { jsonrpc: '2.0', id: rpc.id, result: {
        protocolVersion: '2024-11-05', capabilities: { tools: {} },
        serverInfo: { name: 'qqbot-profile-fixture', version: '1' },
      } });
    }
    if (rpc.method === 'tools/list') {
      onebotFixtureState.toolLists++;
      return sendJson(200, { jsonrpc: '2.0', id: rpc.id, result: {
        tools: onebotFixtureState.exposeCallWs ? [{ name: 'call_ws' }] : [],
      } });
    }
    if (rpc.method === 'tools/call' && rpc.params?.name === 'call_ws') {
      onebotFixtureState.calls++;
      const args = rpc.params.arguments;
      const output = {
        request_id: args.request_id,
        backend_id: args.backend_id,
        audience: args.audience,
        status: 'ok',
        outputs: [{
          action: args.audience === 'group' ? 'send_group_msg' : 'send_private_msg',
          audience: args.audience,
          target_id: 17,
          message: 'PROFILE_FIXTURE_DICE_RESULT_1D1_1',
        }],
      };
      return sendJson(200, { jsonrpc: '2.0', id: rpc.id, result: {
        content: [{ type: 'text', text: JSON.stringify(output) }],
      } });
    }
    return sendJson(200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'method not found' } });
  });
  await new Promise((resolve, reject) => {
    onebotServer.once('error', reject);
    onebotServer.listen(0, '127.0.0.1', resolve);
  });
  const address = onebotServer.address();
  process.env.QQBOT_ONEBOT_ENABLED = 'true';
  process.env.QQBOT_ONEBOT_MCP_URL = `http://127.0.0.1:${address.port}/mcp`;
  process.env.QQBOT_ONEBOT_MCP_TOKEN = fixtureMcpToken;
  process.env.QQBOT_ONEBOT_INTERNAL_TOKEN = fixtureInternalToken;
  process.env.QQBOT_ONEBOT_BACKENDS = 'sealdice';
  process.env.QQBOT_ONEBOT_HIDDEN_ENABLED = 'false';
}
else if (onebotRealMode) {
  assert.equal(process.env.QQBOT_ONEBOT_ENABLED, 'true', 'real OneBot probe requires QQBOT_ONEBOT_ENABLED=true');
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === sdkPackage) {
      return { url: `file://${wrapperPath}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { loadLayeredEnv } = await import(
  `${dshRoot}/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`,
);
const { runProfile } = await import(`${dshRoot}/lib/profile-boot.js`);

const captured = [];
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};
for (const level of Object.keys(originalConsole)) {
  console[level] = (...args) => {
    const line = args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' ');
    captured.push({ level, line });
    originalConsole[level](...args);
  };
}

let boot;
try {
  boot = await runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'qqbot',
    patchFiles: [safetyOverlay],
    args: [],
  });

  const { ctx, shutdown } = boot;
  const tools = ctx.get('tools');
  const agentDefaultModel = ctx.get('agentDefaultModel');
  const systemPrompt = ctx.get('systemPrompt');
  const web = ctx.get('web');
  const expectedImageEnabled = Boolean(process.env.IMAGE_API_KEY);
  const expectedMarkdownEnabled = process.env.QQBOT_MARKDOWN_ENABLED !== 'false';
  const thirdPartyMode = Boolean(process.env.LLM_API_KEY);
  const expectedProvider = thirdPartyMode ? process.env.LLM_PROVIDER : 'deepseek-official';
  const expectedModel = thirdPartyMode ? process.env.LLM_MODEL : 'deepseek-flash';
  const expectedSearchModel = process.env.LLM_SEARCH_MODEL || 'deepseek-flash';
  const expectedSearchBaseUrl = process.env.QQBOT_TEST_EXPECT_SEARCH_BASE_URL
    ?? (thirdPartyMode
      ? process.env.LLM_SEARCH_BASE_URL || process.env.LLM_API_BASE_URL
      : 'https://api.deepseek.com/anthropic/v1');
  assert.equal(ctx.fiber.state, 2, 'Cordis root did not reach the running state');
  assert.ok(tools && typeof tools.schemas === 'function', 'tools service is missing');
  assert.ok(agentDefaultModel && typeof agentDefaultModel.currentSelection === 'function', 'agent default model service is missing');
  assert.ok(systemPrompt && typeof systemPrompt.assemble === 'function', 'systemPrompt service is missing');
  if (onebotFixtureMode) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline
      && (onebotFixtureState.backendProbes < 1 || onebotFixtureState.toolLists < 1)) await pause(25);
    assert.ok(onebotFixtureState.backendProbes >= 1 && onebotFixtureState.toolLists >= 1,
      'initial backend and MCP list probes did not complete');
    await pause(50);
    await waitForOnebotCatalog(tools, systemPrompt, false);
    onebotFixtureState.backendReady = true;
    await waitForOnebotCatalog(tools, systemPrompt, true);
  }
  else if (onebotRealMode) {
    await waitForOnebotCatalog(tools, systemPrompt, true, 15_000);
  }
  const defaultSelection = agentDefaultModel.currentSelection();
  assert.equal(defaultSelection.provider, expectedProvider, 'default chat provider did not follow the active credential mode');
  assert.equal(defaultSelection.model, expectedModel, 'default chat model did not follow the active credential mode');
  assert.equal(web?.searchProviders?.has('deepseek-official'), true, 'native search provider must stay registered in every credential mode');
  const searchProvider = web.searchProviders.get('deepseek-official');
  assert.equal(typeof searchProvider?.resolveOptions, 'function', 'the native search provider options are unavailable');
  const searchOptions = searchProvider.resolveOptions();
  assert.equal(searchOptions.apiKeyEnv, thirdPartyMode ? 'LLM_API_KEY' : 'DEEPSEEK_API_KEY', 'search must use the active mode credential');
  assert.equal(searchOptions.apiKey, undefined, 'persisted literal search keys must be cleared');
  assert.equal(searchOptions.model, expectedSearchModel, 'native search model did not resolve independently from the chat model');
  assert.equal(searchOptions.baseURL, expectedSearchBaseUrl, 'native search endpoint did not resolve from deployment configuration');
  const persistedPatch = await readFile(`${profileRoot}/cordis.patch.yml`, 'utf8').catch(() => '');
  for (const fixtureKey of ['fixture-chat-key', 'fixture-official-key']) {
    assert.ok(!persistedPatch.includes(fixtureKey), `persisted profile must not contain ${fixtureKey}`);
  }
  for (const fixtureValue of [process.env.IMAGE_API_KEY, process.env.IMAGE_API_BASE_URL]) {
    if (fixtureValue) assert.ok(!persistedPatch.includes(fixtureValue), 'image route credentials and endpoint must not be persisted in the profile patch');
  }

  const logText = captured.map(({ line }) => line).join('\n');
  assert.match(logText, /\[im-qqbot\] chat-only policy installed;/, 'chat policy was not installed');
  assert.match(logText, /\[im-qqbot\] Bot ready!/, 'QQ profile did not reach local SDK ready');
  assert.doesNotMatch(logText, /gateway initialization failed|failed to import|entry did not activate/, 'QQ profile reported startup failure');
  if (onebotProbeEnabled) {
    assert.match(logText, /\[qqbot-onebot\] ready backends=1 available=true/, 'OneBot readiness log did not reach stdout');
    if (onebotFixtureMode) {
      assert.match(logText, /\[qqbot-onebot\] backend-not-ready backends=0 available=false/, 'OneBot not-ready state log did not reach stdout');
    }
  }
  for (const secret of [process.env.QQBOT_ONEBOT_MCP_TOKEN, process.env.QQBOT_ONEBOT_INTERNAL_TOKEN]) {
    if (secret) assert.ok(!logText.includes(secret), 'OneBot diagnostic output leaked a configured token');
  }
  if (onebotFixtureMode) assert.doesNotMatch(logText, /127\.0\.0\.1/u, 'OneBot diagnostic output leaked the fixture endpoint');
  for (const secret of [process.env.IMAGE_API_KEY, process.env.IMAGE_API_BASE_URL]) {
    if (secret) assert.ok(!logText.includes(secret), 'image route credentials and endpoint must not appear in logs');
  }

  const registryNames = tools.schemas().map((tool) => tool.name).sort();
  const assembly = await systemPrompt.assemble();
  const modelNames = assembly.tools.map((tool) => tool.name).sort();
  assert.equal(registryNames.includes('qqbot_generate_image'), expectedImageEnabled, 'image generation registration does not match the dedicated image route');
  assert.equal(registryNames.includes('qqbot_create_markdown'), expectedMarkdownEnabled, 'Markdown export registration does not match QQBOT_MARKDOWN_ENABLED');
  assert.ok(registryNames.includes('qqbot_send_asset_image'), 'original setting images must be sendable without image API configuration');
  const expectedTools = [
    'qqbot_describe_image', 'qqbot_read_document',
    'qqbot_send_asset_image',
    ...(expectedImageEnabled ? ['qqbot_generate_image'] : []),
    ...(expectedMarkdownEnabled ? ['qqbot_create_markdown'] : []),
    'web_fetch',
    'web_search',
    ...(onebotProbeEnabled ? ['qqbot_onebot_command'] : []),
  ].sort();
  assert.deepEqual(modelNames, expectedTools, 'model-facing chat tool catalog does not match configured search and generation availability');
  assert.ok(registryNames.includes('qqbot_read_document'), 'QQ document reader must be registered');
  assert.ok(assembly.sections.some((section) => section.name === 'qqbot:chat-only-policy'), 'chat policy prompt section is missing');
  const generationPolicy = assembly.sections.find((section) => section.name === 'qqbot:generation-policy');
  assert.ok(generationPolicy, 'immutable generation policy prompt section is missing');
  for (const constraint of [
    '匹配的原始 QQ 请求', '明确引用', '显式主体、风格、文字、数量和禁止项',
    '不得混入批次内其他用户或历史个人信息', '最多 4000 字符', '不增加模型/API 调用',
  ]) {
    assert.ok(generationPolicy.text.includes(constraint), `immutable generation policy is missing ${constraint}`);
  }
  if (expectedImageEnabled) {
    const imageTool = assembly.tools.find((tool) => tool.name === 'qqbot_generate_image');
    const imageToolSchema = JSON.stringify(imageTool);
    assert.match(imageToolSchema, /matched original QQ request/u, 'real Cordis image schema carries prompt optimization guidance');
    assert.match(imageToolSchema, /4000 characters/u, 'real Cordis image schema documents the final prompt limit');
    assert.match(imageToolSchema, /opaque requestId/u, 'real Cordis image schema retains request ID constraints');
    assert.match(imageToolSchema, /"maxLength":4000/u, 'real Cordis image schema bounds the prompt field');
  }
  const assetTool = assembly.tools.find((tool) => tool.name === 'qqbot_send_asset_image');
  assert.ok(assetTool, 'the original setting image file tool is visible to the model');
  assert.match(JSON.stringify(assetTool), /does not call the image API/u, 'asset sending is distinguished from paid generation');

  let onebotProjection;
  if (onebotProbeEnabled) {
    const onebotScope = await import('/opt/qqbot-defaults/qqbot-onebot-scope.mjs');
    const agentLoop = ctx.get('agentLoop');
    assert.ok(agentLoop && typeof agentLoop.create === 'function', 'agent loop service is missing');
    const agent = await agentLoop.create(`onebot-profile-probe-${randomUUID()}`, defaultSelection);
    const turn = onebotScope.beginOnebotTurn(agent, [{
      ownerId: 'fixture-owner',
      replyTarget: { scope: 'c2c', targetId: 'fixture-owner' },
      text: '请掷一个1d1',
    }], { appId: process.env.QQBOT_APPID });
    const requestId = onebotScope.onebotRequestMetadata(turn)[0]?.requestId;
    assert.ok(requestId, 'OneBot turn metadata did not include an opaque requestId');
    try {
      const execution = await tools.execute({
        name: 'qqbot_onebot_command',
        arguments: { requestId, backend: 'sealdice', command: '.r 1d1' },
        agent,
        callId: 'qqbot-profile-onebot-probe',
        signal: new AbortController().signal,
      });
      assert.equal(execution.isError, false, 'real Cordis tools.execute rejected the OneBot fixture call');
      onebotProjection = JSON.stringify(execution.content ?? execution);
      assert.match(onebotProjection, /PROFILE_FIXTURE_DICE_RESULT_1D1_1|1d1/iu,
        'model-facing Cordis result content omitted the public Dice result');
      assert.doesNotMatch(onebotProjection, /PRIVATE_FIXTURE|private-body/iu,
        'model-facing Cordis result content exposed a private body');
      for (const secret of [process.env.QQBOT_ONEBOT_MCP_TOKEN, process.env.QQBOT_ONEBOT_INTERNAL_TOKEN]) {
        if (secret) assert.ok(!onebotProjection.includes(secret), 'model-facing result leaked a configured OneBot token');
      }

      if (onebotFixtureMode) {
        onebotFixtureState.backendReady = false;
        await waitForOnebotCatalog(tools, systemPrompt, false, 15_000, true);
        const denied = await tools.execute({
          name: 'qqbot_onebot_command',
          arguments: { requestId, backend: 'sealdice', command: '.r 1d1' },
          agent,
          callId: 'qqbot-profile-onebot-unready',
          signal: new AbortController().signal,
        });
        assert.equal(denied.isError, true, 'OneBot execution remained callable after backend readiness was lost');
        const deniedContent = JSON.stringify(denied.content ?? denied);
        assert.match(deniedContent, /optional OneBot command backend is unavailable/iu,
          'unready execution did not fail at the backend availability guard');
        assert.doesNotMatch(deniedContent, /expired|no active QQ message|not available for the current QQ message/iu,
          'unready execution failed because its message authorization had expired');

        onebotFixtureState.backendReady = true;
        const priorToolLists = onebotFixtureState.toolLists;
        onebotFixtureState.exposeCallWs = false;
        const listDeadline = Date.now() + 15_000;
        while (Date.now() < listDeadline && onebotFixtureState.toolLists <= priorToolLists) await pause(25);
        assert.ok(onebotFixtureState.toolLists > priorToolLists, 'missing-call_ws MCP tools/list probe did not complete');
        const missingToolDeadline = Date.now() + 15_000;
        while (Date.now() < missingToolDeadline
          && !captured.some(({ line }) => line.includes('[qqbot-onebot] call-ws-missing'))) await pause(25);
        assert.ok(captured.some(({ line }) => line === '[qqbot-onebot] call-ws-missing backends=1 available=false'),
          'missing-call_ws readiness state was not observed');
        await waitForOnebotCatalog(tools, systemPrompt, false, 15_000, true);
        onebotFixtureState.exposeCallWs = true;
        await waitForOnebotCatalog(tools, systemPrompt, true, 15_000, true);
      }
    }
    finally {
      await onebotScope.endOnebotTurn(agent, turn);
    }
  }

  const dangerous = await tools.execute({
    name: 'exit_plan_mode',
    arguments: {},
    agent: {},
    callId: 'qqbot-profile-probe',
    signal: new AbortController().signal,
  });
  assert.equal(dangerous.isError, true, 'exit_plan_mode was executable under chat-only policy');

  originalConsole.log(JSON.stringify({
    ok: true,
    registryNames,
    modelNames,
    defaultSelection,
    searchEnabled: true,
    policySection: true,
    ...(onebotProbeEnabled ? { onebotProjection } : {}),
    dangerousToolDenied: true,
    searchBaseUrlMatches: true,
    searchModel: expectedSearchModel,
  }));
  await shutdown.shutdown(0);
} catch (error) {
  originalConsole.error(JSON.stringify({
    ok: false,
    error: String(error?.stack ?? error),
    relevantLogs: captured
      .map(({ line }) => line)
      .filter((line) => /im-qqbot|entry did not activate|failed to import/.test(line))
      .slice(-20),
  }));
  if (boot?.shutdown) await boot.shutdown.shutdown(1).catch(() => {});
  process.exitCode = 1;
} finally {
  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  await unlink(wrapperPath).catch(() => {});
  if (onebotServer) await new Promise((resolve) => onebotServer.close(resolve));
  for (const [key, value] of Object.entries(originalOnebotEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
