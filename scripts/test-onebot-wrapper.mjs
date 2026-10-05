// Production qq-bot wrapper -> real MCP -> native SeaDice. QQ identities are fixtures.
import assert from 'node:assert/strict';
import { registerOnebotCommandTool } from '/opt/qqbot-defaults/qqbot-onebot.mjs';
import { createOnebotDirectRouter } from '/opt/qqbot-defaults/qqbot-onebot-direct.mjs';
import {
    beginOnebotTurn, endOnebotTurn, bindOnebotExecution, onebotRequestMetadata,
    getOnebotDirectFallback, getOnebotDirectFallbackForSnapshot,
    renderOnebotDirectFallbackMetadata,
} from '/opt/qqbot-defaults/qqbot-onebot-scope.mjs';

let descriptor;
const appId = '123456789';
const context = { get: (name) => name === 'tools' ? { register(tool) { descriptor = tool; } } : undefined };
const controller = registerOnebotCommandTool(context, { appId });
const summary = [];
try {
    assert.equal(await controller.ready, true, 'real backend is not ready for qq-bot wrapper');
    assert.equal(descriptor?.name, 'qqbot_onebot_command');
    assert.deepEqual(Object.keys(descriptor.parameters.properties).sort(), ['backend', 'command', 'requestId']);
    const groupAgent = {};
    const originals = [
        { ownerId: 'fixtureOwnerA', replyTarget: { scope: 'group', targetId: 'fixtureGroupA' }, text: '设置力量31并查询' },
        { ownerId: 'fixtureOwnerB', replyTarget: { scope: 'group', targetId: 'fixtureGroupA' }, text: '设置力量47并查询' },
    ];
    const groupScope = beginOnebotTurn(groupAgent, originals, { appId });
    const metadata = onebotRequestMetadata(groupScope);
    assert.equal(metadata.length, 2);
    const execution = { agent: groupAgent };
    bindOnebotExecution(execution);
    const run = (requestId, command) => descriptor.execute({ requestId, backend: 'sealdice', command }, execution);
    for (const [index, value] of [[0, 31], [1, 47]]) {
        const requestId = metadata[index].requestId;
        for (const command of ['.set coc7', `.st 力量${value}`]) {
            assert.equal((await run(requestId, command)).status, 'ok', command);
        }
        const card = await run(requestId, '.st show 力量');
        assert.equal(card.status, 'ok');
        assert.ok(card.outputs.join('\n').includes(String(value)));
        summary.push({ check: 'merged-member-card', member: index, value });
    }
    const roll = await run(metadata[0].requestId, '.r 1d1');
    assert.equal(roll.status, 'ok');
    assert.ok(roll.outputs.join('\n').includes('1d1'));
    assert.deepEqual(await run(metadata[0].requestId, '.r 1d1'), roll, 'same-turn result changed on duplicate');
    const denied = await descriptor.execute({ requestId: metadata[0].requestId,
        backend: 'sealdice', command: '.r 1d1', user_id: 'another-user' }, execution);
    assert.equal(denied.status, 'failed');
    assert.equal((await run(metadata[0].requestId, '.rh 1d1')).status, 'failed', 'hidden default must reject before dispatch');
    await endOnebotTurn(groupAgent, groupScope);
    assert.equal((await run(metadata[0].requestId, '.r 1d1')).status, 'failed', 'old authorization still usable');
    summary.push({ check: 'group-dedupe-forged-identity-hidden-and-expiry' });
    // Query under fresh authorization so a cached result cannot mask a shared
    // card accidentally overwritten by the other member of the merge batch.
    const followupScope = beginOnebotTurn(groupAgent, originals, { appId });
    const followupExecution = { agent: groupAgent };
    bindOnebotExecution(followupExecution);
    for (const [index, value] of [[0, 31], [1, 47]]) {
        const card = await descriptor.execute({ requestId: onebotRequestMetadata(followupScope)[index].requestId,
            backend: 'sealdice', command: '.st show 力量' }, followupExecution);
        assert.equal(card.status, 'ok');
        assert.ok(card.outputs.join('\n').includes(String(value)), 'merged members share a character card');
    }
    await endOnebotTurn(groupAgent, followupScope);
    summary.push({ check: 'fresh-turn-merged-member-isolation' });

    const privateAgent = {};
    const privateScope = beginOnebotTurn(privateAgent, [{ ownerId: 'fixtureOwnerA',
        replyTarget: { scope: 'c2c', targetId: 'fixtureOwnerA' }, text: '掷一个1d1' }], { appId });
    const privateExecution = { agent: privateAgent };
    bindOnebotExecution(privateExecution);
    const privateResult = await descriptor.execute({ requestId: onebotRequestMetadata(privateScope)[0].requestId,
        backend: 'sealdice', command: '.r 1d1' }, privateExecution);
    assert.equal(privateResult.status, 'ok');
    assert.ok(privateResult.outputs.join('\n').includes('1d1'));
    await endOnebotTurn(privateAgent, privateScope);
    summary.push({ check: 'private-user-scope' });

    // Invoke the production router against the actual MCP/SeaDice containers.
    // The downstream callback is the model path: native commands must skip it.
    const sent = [];
    let modelCalls = 0;
    const routerOptions = {
        service: controller, appId,
        env: { QQBOT_ONEBOT_DIRECT_ENABLED: 'true' },
        sender: { async sendMarkdown(target, content) { sent.push({ target, content }); } },
    };
    const message = (id, content, owner = 'fixtureDirectA', group = 'fixtureDirectG') => ({
        message: {
            kind: group ? 'group' : 'c2c', senderId: owner, content, attachments: [],
            replyTarget: { scope: group ? 'group' : 'c2c', targetId: group || owner, msgId: id },
        }, state: {},
    });
    const direct = createOnebotDirectRouter(routerOptions);
    const next = async () => { modelCalls++; };
    try {
        for (const [id, command] of [
            ['direct-set', '.set coc7'], ['direct-card', '.st 力量63'],
            ['direct-query', '.st show 力量'], ['direct-roll', '.r2d7'],
        ]) await direct.middleware(message(id, command), next);
        assert.equal(modelCalls, 0, 'native command invoked downstream model path');
        assert.ok(sent.some(({ content }) => content.includes('63')), 'direct card result missing');
        const rolled = sent.at(-1);
        assert.ok(rolled.content.includes('2d7'), 'compact roll did not reach native SeaDice');
        for (const [owner, group, value] of [
            ['fixtureDirectB', 'fixtureDirectG', 47],
            ['fixtureDirectA', 'fixtureDirectG2', 89],
        ]) {
            await direct.middleware(message(`direct-set-${owner}-${group}`, '.set coc7', owner, group), next);
            await direct.middleware(message(`direct-card-${owner}-${group}`, `.st 力量${value}`, owner, group), next);
        }
        for (const [owner, group, value] of [
            ['fixtureDirectA', 'fixtureDirectG', 63],
            ['fixtureDirectB', 'fixtureDirectG', 47],
            ['fixtureDirectA', 'fixtureDirectG2', 89],
        ]) {
            await direct.middleware(message(`direct-query-${owner}-${group}`, '.st show 力量', owner, group), next);
            assert.ok(sent.at(-1).content.includes(String(value)), 'direct identities shared a character card');
            assert.equal(sent.at(-1).target.targetId, group);
        }
        await direct.middleware(message('direct-compact-check', '.ra力量'), next);
        assert.equal(modelCalls, 0, 'compact attribute check invoked model');
        const sentBeforeDuplicate = sent.length;
        await direct.middleware(message('direct-roll', '.r2d7'), next);
        assert.equal(sent.length, sentBeforeDuplicate, 'duplicate original QQ event was delivered twice');
        await direct.middleware(message('direct-private', '.r1d1', 'fixtureDirectA', null), next);
        assert.equal(sent.at(-1).target.scope, 'c2c');
        assert.equal(sent.at(-1).target.targetId, 'fixtureDirectA');

        // A private `.set` is a recognized native command, but SeaDice rejects
        // rule selection in C2C. The real MCP result must hand off once to the
        // normal generation path without sending a premature failure reply.
        const fallbackContext = message('direct-fallback-set', '.set coc7', 'fixtureDirectA', null);
        const beforeFallbackSends = sent.length;
        const beforeFallbackModelCalls = modelCalls;
        await direct.middleware(fallbackContext, next);
        assert.equal(modelCalls, beforeFallbackModelCalls + 1, 'backend failure did not hand off exactly once');
        assert.equal(sent.length, beforeFallbackSends, 'backend failure sent a reply before model handoff');
        assert.equal(fallbackContext.message.content, '.set coc7', 'fallback changed the original message content');
        const fallbackMetadata = getOnebotDirectFallback(fallbackContext);
        assert.ok(fallbackMetadata, 'trusted backend failure metadata was not attached to the original context');
        assert.equal(fallbackMetadata.reason, 'backend_rejected');

        const fallbackSnapshot = {
            ownerId: fallbackContext.message.senderId,
            replyTarget: fallbackContext.message.replyTarget,
            text: fallbackContext.message.content,
            onebotDirectFallback: fallbackMetadata,
        };
        assert.equal(getOnebotDirectFallbackForSnapshot(fallbackSnapshot), fallbackMetadata,
            'captured generation snapshot lost its trusted fallback metadata');
        const fallbackPrompt = renderOnebotDirectFallbackMetadata([fallbackSnapshot]);
        assert.ok(fallbackPrompt.length > 0, 'fallback metadata was not rendered for generation');
        assert.ok(fallbackPrompt.includes('.set coc7'), 'fallback prompt omitted the unchanged original request');

        // Beginning any OneBot turn from the fallback batch blocks every tool
        // call associated with that original request. A separate original in
        // the same batch retains its independent authorization.
        const retryAgent = {};
        const retryOriginals = [fallbackSnapshot, {
            ownerId: 'fixtureFallbackOther',
            replyTarget: { scope: 'group', targetId: 'fixtureFallbackGroup' },
            text: '掷一个1d1',
        }];
        const retryScope = beginOnebotTurn(retryAgent, retryOriginals, { appId });
        const retryExecution = { agent: retryAgent };
        bindOnebotExecution(retryExecution);
        const retryMetadata = onebotRequestMetadata(retryScope);
        assert.equal(retryMetadata.length, 2);
        assert.equal(retryMetadata[0].directFallback?.reason, 'backend_rejected',
            'rerun request metadata lost the trusted fallback marker');
        const blockedRetry = await descriptor.execute({ requestId: retryMetadata[0].requestId,
            backend: 'sealdice', command: '.r 1d1' }, retryExecution);
        assert.equal(blockedRetry.status, 'failed', 'fallback original was allowed to invoke OneBot again');
        const unaffectedRetry = await descriptor.execute({ requestId: retryMetadata[1].requestId,
            backend: 'sealdice', command: '.r 1d1' }, retryExecution);
        assert.equal(unaffectedRetry.status, 'ok', 'unrelated batch original was blocked with the fallback request');
        await endOnebotTurn(retryAgent, retryScope);
        summary.push({ check: 'real-mcp-failure-fallback-once-no-send-preserved-content-and-rerun-blocking' });

        const beforeNaturalModelCalls = modelCalls;
        await direct.middleware(message('direct-natural', '解释 .r 2d7'), next);
        assert.equal(modelCalls, beforeNaturalModelCalls + 1, 'natural language bypassed model path');
        summary.push({ check: 'direct-native-zero-model-compact-card-user-group-private-isolation-and-dedup' });
        // A new process-local router has no duplicate cache. The same trusted
        // source must still return the bridge's durable completed roll.
        const fresh = createOnebotDirectRouter(routerOptions);
        try {
            await fresh.middleware(message('direct-roll', '.r2d7'), next);
            assert.equal(sent.at(-1).content, rolled.content, 'fresh router rerolled a completed source message');
        }
        finally { await fresh.stop(); }
        summary.push({ check: 'direct-stable-source-id-reuses-persisted-bridge-result' });
    }
    finally { await direct.stop(); }
    console.log(JSON.stringify({ result: 'PASS', synthetic_only: true, checks: summary }));
}
finally { await controller.stop(); }
