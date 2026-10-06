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

# Credential presence selects one deployment mode. Stale LLM_* route fields
# alone never switch an official-key deployment to a third-party route.
deepseek_api_key=${DEEPSEEK_API_KEY:-}
llm_api_key=${LLM_API_KEY:-}
if [ -n "$deepseek_api_key" ] && [ -n "$llm_api_key" ]; then
    echo "[entrypoint] Set only one of DEEPSEEK_API_KEY or LLM_API_KEY; the chat credential modes are mutually exclusive" >&2
    exit 64
fi

# Image generation has its own credential and route. It is never inferred from
# the chat provider. A completely absent route keeps the dedicated image tool
# unavailable; any partial route is a configuration error.
image_api_key=${IMAGE_API_KEY:-}
image_api_base_url=${IMAGE_API_BASE_URL:-}
image_model=${IMAGE_MODEL:-}
image_api_protocol=${IMAGE_API_PROTOCOL:-}
if [ -n "$image_api_key" ] || [ -n "$image_api_base_url" ] || [ -n "$image_model" ] || [ -n "$image_api_protocol" ]; then
    if [ -z "$image_api_key" ] || [ -z "$image_api_base_url" ] || [ -z "$image_model" ]; then
        echo "[entrypoint] IMAGE_API_KEY, IMAGE_API_BASE_URL, and IMAGE_MODEL must be set together" >&2
        exit 64
    fi
    image_api_protocol=${image_api_protocol:-openai-images}
    if [ "$image_api_protocol" != "openai-images" ] && [ "$image_api_protocol" != "xai-images" ]; then
        echo "[entrypoint] IMAGE_API_PROTOCOL must be openai-images or xai-images" >&2
        exit 64
    fi
    export IMAGE_API_PROTOCOL="$image_api_protocol"
fi

QQBOT_MARKDOWN_ENABLED=${QQBOT_MARKDOWN_ENABLED:-true}
QQBOT_IMAGE_USER_HOURLY_LIMIT=${QQBOT_IMAGE_USER_HOURLY_LIMIT:-10}
QQBOT_MARKDOWN_USER_HOURLY_LIMIT=${QQBOT_MARKDOWN_USER_HOURLY_LIMIT:-30}
QQBOT_IMAGE_MAX_CONCURRENT=${QQBOT_IMAGE_MAX_CONCURRENT:-2}
QQBOT_MARKDOWN_MAX_CONCURRENT=${QQBOT_MARKDOWN_MAX_CONCURRENT:-4}
if [ "$QQBOT_MARKDOWN_ENABLED" != "true" ] && [ "$QQBOT_MARKDOWN_ENABLED" != "false" ]; then
    echo "[entrypoint] QQBOT_MARKDOWN_ENABLED must be true or false" >&2
    exit 64
fi
export QQBOT_MARKDOWN_ENABLED QQBOT_IMAGE_USER_HOURLY_LIMIT QQBOT_MARKDOWN_USER_HOURLY_LIMIT
export QQBOT_IMAGE_MAX_CONCURRENT QQBOT_MARKDOWN_MAX_CONCURRENT

# Validate route syntax and resource settings before touching persistent state.
# The image request path performs its own DNS/IP checks and pins the connection.
node <<'NODE'
const raw = process.env.IMAGE_API_BASE_URL || '';
for (const [name, maximum] of [
  ['IMAGE_API_KEY', 4096],
  ['IMAGE_API_BASE_URL', 2048],
  ['IMAGE_MODEL', 256],
]) {
  const value = process.env[name] || '';
  if (value.length > maximum) {
    throw new Error(`${name} must be at most ${maximum} characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must not contain control characters`);
  }
}

