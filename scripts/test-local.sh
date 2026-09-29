#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-dsh-qqbot:test-local}"
suffix="$(date +%s)-$$"
data_volume="dsh-qqbot-test-data-${suffix}"
workspace_volume="dsh-qqbot-test-workspace-${suffix}"
container="dsh-qqbot-test-${suffix}"

cleanup() {
    docker rm --force "$container" >/dev/null 2>&1 || true
    docker volume rm "$data_volume" "$workspace_volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required" >&2
    exit 69
fi

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
    docker build --pull --quiet --tag "$IMAGE" .
fi

docker volume create "$data_volume" >/dev/null
docker volume create "$workspace_volume" >/dev/null

# The command is deliberately finite: no credentials are supplied, so this
# validates the image without entering the plugin's first-run QR login flow.
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
        test -w /workspace
        touch /workspace/.dsh-qqbot-test-writable
        dsh --version
    ' >/dev/null

echo "Starting first container run (seed initialisation)"
docker start --attach "$container"

docker run --rm \
    --volume "${data_volume}:/data" \
    --volume "${workspace_volume}:/workspace" \
    "$IMAGE" \
    node -e '
        const plugin = require("/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/package.json");
        if (plugin.version !== "0.5.0") process.exit(1);
        const fs = require("fs");
        if (!fs.existsSync("/workspace/.dsh-qqbot-test-writable")) process.exit(1);
    '

echo "Restarting the same container and named volumes (must preserve /data)"
docker start --attach "$container"

docker run --rm --entrypoint sh --volume "${data_volume}:/data" "$IMAGE" -ec '
    test -f /data/.initialized
    test "$(cat /data/.persistence-check)" = persistent
'

cmd="$(docker image inspect --format '{{json .Config.Cmd}}' "$IMAGE")"
if [[ "$cmd" != '["dsh","--profile","qqbot"]' ]]; then
    echo "Unexpected default image command: $cmd" >&2
    exit 1
fi

if docker image inspect "$IMAGE" | grep -Eqi 'DEEPSEEK_API_KEY|QQBOT_SECRET'; then
    echo "Secret variable name unexpectedly present in image configuration" >&2
    exit 1
fi

if docker history --no-trunc "$IMAGE" | grep -Eqi 'DEEPSEEK_API_KEY|QQBOT_SECRET'; then
    echo "Secret variable name unexpectedly present in image history" >&2
    exit 1
fi

echo "Local validation passed: seed, profile, plugin, workspace, persistence, and image secret scan."
