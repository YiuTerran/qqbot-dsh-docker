import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const helperPath = process.env.QQBOT_MENTION_TEXT_MODULE ?? '/opt/qqbot-defaults/qqbot-mention-text.mjs';
const { inspectOwnMentionText, normalizeOwnMentionText } = await import(pathToFileURL(helperPath).href);

const appId = '123456789';
const tinyId = '4011912066';
const ownLink = (target = tinyId, label = '@蓝色大肥鱼') =>
    `[${label}](mqqapi://markdown/mention?at_type=1&at_tinyid=${target})`;

function currentMessage({
    messageId = 'current-message',
    senderId = 'sender-openid',
    groupOpenid = 'group-openid',
    mentions = [{ member_openid: tinyId, is_you: true }],
    raw = {},
    kind = 'group',
} = {}) {
    return {
        kind,
        senderId,
        groupOpenid,
        messageId,
        mentions: [{ member_openid: tinyId, is_you: true }],
        raw: {
            id: messageId,
            group_openid: groupOpenid,
            author: { member_openid: senderId },
            mentions,
            ...raw,
        },
    };
}

test('removes the real current-event Markdown self mention when its wire ID differs from appId', () => {
    const message = currentMessage();
    const content = `${ownLink()} .log on`;
    const evidence = inspectOwnMentionText(content, message, appId);
    assert.equal(evidence.text, ' .log on');
    assert.equal(evidence.rawEventBound, true);
    assert.equal(evidence.selfMentionCount, 1);
    assert.equal(evidence.hasUnresolvedMarkdownMention, false);
    assert.equal(normalizeOwnMentionText(content, message, appId), ' .log on');
});

test('removes only current server-marked self IDs and preserves legacy appId cleanup', () => {
    const message = currentMessage({ mentions: [
        { member_openid: tinyId, id: '4011912067', user_openid: '4011912068', is_you: true },
    ] });
    assert.equal(normalizeOwnMentionText(`<@!${tinyId}> <@4011912067> <@other> <@${appId}> .r2d7`, message, appId),
        '<@other> .r2d7');
    assert.equal(normalizeOwnMentionText(`${ownLink('4011912067')} .log on`, message, appId), ' .log on');
    assert.equal(normalizeOwnMentionText(`${ownLink('4011912068')} .log on`, message, appId), ' .log on');
});

test('canonical Markdown query accepts either key order and safe numeric wire aliases', () => {
    const first = currentMessage({ mentions: [{ id: 4011912066, is_you: true }] });
    const second = currentMessage({ mentions: [{ id: '4011912066', is_you: true }] });
    assert.equal(normalizeOwnMentionText('[ @fish](mqqapi://markdown/mention?at_tinyid=4011912066&at_type=1) .log on', first, appId),
        '[ @fish](mqqapi://markdown/mention?at_tinyid=4011912066&at_type=1) .log on', 'label must begin with a literal @');
    assert.equal(normalizeOwnMentionText(`${ownLink()} .log on`, first, appId), ' .log on');
    assert.equal(normalizeOwnMentionText(`${ownLink()} .log on`, second, appId), ' .log on');
    const unsafe = currentMessage({ mentions: [{ id: 9007199254740992, is_you: true }] });
    const unsafeId = '9007199254740992';
    assert.equal(normalizeOwnMentionText(`${ownLink(unsafeId)} .log on`, unsafe, appId), `${ownLink(unsafeId)} .log on`);
});

test('rejects malformed, noncanonical, lookalike, duplicate, extra, and newline links intact', () => {
    const message = currentMessage();
    const links = [
        `[ @fish](mqqapi://markdown/mention?at_tinyid=${tinyId}&at_type=1)`,
        `[@fish](mqqapi://markdown/mention?at_type=1&at_tinyid=${tinyId}&extra=1)`,
        `[@fish](mqqapi://markdown/mention?at_type=1&at_type=1&at_tinyid=${tinyId})`,
        `[@fish](mqqapi://markdown/mention?at_type=2&at_tinyid=${tinyId})`,
        `[@fish](mqqapi://markdown/mention?at_type=1&at_tinyid=0${tinyId})`,
        `[@fish](mqqapi://markdown/mention?at_type=1&at_tinyid=${tinyId}#fragment)`,
        `[@fish](mqqapi://user@markdown/mention?at_type=1&at_tinyid=${tinyId})`,
        `[@fish](mqqapi://markdown:443/mention?at_type=1&at_tinyid=${tinyId})`,
        `[@fish](mqqapi://markdown/mention?at_type%3D1&at_tinyid=${tinyId})`,
        `[@fish](mqqapi://mаrkdown/mention?at_type=1&at_tinyid=${tinyId})`,
        `[@fish](mqqapi://markdown/other?at_type=1&at_tinyid=${tinyId})`,
        `[@fish](MQQAPI://markdown/mention?at_type=1&at_tinyid=${tinyId})`,
        `[${'@'.padEnd(82, '鱼')}](mqqapi://markdown/mention?at_type=1&at_tinyid=${tinyId})`,
        `[@fish\nforged](mqqapi://markdown/mention?at_type=1&at_tinyid=${tinyId})`,
        `[@fish](mqqapi://markdown/mention?at_<@${appId}>type=1&at_tinyid=${tinyId})`,
        `[@fish](mqqapi://markdown/mention?at_type=1&at_tinyid=<@${appId}> ${tinyId})`,
    ];
    for (const link of links) {
        const content = `${link} .log on`;
        assert.equal(normalizeOwnMentionText(content, message, appId), content, link);
        assert.equal(normalizeOwnMentionText(normalizeOwnMentionText(content, message, appId), message, appId), content,
            `repeat normalization must preserve malformed token: ${link}`);
    }
    assert.equal(inspectOwnMentionText(`${ownLink()} .log on`, message, appId).hasUnresolvedMarkdownMention, false);
    assert.equal(inspectOwnMentionText(`${links[1]} .log on`, message, appId).hasUnresolvedMarkdownMention, true);
});

