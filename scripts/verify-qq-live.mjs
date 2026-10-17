// Explicitly opt-in live QQ probe. Uses real credentials, a fresh test volume,
// and real inbound QQ requests; never fabricates users or reply credentials.
import { appendFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { writeFile } from 'node:fs/promises';

const output = process.argv[2];
if (!output || !process.env.QQBOT_APPID || !process.env.QQBOT_SECRET) throw new Error('Provide a report path and test QQ credentials.');
const secrets = Object.entries(process.env).filter(([key, value]) => /KEY|TOKEN|SECRET|APPID/u.test(key) && value.length >= 3).map(([, value]) => value);
const hash = value => value ? createHash('sha256').update(process.env.QQBOT_APPID).update(String(value)).digest('hex').slice(0, 16) : undefined;
const redact = value => {
    let serialized = JSON.stringify(value);
    for (const secret of secrets) serialized = serialized.replaceAll(secret, '[redacted]');
    return serialized;
};
writeFileSync(output, '', { mode: 0o600 });
const record = (type, detail = {}) => appendFileSync(output, `${redact({ at: new Date().toISOString(), type, ...detail })}\n`);
globalThis.__qqbotLiveRecord = record;
globalThis.__qqbotLiveHash = hash;

const sdkRoot = '/data/profiles/qqbot/node_modules/@tencent-connect/qqbot-nodejs/dist';
const wrapper = `/tmp/qqbot-live-sdk-${process.pid}.mjs`;
await writeFile(wrapper, `
import * as sdk from '${sdkRoot}/index.js';
export * from '${sdkRoot}/index.js';
export class QQBot extends sdk.QQBot {
  constructor(options) {
    super(options);
    const record = globalThis.__qqbotLiveRecord;
    const hash = globalThis.__qqbotLiveHash;
    this.on('ready', () => record('gateway.ready'));
    this.on('disconnected', event => record('gateway.disconnected', { code: event.code, willReconnect: event.willReconnect }));
    this.on('interaction', (_ctx, event) => record('qq.interaction', { scene: event.scene }));
    this.use(async (ctx, next) => {
      const message = ctx.message;
      record('qq.inbound', { scope: message.kind, messageHash: hash(message.messageId),
        senderHash: hash(message.senderId), text: String(message.content ?? '').slice(0, 4000),
        attachmentCount: message.attachments?.length ?? 0 });
      return next();
    });
  }
}
`);
registerHooks({ resolve(specifier, context, next) {
    return specifier === '@tencent-connect/qqbot-nodejs' ? { url: `file://${wrapper}`, shortCircuit: true } : next(specifier, context);
} });
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const operation = ['api.bot.qq.com', 'api.sgroup.qq.com'].includes(url.hostname) && url.pathname.match(/^\/v2\/(users|groups)\/[^/]+\/(messages|files)$/u);
    let payload;
    if (operation && typeof init?.body === 'string') {
        try { payload = JSON.parse(init.body); } catch { /* Never log unparsed bodies. */ }
    }
    try {
        const response = await originalFetch(input, init);
        if (operation) {
            const fields = { scope: operation[1] === 'users' ? 'c2c' : 'group', operation: operation[2],
                httpStatus: response.status, messageHash: hash(payload?.msg_id ?? payload?.event_id),
                messageType: payload?.msg_type, text: String(payload?.markdown?.content ?? payload?.content ?? '').slice(0, 6000),
                media: Boolean(payload?.media), fileType: payload?.file_type };
            void response.clone().json().then(body => record('qq.response', { ...fields,
                acknowledged: response.ok && Boolean(body.id ?? body.file_info), code: body.code }))
                .catch(() => record('qq.response', { ...fields, acknowledged: false }));
        }
        return response;
    } catch (error) {
        if (operation) record('qq.transport-error', { operation: operation[2], errorType: error?.name });
        throw error;
    }
};

const dsh = '/usr/local/lib/node_modules/@deepseek-ai/dsh';
const { loadLayeredEnv } = await import(`${dsh}/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`);
const { runProfile } = await import(`${dsh}/lib/profile-boot.js`);
const boot = await runProfile({ environment: loadLayeredEnv('dsh'), profile: 'qqbot',
    patchFiles: ['/opt/qqbot-defaults/cordis.safety.patch.yml'], args: [] });
boot.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next();
    const entry = assembly.contexts.find(item => item.name === 'qqbot:capabilities');
    let snapshot;
    try { snapshot = JSON.parse(entry?.text.split('\n').at(-1)); } catch { /* Report a missing snapshot explicitly. */ }
    record('model.assembly', { agentHash: hash(context.agent?.id), tools: assembly.tools.map(tool => tool.name), snapshot });
    return assembly;
});
boot.ctx.on('tools/execute', async (exec, next) => {
    record('tool.start', { name: exec.name, ...(exec.name === 'qqbot_create_markdown' ? { filename: exec.arguments?.filename, heading: exec.arguments?.content?.split('\n').find(line => /^# /u.test(line)) } : {}) });
    try {
        const result = await next();
        record('tool.result', { name: exec.name, isError: result?.isError === true, status: result?.value?.status, ...(exec.name === 'ask_user_question' ? { answers: result?.value?.answers } : {}), ...(exec.name === 'qqbot_create_markdown' ? { filename: result?.value?.filename } : {}) });
        return result;
    } catch (error) { record('tool.error', { name: exec.name, errorType: error?.name }); throw error; }
});
boot.ctx.on('agent/error', ({ error }) => record('model.error', { errorType: error?.name, code: error?.code }));
record('probe.listening');
let stopping = false;
async function stop() {
    if (stopping) return;
    stopping = true;
    record('probe.stopping');
    await boot.shutdown.shutdown(0);
}
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
setTimeout(() => void stop(), 30 * 60_000).unref();
