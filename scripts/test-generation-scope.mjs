// Deterministic provenance and lifetime tests for Phase 2 generation grants.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const scopeUrl = process.env.QQBOT_GENERATION_SCOPE_MODULE
    ?? new URL('../defaults/qqbot-generation-scope.mjs', import.meta.url).href;
const scopeModuleUrl = scopeUrl instanceof URL ? scopeUrl
    : scopeUrl.startsWith('file:') ? new URL(scopeUrl) : pathToFileURL(resolve(scopeUrl));
const {
    beginGenerationTurn,
    endGenerationTurn,
    generationRequestMetadata,
    generationScopeFailure,
    getGenerationImageAttachment,
    getGenerationRecentImageAttachment,
    getGenerationRecentImageReference,
    getGenerationRequest,
    getGenerationTurn,
    renderGenerationRequestMetadata,
    trackGenerationOperation,
    claimGenerationRecentImage,
} = await import(scopeUrl);
const { createPendingImagePromptCache } = await import(new URL('./qqbot-pending-images.mjs', scopeModuleUrl));

const APP = '123456789';

const imageA = 'https://cdn.example.test/first.png';
const imageB = 'https://cdn.example.test/quoted-b.jpg';
const imageC = 'https://cdn.example.test/quoted-c.png';

function originalRequest({ ownerId, groupId, msgId, text = '', currentAttachments = [], quotedAttachments = [], recentImageSnapshot }) {
    return {
        ownerId,
        replyTarget: { scope: 'group', targetId: groupId, msgId },
        text,
        currentAttachments,
        quotedAttachments,
        recentImageSnapshot,
    };
}

function image(url, filename, contentType = 'image/png') {
    return { url, filename, content_type: contentType };
}

function downloaded(url, localPath = `/data/qqbot-media/${encodeURIComponent(url.split('/').at(-1))}`) {
    return { sourceUrl: url, localPath };
}

function activeDocumentScope({ documentMode = false } = {}) {
    return { active: true, documentMode };
}

function metadataFor(scope, ownerId) {
    const request = [...scope.requests.values()].find((entry) => entry.ownerId === ownerId);
    assert.ok(request, `request for ${ownerId} must be present`);
    const metadata = generationRequestMetadata(scope).find((entry) => entry.requestId === request.requestId);
    assert.ok(metadata);
    return { request, metadata };
}

function recentSnapshot(cache, { ownerId = 'user-a', groupId = 'group-a', sourceId = 'image-source', filenames = ['recent.png'] } = {}) {
    const source = {
        appId: APP,
        kind: 'group',
        senderId: ownerId,
        groupOpenid: groupId,
        messageId: sourceId,
        content: '',
        attachments: filenames.map((filename, index) => image(`https://cdn.example.test/${sourceId}-${index}.png`, filename)),
        replyTarget: { scope: 'group', targetId: groupId, msgId: sourceId },
    };
    assert.equal(cache.capture(source, APP), true);
    const prompt = { ...source, messageId: `${sourceId}-prompt`, content: 'use these recent images', attachments: [] };
    return { source, prompt, snapshot: cache.snapshot(prompt, APP, { mention: { wasMentioned: true } }) };
}

test('recent-image grants use branded snapshots, stay separate from current image IDs, and hide source URLs', async () => {
    const cache = createPendingImagePromptCache();
    const { snapshot } = recentSnapshot(cache);
    assert.ok(snapshot);
    const agent = {};
    const scope = beginGenerationTurn(agent, [originalRequest({
        ownerId: 'user-a', groupId: 'group-a', msgId: 'prompt-a', text: 'ordinary chat',
        recentImageSnapshot: snapshot,
    })], [], { documentScope: activeDocumentScope(), media: { enabled: true, maxMB: 2 } });
    const { request, metadata } = metadataFor(scope, 'user-a');

    assert.deepEqual(metadata.images, [], 'recent candidates are not current or quoted generation image IDs');
    assert.equal(metadata.recentImages.length, 1, 'recent grants are available without an image-generation API route');
    assert.equal(metadata.recentImages[0].imageAttachmentId.length > 0, true);
    assert.equal(metadata.recentImages[0].imageRef,
        `qqbot-image:${request.requestId}:${metadata.recentImages[0].imageAttachmentId}`);
    assert.equal(getGenerationRecentImageAttachment(scope, request.requestId,
        metadata.recentImages[0].imageAttachmentId).maxBytes, 2 * 1024 * 1024);
    assert.ok(getGenerationRecentImageReference(scope, metadata.recentImages[0].imageRef));
    assert.ok(!renderGenerationRequestMetadata(scope).includes('https://cdn.example.test/'));
    assert.equal(claimGenerationRecentImage(scope, 'some-other-request', metadata.recentImages[0].imageAttachmentId), false,
        'candidate IDs cannot cross original request boundaries');

    await endGenerationTurn(agent, scope);
    assert.equal(getGenerationRecentImageAttachment(scope, request.requestId, metadata.recentImages[0].imageAttachmentId), undefined);
    assert.equal((await import(new URL('./qqbot-pending-images.mjs', scopeModuleUrl))).recentImageSnapshotAvailable(snapshot), false,
        'ending the original turn releases its snapshot capability');
    cache.clear();
});

