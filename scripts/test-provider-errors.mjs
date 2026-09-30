// Offline classification and native outbound error-presentation regressions.
import assert from 'node:assert/strict';
import { mkdir, readlink, symlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const providerErrorsUrl = process.env.QQBOT_PROVIDER_ERRORS_MODULE
    ? pathToFileURL(resolve(process.env.QQBOT_PROVIDER_ERRORS_MODULE)).href
    : new URL('../defaults/qqbot-provider-errors.mjs', import.meta.url).href;
const { classifyProviderFailure, formatProviderFailure, formatToolFailure } = await import(providerErrorsUrl);
const sensitive = 'sk-test-secret request-secret-id https://private.example/token?key=secret rejected-private-prompt';
const apiFailure = (status, detail = {}, code = 'INVALID_REQUEST') => ({
    code,
    message: `OpenAI API error (${status}): ${JSON.stringify({ message: sensitive, ...detail })}`,
});
const assertSafe = (text) => {
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0 && text.length < 500, 'a bounded fixed notice is returned');
    assert.doesNotMatch(text, /sk-test-secret|request-secret-id|private\.example|rejected-private-prompt|OpenAI API error|INVALID_REQUEST|insufficient_quota/u);
};

test('native stable codes receive category-specific fixed notices without raw error details', () => {
    const codes = {
        QUOTA: 'quota', ACCOUNT_QUOTA: 'quota',
        AUTH: 'auth', MISSING_CREDENTIAL: 'auth', INVALID_CREDENTIAL: 'auth',
        RATE_LIMIT: 'rate-limit', SERVER: 'server', TIMEOUT: 'timeout', TRANSPORT: 'network',
        CONTEXT_WINDOW_EXCEEDED: 'context', EMPTY_RESPONSE: 'empty',
        NO_ADAPTER: 'config', NO_PROVIDER: 'config', NO_MODEL: 'config',
        INVALID_REQUEST: 'invalid', UNKNOWN: 'generic',
    };
    for (const [code, category] of Object.entries(codes)) {
        const failure = { code, message: sensitive };
        assert.equal(classifyProviderFailure(failure), category, code);
        assertSafe(formatProviderFailure(failure));
        assert.equal(formatProviderFailure(failure), formatProviderFailure({ code, message: 'different raw details' }),
            `${code} uses a fixed notice, not templated provider text`);
    }
});

test('HTTP status fallbacks distinguish quota, auth, model configuration and temporary failures', () => {
    const statuses = {
        400: 'invalid', 401: 'auth', 402: 'quota', 403: 'auth', 404: 'config',
        408: 'timeout', 409: 'busy', 413: 'too-large', 422: 'invalid',
        429: 'rate-limit', 500: 'server', 502: 'server', 503: 'server', 504: 'server',
    };
    for (const [status, category] of Object.entries(statuses)) {
        const failure = apiFailure(Number(status));
        assert.equal(classifyProviderFailure(failure), category, status);
        assertSafe(formatProviderFailure(failure));
    }
});

test('structured provider quota and context codes override generic HTTP categories', () => {
    const fixtures = [
        [429, { code: 'insufficient_quota' }, 'quota'],
        [429, { error: { type: 'insufficient_quota', message: sensitive } }, 'quota'],
        [400, { error: { code: 'context_length_exceeded', message: sensitive } }, 'context'],
        [400, { code: 'content_filter' }, 'moderation'],
        [400, { error: { code: 'content_filter', message: sensitive } }, 'moderation'],
        [400, { code: 'invalid_prompt' }, 'invalid'],
        [400, { code: 'invalid_api_key' }, 'auth'],
        [400, { error: { code: 'permission_denied', message: sensitive } }, 'auth'],
        [400, { code: 'model_not_found' }, 'config'],
        [400, { error: { type: 'server_error', message: sensitive } }, 'server'],
        [429, { error: { code: 'rate_limit_exceeded', message: sensitive } }, 'rate-limit'],
    ];
    for (const [status, detail, category] of fixtures) {
        const failure = apiFailure(status, detail);
        assert.equal(classifyProviderFailure(failure), category, JSON.stringify(detail));
        assertSafe(formatProviderFailure(failure));
    }
    assert.match(formatProviderFailure(apiFailure(429, { code: 'insufficient_quota' })), /管理员|充值/u);
    assert.match(formatProviderFailure(apiFailure(503)), /稍后|重试|再试/u);
});

