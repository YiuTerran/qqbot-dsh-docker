import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const moduleRoot = process.env.QQBOT_ONEBOT_MODULE_ROOT ?? new URL('../defaults/', import.meta.url).pathname;
const { createOnebotLogCapture, createOnebotLogCaptureMiddleware, attachOnebotDeliveryObserver } = await import(
    new URL('qqbot-onebot-log.mjs', `file://${moduleRoot.replace(/\/$/u, '')}/`).href);
const { createMergeConcurrencyGuard } = await import(new URL('qqbot-concurrency.mjs',
    `file://${moduleRoot.replace(/\/$/u, '')}/`).href);

const { normalizeOnebotLogText } = await import(new URL('qqbot-log-text.mjs',
    `file://${moduleRoot.replace(/\/$/u, '')}/`).href);

const backendId = 'sealdice';
const appId = '123456';
const currentMessageTimestamp = new Date().toISOString();
const groupBackend = [{ id: backendId, ready: true, capabilities: ['log-capture-v1', 'artifact-v1'] }];

function config() {
    return {
        enabled: true,
        logEnabled: true,
        backendIds: [backendId],
        url: new URL('http://bridge.test/mcp'),
        internalToken: 'internal-test-token',
    };
}

function message(options = {}) {
    const group = options.group ?? 'group-a';
    const user = options.user ?? 'user-a';
    const id = options.id ?? 'source-id-001';
    const content = Object.hasOwn(options, 'content') ? options.content : 'hello';
    const timestamp = options.timestamp ?? currentMessageTimestamp;
    const attachments = options.attachments;
    return {
        kind: 'group',
        groupOpenid: group,
        senderId: user,
        messageId: id,
        replyTarget: { scope: 'group', targetId: group, msgId: id },
        timestamp,
        content: 'SDK-rendered content must not be used',
        raw: {
            id,
            timestamp,
            group_openid: group,
            author: { member_openid: user, username: '🌏'.repeat(24), bot: true },
            ...(content !== undefined ? { content } : {}),
            ...(attachments !== undefined ? { attachments } : {}),
        },
    };
}

function accepted() {
    return new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
    });
}

async function waitFor(predicate, messageText = 'condition not reached') {
    const end = Date.now() + 3000;
    while (Date.now() < end) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(messageText);
}

async function makeService(directory, fetchImpl, name = 'queue.json') {
    const filePath = join(directory, name);
    const service = createOnebotLogCapture({
        config: config(), appId,
        options: { filePath, fetchImpl, requestTimeoutMs: 1000 },
    });
    return { service, filePath };
}

