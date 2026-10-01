import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('usage: enforce-model-context.mjs <dsh-node-modules-directory>');
const packageVersion = '0.1.7-rc.2';
const policy = '/opt/qqbot-defaults/qqbot-model-context.mjs';

async function patchPackage(name, needle, replacement, marker) {
    const pkg = join(root, name);
    const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
    if (manifest.version !== packageVersion) {
        throw new Error(`Group model context requires ${name}@${packageVersion}.`);
    }
    const file = join(pkg, 'lib/index.js');
    const original = await readFile(file, 'utf8');
    const importLine = `import { ${name === 'dsh-agent-loop' ? 'projectGroupModelMessages' : 'isGroupModelContextGuarded'} } from '${policy}';`;
    if (original.includes(marker)) {
        if (original.split(marker).length !== 2
            || original.split(importLine).length !== 2
            || original.split(replacement).length !== 2) {
            throw new Error(`Group model context patch is incomplete in ${name}.`);
        }
        return;
    }
    if (original.split(needle).length !== 2) {
        throw new Error(`Group model context expected one matching location in ${name}.`);
    }
    if (original.includes(importLine)) throw new Error(`Group model context import already exists in ${name}.`);
    const updated = `${importLine}\n${original.replace(needle, `${marker}\n${replacement}`)}`;
    await writeFile(file, updated);
}

await patchPackage('dsh-agent-loop',
    '\t\tconst boundaryMessages = session.deriveMessages();',
    '\t\tconst boundaryMessages = projectGroupModelMessages(this, session.deriveMessages());',
    '// Chat-only group model input v1.');
await patchPackage('dsh-compaction-basic',
    '\tasync compactIfNeeded(agent, trigger, signal) {',
    '\tasync compactIfNeeded(agent, trigger, signal) {\n\t\tif (isGroupModelContextGuarded(agent)) return null;',
    '// Chat-only group compaction guard v1.');