if (raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('IMAGE_API_BASE_URL must be a valid public HTTPS base URL');
  }
  const authority = raw.match(/^https:\/\/([^/?#]*)/i)?.[1] || '';
  if (url.protocol !== 'https:' || !authority || authority.includes('@') ||
      !url.hostname || url.username || url.password || url.search || url.hash || /[?#]/.test(raw)) {
    throw new Error('IMAGE_API_BASE_URL must be a public HTTPS base URL without credentials, query, or fragment');
  }
}

for (const name of [
  'QQBOT_IMAGE_USER_HOURLY_LIMIT',
  'QQBOT_MARKDOWN_USER_HOURLY_LIMIT',
  'QQBOT_IMAGE_MAX_CONCURRENT',
  'QQBOT_MARKDOWN_MAX_CONCURRENT',
]) {
  const value = process.env[name] || '';
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a positive integer`);
  }
}
NODE

selected_provider=''
if [ -n "$llm_api_key" ]; then
    selected_provider=${LLM_PROVIDER:-}
elif [ -n "$deepseek_api_key" ]; then
    selected_provider=deepseek-official
fi
if [ -n "$selected_provider" ] && [ -n "${QQBOT_VISION_PROVIDER:-}" ] \
    && [ "$QQBOT_VISION_PROVIDER" != "$selected_provider" ]; then
    echo "[entrypoint] QQBOT_VISION_PROVIDER must match the active chat credential mode" >&2
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

# Upgrade only exact stock instructions shipped by v0.9.0 through v0.11.0. A
# customized, symlinked, or read-only AGENTS.md remains user-owned and is never
# replaced.
previous_v0_9_stock_agents_sha256=17aa60a400c6c541e11d21da1eb527ebd5330791e646d8e6ca4eb02c8ac2b02b
previous_v0_10_stock_agents_sha256=16ccc3bdc4d3632d70874f8289362b635aa05107e69aa691b729a2e91a66cf67
previous_v0_10_3_stock_agents_sha256=75685d6d97b80482d0f65faea03d406e138a764e36a0ee695aa71f9469145fd1
previous_v0_11_stock_agents_sha256=81ca9f07b266e25113fbc978352d4a53d882423dc556c52425c0f736df9a84a3
if [ -f /data/AGENTS.md ] && [ ! -L /data/AGENTS.md ] && [ -r /data/AGENTS.md ] && [ -w /data/AGENTS.md ]; then
    current_agents_sha256=$(sha256sum /data/AGENTS.md | cut -d ' ' -f 1)
    if [ "$current_agents_sha256" = "$previous_v0_9_stock_agents_sha256" ] \
        || [ "$current_agents_sha256" = "$previous_v0_10_stock_agents_sha256" ] \
        || [ "$current_agents_sha256" = "$previous_v0_10_3_stock_agents_sha256" ] \
        || [ "$current_agents_sha256" = "$previous_v0_11_stock_agents_sha256" ]; then
        agents_migration_tmp="/data/.AGENTS.md.$$"
        if install -o node -g node -m 0644 /opt/qqbot-defaults/AGENTS.md "$agents_migration_tmp" \
            && mv -f "$agents_migration_tmp" /data/AGENTS.md; then
            chown node:node /data/AGENTS.md
        else
            rm -f "$agents_migration_tmp" || true
        fi
    fi
fi

# Store the QQ plugin's transport cache in the persistent data volume.
media_store=/data/qqbot-media

if [ -L "$media_store" ] || { [ -e "$media_store" ] && [ ! -d "$media_store" ]; }; then
    echo "[entrypoint] Refusing unexpected media store at $media_store; it must be a real directory" >&2
    exit 78
fi
if [ ! -e "$media_store" ]; then
    mkdir "$media_store"
fi
chown node:node "$media_store"

# Existing named volumes retain the originally seeded plugin. Apply the chat
# policy and upgrade migrations before launch; policy errors stop startup.
qqbot_dist=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist
if [ ! -d "$qqbot_dist" ]; then
    echo "[entrypoint] Pinned QQ plugin is missing; refusing to start without the qqbot runtime policy" >&2
    exit 78
fi
node /usr/local/lib/enforce-chat-only.mjs "$qqbot_dist"
if ! node /usr/local/lib/instrument-qqbot-startup.mjs "$qqbot_dist"; then
    echo "[entrypoint] QQ startup diagnostics were not applied; continuing with the installed plugin" >&2
fi

# A non-empty LLM_API_KEY selects a third-party OpenAI-compatible route. The
# generated profile patch contains only the environment-variable name, never
# LLM_API_KEY itself. LLM_SEARCH_BASE_URL is an independent optional native
# DeepSeek search endpoint; it is not inferred from LLM_API_BASE_URL.
if [ -n "$llm_api_key" ]; then
    node <<'NODE'
const fs = require('node:fs');
const path = '/data/profiles/qqbot/cordis.patch.yml';
const yaml = require('/data/profiles/qqbot/node_modules/js-yaml');
const { LLM_PROVIDER: provider, LLM_MODEL: model, LLM_API_BASE_URL: baseURL } = process.env;
const api = process.env.LLM_API_PROTOCOL || 'openai-responses';
const searchBaseURL = process.env.LLM_SEARCH_BASE_URL || '';

if (!provider || !model || !baseURL || !process.env.LLM_API_KEY) {
  throw new Error('LLM_PROVIDER, LLM_MODEL, LLM_API_BASE_URL, and LLM_API_KEY must all be set together');
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(provider)) {
  throw new Error('LLM_PROVIDER must contain only lowercase letters, digits, and hyphens');
}
if (provider === 'deepseek-official') {
  throw new Error('LLM_PROVIDER deepseek-official is reserved for the built-in DeepSeek route');
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
if (searchBaseURL) {
  let searchUrl;
  try {
    searchUrl = new URL(searchBaseURL);
  } catch {
    throw new Error('LLM_SEARCH_BASE_URL must be a valid HTTP(S) URL');
  }
  if (searchUrl.protocol !== 'https:' && searchUrl.protocol !== 'http:') {
    throw new Error('LLM_SEARCH_BASE_URL must be an HTTP(S) URL');
  }
  if (searchUrl.username || searchUrl.password) {
    throw new Error('LLM_SEARCH_BASE_URL must not contain credentials; use LLM_API_KEY');
  }
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
