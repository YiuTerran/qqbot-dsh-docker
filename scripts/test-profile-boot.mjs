// Offline integration probe for the complete qqbot Cordis profile.
//
// Run this inside the built image through docker-entrypoint.sh. The entrypoint
// seeds /data and applies its normal startup instrumentation; this probe adds
// only the immutable safety overlay explicitly so it also works when invoked
// directly with `node`. No QQ gateway or model request is made: the SDK class
// is wrapped before the profile is loaded and its start/stop lifecycle is local.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { access, unlink, writeFile } from 'node:fs/promises';

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
  const systemPrompt = ctx.get('systemPrompt');
  assert.equal(ctx.fiber.state, 2, 'Cordis root did not reach the running state');
  assert.ok(tools && typeof tools.schemas === 'function', 'tools service is missing');
  assert.ok(systemPrompt && typeof systemPrompt.assemble === 'function', 'systemPrompt service is missing');

  const logText = captured.map(({ line }) => line).join('\n');
  assert.match(logText, /\[im-qqbot\] chat-only policy installed;/, 'chat policy was not installed');
  assert.match(logText, /\[im-qqbot\] Bot ready!/, 'QQ profile did not reach local SDK ready');
  assert.doesNotMatch(logText, /gateway initialization failed|failed to import|entry did not activate/, 'QQ profile reported startup failure');

  const registryNames = tools.schemas().map((tool) => tool.name).sort();
  const assembly = await systemPrompt.assemble();
  const modelNames = assembly.tools.map((tool) => tool.name).sort();
  assert.deepEqual(modelNames, ['qqbot_describe_image', 'web_fetch'], 'model-facing tool catalog is not chat-only');
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
    policySection: true,
    dangerousToolDenied: true,
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