test('recent candidates yield to current or quoted images, explicit remote sources, disabled media, and document mode', async () => {
    const cases = [
        { text: 'please inspect this', currentAttachments: [image(imageA, 'current.png')] },
        { text: 'please inspect this', quotedAttachments: [image(imageB, 'quoted.jpg')] },
        { text: 'please inspect https://images.example/current.png' },
        { text: 'please inspect http://images.example/current.png' },
        { text: 'please inspect this', media: { enabled: false } },
        { text: 'please inspect this', documentMode: true },
    ];
    for (const [index, entry] of cases.entries()) {
        const cache = createPendingImagePromptCache();
        const { snapshot } = recentSnapshot(cache, { sourceId: `priority-${index}` });
        const agent = {};
        const documentScope = activeDocumentScope({ documentMode: entry.documentMode === true });
        const scope = beginGenerationTurn(agent, [originalRequest({
            ownerId: 'user-a', groupId: 'group-a', msgId: `prompt-${index}`,
            text: entry.text,
            currentAttachments: entry.currentAttachments,
            quotedAttachments: entry.quotedAttachments,
            recentImageSnapshot: snapshot,
        })], [], { documentScope, media: entry.media ?? { enabled: true } });
        assert.deepEqual(generationRequestMetadata(scope)[0].recentImages, [], `case ${index} must not fall back to recent images`);
        await endGenerationTurn(agent, scope);
        cache.clear();
    }
});

test('a batch claim is atomic across distinct snapshot identities and repeatable only for the same original', async () => {
    const cache = createPendingImagePromptCache();
    const { prompt, snapshot: firstSnapshot } = recentSnapshot(cache, { sourceId: 'atomic-source' });
    const secondSnapshot = cache.snapshot(prompt, APP, { mention: { wasMentioned: true } });
    assert.ok(firstSnapshot && secondSnapshot && firstSnapshot !== secondSnapshot);
    const agent = {};
    const scope = beginGenerationTurn(agent, [
        originalRequest({ ownerId: 'user-a', groupId: 'group-a', msgId: 'atomic-a', recentImageSnapshot: firstSnapshot }),
        originalRequest({ ownerId: 'user-a', groupId: 'group-a', msgId: 'atomic-b', recentImageSnapshot: secondSnapshot }),
    ], [], { documentScope: activeDocumentScope(), media: { enabled: true } });
    const first = metadataFor(scope, 'user-a');
    const firstId = first.metadata.recentImages[0].imageAttachmentId;
    const otherRequest = [...scope.requests.values()].find((request) => request.requestId !== first.request.requestId);
    const otherMetadata = generationRequestMetadata(scope).find((entry) => entry.requestId === otherRequest.requestId);
    assert.equal(getGenerationRecentImageAttachment(scope, otherRequest.requestId, firstId), undefined);
    assert.equal(claimGenerationRecentImage(scope, first.request.requestId, firstId), true);
    assert.equal(claimGenerationRecentImage(scope, first.request.requestId, firstId), true,
        'the same original can repeat tool reads after a successful claim');
    assert.equal(generationRequestMetadata(scope).find((entry) => entry.requestId === otherRequest.requestId).recentImages.length, 0,
        'the other snapshot becomes unavailable after the first atomic claim');
    assert.equal(claimGenerationRecentImage(scope, otherRequest.requestId,
        otherMetadata.recentImages[0].imageAttachmentId), false);

    await endGenerationTurn(agent, scope);
    cache.clear();
});

