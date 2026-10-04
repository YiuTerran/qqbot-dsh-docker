import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// This compatibility script only removes the former local group-history
// projection from a DSH runtime prepared by the old patcher. It never installs
// a model input filter and is intentionally not copied into new images.
const root = process.argv[2];
if (!root) throw new Error('usage: enforce-model-context.mjs <dsh-node-modules-directory>');
const packageVersion = '0.1.7-rc.2';
const policy = '/opt/qqbot-defaults/qqbot-model-context.mjs';

async function restorePackage(name, originalLine, replacementLine, marker, importName) {
    const pkg = join(root, name);
    const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
    if (manifest.version !== packageVersion) {
        throw new Error(`Removing the legacy group context patch requires ${name}@${packageVersion}.`);
    }
    const file = join(pkg, 'lib/index.js');
    let source = await readFile(file, 'utf8');
    const importLine = `import { ${importName} } from '${policy}';`;
    const replacement = `${marker}\n${replacementLine}`;
    if (source.includes(marker)) {
        if (source.split(marker).length !== 2 || source.split(importLine).length !== 2
            || source.split(replacement).length !== 2) {
            throw new Error(`Legacy group context patch is incomplete in ${name}.`);
        }
        source = source.replace(replacement, originalLine);
        source = source.replace(`${importLine}\n`, '');
        await writeFile(file, source);
    }
    else if (source.includes(importLine) || source.includes(importName)
        || source.includes(replacementLine)) {
        throw new Error(`Legacy group context patch is partial in ${name}.`);
    }
}

await restorePackage(
    'dsh-agent-loop',
    '\t\tconst boundaryMessages = session.deriveMessages();',
    '\t\tconst boundaryMessages = projectGroupModelMessages(this, session.deriveMessages());',
    '// Chat-only group model input v1.',
    'projectGroupModelMessages',
);
await restorePackage(
    'dsh-compaction-basic',
    '\tasync compactIfNeeded(agent, trigger, signal) {',
    '\tasync compactIfNeeded(agent, trigger, signal) {\n\t\tif (isGroupModelContextGuarded(agent)) return null;',
    '// Chat-only group compaction guard v1.',
    'isGroupModelContextGuarded',
);