test('structured status and provider error identifiers work without an HTTP message envelope', () => {
    const fixtures = [
        [{ code: 'UNKNOWN', status: 429, error: { code: 'insufficient_quota', message: sensitive } }, 'quota'],
        [{ code: 'UNKNOWN', status: 429, message: sensitive }, 'rate-limit'],
        [{ code: 'UNKNOWN', status: 402, message: sensitive }, 'quota'],
        [{ code: 'UNKNOWN', status: 401, message: sensitive }, 'auth'],
        [{ code: 'UNKNOWN', status: 503, message: sensitive }, 'server'],
        [{ code: 'UNKNOWN', status: 400, error: { code: 'context_length_exceeded', message: sensitive } }, 'context'],
        [{ code: 'UNKNOWN', status: 400, error: { code: 'content_filter', message: sensitive } }, 'moderation'],
        [{ code: 'UNKNOWN', status: 400, error: { code: 'invalid_prompt', message: sensitive } }, 'invalid'],
        [{ code: 'UNKNOWN', status: 400, error: { code: 'invalid_api_key', message: sensitive } }, 'auth'],
        [{ code: 'UNKNOWN', status: 400, error: { type: 'permission_denied', message: sensitive } }, 'auth'],
        [{ code: 'UNKNOWN', status: 400, error: { code: 'model_not_found', message: sensitive } }, 'config'],
        [{ code: 'UNKNOWN', status: 400, error: { type: 'server_error', message: sensitive } }, 'server'],
    ];
    for (const [failure, category] of fixtures) {
        assert.equal(classifyProviderFailure(failure), category, JSON.stringify(failure));
        assertSafe(formatProviderFailure(failure));
    }
    for (const status of ['429', 429.5, Number.NaN, 0, 999]) {
        assert.equal(classifyProviderFailure({ code: 'UNKNOWN', status, message: sensitive }), 'generic',
            'invalid status shapes must not produce an HTTP classification');
    }
});

test('provider text is not scanned for quota or moderation keywords', () => {
    for (const message of [
        'insufficient_quota balance exhausted',
        '余额不足，请充值',
        'Content Exists Risk',
        sensitive,
    ]) {
        assert.equal(classifyProviderFailure({ code: 'UNKNOWN', message }), 'generic');
        assert.equal(classifyProviderFailure(apiFailure(429, { message })), 'rate-limit',
            'an unstructured 429 message must not be mistaken for a quota error');
        assertSafe(formatProviderFailure({ code: 'UNKNOWN', message }));
    }
});

test('structured error parsing is bounded and anchored; malformed messages stay safely generic or invalid', () => {
    const valid = apiFailure(429, { code: 'insufficient_quota' }).message;
    const malformed = [
        `prefix ${valid}`, `${valid} suffix`,
        'OpenAI API error (429): {broken-json}',
        'OpenAI API error (429): null',
        'OpenAI API error (429): []',
        'OpenAI API error (429): "insufficient_quota"',
        'OpenAI API error (429): {"error":{"code":{"nested":"insufficient_quota"}}}',
        `${valid}${' '.repeat(16 * 1024)}`,
        `OpenAI API error (429): ${JSON.stringify({ code: 'insufficient_quota', message: sensitive.repeat(300) })}`,
    ];
    for (const message of malformed) {
        const category = classifyProviderFailure({ code: 'UNKNOWN', message });
        assert.notEqual(category, 'quota', 'malformed/unbounded data cannot produce a quota classification');
        assertSafe(formatProviderFailure({ code: 'UNKNOWN', message }));
    }
    for (const failure of [undefined, null, {}, { message: sensitive }, { code: 'UNKNOWN', message: { text: sensitive } }]) {
        assert.equal(classifyProviderFailure(failure), 'generic');
        assertSafe(formatProviderFailure(failure));
    }
});

const adapterDist = process.env.QQBOT_ADAPTER_DIST;
const integration = adapterDist ? test : test.skip;
async function prepareAdapterPeers() {
    const dshRoot = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/';
    const profilePeers = '/data/profiles/qqbot/node_modules/@deepseek-ai';
    await mkdir(dirname(profilePeers), { recursive: true });
    try { await symlink(dshRoot, profilePeers, 'dir'); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await readlink(profilePeers);
        assert.equal(resolve(dirname(profilePeers), existing), resolve(dshRoot));
    }
}