test('recent grants expire and /new revokes their opaque references', async () => {
    let time = 0;
    const cache = createPendingImagePromptCache({ ttlMs: 100, now: () => time,
        setTimeout(callback, delay) { return { callback, at: time + delay, unref() {} }; }, clearTimeout() {} });
    const { source, snapshot } = recentSnapshot(cache, { sourceId: 'expiry-source' });
    const agent = {};
    const scope = beginGenerationTurn(agent, [originalRequest({
        ownerId: 'user-a', groupId: 'group-a', msgId: 'expiry-prompt', recentImageSnapshot: snapshot,
    })], [], { documentScope: activeDocumentScope(), media: { enabled: true } });
    const { request, metadata } = metadataFor(scope, 'user-a');
    const candidateId = metadata.recentImages[0].imageAttachmentId;
    time = 101;
    assert.equal(getGenerationRecentImageAttachment(scope, request.requestId, candidateId), undefined);
    await endGenerationTurn(agent, scope);
    cache.clear();

    const resetCache = createPendingImagePromptCache();
    const reset = recentSnapshot(resetCache, { sourceId: 'reset-source' });
    const resetAgent = {};
    const resetScope = beginGenerationTurn(resetAgent, [originalRequest({
        ownerId: 'user-a', groupId: 'group-a', msgId: 'reset-prompt', recentImageSnapshot: reset.snapshot,
    })], [], { documentScope: activeDocumentScope(), media: { enabled: true } });
    const resetMeta = metadataFor(resetScope, 'user-a');
    assert.equal(resetCache.clearForMessage(reset.source, APP), true);
    assert.equal(getGenerationRecentImageReference(resetScope, resetMeta.metadata.recentImages[0].imageRef), undefined,
        'a /new reset revokes its source snapshot immediately');
    await endGenerationTurn(resetAgent, resetScope);
    resetCache.clear();
});

test('generation metadata binds each merged original request and quoted image to its own owner and reply target', async (t) => {
    const agent = {};
    const documentScope = activeDocumentScope();
    const scope = beginGenerationTurn(agent, [
        originalRequest({
            ownerId: 'user-a', groupId: 'group-a', msgId: 'message-a',
            text: 'Please edit the quoted image into a watercolor postcard.',
            currentAttachments: [image(imageA, 'first.png')],
            quotedAttachments: [image(imageB, 'quote-b.jpg', 'image/jpeg')],
        }),
        originalRequest({
            ownerId: 'user-b', groupId: 'group-b', msgId: 'message-b',
            text: 'Make my attached image brighter.',
            currentAttachments: [image(imageC, 'quote-c.png')],
        }),
    ], [downloaded(imageA), downloaded(imageB), downloaded(imageC)], { documentScope });
    t.after(() => endGenerationTurn(agent, scope));

    const { request: requestA, metadata: metadataA } = metadataFor(scope, 'user-a');
    const { request: requestB, metadata: metadataB } = metadataFor(scope, 'user-b');
    assert.notEqual(requestA.requestId, requestB.requestId);
    assert.deepEqual(requestA.replyTarget, { scope: 'group', targetId: 'group-a', msgId: 'message-a' });
    assert.deepEqual(requestB.replyTarget, { scope: 'group', targetId: 'group-b', msgId: 'message-b' });
    assert.equal(metadataA.images.length, 2);
    assert.equal(metadataA.userRequest, 'Please edit the quoted image into a watercolor postcard.');
    assert.equal(metadataA.images[0].quoted, false);
    assert.equal(metadataA.images[1].quoted, true);
    assert.equal(metadataB.images.length, 1);
    assert.equal(metadataB.images[0].quoted, false);

    const quoteBId = metadataA.images.find((entry) => entry.quoted).imageAttachmentId;
    const imageCId = metadataB.images[0].imageAttachmentId;
    assert.equal(getGenerationImageAttachment(scope, requestA.requestId, quoteBId).localPath, `/data/qqbot-media/${encodeURIComponent('quoted-b.jpg')}`);
    assert.equal(getGenerationImageAttachment(scope, requestB.requestId, quoteBId), undefined,
        'a quote ID from another original request cannot be adopted after messages merge');
    assert.equal(getGenerationImageAttachment(scope, requestA.requestId, imageCId), undefined,
        'one merged member cannot edit another member’s current image');

    const promptMetadata = renderGenerationRequestMetadata(scope);
    assert.ok(promptMetadata.includes(requestA.requestId));
    assert.ok(promptMetadata.includes(requestB.requestId));
    assert.ok(promptMetadata.includes(quoteBId));
    assert.ok(promptMetadata.includes('Please edit the quoted image into a watercolor postcard.'));
    assert.ok(!promptMetadata.includes(imageA));
    assert.ok(!promptMetadata.includes('/data/qqbot-media'));
    assert.match(promptMetadata, /matching original user request explicitly asks/u);
});

