#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-dsh-qqbot:test-local}"
suffix="$(date +%s)-$$"
data_volume="dsh-qqbot-test-data-${suffix}"
workspace_volume="dsh-qqbot-test-workspace-${suffix}"
override_data_volume="dsh-qqbot-test-override-data-${suffix}"
container="dsh-qqbot-test-${suffix}"
instructions_file="$(mktemp)"

log() {
    printf '[test-local] %s\n' "$*"
}

on_error() {
    local status=$?
    log "Failed at script line ${BASH_LINENO[0]} (exit code ${status})"
    exit "$status"
}

cleanup() {
    log "Cleaning up temporary container, volumes, and instruction file"
    docker rm --force "$container" >/dev/null 2>&1 || true
    docker volume rm "$data_volume" "$workspace_volume" "$override_data_volume" >/dev/null 2>&1 || true
    rm -f "$instructions_file"
}
trap cleanup EXIT
trap on_error ERR

if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required" >&2
    exit 69
fi

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
    log "Building image: $IMAGE"
    docker build --pull --quiet --tag "$IMAGE" .
else
    log "Skipping image build; using existing image: $IMAGE"
fi

# The immutable launcher overlay must preserve the plugin's environment
# credential placeholders; otherwise a patched profile can wait for QR setup.
log "Checking immutable QQ credential placeholders"
grep -Fq 'appId: __FROM_ENV__' defaults/cordis.safety.patch.yml
grep -Fq 'appSecret: __FROM_ENV__' defaults/cordis.safety.patch.yml

log "Creating temporary named volumes"
docker volume create "$data_volume" >/dev/null
docker volume create "$workspace_volume" >/dev/null
docker volume create "$override_data_volume" >/dev/null

# A user-provided read-only AGENTS.md must work on a fresh /data volume. This
# specifically catches accidental recursive chown/copy operations on the mount.
log "Checking read-only AGENTS.md mount on a fresh data volume"
printf 'custom mounted instructions\n' >"$instructions_file"
docker run --rm \
    --volume "${override_data_volume}:/data" \
    --mount "type=bind,src=${instructions_file},dst=/data/AGENTS.md,readonly" \
    "$IMAGE" \
    sh -ec '
        test -f /data/.initialized
        test "$(cat /data/AGENTS.md)" = "custom mounted instructions"
    '

# The command is deliberately finite: no credentials are supplied, so this
# validates the image without entering the plugin's first-run QR login flow.
log "Preparing finite first-run validation container"
docker create \
    --name "$container" \
    --volume "${data_volume}:/data" \
    --volume "${workspace_volume}:/workspace" \
    "$IMAGE" \
    sh -ec '
        if [ ! -e /data/.persistence-check ]; then
            printf persistent > /data/.persistence-check
        else
            test "$(cat /data/.persistence-check)" = persistent
        fi
        test -f /data/.initialized
        test -f /data/AGENTS.md
        grep -q "蓝色大肥鱼" /data/AGENTS.md
        test -w /workspace
        touch /workspace/.dsh-qqbot-test-writable
        command -v bwrap
        # Regression guard: the launcher must stay a symlink into the global
        # package root. A real file in /usr/local/bin breaks ESM resolution and
        # dsh dies with ERR_MODULE_NOT_FOUND for @deepseek-ai/dsh-app-boot.
        test -L /usr/local/bin/dsh
        test -L /usr/local/bin/pnpm
        dsh --version
        grep -Rqs "gateway initialization failed" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist
        grep -Rqs "QQ gateway is still not ready" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist
        dsh --profile qqbot --patch /opt/qqbot-defaults/cordis.safety.patch.yml --dump-config >/dev/null
    ' >/dev/null

log "Starting first container run (seed initialisation)"
docker start --attach "$container"

log "Checking seeded profile, plugin version, and writable workspace"
docker run --rm \
    --volume "${data_volume}:/data" \
    --volume "${workspace_volume}:/workspace" \
    "$IMAGE" \
    node -e '
        const plugin = require("/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/package.json");
        if (plugin.version !== "0.5.0") process.exit(1);
        const fs = require("fs");
        if (!fs.readFileSync("/data/AGENTS.md", "utf8").includes("蓝色大肥鱼")) process.exit(1);
        if (!fs.existsSync("/workspace/.dsh-qqbot-test-writable")) process.exit(1);
    '

log "Restarting the same container and named volumes (must preserve /data)"
docker start --attach "$container"

log "Checking persistent data marker after restart"
docker run --rm --entrypoint sh --volume "${data_volume}:/data" "$IMAGE" -ec '
    test -f /data/.initialized
    test "$(cat /data/.persistence-check)" = persistent
'

cmd="$(docker image inspect --format '{{json .Config.Cmd}}' "$IMAGE")"
log "Checking default image command"
if [[ "$cmd" != '["dsh","--profile","qqbot"]' ]]; then
    echo "Unexpected default image command: $cmd" >&2
    exit 1
fi

log "Scanning image configuration for injected secret names"
if docker image inspect "$IMAGE" | grep -Eqi 'DEEPSEEK_API_KEY|LLM_API_KEY|QQBOT_SECRET'; then
    echo "Secret variable name unexpectedly present in image configuration" >&2
    exit 1
fi

log "Scanning image history for injected secret names"
if docker history --no-trunc "$IMAGE" | grep -Eqi 'DEEPSEEK_API_KEY|LLM_API_KEY|QQBOT_SECRET'; then
    echo "Secret variable name unexpectedly present in image history" >&2
    exit 1
fi

log "Passed: seed, profile, plugin, workspace, persistence, and image secret scan"