integration('native turn failures use fixed notices and do not leak raw API errors or reset ordinary failures', async () => {
    await prepareAdapterPeers();
    const { createOutboundHandler } = await import(`${resolve(adapterDist)}/transport/outbound.js`);
    const record = {
        sessionId: 'friendly-errors-session', scope: 'c2c', peerId: 'peer', agent: {},
        replyTarget: { scope: 'c2c', targetId: 'peer', msgId: 'source' },
    };
    const sent = [];
    let resets = 0;
    const handler = createOutboundHandler({
        findBySessionId(id) { return id === record.sessionId ? record : undefined; },
        getSessionRecord() { return record; },
        async remove() { resets++; return true; },
    }, { async sendMarkdown(target, text) { sent.push({ target, text }); } }, {
        textChunkLimit: 2000, streaming: false, showToolResults: false,
    }, { info() {}, debug() {}, warn() {}, error() {} }, {});
    const failures = [
        apiFailure(429, { error: { code: 'insufficient_quota', message: sensitive } }),
        apiFailure(429), apiFailure(401), apiFailure(503), apiFailure(400),
        apiFailure(400, { code: 'content_filter' }),
        { code: 'UNKNOWN', status: 429, error: { code: 'insufficient_quota', message: sensitive }, message: sensitive },
        { code: 'UNKNOWN', status: 503, message: sensitive },
        { code: 'TRANSPORT', message: sensitive }, { code: 'UNKNOWN', message: sensitive },
    ];
    for (const failure of failures) {
        const before = sent.length;
        handler({ header: { id: record.sessionId } }, {
            type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: failure } },
        });
        await new Promise((resolvePromise) => setImmediate(resolvePromise));
        assert.equal(sent.length, before + 1);
        assert.equal(sent.at(-1).text, formatProviderFailure(failure));
        assertSafe(sent.at(-1).text);
        assert.equal(sent.at(-1).target, record.replyTarget);
    }
    assert.equal(resets, 0, 'friendly presentation must not broaden automatic reset criteria');
});

integration('native tool error events and isError content blocks never present raw payloads, including with tool results enabled', async () => {
    await prepareAdapterPeers();
    const { createOutboundHandler } = await import(`${resolve(adapterDist)}/transport/outbound.js`);
    for (const showToolResults of [false, true]) {
        const sent = [];
        const record = { sessionId: `tool-failure-${showToolResults}`, agent: {}, replyTarget: { scope: 'c2c', targetId: 'peer' } };
        const handler = createOutboundHandler({ findBySessionId() { return record; } }, {
            async sendMarkdown(_target, text) { sent.push(text); },
        }, { textChunkLimit: 2000, streaming: false, showToolResults }, {
            info() {}, debug() {}, warn() {}, error() {},
        }, {});
        const errorShapes = [
            { error: { code: 'INVALID_REQUEST', message: sensitive } },
            { content: [{ type: 'tool-result', isError: true, content: [{ type: 'text', text: sensitive }] }] },
        ];
        for (const [index, shape] of errorShapes.entries()) {
            const callId = `unsafe-error-${index}`;
            handler({ header: { id: record.sessionId } }, {
                type: 'tool/call', data: { callId, name: 'web_search', arguments: JSON.stringify({ query: sensitive }) },
            });
            handler({ header: { id: record.sessionId } }, {
                type: 'tool/result', data: {
                    error: shape.error,
                    message: { source: { callId }, content: shape.content ?? [{ type: 'text', text: sensitive }] },
                },
            });
            await new Promise((resolvePromise) => setImmediate(resolvePromise));
            assert.equal(sent.length, index + 1, 'an explicit tool failure is presented even when result display is off');
            assertSafe(sent[index]);
            assert.equal(sent[index], formatToolFailure());
        }
    }
});

integration('native successful assistant text remains unchanged instead of being classified from pasted errors', async () => {
    await prepareAdapterPeers();
    const { createOutboundHandler } = await import(`${resolve(adapterDist)}/transport/outbound.js`);
    const sent = [];
    const record = { sessionId: 'success-text', agent: {}, replyTarget: { scope: 'c2c', targetId: 'peer' } };
    const handler = createOutboundHandler({ findBySessionId() { return record; } }, {
        async sendMarkdown(_target, text) { sent.push(text); },
    }, { textChunkLimit: 2000, streaming: false, showToolResults: false }, {
        info() {}, debug() {}, warn() {}, error() {},
    }, {});
    const text = '主人，骰点是 18。你刚才提到的是 insufficient_quota 错误。';
    handler({ header: { id: record.sessionId } }, {
        type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } },
    });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.deepEqual(sent, [text]);
});

