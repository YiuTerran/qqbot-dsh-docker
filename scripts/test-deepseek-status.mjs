import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const statusModuleUrl = process.env.QQBOT_DEEPSEEK_STATUS_MODULE
    ? pathToFileURL(resolve(process.env.QQBOT_DEEPSEEK_STATUS_MODULE)).href
    : new URL('../defaults/qqbot-deepseek-status.mjs', import.meta.url).href;
const { createDeepSeekStatusReader, DEEPSEEK_STATUS } = await import(statusModuleUrl);

const statusUrl = 'https://status.deepseek.com/api/status-page/6410630422455/summary/active';
const pageComponents = [
    { component_id: 'api-primary', name: 'API服务' },
    { component_id: 'api-secondary', name: 'Public API Service' },
    { component_id: 'web', name: 'Web App' },
    { component_id: 'upload', name: 'File Upload' },
    { component_id: 'search', name: 'Search' },
];
const payload = (activeChanges = []) => ({
    request_id: 'fixture-request-id',
    data: {
        page: { page_id: 6410630422455, custom_domain: 'status.deepseek.com', components: pageComponents },
        active_changes: activeChanges,
    },
});
const incident = (status, affectedComponents, extra = {}) => ({
    type: 'incident', status, title: 'private fixture title', description: 'private fixture details',
    affected_components: affectedComponents, ...extra,
});
const response = (body, options = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: options.status ?? 200,
    headers: options.headers,
});
const readerFor = (fetchImpl, options = {}) => createDeepSeekStatusReader({
    fetchImpl,
    setTimer: options.setTimer ?? (() => 1),
    clearTimer: options.clearTimer ?? (() => {}),
    now: options.now ?? (() => 0),
});

test('recognizes unresolved API incidents and ignores resolved, maintenance, and unrelated component outages', async () => {
    for (const state of ['investigating', 'identified', 'monitoring']) {
        const read = readerFor(async () => response(payload([
            incident(state, [{ component_id: 'api-primary', status: 'partial_outage' }]),
        ])));
        assert.equal(await read(), DEEPSEEK_STATUS.API_INCIDENT, state);
    }

    const normal = readerFor(async () => response(payload()));
    assert.equal(await normal(), DEEPSEEK_STATUS.OPERATIONAL);

    const resolved = readerFor(async () => response(payload([
        incident('resolved', [{ component_id: 'api-primary', status: 'full_outage' }]),
    ])));
    assert.equal(await resolved(), DEEPSEEK_STATUS.OPERATIONAL);

    for (const componentId of ['web', 'upload', 'search']) {
        const unrelated = readerFor(async () => response(payload([
            incident('investigating', [{ component_id: componentId, status: 'full_outage' }]),
        ])));
        assert.equal(await unrelated(), DEEPSEEK_STATUS.OPERATIONAL, componentId);
    }

    const maintenance = readerFor(async () => response(payload([
        { type: 'maintenance', status: 'in_progress', affected_components: [{ component_id: 'api-primary', status: 'full_outage' }] },
    ])));
    assert.equal(await maintenance(), DEEPSEEK_STATUS.OPERATIONAL);
});

test('treats malformed and future unknown API status shapes as unknown', async () => {
    const cases = [
        {},
        { data: { page: {}, active_changes: [] } },
        payload([{ type: 'incident', status: 'investigating' }]),
        payload([incident('investigating', [{ component_id: 'api-primary', status: 'unknown_state' }])]),
        payload([{ type: 'unrecognized_change', status: 'investigating', affected_components: [] }]),
        { ...payload(), data: { ...payload().data, page: { ...payload().data.page, components: [{ component_id: 'web', name: 'Web App' }] } } },
    ];
    for (const value of cases) {
        const read = readerFor(async () => response(value));
        assert.equal(await read(), DEEPSEEK_STATUS.UNKNOWN);
    }
});

test('uses only the fixed public GET endpoint and sends no credentials, cookies, body, or custom headers', async () => {
    let calls = 0;
    const read = readerFor(async (url, init) => {
        calls++;
        assert.equal(url, statusUrl);
        assert.equal(init.method, 'GET');
        assert.equal(init.redirect, 'error');
        assert.equal(init.credentials, 'omit');
        assert.equal(init.cache, 'no-store');
        assert.ok(init.signal instanceof AbortSignal);
        assert.equal('headers' in init, false);
        assert.equal('body' in init, false);
        return response(payload());
    });
    assert.equal(await read(), DEEPSEEK_STATUS.OPERATIONAL);
    assert.equal(calls, 1);
});