test('quoted image grants survive a QQ message ID with visible punctuation, while malformed IDs fail closed', async (t) => {
    const agent = {};
    const msgId = 'ROBOT1.0.AB+/cd==';
    const scope = beginGenerationTurn(agent, [originalRequest({
        ownerId: 'user-a', groupId: 'group-a', msgId,
        text: 'Add a whale to the quoted image.',
        quotedAttachments: [image(imageB, 'quoted.jpg', 'image/jpeg')],
    })], [downloaded(imageB)], { documentScope: activeDocumentScope() });
    t.after(() => endGenerationTurn(agent, scope));

    const { request, metadata } = metadataFor(scope, 'user-a');
    assert.equal(request.replyTarget.msgId, msgId, 'the original opaque QQ message ID is preserved byte for byte');
    assert.equal(metadata.images.length, 1);
    assert.equal(metadata.images[0].quoted, true);
    assert.ok(metadata.images[0].imageAttachmentId, 'the explicitly quoted image receives an opaque grant');
    assert.ok(getGenerationImageAttachment(scope, request.requestId, metadata.images[0].imageAttachmentId));

    const invalidMsgIds = [
        '',
        null,
        42,
        'message with spaces',
        'message\nwith-control',
        `x${'x'.repeat(256)}`,
        '消息',
    ];
    for (const invalidMsgId of invalidMsgIds) {
        const invalidScope = beginGenerationTurn(agent, [originalRequest({
            ownerId: 'user-a', groupId: 'group-a', msgId: invalidMsgId,
            quotedAttachments: [image(imageB, 'quoted.jpg', 'image/jpeg')],
        })], [downloaded(imageB)], { documentScope: activeDocumentScope() });
        assert.equal(generationRequestMetadata(invalidScope).length, 0, `invalid msgId ${String(invalidMsgId)} is rejected`);
        await endGenerationTurn(agent, invalidScope);
    }
});

test('only matching public supported image downloads become image grants', async (t) => {
    const agent = {};
    const scope = beginGenerationTurn(agent, [originalRequest({
        ownerId: 'user-a', groupId: 'group-a', msgId: 'message-a',
        currentAttachments: [
            image(imageA, 'ok.png'),
            image('https://cdn.example.test/animated.gif', 'animated.gif', 'image/gif'),
            image('https://user:secret@cdn.example.test/private.png', 'private.png'),
            image('http://cdn.example.test/insecure.png', 'insecure.png'),
            image('https://cdn.example.test/not-downloaded.png', 'not-downloaded.png'),
        ],
    })], [
        downloaded(imageA),
        downloaded('https://cdn.example.test/animated.gif'),
    ], { documentScope: activeDocumentScope() });
    t.after(() => endGenerationTurn(agent, scope));

    const { metadata } = metadataFor(scope, 'user-a');
    assert.equal(metadata.images.length, 2);
    assert.equal(metadata.images[0].filename, 'ok.png');
    assert.equal(metadata.images[1].filename, 'animated.gif');
});

