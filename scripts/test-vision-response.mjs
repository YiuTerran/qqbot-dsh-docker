import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readVisionResponse } from '/opt/qqbot-defaults/qqbot-vision-response.mjs';
import { BlockAssembler } from '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
function response({ text = '', finish = 'stop' } = {}) {
    const assembler = new BlockAssembler();
    assembler.push({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'PRIVATE_REASONING' } });
    if (text) assembler.push({ type: 'block-end', index: 1, block: { type: 'text', text } });
    assembler.push({ type: 'usage', usage: { inputTokens: 10, outputTokens: 1024, reasoningTokens: 996 } });
    assembler.push({ type: 'finish', reason: { kind: finish } });
    return assembler;
}
test('reasoning-only and partial visual answers report output exhaustion without retrying or blaming image loading', () => {
    for (const text of ['', 'Unfinished description']) {
        assert.throws(() => readVisionResponse(response({ text, finish: 'max-tokens' })), error => {
            assert.equal(error.code, 'VISION_OUTPUT_LIMIT');
            assert.match(error.message, /image loaded successfully/u);
            assert.match(error.message, /do not automatically retry/iu);
            assert.doesNotMatch(error.message, /PRIVATE_REASONING|Unfinished description/u);
            return true;
        });
    }
});
test('a normal finish without visible text is distinct from truncation; reasoning is never returned as the answer', () => {
    assert.throws(() => readVisionResponse(response()), { code: 'VISION_EMPTY_RESPONSE' });
    assert.equal(readVisionResponse(response({ text: '  The character is centered.  ' })), 'The character is centered.');
});
test('vision diagnostics expose only bounded numeric image and response statistics', () => {
    const before = process.env.QQBOT_IMAGE_DEBUG;const info = console.info;const logs = [];
    process.env.QQBOT_IMAGE_DEBUG = 'true';console.info = line => logs.push(line);
    try {
        readVisionResponse(response({ text: 'SECRET_VISUAL_TEXT' }), { bytes: 12345, width: 1024, height: 768,
            attachmentId: 'SECRET_ID', url: 'https://secret.example?rkey=SECRET_KEY' });
        assert.equal(logs.length, 1);
        assert.doesNotMatch(logs[0], /SECRET|https:|rkey|PRIVATE_REASONING/u);
        const event = JSON.parse(logs[0].slice('[qqbot-vision] '.length));
        assert.deepEqual(event, { stage: 'model-response', finish: 'stop', textChars: 18,
            bytes: 12345, width: 1024, height: 768, outputTokens: 1024, reasoningTokens: 996 });
    } finally {
        console.info = info;if(before===undefined)delete process.env.QQBOT_IMAGE_DEBUG;else process.env.QQBOT_IMAGE_DEBUG=before;
    }
});