test('captures raw no-mention group events and attachment placeholders, with identities bound to group', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-'));
    const received = [];
    const { service } = await makeService(directory, async (_url, init) => {
        received.push(JSON.parse(init.body));
        return accepted();
    });
    try {
        service.setBackends(groupBackend);
        const first = message({ group: 'group-a', id: 'same-opaque-id', content: 'raw body only' });
        first.content = 'not raw';
        first.raw.quote = { content: 'must not be captured' };
        await service.captureRaw({ message: first, state: { quote: { content: 'quoted text' } } });
        const second = message({ group: 'group-b', id: 'same-opaque-id', content: undefined,
            attachments: [{ content_type: 'image/png', url: 'https://private.example/image' }] });
        await service.captureRaw({ message: second });
        await waitFor(() => received.length === 2, 'both group messages must be accepted');
        assert.notEqual(received[0].event_id, received[1].event_id, 'stable event ID includes group key');
        assert.equal(received[0].group_key, `${appId}:group-a`);
        assert.equal(received[0].user_key, `${appId}:user-a`);
        assert.equal(received[0].text, 'raw body only');
        assert.equal(received[0].is_bot, true, 'other bot messages remain capturable');
        assert.equal(Array.from(received[0].nickname).length, 24, 'nickname limit counts Unicode codepoints');
        assert.equal(received[1].text, '[image attachment]');
        assert.equal(JSON.stringify(received).includes('private.example'), false, 'attachment URLs never enter the capture event');
        assert.equal(JSON.stringify(received).includes('quoted text'), false, 'quote/history content is not used');
    }
    finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('sends bounded current-event display aliases only when bridge and backend negotiate log-display-v1', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-display-'));
    const received = [];
    const { service } = await makeService(directory, async (_url, init) => {
        received.push(JSON.parse(init.body));
        return accepted();
    });
    try {
        service.setBackends([{
            id: backendId, ready: true, capabilities: ['log-capture-v1', 'artifact-v1', 'log-display-v1'],
        }], ['log-display-v1']);
        const source = message({ id: 'display-current-event', content:
            'Hi [@子若](mqqapi://markdown/mention?at_type=1&at_tinyid=4011912066) <@member-openid-2>' });
        source.raw.mentions = [
            { member_openid: 'member-openid-2', user_openid: 'member-openid-2', id: '4011912066',
                tiny_id: '4011912066', username: '子若' },
        ];
        assert.equal(await service.captureRaw({ message: source }), true);
        await waitFor(() => received.length === 1);
        assert.deepEqual(received[0].display, {
            author_aliases: ['openid:user-a'],
            mentions: [
                { target: 'tinyid:4011912066', aliases: ['openid:member-openid-2', 'tinyid:4011912066'], name: '子若' },
                { target: 'openid:member-openid-2', aliases: ['openid:member-openid-2', 'tinyid:4011912066'], name: '子若' },
            ],
        });
        assert.equal(JSON.stringify(received[0].display).includes('mqqapi:'), false);
        assert.equal(JSON.stringify(received[0].display).includes('https:'), false);
    }
    finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('keeps conflicting SDK mention aliases anonymous instead of using the last record', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-display-ambiguous-'));
    const received = [];
    const { service } = await makeService(directory, async (_url, init) => {
        received.push(JSON.parse(init.body));
        return accepted();
    });
    try {
        service.setBackends([{
            id: backendId, ready: true, capabilities: ['log-capture-v1', 'log-display-v1'],
        }], ['log-display-v1']);

        const sharedTinyId = message({ id: 'display-conflicting-tinyid', content:
            '[@可疑目标](mqqapi://markdown/mention?at_type=1&at_tinyid=4011912066) <@person-a> <@person-b>' });
        sharedTinyId.raw.mentions = [
            { member_openid: 'person-a', tiny_id: '4011912066', username: '成员甲', is_bot: true },
            { member_openid: 'person-b', tiny_id: '4011912066', username: '成员乙' },
        ];
        assert.equal(await service.captureRaw({ message: sharedTinyId }), true);
        await waitFor(() => received.length === 1);
        const tinyTarget = received[0].display.mentions.find((item) => item.target === 'tinyid:4011912066');
        assert.deepEqual(tinyTarget, { target: 'tinyid:4011912066' },
            'ambiguous tiny ID must not inherit a label, identity link, or bot flag');
        assert.deepEqual(received[0].display.mentions.find((item) => item.target === 'openid:person-a'), {
            target: 'openid:person-a', aliases: ['openid:person-a'], name: '成员甲', is_bot: true,
        });

        const sharedOpenId = message({ id: 'display-conflicting-openid', content: '<@same-openid>' });
        sharedOpenId.raw.mentions = [
            { member_openid: 'same-openid', tiny_id: '4011912066', username: '旧名称' },
            { member_openid: 'same-openid', tiny_id: '4011912067', username: '新名称' },
        ];
        assert.equal(await service.captureRaw({ message: sharedOpenId }), true);
        await waitFor(() => received.length === 2);
        assert.deepEqual(received[1].display.mentions.find((item) => item.target === 'openid:same-openid'), {
            target: 'openid:same-openid',
        }, 'ambiguous openid must not inherit metadata from the last record');
    }
    finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('omits display metadata for old bridge or backend and drops oversized display without losing the event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-display-compat-'));
    const received = [];
    const { service } = await makeService(directory, async (_url, init) => {
        received.push(JSON.parse(init.body));
        return accepted();
    });
    try {
        service.setBackends([{
            id: backendId, ready: true, capabilities: ['log-capture-v1', 'log-display-v1'],
        }], []);
        const oldBridgeSource = message({ id: 'display-old-bridge', content:
            '[@子若](mqqapi://markdown/mention?at_type=1&at_tinyid=4011912066)' });
        assert.equal(await service.captureRaw({ message: oldBridgeSource }), true);
        await waitFor(() => received.length === 1);
        assert.equal(Object.hasOwn(received[0], 'display'), false);

        service.setBackends([{
            id: backendId, ready: true, capabilities: ['log-capture-v1'],
        }], ['log-display-v1']);
        const oldSeaSource = message({ id: 'display-old-backend', content:
            '[@子若](mqqapi://markdown/mention?at_type=1&at_tinyid=4011912066)' });
        assert.equal(await service.captureRaw({ message: oldSeaSource }), true);
        await waitFor(() => received.length === 2);
        assert.equal(Object.hasOwn(received[1], 'display'), false);

        service.setBackends([{
            id: backendId, ready: true, capabilities: ['log-capture-v1', 'log-display-v1'],
        }], ['log-display-v1']);
        const oversized = message({ id: 'display-over-limit', content: Array.from({ length: 64 }, (_, index) =>
            `[@x](mqqapi://markdown/mention?at_type=1&at_tinyid=${index + 1})`).join(' ') });
        oversized.raw.mentions = Array.from({ length: 64 }, (_, index) => ({
            member_openid: `member-${index + 1}`, tiny_id: String(index + 1), username: '鱼'.repeat(80),
        }));
        assert.equal(await service.captureRaw({ message: oversized }), true);
        await waitFor(() => received.length === 3);
        assert.equal(received[2].text, oversized.raw.content);
        assert.equal(Object.hasOwn(received[2], 'display'), false);
    }
    finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('invalid optional display metadata in a persisted queue is discarded without rejecting the message', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-display-queue-'));
    const filePath = join(directory, 'queue.json');
    const received = [];
    const event = {
        backend_id: backendId,
        event_id: 'persisted-invalid-display',
        group_key: `${appId}:group-a`,
        user_key: `${appId}:user-a`,
        time: Math.floor(Date.now() / 1000),
        nickname: '旧记录',
        text: '持久队列中的原消息',
        is_bot: false,
        kind: 'message',
        display: { author_aliases: ['bad-alias'], mentions: [] },
    };
    await writeFile(filePath, JSON.stringify({
        version: 1,
        appId,
        pending: [{ backendId, event }],
        gaps: [],
        groups: [[`${backendId}\u0000${appId}:group-a`, `${appId}:group-a`]],
        incomplete: false,
    }));
    const service = createOnebotLogCapture({
        config: config(), appId,
        options: { filePath, fetchImpl: async (_url, init) => {
            received.push(JSON.parse(init.body));
            return accepted();
        } },
    });
    try {
        service.setBackends([{
            id: backendId, ready: true, capabilities: ['log-capture-v1', 'log-display-v1'],
        }], ['log-display-v1']);
        await waitFor(() => received.some((item) => item.event_id === event.event_id) || service.diagnostics().initError,
            `invalid-display queue did not drain: ${JSON.stringify(service.diagnostics())}`);
        const posted = received.find((item) => item.event_id === event.event_id);
        assert.ok(posted, `invalid-display queue did not post: ${JSON.stringify(service.diagnostics())}`);
        assert.equal(posted.text, event.text);
        assert.equal(Object.hasOwn(posted, 'display'), false);
        const state = JSON.parse(await readFile(filePath, 'utf8'));
        assert.equal(state.pending.length, 0);
    }
    finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('suppresses only ACK-matched own echoes in the same group and records only confirmed group sends', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-'));
    const received = [];
    const { service } = await makeService(directory, async (_url, init) => {
        received.push(JSON.parse(init.body));
        return accepted();
    });
    try {
        service.setBackends(groupBackend);
        await service.recordBotDelivery({ target: { scope: 'group', targetId: 'group-a' }, status: 'sent', messageId: 'opaque-sent-id', text: 'confirmed output' });
        const ownEcho = message({ group: 'group-a', id: 'opaque-sent-id', content: 'confirmed output' });
        assert.equal(service.isOwnEcho(ownEcho.raw, `${appId}:group-a`), true);
        assert.equal(await service.captureRaw({ message: ownEcho }), false);
        assert.equal(await service.captureRaw({ message: ownEcho }), false, 'a replayed own echo stays suppressed');
        const coincidentOtherGroup = message({ group: 'group-b', id: 'opaque-sent-id', content: 'different group event' });
        assert.equal(service.isOwnEcho(coincidentOtherGroup.raw, `${appId}:group-b`), false);
        await service.captureRaw({ message: coincidentOtherGroup });
        await service.recordBotDelivery({ target: { scope: 'c2c', targetId: 'private-id' }, status: 'sent', messageId: 'private-id', text: 'private' });
        await service.recordBotDelivery({ target: { scope: 'group', targetId: 'group-c' }, status: 'unknown', text: 'not-confirmed' });
        await waitFor(() => received.length >= 3);
        const output = received.find((event) => event.group_key === `${appId}:group-a` && event.kind === 'message');
        const otherGroupInput = received.find((event) => event.group_key === `${appId}:group-b`);
        const unknownGap = received.find((event) => event.group_key === `${appId}:group-c`);
        assert.equal(output.user_key, `${appId}:__qqbot__`);
        assert.equal(output.nickname, '机器人');
        assert.equal(output.text, 'confirmed output');
        assert.equal(received.filter((event) => event.group_key === `${appId}:group-a` && event.kind === 'message').length, 1);
        assert.equal(otherGroupInput.text, 'different group event');
        assert.equal(unknownGap.kind, 'gap', 'unknown bot delivery becomes a fixed gap event');
        assert.equal(received.some((event) => event.text === 'private'), false);
        assert.equal(received.some((event) => event.text === 'not-confirmed'), false);
    }
    finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('offline capture is durable and restart reports a gap before replaying the raw message', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-'));
    const posts = [];
    let { service, filePath } = await makeService(directory, async (_url, init) => {
        posts.push(JSON.parse(init.body));
        return accepted();
    });
    try {
        service.setBackends([{ ...groupBackend[0], ready: false }]);
        await service.captureRaw({ message: message({ content: 'stored while backend is down' }) });
        assert.equal(service.diagnostics().pending, 1);
        await service.stop();

        service = createOnebotLogCapture({ config: config(), appId,
            options: { filePath, fetchImpl: async (_url, init) => { posts.push(JSON.parse(init.body)); return accepted(); } } });
        service.setBackends(groupBackend);
        assert.equal(await service.barrier({ backendId, groupKey: `${appId}:group-a`, timeoutMs: 2500 }), true);
        await waitFor(() => posts.length === 2);
        assert.equal(posts[0].kind, 'gap');
        assert.match(posts[0].text, /重启期间/u);
        assert.equal(posts[1].kind, 'message');
        assert.equal(posts[1].text, 'stored while backend is down');
    }
    finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('a fully drained group still receives a restart gap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-'));
    const posted = [];
    let service;
    try {
        const instance = await makeService(directory, async (_url, init) => {
            posted.push(JSON.parse(init.body));
            return accepted();
        });
        service = instance.service;
        service.setBackends(groupBackend);
        await service.captureRaw({ message: message({ id: 'drained-before-restart' }) });
        assert.equal(await service.barrier({ backendId, groupKey: `${appId}:group-a` }), true);
        await service.stop();
        const stored = JSON.parse(await readFile(instance.filePath, 'utf8'));
        assert.equal(stored.pending.length, 0);
        assert.equal(stored.groups.length, 1);

        posted.length = 0;
        service = createOnebotLogCapture({ config: config(), appId, options: {
            filePath: instance.filePath,
            fetchImpl: async (_url, init) => { posted.push(JSON.parse(init.body)); return accepted(); },
        } });
        service.setBackends(groupBackend);
        assert.equal(await service.barrier({ backendId, groupKey: `${appId}:group-a` }), true);
        assert.deepEqual(posted.map((event) => event.kind), ['gap']);
        assert.match(posted[0].text, /重启期间/u);
    }
    finally { await service?.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('legacy group tracking is admitted within current group and gap caps', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-'));
    let service;
    try {
        const filePath = join(directory, 'queue.json');
        const groups = Array.from({ length: 4096 }, (_, index) => [
            `${backendId}\u0000${appId}:group-${index}`, `${appId}:group-${index}`,
        ]);
        await writeFile(filePath, JSON.stringify({ version: 1, appId, pending: [], gaps: [], groups }));
        service = createOnebotLogCapture({ config: config(), appId, options: {
            filePath, fetchImpl: async () => accepted(),
        } });
        service.setBackends([{ ...groupBackend[0], ready: false }]);
        await service.captureRaw({ message: message({ group: 'group-1', id: 'after-legacy-load' }) });
        assert.equal(service.diagnostics().initError, false);
        assert.equal(service.diagnostics().incomplete, true);
        await service.stop();
        const stored = JSON.parse(await readFile(filePath, 'utf8'));
        assert.equal(stored.groups.length, 2048);
        assert.equal(stored.gaps.length + stored.pending.filter((item) => item.event.kind === 'gap').length, 512);
        assert.equal(stored.pending.filter((item) => item.event.kind === 'message').length, 1);
        assert.ok(Buffer.byteLength(JSON.stringify(stored), 'utf8') < 8 * 1024 * 1024);
    }
    finally { await service?.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('large raw messages stop at the serialized state byte limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-'));
    const posted = [];
    const { service, filePath } = await makeService(directory, async (_url, init) => {
        posted.push(JSON.parse(init.body).kind);
        return accepted();
    });
    try {
        service.setBackends([{ ...groupBackend[0], ready: false }]);
        let rejected = false;
        let acceptedCount = 0;
        for (let index = 0; index < 400; index += 1) {
            const acceptedLocally = await service.captureRaw({ message: message({
                id: `large-${index}`, content: '中'.repeat([8192, 7001, 8123, 4091][index % 4]),
            }) });
            if (!acceptedLocally) { rejected = true; break; }
            acceptedCount += 1;
        }
        assert.equal(rejected, true);
        await waitFor(async () => JSON.parse(await readFile(filePath, 'utf8')).gaps.length === 1,
            'loss marker to persist at the byte boundary');
        const bytes = Buffer.byteLength(await readFile(filePath, 'utf8'), 'utf8');
        assert.ok(bytes < 8 * 1024 * 1024, `persisted ${bytes} bytes`);
        const stored = JSON.parse(await readFile(filePath, 'utf8'));
        assert.equal(stored.pending.length, acceptedCount);
        assert.equal(stored.gaps.length, 1);
        assert.equal(service.diagnostics().initError, false);
        service.setBackends(groupBackend);
        assert.equal(await service.barrier({ backendId, groupKey: `${appId}:group-a`, timeoutMs: 60000 }), true);
        assert.deepEqual(posted, [...Array(acceptedCount).fill('message'), 'gap']);
    }
    finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('ready capability downgrade parks pending content and records unsupported raw arrivals as gaps', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-'));
    const posted = [];
    const { service } = await makeService(directory, async (_url, init) => {
        posted.push(JSON.parse(init.body));
        return accepted();
    });
    try {
        service.setBackends([{ ...groupBackend[0], ready: false }]);
        await service.captureRaw({ message: message({ id: 'before-downgrade', content: 'older' }) });
        service.setBackends([{ id: backendId, ready: true, capabilities: [] }]);
        assert.equal(await service.captureRaw({ message: message({ id: 'during-downgrade-a', content: 'lost-a' }) }), false);
        assert.equal(await service.captureRaw({ message: message({ group: 'group-b', id: 'during-downgrade-b', content: 'lost-b' }) }), false);
        assert.equal(service.diagnostics().pending, 1);
        assert.equal(service.diagnostics().gaps, 2);
        service.setBackends(groupBackend);
        assert.equal(await service.barrier({ backendId, groupKey: `${appId}:group-a` }), true);
        assert.equal(await service.barrier({ backendId, groupKey: `${appId}:group-b` }), true);
        await service.captureRaw({ message: message({ id: 'after-restore', content: 'newer' }) });
        assert.equal(await service.barrier({ backendId, groupKey: `${appId}:group-a` }), true);
        assert.deepEqual(posted.filter((event) => event.group_key === `${appId}:group-a`).map((event) => event.kind === 'gap' ? 'gap' : event.text),
            ['older', 'gap', 'newer']);
        assert.deepEqual(posted.filter((event) => event.group_key === `${appId}:group-b`).map((event) => event.kind), ['gap']);
        assert.equal(posted.some((event) => event.text === 'lost-a' || event.text === 'lost-b'), false);
    }
    finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('capture loss diagnostics are fixed, redacted, and throttled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-'));
    const warnings = [];
    const service = createOnebotLogCapture({ config: config(), appId, options: {
        filePath: join(directory, 'queue.json'),
        fetchImpl: async () => accepted(),
        logger: { warn(value) { warnings.push(value); } },
    } });
    try {
        service.setBackends([{ id: backendId, ready: true, capabilities: [] }]);
        await service.captureRaw({ message: message({ group: 'private-group-name', id: 'lost-1', content: 'private message body' }) });
        await service.captureRaw({ message: message({ group: 'private-group-name', id: 'lost-2', content: 'another private body' }) });
        assert.deepEqual(warnings, ['[qqbot-onebot-log] capture-gap reason=capability_unavailable']);
    }
    finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('a group beyond the gap cap waits for its gap before accepting content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-'));
    const filePath = join(directory, 'queue.json');
    const groupZero = `${appId}:group-0`;
    const groupOne = `${appId}:group-1`;
    const gaps = Array.from({ length: 512 }, (_, index) => [`${backendId}\u0000${groupZero}`, {
        event: {
            backend_id: backendId, event_id: `gap-${String(index).padStart(16, '0')}`,
            group_key: groupZero, user_key: `${appId}:__qqbot__`, time: 1_780_000_000,
            nickname: '机器人', text: '记录缺口：部分群消息未能保存。', is_bot: true, kind: 'gap',
        },
        count: 1, beforeEventId: null,
    }]);
    await writeFile(filePath, JSON.stringify({ version: 1, appId, pending: [], gaps,
        groups: [[`${backendId}\u0000${groupZero}`, groupZero], [`${backendId}\u0000${groupOne}`, groupOne]] }));
    const posted = [];
    const service = createOnebotLogCapture({ config: config(), appId, options: {
        filePath, fetchImpl: async (_url, init) => { posted.push(JSON.parse(init.body)); return accepted(); },
    } });
    try {
        service.setBackends([{ ...groupBackend[0], ready: false }]);
        assert.equal(await service.captureRaw({ message: message({ group: 'group-1', id: 'before-cap-opens' }) }), false);
        assert.equal(service.diagnostics().incomplete, true);
        service.setBackends(groupBackend);
        await waitFor(() => service.diagnostics().gaps < 512);
        assert.equal(await service.captureRaw({ message: message({ group: 'group-1', id: 'after-cap-opens', content: 'newer' }) }), true);
        assert.equal(await service.barrier({ backendId, groupKey: groupOne }), true);
        assert.deepEqual(posted.filter((event) => event.group_key === groupOne).map((event) => event.kind),
            ['gap', 'message']);
    }
    finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('real disconnect status with empty capabilities retains pending events and group tracking', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-'));
    const posted = [];
    let service;
    try {
        const instance = await makeService(directory, async (_url, init) => {
            posted.push(JSON.parse(init.body));
            return accepted();
        });
        service = instance.service;
        service.setBackends([{ ...groupBackend[0], ready: false }]);
        await service.captureRaw({ message: message({ id: 'before-disconnect', content: 'before' }) });
        service.setBackends([{ id: backendId, ready: false, capabilities: [] }]);
        await service.captureRaw({ message: message({ id: 'during-disconnect', content: 'during' }) });
        assert.equal(service.diagnostics().pending, 2);
        await service.stop();
        const stored = JSON.parse(await readFile(instance.filePath, 'utf8'));
        assert.equal(stored.pending.length, 2);
        assert.equal(stored.groups.length, 1, 'offline capability loss cannot erase tracked group history');

        service = createOnebotLogCapture({ config: config(), appId, options: {
            filePath: instance.filePath,
            fetchImpl: async (_url, init) => { posted.push(JSON.parse(init.body)); return accepted(); },
        } });
        service.setBackends([{ id: backendId, ready: false, capabilities: [] }]);
        await service.captureRaw({ message: message({ id: 'after-restart-offline', content: 'still offline' }) });
        assert.equal(service.diagnostics().pending, 4, 'restart gap is queued before offline messages');
        service.setBackends(groupBackend);
        assert.equal(await service.barrier({ backendId, groupKey: `${appId}:group-a`, timeoutMs: 2500 }), true);
        assert.deepEqual(posted.map((event) => event.kind === 'gap' ? 'restart gap' : event.text), [
            'restart gap', 'before', 'during', 'still offline',
        ]);
    }
    finally { await service?.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('a full local queue places its loss gap after 500 older messages and before later accepted content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-'));
    const posted = [];
    let releaseThird;
    const third = new Promise((resolve) => { releaseThird = resolve; });
    const { service } = await makeService(directory, async (_url, init) => {
        const event = JSON.parse(init.body);
        posted.push(event.kind === 'gap' ? 'gap' : event.text);
        if (event.text === 'old-2') return third;
        return accepted();
    });
    try {
        service.setBackends([{ ...groupBackend[0], ready: false }]);
        for (let index = 0; index < 500; index += 1) {
            assert.equal(await service.captureRaw({ message: message({
                id: `old-${index}`, content: `old-${index}`,
            }) }), true);
        }
        assert.equal(await service.captureRaw({ message: message({ id: 'lost-501', content: 'lost-501' }) }), false);
        assert.equal(service.diagnostics().pending, 500);
        assert.equal(service.diagnostics().gaps, 1);
        service.setBackends(groupBackend);
        await waitFor(() => posted.includes('old-2'));
        assert.equal(await service.captureRaw({ message: message({ id: 'future', content: 'future' }) }), true);
        releaseThird(accepted());
        assert.equal(await service.barrier({ backendId, groupKey: `${appId}:group-a`, timeoutMs: 3000 }), true);
        assert.deepEqual(posted, [
            ...Array.from({ length: 500 }, (_, index) => `old-${index}`), 'gap', 'future',
        ]);
    }
    finally { releaseThird?.(accepted()); await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('a persisted bridge queue_full gap survives restart and backpressure does not spin', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-'));
    const firstRequests = [];
    const { service, filePath } = await makeService(directory, async (_url, init) => {
        firstRequests.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ error: 'queue_full' }), {
            status: 429, headers: { 'content-type': 'application/json' },
        });
    });
    let restarted;
    try {
        service.setBackends(groupBackend);
        await service.captureRaw({ message: message() });
        await waitFor(() => service.diagnostics().gaps === 1);
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.equal(firstRequests.length, 1, '429 uses a delayed retry instead of repeatedly manufacturing gaps');
        await service.stop();
        const stored = JSON.parse(await readFile(filePath, 'utf8'));
        const persistedGap = stored.gaps.find(([, value]) => value.event.group_key === `${appId}:group-a`);
        assert.equal(persistedGap?.[1]?.count, 1);
        assert.equal(persistedGap?.[1]?.event?.kind, 'gap');

        const restartedPosts = [];
        restarted = createOnebotLogCapture({ config: config(), appId, options: { filePath,
            fetchImpl: async (_url, init) => { restartedPosts.push(JSON.parse(init.body)); return accepted(); } } });
        restarted.setBackends(groupBackend);
        assert.equal(await restarted.barrier({ backendId, groupKey: `${appId}:group-a`, timeoutMs: 2500 }), true);
        await waitFor(() => restartedPosts.length === 2);
        assert.equal(restartedPosts[0].kind, 'gap');
        assert.match(restartedPosts[0].text, /重启期间/u);
        assert.equal(restartedPosts[1].text, '记录缺口：部分群消息未能保存。');
    }
    finally { await service.stop(); await restarted?.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('legacy single-gap state loads ahead of its pending message without losing a restart gap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-'));
    const posted = [];
    let service;
    try {
        const instance = await makeService(directory, async () => accepted());
        service = instance.service;
        service.setBackends([{ ...groupBackend[0], ready: false }]);
        await service.captureRaw({ message: message({ id: 'legacy-pending', content: 'legacy message' }) });
        await service.recordBotDelivery({ target: { scope: 'group', targetId: 'group-a' }, status: 'unknown' });
        await service.stop();
        const stored = JSON.parse(await readFile(instance.filePath, 'utf8'));
        delete stored.incomplete;
        for (const [, gap] of stored.gaps) delete gap.beforeEventId;
        await writeFile(instance.filePath, JSON.stringify(stored));

        service = createOnebotLogCapture({ config: config(), appId, options: {
            filePath: instance.filePath,
            fetchImpl: async (_url, init) => { posted.push(JSON.parse(init.body)); return accepted(); },
        } });
        service.setBackends(groupBackend);
        assert.equal(await service.barrier({ backendId, groupKey: `${appId}:group-a`, timeoutMs: 2500 }), true);
        assert.deepEqual(posted.map((event) => event.text), [
            '记录缺口：记录服务重启期间的消息可能不完整。',
            '记录缺口：部分群消息未能保存。',
            'legacy message',
        ]);
    }
    finally { await service?.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('interleaved ACKs from two group workers remove their own stable event, not a neighboring event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-'));
    const posts = [];
    let releaseA1;
    let releaseB1;
    const a1 = new Promise((resolve) => { releaseA1 = resolve; });
    const b1 = new Promise((resolve) => { releaseB1 = resolve; });
    const { service } = await makeService(directory, async (_url, init) => {
        const event = JSON.parse(init.body);
        posts.push(event.text);
        if (event.text === 'a1') return a1;
        if (event.text === 'b1') return b1;
        return accepted();
    });
    try {
        service.setBackends(groupBackend);
        await service.captureRaw({ message: message({ group: 'group-a', id: 'a1', content: 'a1' }) });
        await service.captureRaw({ message: message({ group: 'group-b', id: 'b1', content: 'b1' }) });
        await waitFor(() => posts.includes('b1'));
        await service.captureRaw({ message: message({ group: 'group-b', id: 'b2', content: 'b2' }) });
        releaseA1(accepted());
        await waitFor(() => service.diagnostics().pending === 2);
        releaseB1(accepted());
        await waitFor(() => posts.includes('b2'), 'the second group-b event must not be deleted by another worker ACK');
        await waitFor(() => service.diagnostics().pending === 0);
        assert.deepEqual(posts, ['a1', 'b1', 'b2']);
    }
    finally { releaseA1?.(accepted()); releaseB1?.(accepted()); await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('capture middleware does not require a mention and never blocks downstream chat', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-'));
    const { service } = await makeService(directory, async () => accepted());
    let nextCalled = false;
    try {
        service.setBackends([{ ...groupBackend[0], ready: false }]);
        const middleware = createOnebotLogCaptureMiddleware({ runtime: { logCapture: service } });
        await middleware({ message: message({ content: 'ordinary group chat with no @bot' }) }, async () => { nextCalled = true; });
        assert.equal(nextCalled, true);
        await waitFor(() => service.diagnostics().pending === 1);
    }
    finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('middleware registers the current message before a log command reaches the barrier', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-'));
    let release;
    const response = new Promise((resolve) => { release = resolve; });
    const { service } = await makeService(directory, async () => response);
    try {
        service.setBackends(groupBackend);
        const middleware = createOnebotLogCaptureMiddleware({ runtime: { logCapture: service } });
        await middleware({ message: message({ content: '.log new session' }) }, async () => {
            const passed = await service.barrier({ backendId, groupKey: `${appId}:group-a`, timeoutMs: 40 });
            assert.equal(passed, false, 'the command must wait for its captured source event');
        });
        release(accepted());
        assert.equal(await service.barrier({ backendId, groupKey: `${appId}:group-a`, timeoutMs: 1000 }), true);
    }
    finally { release?.(accepted()); await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

for (const action of ['on', 'off']) {
    test(`a delayed .log ${action} source ACK holds later group captures until command completion`, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-'));
        const posted = [];
        let releaseAck;
        let releaseCommand;
        const ack = new Promise((resolve) => { releaseAck = resolve; });
        const command = new Promise((resolve) => { releaseCommand = resolve; });
        const { service } = await makeService(directory, async (_url, init) => {
            const event = JSON.parse(init.body);
            posted.push(event);
            return event.text === `.log ${action}` ? ack : accepted();
        });
        try {
            service.setBackends(groupBackend);
            const middleware = createOnebotLogCaptureMiddleware({ runtime: { logCapture: service } });
            const source = message({ id: `control-${action}`, content: `.log ${action}` });
            source.raw.quote = { content: '.log del other-session' };
            source.refMsgIdx = 'quoted-message';
            const sourceCtx = { message: source, state: { quote: { text: '.log del other-session' } } };
            let sourceAccepted = false;
            const sourceRun = middleware(sourceCtx, async () => {
                sourceAccepted = await service.barrier({ backendId, groupKey: `${appId}:group-a`,
                    sourceMessageId: source.messageId, timeoutMs: 2000 });
                await command;
                service.releaseControlSource(`${appId}:group-a`, source.messageId, backendId);
            });
            const laterRun = middleware({ message: message({ id: `after-${action}`, content: 'later' }), state: {} }, async () => {});
            const otherRun = middleware({ message: message({ group: 'group-b', id: `other-${action}`, content: 'other' }), state: {} }, async () => {});
            await Promise.all([laterRun, otherRun]);
            await waitFor(() => posted.some((event) => event.text === 'other'));
            assert.deepEqual(posted.filter((event) => event.group_key === `${appId}:group-a`).map((event) => event.text), [`.log ${action}`]);
            releaseAck(accepted());
            await waitFor(() => sourceAccepted);
            assert.deepEqual(posted.filter((event) => event.group_key === `${appId}:group-a`).map((event) => event.text), [`.log ${action}`]);
            releaseCommand();
            await sourceRun;
            assert.equal(await service.barrier({ backendId, groupKey: `${appId}:group-a` }), true);
            assert.deepEqual(posted.filter((event) => event.group_key === `${appId}:group-a`).map((event) => event.text), [`.log ${action}`, 'later']);
        }
        finally { releaseAck?.(accepted()); releaseCommand?.(); await service.stop(); await rm(directory, { recursive: true, force: true }); }
    });
}

test('a skipped control releases its hold when middleware finishes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-'));
    const posted = [];
    const { service } = await makeService(directory, async (_url, init) => {
        posted.push(JSON.parse(init.body).text);
        return accepted();
    });
    try {
        service.setBackends(groupBackend);
        const middleware = createOnebotLogCaptureMiddleware({ runtime: { logCapture: service } });
        await middleware({ message: message({ id: 'skipped-control', content: '.log off' }), state: {} }, async () => {});
        await middleware({ message: message({ id: 'after-skip', content: 'later' }), state: {} }, async () => {});
        assert.equal(await service.barrier({ backendId, groupKey: `${appId}:group-a` }), true);
        assert.deepEqual(posted, ['.log off', 'later']);
    }
    finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

for (const executesTool of [true, false]) {
    test(`a merged non-survivor control holds later capture until ${executesTool ? 'executor release' : 'survivor finally'}`, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-'));
        const posted = [];
        let releaseFirst;
        let releaseTerminal;
        const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
        const terminalGate = new Promise((resolve) => { releaseTerminal = resolve; });
        const { service } = await makeService(directory, async (_url, init) => {
            posted.push(JSON.parse(init.body).text);
            return accepted();
        });
        const runs = [];
        try {
            service.setBackends(groupBackend);
            const capture = createOnebotLogCaptureMiddleware({ runtime: { logCapture: service } });
            const merge = createMergeConcurrencyGuard({ maxQueue: 4, maxProcessingMs: 0 });
            let firstStarted = false;
            let survivorStarted = false;
            let nonSurvivorFinished = false;
            let sourceAccepted = false;
            const makeCtx = (id, content) => {
                const rawMessage = message({ id, content });
                rawMessage.content = content;
                rawMessage.replyTarget = { scope: 'group', targetId: 'group-a', msgId: id };
                return { message: rawMessage, state: {}, signal: new AbortController().signal,
                    stop() {}, log: { warn() {} } };
            };
            const downstream = async (ctx) => {
                if (ctx.message.messageId === 'first') {
                    firstStarted = true;
                    await firstGate;
                    return;
                }
                survivorStarted = true;
                assert.equal(ctx.message.messageId, 'survivor');
                assert.equal(ctx.state.qqbotLogHolds.length, 1);
                if (executesTool) {
                    sourceAccepted = await service.barrier({ backendId, groupKey: `${appId}:group-a`,
                        sourceMessageId: 'non-survivor-control', timeoutMs: 2000 });
                }
                await terminalGate;
                if (executesTool) service.releaseControlSource(`${appId}:group-a`, 'non-survivor-control', backendId);
            };
            const submit = (ctx) => capture(ctx, () => merge(ctx, () => downstream(ctx)));
            runs.push(submit(makeCtx('first', 'first')));
            await waitFor(() => firstStarted);
            runs.push(submit(makeCtx('survivor', 'survivor')));
            const nonSurvivor = submit(makeCtx('non-survivor-control', '.log off'));
            runs.push(nonSurvivor.then(() => { nonSurvivorFinished = true; }));
            releaseFirst();
            await waitFor(() => survivorStarted && nonSurvivorFinished);
            await waitFor(() => posted.includes('.log off'));
            if (executesTool) await waitFor(() => sourceAccepted);
            await capture(makeCtx('later', 'later'), async () => {});
            await new Promise((resolve) => setTimeout(resolve, 20));
            assert.equal(posted.includes('later'), false, 'non-survivor finally must not release its transferred hold');
            releaseTerminal();
            await Promise.all(runs);
            assert.equal(await service.barrier({ backendId, groupKey: `${appId}:group-a` }), true);
            assert.deepEqual(posted, ['first', 'survivor', '.log off', 'later']);
        }
        finally {
            releaseFirst?.();
            releaseTerminal?.();
            await Promise.allSettled(runs);
            await service.stop();
            await rm(directory, { recursive: true, force: true });
        }
    });
}

test('a canceled queued control releases its hold without executing a tool', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-'));
    const posted = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const { service } = await makeService(directory, async (_url, init) => {
        posted.push(JSON.parse(init.body).text);
        return accepted();
    });
    const runs = [];
    try {
        service.setBackends(groupBackend);
        const capture = createOnebotLogCaptureMiddleware({ runtime: { logCapture: service } });
        const merge = createMergeConcurrencyGuard({ maxQueue: 4, maxProcessingMs: 0 });
        let firstStarted = false;
        const makeCtx = (id, content) => {
            const controller = new AbortController();
            const rawMessage = message({ id, content });
            rawMessage.content = content;
            rawMessage.replyTarget = { scope: 'group', targetId: 'group-a', msgId: id };
            return { message: rawMessage, state: {}, signal: controller.signal,
                abort() { controller.abort(); }, stop() {}, log: { warn() {} } };
        };
        const submit = (ctx) => capture(ctx, () => merge(ctx, async () => {
            if (ctx.message.messageId === 'blocking-owner') {
                firstStarted = true;
                await firstGate;
            }
            else assert.fail('a canceled control must not reach downstream');
        }));
        runs.push(submit(makeCtx('blocking-owner', 'first')));
        await waitFor(() => firstStarted);
        const control = makeCtx('canceled-control', '.log off');
        runs.push(submit(control));
        await waitFor(() => posted.includes('.log off'));
        await capture(makeCtx('after-cancel', 'later'), async () => {});
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(posted.includes('later'), false);
        control.abort();
        releaseFirst();
        await Promise.all(runs);
        assert.equal(await service.barrier({ backendId, groupKey: `${appId}:group-a` }), true);
        assert.deepEqual(posted, ['first', '.log off', 'later']);
    }
    finally {
        releaseFirst?.();
        await Promise.allSettled(runs);
        await service.stop();
        await rm(directory, { recursive: true, force: true });
    }
});

test('stop drains an in-flight delivery and persists its final queue state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-'));
    let release;
    let started = false;
    const response = new Promise((resolve) => { release = resolve; });
    const { service, filePath } = await makeService(directory, async () => {
        started = true;
        return response;
    });
    try {
        service.setBackends(groupBackend);
        await service.captureRaw({ message: message() });
        await waitFor(() => started);
        let finished = false;
        const stopping = service.stop().then(() => { finished = true; });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(finished, false);
        release(accepted());
        await stopping;
        const stored = JSON.parse(await readFile(filePath, 'utf8'));
        assert.equal(stored.pending.length, 0);
    }
    finally { release?.(accepted()); await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('SDK send observer records one final group ACK across markdown, direct event sends and errors', async () => {
    const deliveries = [];
    const bot = {
        async send(options) {
            if (options.markdown?.content === 'uncertain') throw new Error('network outcome unknown');
            if (options.markdown?.content === 'denied') throw Object.assign(new Error('bad request'), { httpStatus: 400 });
            if (options.markdown?.content === 'missing ack') return {};
            return { id: 'qq-ack' };
        },
        async sendMarkdown(target, content) {
            return this.send({ target, markdown: { content } });
        },
    };
    const original = bot.send;
    const detach = attachOnebotDeliveryObserver(bot, {
        observeBotDelivery(event) { deliveries.push(event); },
    });
    const target = { scope: 'group', targetId: 'group-a' };
    await bot.sendMarkdown(target, 'standard');
    await bot.send({ target, markdown: { content: 'event reply' }, extra: { event_id: 'event-1' } });
    await assert.rejects(bot.sendMarkdown(target, 'uncertain'));
    await assert.rejects(bot.sendMarkdown(target, 'denied'));
    await bot.sendMarkdown(target, 'missing ack');
    await bot.sendMarkdown({ scope: 'c2c', targetId: 'private' }, 'private');
    assert.deepEqual(deliveries, [
        { target, status: 'sent', messageId: 'qq-ack', text: 'standard' },
        { target, status: 'sent', messageId: 'qq-ack', text: 'event reply' },
        { target, status: 'unknown', text: 'uncertain' },
        { target, status: 'failed', text: 'denied' },
        { target, status: 'unknown', text: 'missing ack' },
    ]);
    detach();
    assert.equal(bot.send, original);
    await bot.sendMarkdown(target, 'after shutdown');
    assert.equal(deliveries.length, 5);
});


const faceTag = (bytes) => `<faceType=1,faceId="123",ext="${Buffer.from(bytes).toString('base64')}">`;
const namedFace = (text, extra = {}) => faceTag(JSON.stringify({ text, ...extra }));

test('log face normalization is bounded, readable and preserves ordinary text', () => {
    const body = '普通 Unicode 🌏\n**Markdown** <b>HTML</b>';
    assert.equal(normalizeOnebotLogText(body), body);
    assert.equal(normalizeOnebotLogText(`前${namedFace('微笑', { ignored: 'OPAQUE_EXTRA' })}后`), '前[表情: 微笑]后');
    assert.equal(normalizeOnebotLogText('[<face,id=14/>] [<face,id=14>] [<face,id=99999/>]'),
        '[表情: 微笑] [表情: 微笑] [表情]');
    assert.equal(normalizeOnebotLogText(`前<faceType=1,faceId="1",ext="${'A'.repeat(64 * 1024)}">后`), '前[表情]后');
    for (const tag of [
        '<faceType=1,faceId="1",ext="invalid!">',
        '<faceType=1,faceId="1",ext="invalid>OPAQUE_AFTER_GREATER_THAN">',
        '<faceType=1,faceId="1",ext="AB==">', // Noncanonical padding bits.
        faceTag(Buffer.from([0xff])),
        faceTag('{invalid json'),
        faceTag(JSON.stringify({ text: 'valid', extra: 'x'.repeat(4096) })),
        namedFace('字'.repeat(81)), namedFace('🌏'.repeat(80)), namedFace(7), namedFace(null),
        namedFace(''), namedFace('line\nbreak'), namedFace('a\u0000b'), namedFace('line\u2028break'),
        '<faceType=1,faceId="1",ext="unterminated OPAQUE_PAYLOAD',
        '[<face,id=not-a-number/>]', '[<face,id=14/>',
    ]) {
        assert.equal(normalizeOnebotLogText(tag), '[表情]', tag.slice(0, 80));
    }
    assert.equal(normalizeOnebotLogText(namedFace('a'.repeat(80))), `[表情: ${'a'.repeat(80)}]`);
    assert.equal(normalizeOnebotLogText(namedFace('🌏'.repeat(64))), `[表情: ${'🌏'.repeat(64)}]`);
    const many = Array.from({ length: 33 }, (_, index) => namedFace(`face-${index}`)).join('');
    const normalized = normalizeOnebotLogText(many);
    assert.ok(normalized.includes('[表情: face-31]'));
    assert.ok(normalized.endsWith('[表情]'));
    assert.equal(normalized.includes('face-32'), false);
    assert.equal(normalizeOnebotLogText('x'.repeat(1024 * 1024 + 1)), undefined);
    assert.equal(normalizeOnebotLogText('中'.repeat(350_000)), undefined, 'raw cap is measured in UTF-8 bytes');
    assert.equal(normalizeOnebotLogText(`<faceType=${'A'.repeat(128 * 1024)}`), '[表情]');
});

test('raw face payloads never enter durable capture or posted events, and bot output uses the same normalization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqbot-log-face-'));
    const posted = [];
    const { service, filePath } = await makeService(directory, async (_url, init) => {
        posted.push(JSON.parse(init.body));
        return accepted();
    });
    const largeTag = `<faceType=1,faceId="1",ext="${'A'.repeat(64 * 1024)}">`;
    try {
        service.setBackends([{ ...groupBackend[0], ready: false }]);
        const current = message({ id: 'face-current', content: `before ${largeTag} ${namedFace('微笑', { ignored: 'OPAQUE_EXTRA' })} after\n[<face,id=14/>]` });
        current.content = 'SDK_POLLUTED_HISTORY';
        current.raw.quote = { content: 'RAW_QUOTE_SENTINEL' };
        await createOnebotLogCaptureMiddleware({ runtime: { logCapture: service } })({
            message: current, state: { quote: { text: 'QUOTED_HISTORY_SENTINEL' }, history: ['HISTORY_SENTINEL'] },
        }, async () => {});
        let persisted;
        const expectedText = 'before [表情] [表情: 微笑] after\n[表情: 微笑]';
        await waitFor(async () => {
            let snapshot;
            try { snapshot = JSON.parse(await readFile(filePath, 'utf8')); }
            catch (error) {
                if (error?.code === 'ENOENT') return false;
                throw error;
            }
            if (!snapshot.pending?.some((item) => item.event?.kind === 'message'
                && item.event.text === expectedText)) return false;
            persisted = JSON.stringify(snapshot);
            return true;
        }, 'sanitized face event must be durably persisted before inspecting the queue');
        const stored = persisted;
        assert.ok(Buffer.byteLength(stored, 'utf8') < 8192, '64 KiB face data becomes a short durable record');
        for (const forbidden of [largeTag, 'faceType=', 'OPAQUE_EXTRA', 'SDK_POLLUTED_HISTORY',
            'RAW_QUOTE_SENTINEL', 'QUOTED_HISTORY_SENTINEL', 'HISTORY_SENTINEL']) {
            assert.equal(stored.includes(forbidden), false, forbidden.slice(0, 60));
        }
        service.setBackends(groupBackend);
        await waitFor(() => posted.length === 1);
        assert.equal(posted[0].text, expectedText);
        assert.equal(await service.recordBotDelivery({ target: { scope: 'group', targetId: 'group-a' },
            status: 'sent', messageId: 'face-bot', text: `bot ${largeTag} ${namedFace('赞')}` }), true);
        await waitFor(() => posted.length === 2);
        assert.equal(posted[1].text, 'bot [表情] [表情: 赞]');
        assert.equal(JSON.stringify(posted).includes('ext='), false);
        assert.equal(await service.captureRaw({ message: message({ id: 'raw-over-limit',
            content: `<faceType=${'x'.repeat(1024 * 1024)}` }) }), false);
        assert.equal(await service.captureRaw({ message: message({ id: 'normalized-over-limit',
            content: 'x'.repeat(8193) + largeTag }) }), false);
        assert.equal(await service.recordBotDelivery({ target: { scope: 'group', targetId: 'group-a' },
            status: 'sent', messageId: 'bot-over-limit', text: 'x'.repeat(8193) + largeTag }), false);
        await service.barrier({ backendId, groupKey: `${appId}:group-a` });
        assert.equal(posted.filter((event) => event.kind === 'message').length, 2, 'oversized text creates gaps without truncating body');
        assert.ok(posted.some((event) => event.kind === 'gap'));
    }
    finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
});
