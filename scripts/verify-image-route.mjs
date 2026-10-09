// Manual live smoke test. Run inside the dsh image with IMAGE_* from --env-file.
// Exactly one paid generation request; no real QQ requests or production quota writes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const PROMPT = 'A simple friendly blue whale on a plain white background, flat illustration, no text.';
const SAFE_ERRORS = new Set([
    'invalid-request', 'expired', 'aborted', 'provider-response', 'provider-image-url',
    'provider-image', 'invalid-image', 'image-too-large', 'response-too-large',
    'cross-origin-redirect', 'redirect-limit', 'api-redirect-denied', 'no-public-address',
    'invalid-image-response', 'invalid-image-url', 'generation-timeout',
    'output-directory-required', 'image-route-required',
]);
const SAFE_TYPES = new Set(['application/json', 'image/png', 'image/jpeg', 'text/html', 'text/plain']);
const SAFE_RESPONSE_TYPES = new Set(['basic', 'cors', 'default', 'error', 'opaque', 'opaqueredirect']);

let phase = 'usage';
let ctx;
let generationScope;
let documentScope;
let scopeModules;
let quotaDirectory;
let serviceFailure;
let image;
let toolStatus;
let generateCalls = 0;
let savedImages = 0;
let markdownSends = 0;
const agent = {};
const requests = [];
const started = performance.now();

function safeFailure(error) {
    if ([error?.code, error?.cause?.code].includes('UND_ERR_INVALID_ARG')) return 'transport-dispatcher-compatibility-error';
    // Inspect provider diagnostics locally, but expose only this fixed category.
    if (typeof error?.message === 'string'
        && /\b(?:dns|ip|address)\b.*\b(?:public|private|reserved|blocked|forbidden)\b|\b(?:public|private|reserved)\b.*\b(?:ip|address)\b/iu.test(error.message)) {
        return 'dns-public-address-check';
    }
    if (SAFE_ERRORS.has(error?.message)) return error.message;
    if (error?.name === 'TimeoutError') return 'timeout';
    if (error?.name === 'AbortError') return 'aborted';
    return `${phase}-failed`;
}

function mimeOf(bytes) {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    return 'unknown';
}

function metadata() {
    return { elapsedMs: Math.round(performance.now() - started), requests };
}