test('lazy quote grants are bounded, immutable, request scoped and require enabled media', async () => {
    const agent = {};
    const source = originalRequest({ ownerId: 'user-a', groupId: 'group-a', msgId: 'message-a',
        currentAttachments: [image(imageA, 'current.png')],
        quotedAttachments: [image(imageB, 'quote.jpg', 'image/jpeg'),
            image('https://cdn.example.test/photo.webp', 'photo.jpg', 'image/webp'),
            image('https://cdn.example.test/file.png', 'file.png', 'file'),
            image('http://cdn.example.test/insecure.png', 'insecure.png'),
            image('https://user:pass@cdn.example.test/private.png', 'private.png')],
    });
    for (const media of [undefined, { enabled: false }, { enabled: true, maxMB: 0 },
        { enabled: true, maxMB: '10' }, { enabled: true, maxMB: Infinity }]) {
        const scope = beginGenerationTurn(agent, [source], [], { documentScope: activeDocumentScope(), media });
        assert.deepEqual(generationRequestMetadata(scope)[0].images, []);
        await endGenerationTurn(agent, scope);
    }
    const scope = beginGenerationTurn(agent, [source,
        originalRequest({ ownerId: 'user-b', groupId: 'group-a', msgId: 'message-b' })], [],
        { documentScope: activeDocumentScope(), media: { enabled: true, maxMB: 2 } });
    const [first, second] = generationRequestMetadata(scope);
    assert.equal(first.images.length, 2, 'only explicitly declared quoted images can be deferred');
    const grant = getGenerationImageAttachment(scope, first.requestId, first.images[0].imageAttachmentId);
    assert.ok(Object.isFrozen(grant));
    assert.equal(grant.localPath, undefined);
    assert.equal(grant.sourceUrl, imageB);
    assert.equal(grant.maxBytes, 2 * 1024 * 1024);
    assert.equal(getGenerationImageAttachment(scope, second.requestId, grant.imageAttachmentId), undefined);
    assert.ok(!renderGenerationRequestMetadata(scope).includes(imageB));
    await endGenerationTurn(agent, scope);
    assert.equal(scope.imageAttachments.size, 0);
    assert.equal(getGenerationImageAttachment(scope, first.requestId, grant.imageAttachmentId), undefined);
});

test('a plain-text attachment anywhere in the merged sources protects the entire generation turn', async (t) => {
    const agent = {};
    const documentScope = activeDocumentScope();
    const scope = beginGenerationTurn(agent, [
        originalRequest({
            ownerId: 'user-a', groupId: 'group-a', msgId: 'message-a',
            currentAttachments: [image(imageA, 'first.png')],
        }),
        originalRequest({
            ownerId: 'user-b', groupId: 'group-b', msgId: 'message-b',
            quotedAttachments: [{
                url: 'https://cdn.example.test/notes.txt', filename: 'notes.txt', content_type: 'text/plain',
            }],
        }),
    ], [downloaded(imageA)], { documentScope });
    t.after(() => endGenerationTurn(agent, scope));

    assert.equal(documentScope.documentMode, true, 'a non-first source document must activate the shared document guard');
    assert.equal(generationScopeFailure(scope), 'document-mode');
    assert.equal(getGenerationRequest(scope, metadataFor(scope, 'user-a').request.requestId), undefined,
        'document-mode checks also refuse a direct helper/tool execution path');
    const markdownRequest = metadataFor(scope, 'user-b').request;
    assert.equal(generationScopeFailure(scope, 'markdown'), undefined,
        'document mode keeps the explicitly allowed Markdown export capability active');
    assert.equal(getGenerationRequest(scope, markdownRequest.requestId, 'markdown'), markdownRequest);
});

