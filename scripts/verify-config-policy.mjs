// Check complete entry blocks, not a fixed number of lines from an upstream ID.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(process.argv[2], 'utf8');
function entry(id) {
    const blocks = source.split(/(?=^- id: )/mu).filter(block => block.startsWith(`- id: ${id}\n`));
    assert.equal(blocks.length, 1, `expected exactly one ${id} entry`);
    return blocks[0].split('\n');
}
function field(id, line) { assert.ok(entry(id).includes(line), `${id} must include ${line.trim()}`); }
for (const id of ['tool-bash', 'tool-fs', 'tool-subagent', 'ptc-runtime', 'web-fetch-http', 'tool-executor-ptc']) field(id, '  disabled: true');
field('tool-executor-native', '  disabled: false');
assert.ok(!entry('tools').some(line => /^\s+mode: (native|ptc)\s*$/u.test(line)), 'obsolete tool mode remained');
for (const line of ['    searchProvider: deepseek-official', '    fetchProvider: qqbot-pages']) field('web', line);
for (const line of ['    searchMaxResults: 8', '    searchMaxQueries: 4', '    searchTimeoutMs: 60000', '    fetch: true']) field('tool-web', line);
field('web-search-deepseek', '    maxUses: 0');
field('agent-loop', '    agents: []');
for (const line of ['    appId: __FROM_ENV__', '    appSecret: __FROM_ENV__', '    sendPresentedFiles: false']) {
    assert.equal(entry('im-qqbot').filter(value => value === line).length, 1, `immutable QQ config must contain ${line.trim()} exactly once`);
}
console.log('Final native executor and chat-only configuration verified');