try {
    if (process.argv.length !== 3 || !process.argv[2]) throw new Error('output-directory-required');
    const outputDirectory = resolve(process.argv[2]);
    phase = 'configuration';
    const moduleSpecifier = process.env.QQBOT_GENERATION_MODULE ?? '/opt/qqbot-defaults/qqbot-generation.mjs';
    const generationUrl = moduleSpecifier.startsWith('file:') ? moduleSpecifier : pathToFileURL(resolve(moduleSpecifier)).href;
    const generationDir = dirname(fileURLToPath(generationUrl));
    const generation = await import(generationUrl);
    const route = generation.readImageRouteConfig();
    if (!route) throw new Error('image-route-required');
    const api = new URL(route.baseUrl);
    const apiPath = `${api.pathname.replace(/\/+$/u, '')}/images/generations`;
    const generationScopes = await import(pathToFileURL(join(generationDir, 'qqbot-generation-scope.mjs')).href);
    const documentScopes = await import(pathToFileURL(join(generationDir, 'qqbot-document-scope.mjs')).href);
    scopeModules = { ...generationScopes, ...documentScopes };
    const { createGenerationQuota } = await import(pathToFileURL(join(generationDir, 'qqbot-generation-quotas.mjs')).href);
    quotaDirectory = await mkdtemp(join(tmpdir(), 'qqbot-live-image-'));
    const limits = { imageHourlyLimit: 1, markdownHourlyLimit: 1, imageConcurrent: 1, markdownConcurrent: 1 };
    const quota = createGenerationQuota({ path: join(quotaDirectory, 'quota.json'), appId: 'live-image-probe', limits });

    // Preserve every production fetch option, especially its validated DNS dispatcher.
    // Fetch and Agent must come from the same undici package version.
    const { fetch: nativeFetch } = await import('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/undici/index.js');
    const imageService = generation.createImageService({ route, fetchImpl: async (url, options) => {
        const response = await nativeFetch(url, options);
        const isGeneration = options.method === 'POST';
        const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
        requests.push({
            stage: isGeneration ? 'generation' : 'image-download',
            ...(isGeneration ? { host: api.hostname, path: apiPath } : {}),
            status: response.status,
            contentType: SAFE_TYPES.has(contentType) ? contentType : 'other',
            type: SAFE_RESPONSE_TYPES.has(response.type) ? response.type : 'other',
        });
        return response;
    } });
    const service = { async generate(input) {
        assert.equal(++generateCalls, 1, 'Only one generation call is allowed.');
        assert.equal(typeof input.assertActive, 'function');
        assert.equal(input.assertActive(), true);
        try { return await imageService.generate(input); }
        catch (error) { serviceFailure = safeFailure(error); throw error; }
    } };
    const sender = {
        async sendNotice() { return { sent: true }; },
        async sendImage(request, bytes, signal) {
            assert.equal(request.isActive('image'), true);
            assert.equal(signal.aborted, false);
            assert.equal(++savedImages, 1);
            image = Buffer.from(bytes);
            const mime = mimeOf(image);
            assert.ok(['image/png', 'image/jpeg'].includes(mime));
            await mkdir(outputDirectory, { recursive: true });
            await writeFile(join(outputDirectory, mime === 'image/png' ? 'blue-whale.png' : 'blue-whale.jpg'), image, { flag: 'wx' });
            assert.equal(request.isActive('image'), true);
            return { sent: true };
        },
        async sendMarkdownFile(request, bytes, filename, signal) {
            assert.equal(request.isActive('markdown'), true);
            assert.equal(signal.aborted, false);
            assert.equal(filename, 'live-probe.md');
            assert.equal(Buffer.from(bytes).toString('utf8'), '# Live probe\n');
            markdownSends += 1;
            return { sent: true };
        },
        async sendMarkdownFallback() { throw new Error('unexpected-markdown-fallback'); },
        async sendAssetImageFile() { throw new Error('unexpected-original-asset-delivery'); },
    };

    phase = 'runtime';
    const dshRoot = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/';
    const { Context } = await import(`${dshRoot}cordis/lib/index.js`);
    const { default: SystemPrompt } = await import(`${dshRoot}dsh-system-prompt/lib/index.js`);
    const { default: ToolRuntime } = await import(`${dshRoot}dsh-tools/lib/index.js`);
    ctx = new Context();
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime, { mode: 'native' });
    ctx.tools.guard((exec) => {
        scopeModules.bindDocumentExecution(exec);
        return generation.validateGenerationToolCall(exec, route);
    });
    ctx.on('tools/execute', (exec, next) => scopeModules.runInDocumentExecution(exec, next));
    const registration = generation.registerGenerationTools(ctx, { route, quota, sender, imageService: service, limits, markdownEnabled: true });
    assert.equal(registration.imageEnabled, true);
    const visibleTools = (await ctx.systemPrompt.assemble()).tools.map(({ name }) => name);
    assert.ok(visibleTools.includes(generation.GENERATE_IMAGE_TOOL));
    assert.ok(visibleTools.includes(generation.CREATE_MARKDOWN_TOOL));

    const requestText = 'Generate one simple blue whale image and export a Markdown file.';
    scopeModules.beginDocumentTurn(agent, { content: requestText });
    documentScope = scopeModules.getDocumentTurn(agent);
    generationScope = scopeModules.beginGenerationTurn(agent, [{
        ownerId: 'live-probe-owner',
        replyTarget: { scope: 'group', targetId: 'live-probe-group', msgId: 'live-probe-message' },
        text: requestText,
        currentAttachments: [], quotedAttachments: [],
    }], [], { documentScope });
    const [requestId] = generationScope.requests.keys();
    assert.equal(typeof requestId, 'string');
    const execute = (name, args, callId) => ctx.tools.execute({ name, arguments: args, agent, callId, signal: new AbortController().signal });

    phase = 'markdown-verification';
    const markdown = await execute(generation.CREATE_MARKDOWN_TOOL, { requestId, filename: 'live-probe.md', content: '# Live probe\n' }, 'live-markdown');
    assert.equal(markdown.isError, false);
    assert.equal(markdown.value.status, 'markdown');
    assert.equal(markdownSends, 1);

    phase = 'image-verification';
    const result = await execute(generation.GENERATE_IMAGE_TOOL, { requestId, prompt: PROMPT }, 'live-image');
    toolStatus = ['sent', 'failed', 'expired', 'quota', 'state', 'busy', 'invalid', 'image-type', 'too-large'].includes(result.value?.status)
        ? result.value.status : 'unknown';
    assert.equal(result.isError, false);
    assert.equal(toolStatus, 'sent');
    assert.equal(generateCalls, 1);
    assert.equal(savedImages, 1);
    assert.ok(image?.length > 0);

    phase = 'cleanup-verification';
    await scopeModules.endGenerationTurn(agent, generationScope);
    scopeModules.endDocumentTurn(agent, documentScope);
    assert.equal(generationScope.active, false);
    assert.equal(generationScope.requests.size, 0);
    assert.equal(scopeModules.getDocumentTurn(agent), undefined);
    const expired = await execute(generation.CREATE_MARKDOWN_TOOL, { requestId, filename: 'live-probe.md', content: '# Live probe\n' }, 'live-expired');
    assert.equal(expired.isError, true);
    assert.equal(markdownSends, 1);
    assert.equal(generateCalls, 1);
    console.log(JSON.stringify({ ok: true, bytes: image.length, sha256: createHash('sha256').update(image).digest('hex'), mime: mimeOf(image), toolStatus, markdown: 'sent', cleanup: 'verified', ...metadata() }));
}
catch (error) {
    console.error(JSON.stringify({ ok: false, classification: serviceFailure ?? safeFailure(error), ...(toolStatus ? { toolStatus } : {}), ...metadata() }));
    process.exitCode = 1;
}
finally {
    // Never let cleanup exceptions print a raw stack or provider-originated data.
    let cleanupFailed = false;
    for (const cleanup of [
        () => generationScope && scopeModules.endGenerationTurn(agent, generationScope),
        () => documentScope && scopeModules.endDocumentTurn(agent, documentScope),
        () => ctx?.fiber.dispose(),
        () => quotaDirectory && rm(quotaDirectory, { recursive: true, force: true }),
    ]) {
        try { await cleanup(); }
        catch { cleanupFailed = true; }
    }
    if (cleanupFailed) {
        console.error(JSON.stringify({ ok: false, classification: 'cleanup-failed', ...metadata() }));
        process.exitCode = 1;
    }
}
