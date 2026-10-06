// Production qq-bot wrapper -> real MCP -> native SeaDice. QQ identities are fixtures.
import assert from 'node:assert/strict';
import { registerOnebotCommandTool } from '/opt/qqbot-defaults/qqbot-onebot.mjs';
import { createOnebotDirectRouter } from '/opt/qqbot-defaults/qqbot-onebot-direct.mjs';
import { captureOnebotGroupRole } from '/opt/qqbot-defaults/qqbot-sealdice-policy.mjs';
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
const groupOriginal = (ownerId, group, text, role = 'member') => {
    const message = { kind: 'group', senderId: ownerId, groupOpenid: group,
        replyTarget: { scope: 'group', targetId: group },
        raw: { author: { member_openid: ownerId, ...(role ? { member_role: role } : {}) }, group_openid: group } };
    return { ownerId, text, replyTarget: message.replyTarget, groupRole: captureOnebotGroupRole(message) ?? 'unknown' };
};
try {
    assert.equal(await controller.ready, true, 'real backend is not ready for qq-bot wrapper');
    assert.equal(descriptor?.name, 'qqbot_onebot_command');
    assert.deepEqual(Object.keys(descriptor.parameters.properties).sort(), ['backend', 'command', 'requestId']);
    const setupAgent = {};
    const setupScope = beginOnebotTurn(setupAgent,
        [groupOriginal('fixtureOwnerA', 'fixtureGroupA', '.set coc7', 'owner')], { appId });
    try {
        assert.equal((await descriptor.execute({ requestId: onebotRequestMetadata(setupScope)[0].requestId,
            backend: 'sealdice', command: '.set coc7' }, { agent: setupAgent })).status, 'ok');
    } finally { await endOnebotTurn(setupAgent, setupScope); }
    const groupAgent = {};
    const originals = [
        groupOriginal('fixtureOwnerA', 'fixtureGroupA', '设置力量31并查询', 'owner'),
        groupOriginal('fixtureOwnerB', 'fixtureGroupA', '设置力量47并查询'),
    ];
    const groupScope = beginOnebotTurn(groupAgent, originals, { appId });
    const metadata = onebotRequestMetadata(groupScope);
    assert.equal(metadata.length, 2);
    const execution = { agent: groupAgent };
    bindOnebotExecution(execution);
    const run = (requestId, command) => descriptor.execute({ requestId, backend: 'sealdice', command }, execution);
    assert.equal(metadata[0].groupRole, 'owner');
    assert.equal(metadata[1].groupRole, 'member');
    assert.equal((await run(metadata[0].requestId, '.set dnd')).failureReason, 'group_state_source_mismatch',
        'a member cannot borrow an unrelated owner original to change group rules');
    const beforeDenied = await run(metadata[1].requestId, '.set info');
    assert.equal((await run(metadata[1].requestId, '.set dnd')).failureReason, 'group_role_denied');
    // A fresh request avoids any cached query hiding a rule mutation.
    const auditAgent = {};
    const auditScope = beginOnebotTurn(auditAgent, [groupOriginal('fixtureOwnerB', 'fixtureGroupA', '.set info')], { appId });
    try {
        const audited = await descriptor.execute({ requestId: onebotRequestMetadata(auditScope)[0].requestId,
            backend: 'sealdice', command: '.set info' }, { agent: auditAgent });
        assert.deepEqual(audited.outputs, beforeDenied.outputs);
    } finally { await endOnebotTurn(auditAgent, auditScope); }
    for (const [index, value] of [[0, 31], [1, 47]]) {
        const requestId = metadata[index].requestId;
        for (const command of [`.st 力量${value}`]) {
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

    const freshCommand = async (ownerId, command, { group, text = command, role = 'member' } = {}) => {
        const agent = {};
        const scope = beginOnebotTurn(agent, [group ? groupOriginal(ownerId, group, text, role) : { ownerId, text, replyTarget: {
            scope: group ? 'group' : 'c2c', targetId: group || ownerId,
        } }], { appId });
        try {
            return await descriptor.execute({ requestId: onebotRequestMetadata(scope)[0].requestId,
                backend: 'sealdice', command }, { agent });
        } finally { await endOnebotTurn(agent, scope); }
    };
    assert.ok(controller.runtime.adminBackends.has('sealdice'), 'real Master ACL was not negotiated');
    for (const command of ['.master list', '.master backup']) {
        const result = await freshCommand('fixtureMaster', command);
        assert.equal(result.status, 'ok', command);
        assert.ok(result.outputs.length > 0);
        if (command.endsWith('backup')) assert.ok(result.outputs.some(line => line.includes('备份成功')));
    }
    for (const [ownerId, command, options] of [
        ['fixtureOwnerA', '.master list', {}], ['fixtureMaster', '.master list', { group: 'fixtureGroupA' }],
        ['fixtureMaster', '.master backup', { text: '请解释 .master backup' }],
        ['fixtureMaster', '.master reboot', {}], ['fixtureMaster', '.master add me', {}],
    ]) assert.equal((await freshCommand(ownerId, command, options)).status, 'failed', command);
    const identity = await freshCommand('fixtureBanTarget', '.userid');
    assert.equal(identity.status, 'ok');
    assert.ok(identity.outputs.join('\n').includes(`${appId}:fixtureBanTarget`));
    const target = identity.outputs.join('\n').match(/QQ:[0-9]+/)?.[0];
    assert.ok(target, 'native virtual ID was not included');
    assert.equal((await freshCommand('fixtureMaster', `.ban add ${target}`)).status, 'ok');
    assert.equal((await freshCommand('fixtureBanTarget', '.r 1d1')).status, 'failed', 'banned player executed a command');
    assert.equal((await freshCommand('fixtureMaster', `.ban query ${target}`)).status, 'ok');
    assert.equal((await freshCommand('fixtureMaster', `.ban rm ${target}`)).status, 'ok');
    assert.equal((await freshCommand('fixtureBanTarget', '.r 1d1')).status, 'ok');
    assert.equal((await freshCommand('fixtureMaster', `.ban trust ${target}`)).status, 'ok');
    assert.equal((await freshCommand('fixtureBanTarget', '.master list')).status, 'failed', 'trust granted Master');
    for (const target of ['UI:1001', 'QQ:17', 'QQ:8999999999999000', 'Discord:8999999999999999']) {
        assert.equal((await freshCommand('fixtureMaster', `.ban add ${target}`)).status, 'failed', target);
    }
    summary.push({ check: 'real-master-private-exact-source-backup-ban-trust-and-known-target-boundary' });
    for (const [ownerId, role, reason] of [
        ['fixtureRoleMember', 'member', 'group_role_denied'],
        ['fixtureRoleUnknown', undefined, 'group_role_unknown'],
        ['fixtureMaster', 'member', 'group_role_denied'],
    ]) {
        const result = await freshCommand(ownerId, '.set dnd', { group: 'fixtureGroupA', role: role ?? '' });
        assert.equal(result.status, 'failed');
        assert.equal(result.failureReason, reason);
        assert.equal((await freshCommand(ownerId, '.set info', { group: 'fixtureGroupA', role: role ?? '' })).status, 'ok');
    }
    summary.push({ check: 'real-wrapper-per-original-group-role-member-unknown-master-no-bypass' });
    assert.equal((await freshCommand('fixtureNaturalOwner', '.set dnd', { group: 'fixtureNaturalGroup',
        role: 'owner', text: '请把当前群规则改为 DND' })).status, 'ok');
    const naturalRule = await freshCommand('fixtureNaturalMember', '.set info', { group: 'fixtureNaturalGroup' });
    assert.ok(naturalRule.outputs.join('\n').includes('20'));
    assert.equal((await freshCommand('fixtureNaturalMember', '.set coc7', { group: 'fixtureNaturalGroup',
        text: '请改为 COC 规则' })).failureReason, 'group_role_denied');
    assert.deepEqual((await freshCommand('fixtureNaturalMember', '.set info', { group: 'fixtureNaturalGroup' })).outputs,
        naturalRule.outputs);
    summary.push({ check: 'real-single-original-natural-language-owner-only-group-rule-write' });

    for (const command of ['.set coc7', '.coc 2', '.ti', '.li', '.ww 3a10', '.dx 3c10', '.ek 潜行', '.rsr 3',
        '.jrrp', '.gugu', '.ping', '.set info', '.setcoc', '.setcoc details']) {
        const result = await freshCommand('fixtureQueryOwner', command, { group: 'fixtureQueryGroup',
            role: command === '.set coc7' ? 'owner' : 'member' });
        assert.equal(result.status, 'ok', command);
        assert.ok(result.outputs.length > 0, command);
    }
    assert.equal((await freshCommand('fixtureQueryOwner', '.set dnd', { group: 'fixtureQueryGroup', role: 'admin' })).status, 'ok');
    for (const command of ['.dnd 2', '.dndx 2', '.ss', '.buff', '.ds stat', '.init', '.init list']) {
        assert.equal((await freshCommand('fixtureQueryOwner', command, { group: 'fixtureQueryGroup' })).status, 'ok', command);
    }
    const beforeQuery = await freshCommand('fixtureQueryOwner', '.set info', { group: 'fixtureQueryGroup' });
    assert.equal((await freshCommand('fixtureQueryOwner', '.setcoc', { group: 'fixtureQueryGroup' })).status, 'ok');
    const afterQuery = await freshCommand('fixtureQueryOwner', '.set info', { group: 'fixtureQueryGroup' });
    assert.deepEqual(afterQuery.outputs, beforeQuery.outputs, 'CoC query silently changed the active rule');
    for (const command of ['.coc 11', '.r 11#1d1', '.ww set clr', '.ss init 1', '.buff hp:30', '.init end', '.rxh 1d1']) {
        assert.equal((await freshCommand('fixtureQueryOwner', command, { group: 'fixtureQueryGroup' })).status, 'failed', command);
    }
    summary.push({ check: 'real-expanded-native-commands-query-rule-stability-and-per-call-limits' });

    // Invoke the production router against the actual MCP/SeaDice containers.
    // The downstream callback is the model path: native commands must skip it.
    const sent = [];
    let modelCalls = 0;
    const routerOptions = {
        service: controller, appId,
        env: { QQBOT_ONEBOT_DIRECT_ENABLED: 'true' },
        sender: { async sendMarkdown(target, content) { sent.push({ target, content }); } },
    };
    const message = (id, content, owner = 'fixtureDirectA', group = 'fixtureDirectG', role = 'member') => ({
        message: {
            kind: group ? 'group' : 'c2c', senderId: owner, content, attachments: [],
            replyTarget: { scope: group ? 'group' : 'c2c', targetId: group || owner, msgId: id },
            ...(group ? { groupOpenid: group, raw: { author: { member_openid: owner,
                ...(role ? { member_role: role } : {}) }, group_openid: group } } : {}),
        }, state: {},
    });
    const direct = createOnebotDirectRouter(routerOptions);
    const next = async () => { modelCalls++; };
    try {
        for (const [id, command] of [
            ['direct-set', '.set coc7'], ['direct-card', '.st 力量63'],
            ['direct-query', '.st show 力量'], ['direct-roll', '.r2d7'],
        ]) await direct.middleware(message(id, command, 'fixtureDirectA', 'fixtureDirectG',
            command === '.set coc7' ? 'owner' : 'member'), next);
        assert.equal(modelCalls, 0, 'native command invoked downstream model path');
        assert.ok(sent.some(({ content }) => content.includes('63')), 'direct card result missing');
        const rolled = sent.at(-1);
        assert.ok(rolled.content.includes('2d7'), 'compact roll did not reach native SeaDice');
        for (const [owner, group, value] of [
            ['fixtureDirectB', 'fixtureDirectG', 47],
            ['fixtureDirectA', 'fixtureDirectG2', 89],
        ]) {
            await direct.middleware(message(`direct-set-${owner}-${group}`, '.set coc7', owner, group, 'admin'), next);
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

        for (const [id, role, reason] of [
            ['direct-member-denied', 'member', 'group_role_denied'],
            ['direct-role-missing', '', 'group_role_unknown'],
        ]) {
            const beforeState = await freshCommand('fixtureDirectA', '.set info', { group: 'fixtureDirectG' });
            const deniedContext = message(id, '.set dnd', 'fixtureDirectA', 'fixtureDirectG', role);
            const beforeSent = sent.length;
            const beforeCalls = modelCalls;
            await direct.middleware(deniedContext, next);
            assert.equal(modelCalls, beforeCalls + 1);
            assert.equal(sent.length, beforeSent);
            assert.equal(getOnebotDirectFallback(deniedContext)?.reason, reason);
            const afterState = await freshCommand('fixtureDirectA', '.set info', { group: 'fixtureDirectG' });
            assert.deepEqual(afterState.outputs, beforeState.outputs, 'denied direct call changed group rules');
        }
        summary.push({ check: 'real-direct-member-and-unknown-refused-before-write-no-early-notice' });

        // A private `.set` is recognized but rejected before dispatch.
        // The permission result must hand off once to the
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
        assert.equal(fallbackMetadata.reason, 'group_state_private');

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
        assert.equal(retryMetadata[0].directFallback?.reason, 'group_state_private',
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