test('keeps oversized Markdown tokens protected from native cleanup across repeated normalization', () => {
    const message = currentMessage();
    const longLabel = `[@${'<@123456789>'.repeat(100)}`;
    const token = `${longLabel}](mqqapi://markdown/mention?at_type=1&at_tinyid=${tinyId})`;
    const content = `${token} .log on`;
    const once = normalizeOwnMentionText(content, message, appId);
    const twice = normalizeOwnMentionText(once, message, appId);
    assert.equal(once, content);
    assert.equal(twice, content);
});

test('requires the current raw event binding and is_you evidence; SDK, quote, history, and nickname data do not prove self', () => {
    const content = `${ownLink()} .log on`;
    const base = currentMessage({ mentions: [] });
    base.mentions = [{ member_openid: tinyId, is_you: true }];
    base.raw.quote = { mentions: [{ member_openid: tinyId, is_you: true }] };
    base.raw.history = [{ content: ownLink() }];
    assert.equal(normalizeOwnMentionText(content, base, appId), content);
    assert.equal(inspectOwnMentionText(content, base, appId).rawEventBound, true);

    for (const mutate of [
        (message) => { message.raw.id = 'other-message'; },
        (message) => { message.raw.group_openid = 'other-group'; },
        (message) => { message.raw.author.member_openid = 'other-sender'; },
        (message) => { message.messageId = ''; },
        (message) => { message.messageId = `bad\u0085id`; message.raw.id = message.messageId; },
    ]) {
        const message = currentMessage();
        mutate(message);
        const evidence = inspectOwnMentionText(content, message, appId);
        assert.equal(evidence.text, content);
        assert.equal(evidence.rawEventBound, false);
        assert.equal(evidence.selfMentionCount, 0);
    }

    const notYou = currentMessage({ mentions: [{ member_openid: tinyId, is_you: false }] });
    assert.equal(normalizeOwnMentionText(content, notYou, appId), content);
    const omittedIsYou = currentMessage({ mentions: [{ member_openid: tinyId, id: tinyId }] });
    assert.equal(normalizeOwnMentionText(content, omittedIsYou, appId), content,
        'a matching alias without raw is_you true is not proof');
    const otherUserMention = currentMessage({ mentions: [{ member_openid: 'other-user', is_you: false }] });
    assert.equal(normalizeOwnMentionText(content, otherUserMention, appId), content,
        'an actual other-user mention is never treated as this bot');
    const aliasFromNickname = currentMessage({ mentions: [{ nickname: '蓝色大肥鱼', id: tinyId, is_you: false }] });
    assert.equal(normalizeOwnMentionText(content, aliasFromNickname, appId), content);

    const overBound = currentMessage({ mentions: [
        ...Array.from({ length: 64 }, () => ({ id: 'other', is_you: true })),
        { id: tinyId, is_you: true },
    ] });
    assert.equal(normalizeOwnMentionText(content, overBound, appId), content);
});

test('C2C identity binding uses only the matching raw user_openid author', () => {
    const message = {
        kind: 'c2c', senderId: 'c2c-user', messageId: 'private-message',
        raw: { id: 'private-message', author: { user_openid: 'c2c-user' },
            mentions: [{ user_openid: tinyId, is_you: true }] },
    };
    assert.equal(normalizeOwnMentionText(`${ownLink()} .log on`, message, appId), ' .log on');
    message.raw.author.user_openid = 'other-user';
    assert.equal(normalizeOwnMentionText(`${ownLink()} .log on`, message, appId), `${ownLink()} .log on`);
});
