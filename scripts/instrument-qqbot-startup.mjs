import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) {
  throw new Error('usage: instrument-qqbot-startup.mjs <dsh-qqbot-dist-directory>');
}

const indexPath = join(root, 'index.js');
const gatewayPath = join(root, 'gateway', 'bootstrap.js');

function replaceOne(content, expression, replacement, label, path) {
  const matches = [...content.matchAll(expression)];
  if (matches.length !== 1) {
    throw new Error(`${label}: expected one matching location in ${path}, found ${matches.length}`);
  }
  const match = matches[0];
  return `${content.slice(0, match.index)}${replacement(match)}${content.slice(match.index + match[0].length)}`;
}

let index = await readFile(indexPath, 'utf8');
let gateway = await readFile(gatewayPath, 'utf8');

// DSH does not expose this profile's ctx.logger on container stdout. Capture
// every synchronous setup failure, not only the later bot.start() rejection.
if (!index.includes('[im-qqbot] gateway initialization failed:')) {
  index = replaceOne(
    index,
    /^(\s*)await bootstrapGateway\(ctx, agents, resolvedConfig, logger\);$/gm,
    (match) => {
      const indent = match[1];
      const trace = index.includes('[im-qqbot] QQ credentials resolved; initializing gateway')
        ? ''
        : `${indent}console.log('[im-qqbot] QQ credentials resolved; initializing gateway');\n`;
      return `${trace}${indent}try {\n${indent}  await bootstrapGateway(ctx, agents, resolvedConfig, logger);\n${indent}} catch (err) {\n${indent}  console.error(\`[im-qqbot] gateway initialization failed: \${err instanceof Error ? err.stack ?? err.message : String(err)}\`);\n${indent}  throw err;\n${indent}}`;
    },
    'gateway initialization trace',
    indexPath,
  );
}

// The ready event is registered before bot.start(). Keep a simple flag in the
// enclosing scope so a silent SDK reconnect loop becomes observable.
if (!gateway.includes('[im-qqbot] requesting QQ gateway connection')) {
  gateway = replaceOne(
    gateway,
    /^(\s*)bot\.on\('ready', \(\) => \{$/gm,
    (match) => `${match[1]}let qqbotGatewayReady = false;\n${match[0]}`,
    'ready flag',
    gatewayPath,
  );
  gateway = replaceOne(
    gateway,
    /^(\s*)bot\.on\('ready', \(\) => \{\n/gm,
    (match) => `${match[0]}${match[1]}  qqbotGatewayReady = true;\n`,
    'ready trace',
    gatewayPath,
  );
  gateway = replaceOne(
    gateway,
    /^(\s*)bot\.start\(\)\.catch\(\(err\) => \{$/gm,
    (match) => {
      const indent = match[1];
      return `${indent}const qqbotStartupWarnMs = Math.max(1_000, Number(process.env.QQBOT_STARTUP_WARN_MS ?? '20000') || 20_000);\n${indent}const qqbotStartupWatchdog = setTimeout(() => {\n${indent}  if (!qqbotGatewayReady) {\n${indent}    console.warn(\`[im-qqbot] QQ gateway is still not ready after \${qqbotStartupWarnMs}ms; check DNS, TLS/proxy egress, and QQ Bot credentials/permissions\`);\n${indent}  }\n${indent}}, qqbotStartupWarnMs);\n${indent}qqbotStartupWatchdog.unref?.();\n${indent}console.log('[im-qqbot] requesting QQ gateway connection');\n${match[0]}\n${indent}  console.error(\`[im-qqbot] Bot start failed: \${err instanceof Error ? err.stack ?? err.message : String(err)}\`);`;
    },
    'gateway start trace',
    gatewayPath,
  );
}

await Promise.all([
  writeFile(indexPath, index),
  writeFile(gatewayPath, gateway),
]);
