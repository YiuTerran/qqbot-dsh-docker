// Opt-in, paid LLM comprehension smoke test. No QQ delivery or backend commands.
// Run with the deployment's LLM_* environment in the built image.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createCapabilityRegistry, capabilityRuntimeContext } from '/opt/qqbot-defaults/qqbot-capabilities.mjs';
const protocol = process.env.LLM_API_PROTOCOL || 'openai-responses';
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL;
const output = process.argv[2];
if (!apiKey || !model || !process.env.LLM_API_BASE_URL || !output
    || !['openai-responses', 'openai-completions'].includes(protocol)) {
    throw new Error('Provide LLM_API_KEY, LLM_MODEL, LLM_API_BASE_URL, a supported LLM_API_PROTOCOL and an output path.');
}
const url = new URL(process.env.LLM_API_BASE_URL.replace(/\/+$/u, '') + (protocol === 'openai-responses' ? '/responses' : '/chat/completions'));
if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid configured model endpoint');
const registry = createCapabilityRegistry();
registry.setOnebotProvider(() => ({ configured: 'disabled', reason: 'config-disabled' }));
const snapshot = registry.getSnapshot({ toolSchemas: [] }).snapshot;
const system = '你是 QQ bot。简洁回答用户；只依据当前明确的能力状态判断可调用能力。\n' + capabilityRuntimeContext(snapshot).text;
const cases = [
    { name: 'userid-disabled', prompt: '.userid', check: /未启用|未开启|未开通/u },
    { name: 'capability-question', prompt: '你现在能调用 OneBot 和海豹骰吗？你有哪些能力？', check: /未启用|未开启|不可用|无法|不能/u },
    { name: 'userid-help', prompt: '.userid 是什么命令，怎么用？只解释用法，不要执行。', check: /虚拟|身份/u },
];
const evidence = { backend: 'not-deployed-for-this-probe', qqDelivery: false, snapshot, results: [] };
for (const scenario of cases.filter((entry) => !process.argv[3] || entry.name === process.argv[3])) {
    const messages = [{ role: 'system', content: system },
        { role: 'user', content: '上次你说海豹骰已经连好了。' },
        { role: 'assistant', content: '我可以调用海豹骰查询身份。' },
        { role: 'user', content: scenario.prompt }];
    const body = protocol === 'openai-responses'
        ? { model, input: messages, max_output_tokens: 1200, store: false }
        : { model, messages, max_tokens: 1200 };
    let response;
    try {
        response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
            headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch { throw new Error(`Capability smoke request failed: ${scenario.name}`); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Capability smoke HTTP ${response.status}: ${scenario.name}`); }
    const result = await response.json();
    const text = protocol === 'openai-responses'
        ? (result.output ?? []).flatMap((entry) => entry.content ?? []).filter((entry) => entry.type === 'output_text').map((entry) => entry.text).join('\n')
        : result.choices?.[0]?.message?.content ?? '';
    const toolCalls = protocol === 'openai-responses' ? (result.output ?? []).filter((entry) => entry.type === 'function_call')
        : result.choices?.[0]?.message?.tool_calls ?? [];
    assert.equal(toolCalls.length, 0, `${scenario.name} must not execute a tool`);
    assert.match(text, scenario.check, `${scenario.name} did not acknowledge the capability boundary`);
    assert.doesNotMatch(text, /已执行|已经执行|已经卸载|已卸载/u);
    evidence.results.push({ name: scenario.name, prompt: scenario.prompt, text });
    console.log(`${scenario.name}: passed`);
}
await writeFile(output, JSON.stringify(evidence, null, 2), { mode: 0o600 });
