#!/bin/sh
set -eu

: "${DSH_HOME:=/data}"
export DSH_HOME
export HOME=/home/node
# Chat-only is a deployment policy, not a permission that a chat user can raise.
export DSH_PERMISSION_MODE=read-only

if [ "$DSH_HOME" != "/data" ]; then
    echo "DSH_HOME must be /data; refusing to initialize an unexpected path: $DSH_HOME" >&2
    exit 64
fi

mkdir -p /data /workspace

# dsh itself resolves its state through DSH_HOME. dsh-qqbot 0.5.0 also reads
# ~/.dsh/settings.yaml as a compatibility fallback, so point that legacy view at
# the same persistent root instead of the image's ephemeral node home.
mkdir -p "$HOME"
ln -sfn /data "$HOME/.dsh"
chown -h node:node "$HOME/.dsh"

if [ ! -e /data/.initialized ]; then
    cp -a /opt/dsh-seed/. /data/
    : > /data/.initialized
    # /opt/dsh-seed is already node-owned.  Do not recursively chown /data:
    # users may bind mount /data/AGENTS.md read-only to replace the default.
    chown node:node /data /data/.initialized
fi

# Seed the shared, user-overridable instruction file separately from the dsh
# profile seed. A read-only bind mount at this target therefore wins safely.
if [ ! -e /data/AGENTS.md ]; then
    install -o node -g node -m 0644 /opt/qqbot-defaults/AGENTS.md /data/AGENTS.md
fi

# Existing named volumes retain the originally seeded plugin. Apply the strict
# chat policy before launch; diagnostics may degrade, but policy must not.
qqbot_dist=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist
if [ ! -d "$qqbot_dist" ]; then
    echo "[entrypoint] Pinned QQ plugin is missing; refusing to start without the chat-only policy" >&2
    exit 78
fi
node /usr/local/lib/enforce-chat-only.mjs "$qqbot_dist"
if ! node /usr/local/lib/instrument-qqbot-startup.mjs "$qqbot_dist"; then
    echo "[entrypoint] QQ startup diagnostics were not applied; continuing with the installed plugin" >&2
fi

# Container Station can configure a third-party OpenAI-compatible route entirely
# through environment variables. The generated profile patch contains only the
# environment-variable *name*, never LLM_API_KEY itself.
if [ -n "${LLM_PROVIDER:-}${LLM_MODEL:-}${LLM_API_BASE_URL:-}${LLM_API_KEY:-}" ]; then
    node <<'NODE'
const fs = require('node:fs');
const path = '/data/profiles/qqbot/cordis.patch.yml';
const yaml = require('/data/profiles/qqbot/node_modules/js-yaml');
const { LLM_PROVIDER: provider, LLM_MODEL: model, LLM_API_BASE_URL: baseURL } = process.env;
const api = process.env.LLM_API_PROTOCOL || 'openai-responses';

if (!provider || !model || !baseURL || !process.env.LLM_API_KEY) {
  throw new Error('LLM_PROVIDER, LLM_MODEL, LLM_API_BASE_URL, and LLM_API_KEY must all be set together');
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(provider)) {
  throw new Error('LLM_PROVIDER must contain only lowercase letters, digits, and hyphens');
}
if (!['openai-responses', 'openai-completions'].includes(api)) {
  throw new Error('LLM_API_PROTOCOL must be openai-responses or openai-completions');
}
const url = new URL(baseURL);
if (url.protocol !== 'https:' && url.protocol !== 'http:') {
  throw new Error('LLM_API_BASE_URL must be an HTTP(S) URL');
}
if (url.username || url.password) {
  throw new Error('LLM_API_BASE_URL must not contain credentials; use LLM_API_KEY');
}

const existing = fs.existsSync(path) ? yaml.load(fs.readFileSync(path, 'utf8')) : [];
if (existing != null && !Array.isArray(existing)) {
  throw new Error(`${path} must have a YAML array at its root`);
}
const entries = existing || [];
const upsert = (id) => {
  let entry = entries.find((item) => item && item.id === id);
  if (!entry) {
    entry = { id, config: {} };
    entries.push(entry);
  }
  entry.config ||= {};
  return entry;
};

const route = upsert('llm-pi-ai');
route.config.providers ||= {};
route.config.providers[provider] = {
  displayName: provider,
  apiKeyEnv: 'LLM_API_KEY',
  api,
  baseURL: url.toString().replace(/\/$/, ''),
  // This declaration permits image inputs but doesn't make a text-only model
  // multimodal. Deployers must select an image-capable model for vision.
  models: [{ id: model, name: model, input: ['text', 'image'] }],
};
const defaultModel = upsert('agent-default-model');
defaultModel.config.provider = provider;
defaultModel.config.model = model;

fs.writeFileSync(path, `# Generated from LLM_* environment variables; no secret is stored here.\n${yaml.dump(entries)}`);
NODE
    chown node:node /data/profiles/qqbot/cordis.patch.yml
fi

# A Docker named volume is normally root-owned when first mounted.  Make its
# mount point writable before dropping privileges, without recursively changing
# a long-lived agent workspace on every start.
chown node:node /workspace
cd /workspace

# Append the immutable transport safety overlay to the stock command while
# preserving the image's documented CMD. It applies after any persisted profile
# configuration; AGENTS.md stays separately user-replaceable.
if [ "$#" -ge 3 ] && [ "$1" = "dsh" ] && [ "$2" = "--profile" ] && [ "$3" = "qqbot" ]; then
    shift 3
    set -- dsh --profile qqbot "$@" --patch /opt/qqbot-defaults/cordis.safety.patch.yml
fi

exec setpriv --reuid=node --regid=node --init-groups -- "$@"
