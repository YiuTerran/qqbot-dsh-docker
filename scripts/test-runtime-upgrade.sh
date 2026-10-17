#!/usr/bin/env bash
set -euo pipefail
repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
image="${IMAGE:-dsh-qqbot:test-local}"
legacy_image="${LEGACY_IMAGE:-tryao/qqbot-dsh:v0.17.0}"
temporary="$(mktemp -d /tmp/qqbot-upgrade-XXXXXX)"
container=''
volumes=()
cleanup() {
    if [ -n "$container" ]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
    for volume in "${volumes[@]}"; do docker volume rm "$volume" >/dev/null 2>&1 || true; done
    rm -rf "$temporary"
}
trap cleanup EXIT
if ! docker image inspect "$legacy_image" >/dev/null 2>&1; then docker pull "$legacy_image"; fi
container="$(docker create "$legacy_image")"
docker cp "$container:/opt/dsh-seed/profiles/qqbot" "$temporary/legacy-profile"
docker run --rm --network none --entrypoint node \
    --volume "$temporary/legacy-profile:/legacy-profile:ro" \
    --volume "$repo_root/scripts/test-runtime-upgrade.mjs:/tmp/test-runtime-upgrade.mjs:ro" \
    --env QQBOT_LEGACY_PROFILE=/legacy-profile \
    "$image" --test /tmp/test-runtime-upgrade.mjs
mkdir "$temporary/sessions"
for mode in write resume; do
    session_image="$image"
    if [ "$mode" = write ]; then session_image="$legacy_image"; fi
    docker run --rm --network none --user "$(id -u):$(id -g)" --entrypoint node \
        --volume "$temporary/sessions:/history" \
        --volume "$repo_root/scripts/test-session-upgrade.mjs:/tmp/test-session-upgrade.mjs:ro" \
        --env QQBOT_HISTORY_ROOT=/history \
        "$session_image" /tmp/test-session-upgrade.mjs "$mode"
done

# Exercise the actual entrypoint on a real old volume, and restore its complete snapshot for rollback.
for label in data snapshot restored; do
    volumes+=("$(docker volume create "qqbot-runtime-upgrade-${label}-$(basename "$temporary")")")
done
docker run --rm --network none --entrypoint sh --volume "${volumes[0]}:/data" --volume "${volumes[1]}:/snapshot" \
    "$legacy_image" -ec 'cp -a /opt/dsh-seed/. /data/; touch /data/.initialized; printf "custom persona\n" > /data/AGENTS.md; cp -a /data/. /snapshot/'
docker run --rm --network none --volume "${volumes[0]}:/data" --env QQBOT_APPID=fixture --env QQBOT_SECRET=fixture \
    --env DEEPSEEK_API_KEY=fixture "$image" node -e \
    'const fs=require("fs"); if(require("/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/package.json").version!=="0.5.2")throw Error("upgrade failed"); if(fs.readFileSync("/data/AGENTS.md","utf8")!=="custom persona\n")throw Error("persona overwritten")'
docker run --rm --network none --entrypoint sh --volume "${volumes[1]}:/snapshot:ro" --volume "${volumes[2]}:/data" \
    "$legacy_image" -ec 'cp -a /snapshot/. /data/'
docker run --rm --network none --volume "${volumes[2]}:/data" --env QQBOT_APPID=fixture --env QQBOT_SECRET=fixture \
    --env DEEPSEEK_API_KEY=fixture "$legacy_image" node -e \
    'const fs=require("fs"); if(require("/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/package.json").version!=="0.5.0")throw Error("rollback failed"); if(fs.readFileSync("/data/AGENTS.md","utf8")!=="custom persona\n")throw Error("snapshot was not restored")'
echo 'Actual entrypoint upgrade and full-volume rollback passed'
