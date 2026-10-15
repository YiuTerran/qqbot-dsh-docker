const STATUS_URL = 'https://status.deepseek.com/api/status-page/6410630422455/summary/active';
const STATUS_PAGE_ID = 6410630422455;
const MAX_BODY_BYTES = 256 * 1024;
const DEADLINE_MS = 2_000;
const KNOWN_TTL_MS = 60_000;
const UNKNOWN_TTL_MS = 15_000;

export const DEEPSEEK_STATUS = Object.freeze({
    OPERATIONAL: 'operational',
    API_INCIDENT: 'api-incident',
    UNKNOWN: 'unknown',
});

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}

function isApiServiceName(name) {
    const normalized = name.toLowerCase();
    return normalized.includes('api服务') || normalized.includes('api service');
}

function parseStatusPayload(payload) {
    if (!isObject(payload) || !isObject(payload.data)) return DEEPSEEK_STATUS.UNKNOWN;
    const { page, active_changes: activeChanges } = payload.data;
    if (!isObject(page) || String(page.page_id) !== String(STATUS_PAGE_ID) || page.custom_domain !== 'status.deepseek.com'
        || !Array.isArray(page.components) || !Array.isArray(activeChanges)) {
        return DEEPSEEK_STATUS.UNKNOWN;
    }

    const apiComponentIds = new Set();
    for (const component of page.components) {
        if (!isObject(component) || !isNonEmptyString(component.component_id) || !isNonEmptyString(component.name)) {
            return DEEPSEEK_STATUS.UNKNOWN;
        }
        if (isApiServiceName(component.name)) apiComponentIds.add(component.component_id);
    }
    if (apiComponentIds.size === 0) return DEEPSEEK_STATUS.UNKNOWN;

    let apiIncident = false;
    for (const change of activeChanges) {
        if (!isObject(change) || !isNonEmptyString(change.type)) return DEEPSEEK_STATUS.UNKNOWN;
        if (change.type === 'maintenance') continue;
        if (change.type !== 'incident') return DEEPSEEK_STATUS.UNKNOWN;
        if (change.status === 'resolved' || change.status === 'completed') continue;
        if (!['investigating', 'identified', 'monitoring'].includes(change.status)
            || !Array.isArray(change.affected_components)) {
            return DEEPSEEK_STATUS.UNKNOWN;
        }
        for (const affected of change.affected_components) {
            if (!isObject(affected) || !isNonEmptyString(affected.component_id)
                || !isNonEmptyString(affected.status)) {
                return DEEPSEEK_STATUS.UNKNOWN;
            }
            if (!apiComponentIds.has(affected.component_id)) continue;
            if (['degraded', 'partial_outage', 'full_outage'].includes(affected.status)) apiIncident = true;
            else if (affected.status !== 'operational') return DEEPSEEK_STATUS.UNKNOWN;
        }
    }
    return apiIncident ? DEEPSEEK_STATUS.API_INCIDENT : DEEPSEEK_STATUS.OPERATIONAL;
}

async function readBoundedBody(response, onReader = () => {}) {
    const contentLength = response.headers?.get?.('content-length');
    if (typeof contentLength === 'string' && /^\d+$/u.test(contentLength)
        && Number(contentLength) > MAX_BODY_BYTES) {
        throw new Error('status response too large');
    }
    const reader = response.body?.getReader?.();
    if (!reader) throw new Error('status response has no readable body');
    onReader(reader);

    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
            total += chunk.byteLength;
            if (total > MAX_BODY_BYTES) {
                try { await reader.cancel(); } catch { /* Keep the size failure authoritative. */ }
                throw new Error('status response too large');
            }
            chunks.push(chunk);
        }
    }
    finally {
        try { reader.releaseLock?.(); } catch { /* The body reader may already be closed. */ }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function cancelResponseBody(response) {
    try { await response?.body?.cancel?.(); } catch { /* A rejected or already-aborted body stays an unknown result. */ }
}

async function fetchStatus({ fetchImpl, controller, setActiveReader }) {
    const response = await fetchImpl(STATUS_URL, {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
    });
    if (!response || response.ok !== true || response.redirected === true) {
        await cancelResponseBody(response);
        return DEEPSEEK_STATUS.UNKNOWN;
    }
    let text;
    try { text = await readBoundedBody(response, (reader) => setActiveReader(reader)); }
    catch (error) {
        controller.abort();
        await cancelResponseBody(response);
        throw error;
    }
    let payload;
    try { payload = JSON.parse(text); }
    catch { return DEEPSEEK_STATUS.UNKNOWN; }
    return parseStatusPayload(payload);
}

/** Create a process-local status reader. Injected dependencies keep tests offline and deterministic. */
export function createDeepSeekStatusReader({
    fetchImpl = (...args) => globalThis.fetch(...args),
    now = () => Date.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (timer) => clearTimeout(timer),
} = {}) {
    let cache;
    let inFlight;

    return function readDeepSeekStatus() {
        const currentTime = now();
        if (cache && cache.expiresAt > currentTime) return Promise.resolve(cache.value);
        if (inFlight) return inFlight;

        const request = Promise.resolve().then(() => {
            const controller = new AbortController();
            let timer;
            let timedOut = false;
            let activeReader;
            const deadline = new Promise((resolve) => {
                timer = setTimer(() => {
                    timedOut = true;
                    controller.abort();
                    try {
                        const cancellation = activeReader?.cancel?.();
                        if (cancellation && typeof cancellation.catch === 'function') void cancellation.catch(() => {});
                    }
                    catch { /* Timeout already settles independently. */ }
                    resolve(DEEPSEEK_STATUS.UNKNOWN);
                }, DEADLINE_MS);
            });
            const operation = Promise.resolve()
                .then(() => fetchStatus({ fetchImpl, controller, setActiveReader: (reader) => {
                    activeReader = reader;
                    if (controller.signal.aborted) {
                        try {
                            const cancellation = reader.cancel();
                            if (cancellation && typeof cancellation.catch === 'function') void cancellation.catch(() => {});
                        }
                        catch { /* The deadline has already settled the caller. */ }
                    }
                } }))
                .catch(() => DEEPSEEK_STATUS.UNKNOWN);
            return Promise.race([operation, deadline]).finally(() => {
                if (timer !== undefined) clearTimer(timer);
                if (timedOut) controller.abort();
            });
        }).catch(() => DEEPSEEK_STATUS.UNKNOWN).then((value) => {
            const ttl = value === DEEPSEEK_STATUS.UNKNOWN ? UNKNOWN_TTL_MS : KNOWN_TTL_MS;
            cache = { value, expiresAt: now() + ttl };
            return value;
        });

        let sharedRequest;
        sharedRequest = request.finally(() => {
            if (inFlight === sharedRequest) inFlight = undefined;
        });
        inFlight = sharedRequest;
        return sharedRequest;
    };
}

const productionStatusReader = createDeepSeekStatusReader();

/** The default reader has no startup or background request; it runs only when explicitly awaited. */
export function readDeepSeekStatus() {
    return productionStatusReader();
}
