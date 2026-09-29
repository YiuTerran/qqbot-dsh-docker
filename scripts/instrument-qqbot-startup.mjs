import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) {
  throw new Error('usage: instrument-qqbot-startup.mjs <dsh-qqbot-package-directory>');
}

const sourceExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);
const files = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (sourceExtensions.has(path.slice(path.lastIndexOf('.')))) files.push(path);
  }
}

function replaceOnce(content, search, replacement, label, path) {
  const first = content.indexOf(search);
  if (first < 0) return { content, changed: false };
  if (content.indexOf(search, first + search.length) >= 0) {
    throw new Error(`${label}: multiple matching locations in ${path}`);
  }
  return {
    content: `${content.slice(0, first)}${replacement}${content.slice(first + search.length)}`,
    changed: true,
  };
}

await walk(root);

let credentialTrace = 0;
let gatewayTrace = 0;
let readinessTrace = 0;

for (const path of files) {
  let content = await readFile(path, 'utf8');
  let changed = false;

  if (content.includes("console.log('[im-qqbot] apply() called');") && content.includes('await bootstrapGateway(')) {
    const result = replaceOnce(
      content,
      '  await bootstrapGateway(ctx, agents, resolvedConfig, logger);',
      "  console.log('[im-qqbot] QQ credentials resolved; initializing gateway');\n  await bootstrapGateway(ctx, agents, resolvedConfig, logger);",
      'credential trace',
      path,
    );
    content = result.content;
    changed ||= result.changed;
    credentialTrace += Number(result.changed);
  }

  if (content.includes("bot.on('ready'" ) && content.includes('bot.start().catch(')) {
    const startSearch = content.includes('      bot.start().catch((err: unknown) => {')
      ? '      bot.start().catch((err: unknown) => {'
      : '      bot.start().catch((err) => {';
    if (!content.includes(startSearch)) {
      throw new Error(`gateway trace: unsupported dsh-qqbot build layout in ${path}`);
    }
    const startResult = replaceOnce(
      content,
      startSearch,
      `      const qqbotStartupWarnMs = Math.max(1_000, Number(process.env.QQBOT_STARTUP_WARN_MS ?? '20000') || 20_000);\n      const qqbotStartupWatchdog = setTimeout(() => {\n        if (!qqbotGatewayReady) {\n          console.warn(\`[im-qqbot] QQ gateway is still not ready after \${qqbotStartupWarnMs}ms; check DNS, TLS/proxy egress, and QQ Bot credentials/permissions\`);\n        }\n      }, qqbotStartupWarnMs);\n      qqbotStartupWatchdog.unref?.();\n      console.log('[im-qqbot] requesting QQ gateway connection');\n${startSearch}\n        console.error(\`[im-qqbot] Bot start failed: \${err instanceof Error ? err.message : String(err)}\`);`,
      'gateway trace',
      path,
    );
    content = startResult.content;
    changed ||= startResult.changed;
    gatewayTrace += Number(startResult.changed);

    const readyResult = replaceOnce(
      content,
      "bot.on('ready', () => {\n",
      "let qqbotGatewayReady = false;\n  bot.on('ready', () => {\n    qqbotGatewayReady = true;\n",
      'ready trace',
      path,
    );
    content = readyResult.content;
    changed ||= readyResult.changed;
    readinessTrace += Number(readyResult.changed);
  }

  if (changed) await writeFile(path, content);
}

if (credentialTrace !== 1 || gatewayTrace !== 1 || readinessTrace !== 1) {
  throw new Error(`QQ startup instrumentation no longer matches dsh-qqbot 0.5.0 (credential=${credentialTrace}, gateway=${gatewayTrace}, ready=${readinessTrace})`);
}
