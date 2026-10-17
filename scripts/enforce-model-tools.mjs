import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('usage: enforce-model-tools.mjs <dsh-llm-directory>');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (manifest.version !== '0.2.1-rc.2') throw new Error('QQ tool projection requires dsh-llm 0.2.1-rc.2.');
const path = join(root, 'lib/index.js');
const anchor = 'function projectToolUpdates(messages, tools, toolUpdate, history) {';
const marker = '// QQ bot: revoked tool declarations must not survive historical projection.';
const replacement = `${anchor}
\t${marker}
\tif (messages.some(message => message.source?.kind === "runtime-context"
\t\t&& message.source.sections?.some(section => section.name === "qqbot:capabilities"))) {
\t\tconst active = new Set((tools ?? []).map(tool => tool.name));
\t\tconst historical = [...history?.tools ?? [], ...(history?.updates ?? []).flatMap(update => update.additions)];
\t\t// Use the upstream full-current-declarations path when history contains a revoked tool.
\t\tif (historical.some(tool => !active.has(tool.name))) toolUpdate = void 0;
\t}`;
let source = await readFile(path, 'utf8');
const alreadyPatched = source.includes(marker);
if (!alreadyPatched) {
    if (source.split(anchor).length !== 2) throw new Error('QQ tool projection source layout changed.');
    source = source.replace(anchor, replacement);
}
if (source.split(replacement).length !== 2 || source.split(marker).length !== 2) throw new Error('Incomplete or duplicated QQ tool projection patch.');
if (!alreadyPatched) await writeFile(path, source);
