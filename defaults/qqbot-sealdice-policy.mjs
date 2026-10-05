// QQ routing and model tools share one conservative command boundary. Native
// SeaDice parsing and the bridge's independent guard remain authoritative.
const ALIASES = Object.freeze({ roll: 'r', rd: 'r', 查询: 'find', 咕咕: 'gugu', 死亡豁免: 'ds' });
const HIDDEN = new Set(['rh', 'rhd', 'rdh', 'rxh', 'rhx', 'rah', 'rch', 'drlh', 'dxh', 'wh', 'wwh']);
const COMMANDS = new Set(['r', 'ra', 'rc', 'st', 'pc', 'sc', 'en', 'set', 'ww', 'dx', 'ek', 'rsr',
    'coc', 'dnd', 'dndx', 'ti', 'li', 'userid', 'find', 'setcoc', 'ss', 'buff', 'ds', 'init',
    'jrrp', 'gugu', 'ping', 'master', 'ban', ...HIDDEN, ...Object.keys(ALIASES)]);
const ORDERED = [...COMMANDS].sort((a, b) => b.length - a.length);
export const SEALDICE_TOOL_GUIDANCE = 'Native SeaDice commands: r/roll, ra, rc, st, pc, sc, en, set rule selection or info; ww (not set), dx, ek, rsr, coc, dnd, dndx, ti, li; userid, find/查询 (query only), setcoc (no args/details), ss and buff (no args), ds stat, init (no args/list); jrrp, gugu/咕咕 and ping. At most 10 generated candidates or execution rounds per call; saved cards have no new total limit. Never use hidden rolls, cross-user delegates, scripts or unlisted subcommands. Master list/backup and ban list/query/add/rm/trust require an authorized private sender and the exact command in that original QQ message; never synthesize an administrative command.';

export function readOnebotMasterUsers(value = '[]') {
    let entries;
    try { entries = JSON.parse(typeof value === 'string' && !value.trim() ? '[]' : value); } catch { throw new Error('Invalid QQBOT_ONEBOT_MASTER_USERS.'); }
    if (!Array.isArray(entries) || entries.length > 100 || entries.some(entry => typeof entry !== 'string'
        || !/^[0-9]{1,20}:[A-Za-z0-9_-]{1,128}$/u.test(entry))) throw new Error('Invalid QQBOT_ONEBOT_MASTER_USERS.');
    return Object.freeze([...new Set(entries)]);
}

export function inspectSeaDiceCommand(input, { direct = false } = {}) {
    if (typeof input !== 'string' || input.length < 1 || input.length > 4000
        || /[\r\n\u2028\u2029\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(input)) return undefined;
    const text = input.trim();
    if (direct && !text.startsWith('.')) return undefined;
    const body = text.replace(/^\./u, '');
    for (const candidate of ORDERED) {
        if (!body.toLowerCase().startsWith(candidate)) continue;
        let tail = body.slice(candidate.length);
        if (tail && !/^\s/u.test(tail)) {
            const compact = ['r', 'rh', 'rd', 'rhd', 'rdh'].includes(candidate)
                ? /^(?:\d|d(?:\d|$))/iu.test(tail)
                : ['ra', 'rc', 'st', 'en'].includes(candidate) && /^[^\x00-\x7f]/u.test(tail) && /^[\p{L}\p{N}]/u.test(tail);
            if (!compact) continue;
        }
        tail = tail.trim();
        const kind = ALIASES[candidate] ?? candidate;
        const command = `.${kind}${tail ? ` ${tail}` : ''}`;
        const args = tail ? tail.split(/\s+/u) : [];
        let allowed = !HIDDEN.has(kind);
        // No target identity may be smuggled as a CQ segment or delegated QQ ID.
        if (/\[CQ:|<@|@\S/u.test(tail)) allowed = false;
        if (kind !== 'find' && args.some(arg => arg.startsWith('--'))) allowed = false;
        if (kind === 'set') allowed &&= /^(?:info|dnd|dnd5e|coc|coc7)$/iu.test(tail);
        if (kind === 'ww') allowed &&= !/^set(?:\s|$)/iu.test(tail);
        if (kind === 'rsr') allowed &&= args.length === 1;
        if (['ti', 'li', 'userid', 'ss', 'buff', 'jrrp', 'ping'].includes(kind)) allowed &&= args.length === 0;
        if (kind === 'setcoc') allowed &&= args.length === 0 || tail === 'details';
        if (kind === 'ds') allowed &&= tail === 'stat';
        if (kind === 'init') allowed &&= args.length === 0 || tail === 'list';
        if (kind === 'gugu') allowed &&= args.length === 0 || ['来源', '作者', 'from', 'showfrom'].includes(tail);
        if (['coc', 'dnd', 'dndx'].includes(kind)) allowed &&= args.length === 0 || /^(?:[1-9]|10)$/u.test(tail);
        if (kind === 'find') {
            allowed &&= args.length > 0 && !/^(?:config|help)(?:\s|$)/iu.test(tail)
                && (args.some(arg => !arg.startsWith('--')) || args.includes('--rand'));
            for (const arg of args.filter(arg => arg.startsWith('--'))) {
                allowed &&= arg === '--rand' || /^--num=(?:[1-9]|10)$/u.test(arg) || /^--page=[1-9][0-9]{0,3}$/u.test(arg);
            }
        }
        if (kind === 'master') allowed &&= /^(?:list|backup)$/u.test(tail);
        if (kind === 'ban') {
            allowed &&= /^(?:list(?:\s+(?:ban|warn|trust))?|(?:query|rm|trust)\s+(?:QQ|QQ-Group):[1-9][0-9]{15}|add\s+(?:QQ|QQ-Group):[1-9][0-9]{15}(?:\s+\S+)?)$/u.test(tail);
        }
        const rounds = tail.match(/(?:^|\s)(\d+)\s*#/u);
        if (rounds && (Number(rounds[1]) < 1 || Number(rounds[1]) > 10)) allowed = false;
        return { kind, command, allowed, admin: kind === 'master' || kind === 'ban',
            reason: HIDDEN.has(kind) ? 'hidden_disabled' : allowed ? undefined : 'invalid_command' };
    }
    return undefined;
}
