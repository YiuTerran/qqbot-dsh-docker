import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('usage: enforce-web-search.mjs <dsh-web-search-deepseek-directory>');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (manifest.version !== '0.1.7-rc.2') throw new Error('Search patch requires dsh-web-search-deepseek 0.1.7-rc.2.');
const path = join(root, 'lib/index.js');
const marker = '// QQ bot: maxUses=0 omits the native search-use cap.';
const changes = [
    ['isPositiveInteger(options.maxUses);', '(options.maxUses === 0 || isPositiveInteger(options.maxUses));'],
    ['max_uses: options.maxUses', '...(options.maxUses === 0 ? {} : { max_uses: options.maxUses })'],
    ['maxUses: z.number().step(1).min(1).default(5).volatile()', 'maxUses: z.number().step(1).min(0).default(5).volatile()'],
];
let source = await readFile(path, 'utf8');
const alreadyPatched = source.includes(marker);
if (!alreadyPatched) {
    for (const [before, after] of changes) {
        if (source.split(before).length !== 2) throw new Error('Search patch layout changed; refusing to guess.');
        source = source.replace(before, after);
    }
    source = `${marker}\n${source}`;
}
if (source.split(marker).length !== 2 || changes.some(([, after]) => source.split(after).length !== 2)) {
    throw new Error('Search patch is missing, duplicated or incomplete.');
}
if (!alreadyPatched) await writeFile(path, source);
