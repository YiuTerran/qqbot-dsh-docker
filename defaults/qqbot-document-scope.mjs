import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolveTextDocumentType } from './qqbot-text-documents.mjs';

const activeTurns = new WeakMap();
const executionBindings = new WeakMap();
const executionStorage = new AsyncLocalStorage();
const MAX_DOCUMENT_ATTEMPTS = 4;
const MAX_DOCUMENT_CHARS = 50000;
const MAX_TURN_DOCUMENT_CHARS = 100000;

function normalizeUrl(value) {
    if (value instanceof URL) value = value.href;
    if (typeof value !== 'string') return undefined;
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
        return url;
    }
    catch {
        return undefined;
    }
}

function addUrlsFromText(target, value) {
    if (typeof value !== 'string') return;
    for (const match of value.matchAll(/https?:\/\/[^\s<>"']+/giu)) {
        let candidate = match[0].replace(/[.,!?;:]+$/u, '');
        while (candidate.endsWith(')') && (candidate.match(/\(/gu)?.length ?? 0) < (candidate.match(/\)/gu)?.length ?? 0)) {
            candidate = candidate.slice(0, -1);
        }
        while (candidate.endsWith(']') && (candidate.match(/\[/gu)?.length ?? 0) < (candidate.match(/\]/gu)?.length ?? 0)) {
            candidate = candidate.slice(0, -1);
        }
        const url = normalizeUrl(candidate);
        if (url) target.add(url.href);
    }
}

function safeFilename(value, index) {
    if (typeof value !== 'string') return `attachment-${index + 1}.txt`;
    const basename = value.split(/[\\/]/u).at(-1) ?? '';
    const safe = basename.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').trim().slice(0, 160);
    return safe || `attachment-${index + 1}.txt`;
}

function safeSize(value) {
    if (value === null || value === undefined || value === '') return null;
    const size = Number(value);
    return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

function safeDeclaredContentType(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').trim().slice(0, 200);
}

function attachmentUrl(value) {
    const url = normalizeUrl(value);
    if (!url || url.protocol !== 'https:') return undefined;
    url.hash = '';
    return url.href;
}

function candidateAttachments(message, quote) {
    const current = Array.isArray(message?.attachments) ? message.attachments : [];
    const quoted = Array.isArray(quote?.attachments) ? quote.attachments : [];
    return [
        ...current.map((attachment) => ({ attachment, quoted: false })),
        ...quoted.map((attachment) => ({ attachment, quoted: true })),
    ];
}

function opaqueId() {
    return randomBytes(18).toString('base64url');
}

function cancelTurn(scope) {
    if (!scope || !scope.active) return;
    scope.active = false;
    scope.controller.abort(new Error('QQ document turn ended.'));
    scope.documents.clear();
    scope.readPromises.clear();
    scope.attemptedIds.clear();
    scope.allowedUrls.clear();
}

/** Create an in-memory scope for exactly one QQ message and its explicit quote. */
export function beginDocumentTurn(agent, message, quote) {
    if ((typeof agent !== 'object' && typeof agent !== 'function') || agent === null) {
        throw new TypeError('A QQ agent is required to create a document turn.');
    }
    const previous = activeTurns.get(agent);
    cancelTurn(previous);

    const scope = {
        agent,
        active: true,
        documentMode: false,
        controller: new AbortController(),
        documents: new Map(),
        readPromises: new Map(),
        attemptedIds: new Set(),
        allowedUrls: new Set(),
        outputChars: 0,
    };
    addUrlsFromText(scope.allowedUrls, message?.content);

    const metadata = [];
    const seenIds = new Set();
    for (const { attachment, quoted } of candidateAttachments(message, quote)) {
        const declaredRaw = safeDeclaredContentType(attachment?.content_type ?? attachment?.contentType);
        // QQ's generic `file` label carries no MIME information. It may use
        // the narrowly allowed extension fallback; explicit complex MIME stays denied.
        const declaredValue = declaredRaw.toLowerCase() === 'file' ? '' : declaredRaw;
        const sourceFilename = typeof attachment?.filename === 'string' ? attachment.filename : '';
        const filename = safeFilename(sourceFilename, metadata.length);
        const type = resolveTextDocumentType(declaredValue, sourceFilename, { allowExtensionFallback: true });
        const url = attachmentUrl(attachment?.url);
        if (!type.accepted || !url) continue;
        let attachmentId = opaqueId();
        while (seenIds.has(attachmentId)) attachmentId = opaqueId();
        seenIds.add(attachmentId);

        const entry = {
            attachmentId,
            filename,
            contentType: type.contentType,
            size: safeSize(attachment?.size),
            quoted,
        };
        scope.documents.set(attachmentId, {
            ...entry,
            url,
            sourceFilename,
            declaredContentType: declaredValue,
        });
        metadata.push(entry);
    }
    scope.documentMode = metadata.length > 0;
    activeTurns.set(agent, scope);
    return metadata;
}

/** End a turn, abort its work, and immediately invalidate IDs and URL grants. */
export function endDocumentTurn(agent, expectedScope) {
    if (!agent || (typeof agent !== 'object' && typeof agent !== 'function')) return;
    const scope = activeTurns.get(agent);
    if (!scope || (expectedScope && scope !== expectedScope)) return;
    cancelTurn(scope);
    if (activeTurns.get(agent) === scope) activeTurns.delete(agent);
}

export function getDocumentTurn(agent) {
    const scope = agent && activeTurns.get(agent);
    return scope?.active ? scope : undefined;
}

export function isDocumentTurnActive(agent, scope) {
    const current = agent && activeTurns.get(agent);
    return Boolean(current?.active && (!scope || current === scope));
}

/** Bind a native execution object once so a delayed dispatch cannot adopt a later turn. */
export function bindDocumentExecution(exec) {
    if (!exec || (typeof exec !== 'object' && typeof exec !== 'function')) return undefined;
    if (!executionBindings.has(exec)) executionBindings.set(exec, getDocumentTurn(exec.agent) ?? null);
    return executionBindings.get(exec);
}

export function getBoundDocumentExecution(exec) {
    return exec && executionBindings.has(exec) ? executionBindings.get(exec) : undefined;
}

export function runInDocumentExecution(exec, operation) {
    const scope = bindDocumentExecution(exec);
    return executionStorage.run({ agent: exec?.agent, scope, exec }, operation);
}

export function getDocumentExecutionContext() {
    return executionStorage.getStore();
}

export function isBoundDocumentExecutionActive(exec) {
    const scope = getBoundDocumentExecution(exec);
    return Boolean(scope && isDocumentTurnActive(exec?.agent, scope));
}

export function documentExecutionFailure(exec) {
    const scope = bindDocumentExecution(exec);
    if (!scope) return 'No active QQ message authorizes this tool call.';
    if (!isDocumentTurnActive(exec?.agent, scope)) return 'This tool call belongs to an expired QQ message.';
    return undefined;
}

export function getDocumentRecord(scope, attachmentId) {
    if (!scope?.active || typeof attachmentId !== 'string') return undefined;
    return scope.documents.get(attachmentId);
}

export function beginDocumentRead(scope, attachmentId, loader) {
    if (!scope?.active || !scope.documents.has(attachmentId)) {
        throw new Error('This QQ document attachment is no longer available.');
    }
    if (!scope.attemptedIds.has(attachmentId)) {
        if (scope.attemptedIds.size >= MAX_DOCUMENT_ATTEMPTS) {
            throw new Error('This QQ message has reached its four-document read limit.');
        }
        scope.attemptedIds.add(attachmentId);
    }
    let pending = scope.readPromises.get(attachmentId);
    if (!pending) {
        pending = Promise.resolve().then(loader);
        scope.readPromises.set(attachmentId, pending);
    }
    return pending;
}

export function chargeDocumentOutput(scope, text) {
    if (!scope?.active) throw new Error('This QQ document turn has expired.');
    const chars = typeof text === 'string' ? text.length : 0;
    if (chars > MAX_DOCUMENT_CHARS) throw new Error('A QQ document result exceeds the 50000-character output limit.');
    if (scope.outputChars + chars > MAX_TURN_DOCUMENT_CHARS) {
        throw new Error('This QQ message has reached its 100000-character document output limit.');
    }
    scope.outputChars += chars;
}

export function isTurnUrlAllowed(agent, candidate, scope = getDocumentTurn(agent)) {
    if (!scope || !isDocumentTurnActive(agent, scope)) return false;
    const url = normalizeUrl(candidate);
    return Boolean(url && scope.allowedUrls.has(url.href));
}

export function activateDocumentMode(scope) {
    if (scope?.active) scope.documentMode = true;
}

export function activateCurrentDocumentMode() {
    const context = executionStorage.getStore();
    if (context?.scope?.active) context.scope.documentMode = true;
}

export function recordSuccessfulSearchSources(exec, result) {
    const scope = getBoundDocumentExecution(exec);
    if (!scope || !isDocumentTurnActive(exec?.agent, scope) || result?.isError) return;
    const sources = result?.value?.sources;
    if (!Array.isArray(sources)) return;
    for (const source of sources) {
        const url = normalizeUrl(source?.url);
        if (url) scope.allowedUrls.add(url.href);
    }
}

/** Capture an exact turn-authorized URL for one provider fetch operation. */
export function authorizeTurnProviderUrl(candidate) {
    const context = executionStorage.getStore();
    if (!context) return undefined; // Direct provider diagnostics have no QQ tool context.
    const { scope, agent } = context;
    if (!scope || !isDocumentTurnActive(agent, scope)) throw new Error('This QQ message scope has expired.');
    const url = normalizeUrl(candidate);
    if (!url || (scope.documentMode && !scope.allowedUrls.has(url.href))) {
        throw new Error('This URL was not present in the current QQ message or its successful web search results.');
    }
    return { kind: 'turn-url', scope, agent, origin: url.origin, initialUrl: url.href };
}

/** Authorize only the registered attachment ID's exact HTTPS URL for its document fetch. */
export function authorizeDocumentProviderUrl(candidate, attachmentId) {
    const context = executionStorage.getStore();
    if (!context) throw new Error('QQ document access requires an active tool execution.');
    const { scope, agent } = context;
    if (!scope || !isDocumentTurnActive(agent, scope)) throw new Error('This QQ message scope has expired.');
    const record = getDocumentRecord(scope, attachmentId);
    const url = normalizeUrl(candidate);
    if (!record || !url || url.href !== record.url) throw new Error('This QQ document URL is no longer authorized.');
    return { kind: 'document-url', scope, agent, attachmentId, initialUrl: record.url };
}

export function runWithDocumentCapability(scope, attachmentId, operation) {
    const context = executionStorage.getStore();
    if (!context || context.scope !== scope || !isDocumentTurnActive(context.agent, scope)
        || !getDocumentRecord(scope, attachmentId)) {
        throw new Error('QQ document access requires its active attachment capability.');
    }
    return executionStorage.run({
        ...context,
        documentCapability: attachmentId,
        providerAuthorization: undefined,
    }, operation);
}

export function runWithProviderAuthorization(authorization, operation) {
    const context = executionStorage.getStore();
    if (!context || !authorization) return operation();
    return executionStorage.run({ ...context, providerAuthorization: authorization }, operation);
}

/** Recheck the captured scope after DNS resolution and before a network request. */
export function assertProviderRequestUrl(candidate) {
    const context = executionStorage.getStore();
    if (!context) return; // Retain direct provider tests/diagnostics outside model execution.
    const authorization = context.providerAuthorization;
    if (!authorization || !isDocumentTurnActive(authorization.agent, authorization.scope)) {
        throw new Error('This QQ message scope has expired.');
    }
    const url = normalizeUrl(candidate);
    if (!url) throw new Error('Only public HTTP(S) URLs without credentials are allowed.');
    if (authorization.kind === 'turn-url' && url.origin === authorization.origin) {
        if (authorization.scope.documentMode && !authorization.scope.allowedUrls.has(authorization.initialUrl)) {
            throw new Error('This URL is outside the active QQ document-mode allowlist.');
        }
        return;
    }
    if (authorization.kind === 'document-url' && url.href === authorization.initialUrl
        && getDocumentRecord(authorization.scope, authorization.attachmentId)?.url === authorization.initialUrl) return;
    throw new Error('The network request is outside the authorized URL scope.');
}

export function getTurnRequestSignal(scope, signal) {
    if (!scope?.active) throw new Error('This QQ message scope has expired.');
    return signal ? AbortSignal.any([signal, scope.controller.signal]) : scope.controller.signal;
}