integration('native successful tool results retain their existing display behavior', async () => {
    await prepareAdapterPeers();
    const { createOutboundHandler } = await import(`${resolve(adapterDist)}/transport/outbound.js`);
    for (const showToolResults of [false, true]) {
        const sent = [];
        const record = { sessionId: 'successful-tool', agent: {}, replyTarget: { scope: 'c2c', targetId: 'peer' } };
        const handler = createOutboundHandler({ findBySessionId() { return record; } }, {
            async sendMarkdown(_target, text) { sent.push(text); },
        }, { textChunkLimit: 2000, streaming: false, showToolResults }, {
            info() {}, debug() {}, warn() {}, error() {},
        }, {});
        const callId = 'successful-call';
        const text = 'd20: d20[18] = 18';
        handler({ header: { id: record.sessionId } }, {
            type: 'tool/call', data: { callId, name: 'qqbot_roll_dice', arguments: '{"expression":"d20"}' },
        });
        handler({ header: { id: record.sessionId } }, {
            type: 'tool/result', data: { message: {
                source: { callId }, content: [{ type: 'tool-result', isError: false, content: [{ type: 'text', text }] }],
            } },
        });
        await new Promise((resolvePromise) => setImmediate(resolvePromise));
        assert.deepEqual(sent, showToolResults ? [`🔧 \`qqbot_roll_dice\` 完成\n${text}`] : []);
    }
});

integration('native outbound send failures log fixed diagnostics instead of raw QQ errors', async () => {
    await prepareAdapterPeers();
    const { createOutboundHandler } = await import(`${resolve(adapterDist)}/transport/outbound.js`);
    const record = { sessionId: 'send-failure', agent: {}, replyTarget: { scope: 'c2c', targetId: 'peer' } };
    const diagnostics = [];
    let sends = 0;
    const handler = createOutboundHandler({ findBySessionId() { return record; } }, {
        async sendMarkdown() { sends++; throw new Error(sensitive); },
    }, { textChunkLimit: 2000, streaming: false, showToolResults: false }, {
        info() {}, debug() {}, warn(...args) { diagnostics.push(args); }, error(...args) { diagnostics.push(args); },
    }, {});
    handler({ header: { id: record.sessionId } }, {
        type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: apiFailure(503) } },
    });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(sends, 1, 'failed QQ sends do not retry the model or replay the error notice');
    assert.ok(diagnostics.length > 0, 'a bounded operational failure diagnostic is retained');
    assert.doesNotMatch(JSON.stringify(diagnostics), /sk-test-secret|request-secret-id|private\.example|rejected-private-prompt/u);
});

integration('native followup or whenIdle failures revoke grants and do not log sensitive provider payloads', async () => {
    await prepareAdapterPeers();
    const { handleInbound } = await import(`${resolve(adapterDist)}/transport/inbound.js`);
    const scopePath = process.env.QQBOT_DOCUMENT_SCOPE_MODULE ?? '/opt/qqbot-defaults/qqbot-document-scope.mjs';
    const { getDocumentTurn } = await import(pathToFileURL(resolve(scopePath)).href);
    for (const failureStage of ['followup', 'whenIdle']) {
        const diagnostics = [];
        const agent = {
            followup() { if (failureStage === 'followup') throw new Error(sensitive); },
            async whenIdle() { if (failureStage === 'whenIdle') throw new Error(sensitive); },
        };
        const record = { agent, sessionId: `sensitive-${failureStage}` };
        const manager = { async getOrCreate() { return record; }, getSessionRecord() { return record; } };
        await handleInbound({
            message: { kind: 'c2c', senderId: 'log-peer', messageId: 'log-message', content: 'harmless fixture question' },
            state: {}, bot: { async sendMarkdown() {} },
        }, manager, { appId: 'log-fixture' }, {
            info() {}, debug() {}, warn(...args) { diagnostics.push(args); }, error(...args) { diagnostics.push(args); },
        });
        assert.equal(getDocumentTurn(agent), undefined, 'error formatting does not interfere with grant cleanup');
        assert.ok(diagnostics.length > 0);
        assert.doesNotMatch(JSON.stringify(diagnostics), /sk-test-secret|request-secret-id|private\.example|rejected-private-prompt/u);
    }
});

integration('an unbound exact moderation event stays silent and cannot reset a current session', async () => {
    await prepareAdapterPeers();
    const { createOutboundHandler } = await import(`${resolve(adapterDist)}/transport/outbound.js`);
    const sent = [];
    let resets = 0;
    const record = { sessionId: 'unbound-risk', agent: {}, replyTarget: { scope: 'c2c', targetId: 'peer' } };
    const handler = createOutboundHandler({
        findBySessionId() { return record; }, getSessionRecord() { return record; },
        async remove() { resets++; return true; },
    }, { async sendMarkdown(_target, text) { sent.push(text); } }, {
        textChunkLimit: 2000, streaming: false, showToolResults: false,
    }, { info() {}, debug() {}, warn() {}, error() {} }, {});
    handler({ header: { id: record.sessionId } }, {
        type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: {
            code: 'INVALID_REQUEST',
            message: `OpenAI API error (400): ${JSON.stringify({ message: `Content Exists Risk (requestid: ${sensitive})` })}`,
        } } },
    });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.deepEqual(sent, []);
    assert.equal(resets, 0);
});