test('expired scopes invalidate IDs and abort while end waits for already-started work to drain', async () => {
    const agent = {};
    const scope = beginGenerationTurn(agent, [originalRequest({ ownerId: 'user-a', groupId: 'group-a', msgId: 'message-a' })], [], {
        documentScope: activeDocumentScope(),
    });
    const requestId = generationRequestMetadata(scope)[0].requestId;
    let release;
    const operation = new Promise((resolve) => { release = resolve; });
    const tracked = trackGenerationOperation(scope, operation);
    const ending = endGenerationTurn(agent, scope);

    assert.equal(scope.active, false, 'turn grants are synchronously revoked before drain completes');
    assert.equal(scope.controller.signal.aborted, true, 'active provider and send work receives cancellation');
    assert.equal(getGenerationTurn(agent), undefined);
    assert.equal(getGenerationRequest(scope, requestId), undefined);
    let ended = false;
    void ending.then(() => { ended = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ended, false, 'turn finalization waits for in-flight sends to settle');

    release('sent');
    await Promise.all([tracked, ending]);
    assert.equal(ended, true);
});

test('retiring an old scope drains its work without touching the replacement scope', async () => {
    const agent = {};
    const oldScope = beginGenerationTurn(agent, [originalRequest({ ownerId: 'user-a', groupId: 'group-a', msgId: 'old-message' })], [], {
        documentScope: activeDocumentScope(),
    });
    let release;
    const operation = new Promise((resolve) => { release = resolve; });
    const tracked = trackGenerationOperation(oldScope, operation);
    const newScope = beginGenerationTurn(agent, [originalRequest({ ownerId: 'user-a', groupId: 'group-a', msgId: 'new-message' })], [], {
        documentScope: activeDocumentScope(),
    });

    let drained = false;
    const endingOld = endGenerationTurn(agent, oldScope).then(() => { drained = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drained, false, 'finalization still waits for the old scope’s already-started operation');
    assert.equal(getGenerationTurn(agent), newScope, 'finalizing an old scope cannot delete the replacement scope');
    release();
    await Promise.all([tracked, endingOld]);
    assert.equal(drained, true);
    assert.equal(getGenerationTurn(agent), newScope);
    await endGenerationTurn(agent, newScope);
});

test('rejected tracked operations are drainable without creating an unhandled finally rejection', async (t) => {
    const agent = {};
    const scope = beginGenerationTurn(agent, [], [], { documentScope: activeDocumentScope() });
    t.after(() => endGenerationTurn(agent, scope));
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
        await assert.rejects(trackGenerationOperation(scope, Promise.reject(new Error('controlled rejection'))), /controlled rejection/u);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(unhandled, []);
    }
    finally {
        process.off('unhandledRejection', onUnhandled);
    }
});

test('new turns revoke old request and image identifiers without affecting the replacement turn', async (t) => {
    const agent = {};
    const first = beginGenerationTurn(agent, [originalRequest({
        ownerId: 'user-a', groupId: 'group-a', msgId: 'old-message', currentAttachments: [image(imageA, 'old.png')],
    })], [downloaded(imageA)], { documentScope: activeDocumentScope() });
    const oldMeta = generationRequestMetadata(first)[0];
    const second = beginGenerationTurn(agent, [originalRequest({
        ownerId: 'user-a', groupId: 'group-a', msgId: 'new-message', currentAttachments: [image(imageB, 'new.jpg')],
    })], [downloaded(imageB)], { documentScope: activeDocumentScope() });
    t.after(() => endGenerationTurn(agent, second));

    assert.equal(first.active, false);
    assert.equal(getGenerationRequest(first, oldMeta.requestId), undefined);
    assert.equal(getGenerationImageAttachment(first, oldMeta.requestId, oldMeta.images[0].imageAttachmentId), undefined);
    assert.equal(getGenerationTurn(agent), second);
    assert.notEqual(generationRequestMetadata(second)[0].requestId, oldMeta.requestId);
});

test('request records require an active document-turn capability and current batch identity', async (t) => {
    const agent = {};
    const documentScope = activeDocumentScope();
    const scope = beginGenerationTurn(agent, [originalRequest({ ownerId: 'bad owner', groupId: 'group-a', msgId: 'message-a' })], [], {
        documentScope,
    });
    t.after(() => endGenerationTurn(agent, scope));
    assert.equal(generationRequestMetadata(scope).length, 0, 'invalid source owners are ignored');
    assert.equal(generationScopeFailure(scope), undefined);

    const stale = beginGenerationTurn(agent, [originalRequest({ ownerId: 'user-a', groupId: 'group-a', msgId: 'message-a' })], [], {
        documentScope: { active: true, documentMode: false },
        isCurrentRecord: () => false,
    });
    assert.equal(generationScopeFailure(stale), 'expired', 'stale session records lose tool authority');
    await endGenerationTurn(agent, stale);
});

test('model-visible original request text is bounded and never includes attachment paths or source URLs from metadata', async (t) => {
    const agent = {};
    const scope = beginGenerationTurn(agent, [originalRequest({
        ownerId: 'user-a', groupId: 'group-a', msgId: 'message-a',
        text: `${'x'.repeat(3999)}😀`,
        currentAttachments: [image(imageA, 'secret-local-name.png')],
    })], [downloaded(imageA, '/private/should-not-be-rendered.png')], { documentScope: activeDocumentScope() });
    t.after(() => endGenerationTurn(agent, scope));

    const rendered = renderGenerationRequestMetadata(scope);
    const { metadata } = metadataFor(scope, 'user-a');
    assert.equal(metadata.userRequest.length, 3999, 'truncating a UTF-16 surrogate pair never emits a lone surrogate');
    assert.ok(!rendered.includes(imageA));
    assert.ok(!rendered.includes('/private/should-not-be-rendered.png'));
});
