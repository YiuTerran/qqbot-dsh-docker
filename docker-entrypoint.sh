#!/bin/sh
set -eu

: "${DSH_HOME:=/data}"
export DSH_HOME
export HOME=/home/node

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
    chown -R node:node /data
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
  models: [{ id: model, name: model }],
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

exec setpriv --reuid=node --regid=node --init-groups -- "$@"