test('HTTP errors, redirects, invalid JSON, and oversized bodies become unknown', async () => {
    assert.equal(await readerFor(async () => response('unavailable', { status: 503 }))(), DEEPSEEK_STATUS.UNKNOWN);
    assert.equal(await readerFor(async () => response('{invalid json'))(), DEEPSEEK_STATUS.UNKNOWN);
    assert.equal(await readerFor(async () => ({
        ok: true, redirected: true, headers: new Headers(), body: response(payload()).body,
    }))(), DEEPSEEK_STATUS.UNKNOWN);
    const oversizedBody = new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); controller.close(); },
    });
    assert.equal(await readerFor(async () => ({
        ok: true, redirected: false, headers: new Headers(), body: oversizedBody,
    }))(), DEEPSEEK_STATUS.UNKNOWN);

    let contentLengthBodyCancelled = false;
    const contentLengthBody = new ReadableStream({
        cancel() { contentLengthBodyCancelled = true; },
    });
    assert.equal(await readerFor(async () => ({
        ok: true, redirected: false, headers: new Headers({ 'content-length': String(256 * 1024 + 1) }), body: contentLengthBody,
    }))(), DEEPSEEK_STATUS.UNKNOWN);
    assert.equal(contentLengthBodyCancelled, true, 'an oversized Content-Length response body is canceled');
});

test('a hard deadline settles even if fetch or body reading ignores abort', async () => {
    async function expire(fetchImpl) {
        let deadline;
        let requestedDelay;
        const read = createDeepSeekStatusReader({
            fetchImpl,
            now: () => 0,
            setTimer(callback, delay) { deadline = callback; requestedDelay = delay; return 1; },
            clearTimer() {},
        });
        const pending = read();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(requestedDelay, 2_000);
        assert.equal(typeof deadline, 'function');
        deadline();
        assert.equal(await pending, DEEPSEEK_STATUS.UNKNOWN);
    }

    let fetchSignal;
    await expire((_url, init) => {
        fetchSignal = init.signal;
        return new Promise(() => {});
    });
    assert.equal(fetchSignal.aborted, true);

    let bodySignal;
    let slowBodyCancelled = false;
    const slowBody = new ReadableStream({
        pull() { return new Promise(() => {}); },
        cancel() { slowBodyCancelled = true; },
    });
    await expire((_url, init) => {
        bodySignal = init.signal;
        return Promise.resolve({ ok: true, redirected: false, headers: new Headers(), body: slowBody });
    });
    assert.equal(bodySignal.aborted, true);
    assert.equal(slowBodyCancelled, true, 'the deadline explicitly cancels a stalled response body');
});

test('single-flight requests share results and known/unknown cache entries use their separate TTLs', async () => {
    let currentTime = 0;
    let calls = 0;
    let release;
    const fetchImpl = async () => {
        calls++;
        if (calls === 1) await new Promise((resolve) => { release = resolve; });
        return response(payload());
    };
    const read = readerFor(fetchImpl, { now: () => currentTime });
    const first = read();
    const concurrent = read();
    assert.equal(first, concurrent);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    assert.equal(await first, DEEPSEEK_STATUS.OPERATIONAL);
    currentTime = 59_999;
    assert.equal(await read(), DEEPSEEK_STATUS.OPERATIONAL);
    assert.equal(calls, 1);
    currentTime = 60_000;
    assert.equal(await read(), DEEPSEEK_STATUS.OPERATIONAL);
    assert.equal(calls, 2);

    currentTime = 100_000;
    let unknownCalls = 0;
    const unknown = readerFor(async () => { unknownCalls++; return response('bad json'); }, { now: () => currentTime });
    assert.equal(await unknown(), DEEPSEEK_STATUS.UNKNOWN);
    currentTime += 14_999;
    assert.equal(await unknown(), DEEPSEEK_STATUS.UNKNOWN);
    assert.equal(unknownCalls, 1);
    currentTime += 1;
    assert.equal(await unknown(), DEEPSEEK_STATUS.UNKNOWN);
    assert.equal(unknownCalls, 2);
});
