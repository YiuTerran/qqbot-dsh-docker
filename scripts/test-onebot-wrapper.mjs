// Production qq-bot wrapper -> real MCP -> native SeaDice. QQ identities are fixtures.
import assert from 'node:assert/strict';
import { registerOnebotCommandTool } from '/opt/qqbot-defaults/qqbot-onebot.mjs';
import {
    beginOnebotTurn, endOnebotTurn, bindOnebotExecution, onebotRequestMetadata,
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
    console.log(JSON.stringify({ result: 'PASS', synthetic_only: true, checks: summary }));
}
finally { await controller.stop(); }
