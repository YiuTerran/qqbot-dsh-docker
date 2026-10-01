// Deterministic provenance and lifetime tests for Phase 2 generation grants.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const scopeUrl = process.env.QQBOT_GENERATION_SCOPE_MODULE
    ?? new URL('../defaults/qqbot-generation-scope.mjs', import.meta.url).href;
const {
    beginGenerationTurn,
    endGenerationTurn,
    generationRequestMetadata,
    generationScopeFailure,
    getGenerationImageAttachment,
    getGenerationRequest,
    getGenerationTurn,
    renderGenerationRequestMetadata,
    trackGenerationOperation,
} = await import(scopeUrl);

const imageA = 'https://cdn.example.test/first.png';
const imageB = 'https://cdn.example.test/quoted-b.jpg';
const imageC = 'https://cdn.example.test/quoted-c.png';

function originalRequest({ ownerId, groupId, msgId, text = '', currentAttachments = [], quotedAttachments = [] }) {
    return {
        ownerId,
        replyTarget: { scope: 'group', targetId: groupId, msgId },
        text,
        currentAttachments,
        quotedAttachments,
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
