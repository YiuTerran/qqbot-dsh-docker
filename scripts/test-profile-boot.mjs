// Offline integration probe for the complete qqbot Cordis profile.
//
// Run this inside the built image through docker-entrypoint.sh. The entrypoint
// seeds /data and applies its normal startup instrumentation; this probe adds
// only the immutable safety overlay explicitly so it also works when invoked
// directly with `node`. No QQ gateway or model request is made: the SDK class
// is wrapped before the profile is loaded and its start/stop lifecycle is local.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { access, readFile, unlink, writeFile } from 'node:fs/promises';

const dshRoot = '/usr/local/lib/node_modules/@deepseek-ai/dsh';
const profileRoot = '/data/profiles/qqbot';
const safetyOverlay = '/opt/qqbot-defaults/cordis.safety.patch.yml';
const sdkPackage = '@tencent-connect/qqbot-nodejs';
const wrapperPath = `/tmp/qqbot-profile-sdk-wrapper-${process.pid}.mjs`;
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

await access(profileRoot);
await access(safetyOverlay);
await writeFile(wrapperPath, wrapperSource, { mode: 0o600 });

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
  const expectedSearchBaseUrl = process.env.QQBOT_TEST_EXPECT_SEARCH_BASE_URL;
  const expectedImageEnabled = Boolean(process.env.IMAGE_API_KEY);
  const expectedMarkdownEnabled = process.env.QQBOT_MARKDOWN_ENABLED !== 'false';
  const thirdPartyMode = Boolean(process.env.LLM_API_KEY);
  const expectedProvider = thirdPartyMode ? process.env.LLM_PROVIDER : 'deepseek-official';
  const expectedModel = thirdPartyMode ? process.env.LLM_MODEL : 'deepseek-flash';
  const expectedSearchModel = process.env.LLM_SEARCH_MODEL || 'deepseek-flash';
  const searchEnabled = !thirdPartyMode || Boolean(process.env.LLM_SEARCH_BASE_URL);
  assert.equal(ctx.fiber.state, 2, 'Cordis root did not reach the running state');
  assert.ok(tools && typeof tools.schemas === 'function', 'tools service is missing');
  assert.ok(agentDefaultModel && typeof agentDefaultModel.currentSelection === 'function', 'agent default model service is missing');
  assert.ok(systemPrompt && typeof systemPrompt.assemble === 'function', 'systemPrompt service is missing');
  const defaultSelection = agentDefaultModel.currentSelection();
  assert.equal(defaultSelection.provider, expectedProvider, 'default chat provider did not follow the active credential mode');
  assert.equal(defaultSelection.model, expectedModel, 'default chat model did not follow the active credential mode');
  assert.equal(web?.searchProviders?.has('deepseek-official'), searchEnabled, 'native search provider registration does not match the active mode');
  let searchBaseUrlMatches;
  if (searchEnabled) {
    const searchProvider = web.searchProviders.get('deepseek-official');
    assert.equal(typeof searchProvider?.resolveOptions, 'function', 'the native search provider options are unavailable');
    const searchOptions = searchProvider.resolveOptions();
    assert.equal(searchOptions.apiKeyEnv, thirdPartyMode ? 'LLM_API_KEY' : 'DEEPSEEK_API_KEY', 'search must use the active mode credential');
    assert.equal(searchOptions.apiKey, undefined, 'persisted literal search keys must be cleared');
    assert.equal(searchOptions.model, expectedSearchModel, 'native search model did not resolve independently from the chat model');
    if (expectedSearchBaseUrl) {
      assert.equal(searchOptions.baseURL, expectedSearchBaseUrl, 'native search endpoint did not resolve from deployment configuration');
      searchBaseUrlMatches = true;
    }
  }
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
  for (const secret of [process.env.IMAGE_API_KEY, process.env.IMAGE_API_BASE_URL]) {
    if (secret) assert.ok(!logText.includes(secret), 'image route credentials and endpoint must not appear in logs');
  }

  const registryNames = tools.schemas().map((tool) => tool.name).sort();
  const assembly = await systemPrompt.assemble();
  const modelNames = assembly.tools.map((tool) => tool.name).sort();
  assert.equal(registryNames.includes('qqbot_generate_image'), expectedImageEnabled, 'image generation registration does not match the dedicated image route');
  assert.equal(registryNames.includes('qqbot_create_markdown'), expectedMarkdownEnabled, 'Markdown export registration does not match QQBOT_MARKDOWN_ENABLED');
  const expectedTools = [
    'qqbot_describe_image', 'qqbot_read_document', 'qqbot_roll_dice',
    ...(expectedImageEnabled ? ['qqbot_generate_image'] : []),
    ...(expectedMarkdownEnabled ? ['qqbot_create_markdown'] : []),
    'web_fetch',
    ...(searchEnabled ? ['web_search'] : []),
  ].sort();
  assert.deepEqual(modelNames, expectedTools, 'model-facing chat tool catalog does not match configured search and generation availability');
  assert.ok(registryNames.includes('qqbot_read_document'), 'QQ document reader must be registered');
  assert.ok(registryNames.includes('qqbot_roll_dice'), 'TRPG dice tool must be registered');
  if (!searchEnabled) {
    assert.ok(!registryNames.includes('web_search'), 'web_search must not be registered when native search is disabled');
    const unavailable = await tools.execute({
      name: 'web_search',
      arguments: { queries: ['must not call search'] },
      agent: {},
      callId: 'qqbot-profile-search-disabled',
      signal: new AbortController().signal,
    });
    assert.equal(unavailable.isError, true, 'direct web_search call must fail when search is disabled');
  }
  assert.ok(assembly.sections.some((section) => section.name === 'qqbot:chat-only-policy'), 'chat policy prompt section is missing');

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
    searchEnabled,
    policySection: true,
    dangerousToolDenied: true,
    ...(searchBaseUrlMatches === undefined ? {} : { searchBaseUrlMatches }),
    ...(searchEnabled ? { searchModel: expectedSearchModel } : {}),
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
}
