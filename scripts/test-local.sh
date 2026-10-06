#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-dsh-qqbot:test-local}"
repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
chat_policy_test="${repo_root}/scripts/test-chat-policy.mjs"
model_context_test="${repo_root}/scripts/test-model-context.mjs"
group_history_test="${repo_root}/scripts/test-group-history.mjs"
recovery_policy_test="${repo_root}/scripts/test-session-recovery.mjs"
provider_errors_test="${repo_root}/scripts/test-provider-errors.mjs"
concurrency_test="${repo_root}/scripts/test-concurrency.mjs"
generation_test="${repo_root}/scripts/test-generation.mjs"
recent_image_generation_test="${repo_root}/scripts/test-recent-image-generation.mjs"
generation_scope_test="${repo_root}/scripts/test-generation-scope.mjs"
generation_quota_test="${repo_root}/scripts/test-generation-quotas.mjs"
pending_images_test="${repo_root}/scripts/test-pending-images.mjs"
pending_images_native_test="${repo_root}/scripts/test-pending-images-native.mjs"
memory_images_test="${repo_root}/scripts/test-memory-images.mjs"
onebot_native_test="${repo_root}/scripts/test-onebot-native.mjs"
onebot_direct_test="${repo_root}/scripts/test-onebot-direct.mjs"
sealdice_policy_test="${repo_root}/scripts/test-sealdice-policy.mjs"
sealdice_policy_fixture="${repo_root}/third_party/sealdice-core/dice/testdata/onebot-bridge-policy.json"
onebot_direct_native_test="${repo_root}/scripts/test-onebot-direct-native.mjs"
recovery_upgrade_test="${repo_root}/scripts/test-recovery-upgrade.mjs"
pre_recovery_fixture="${repo_root}/scripts/prepare-pre-recovery-fixture.mjs"
pre_concurrency_fixture="${repo_root}/scripts/prepare-pre-concurrency-fixture.mjs"
previous_stock_agents_fixture="${repo_root}/scripts/fixtures/agents-v0.9.0-stock.md"
previous_stock_agents_v0_10_fixture="${repo_root}/scripts/fixtures/agents-v0.10.0-stock.md"
previous_stock_agents_v0_10_3_fixture="${repo_root}/scripts/fixtures/agents-v0.10.3-stock.md"
previous_stock_agents_v0_11_fixture="${repo_root}/scripts/fixtures/agents-v0.11.0-stock.md"
persistent_reset_probe="${repo_root}/scripts/test-persistent-reset.mjs"
suffix="$(date +%s)-$$"
data_volume="dsh-qqbot-test-data-${suffix}"
workspace_volume="dsh-qqbot-test-workspace-${suffix}"
override_data_volume="dsh-qqbot-test-override-data-${suffix}"
legacy_data_volume="dsh-qqbot-test-legacy-data-${suffix}"
dice_legacy_data_volume="dsh-qqbot-test-dice-legacy-data-${suffix}"
incompatible_data_volume="dsh-qqbot-test-incompatible-data-${suffix}"
media_guard_data_volume="dsh-qqbot-test-media-guard-data-${suffix}"
search_env_data_volume="dsh-qqbot-test-search-env-data-${suffix}"
official_data_volume="dsh-qqbot-test-official-data-${suffix}"
no_search_data_volume="dsh-qqbot-test-no-search-data-${suffix}"
partial_recovery_data_volume="dsh-qqbot-test-partial-recovery-data-${suffix}"
recovery_v1_data_volume="dsh-qqbot-test-recovery-v1-data-${suffix}"
pre_concurrency_data_volume="dsh-qqbot-test-pre-concurrency-data-${suffix}"
partial_concurrency_data_volume="dsh-qqbot-test-partial-concurrency-data-${suffix}"
stock_agents_data_volume="dsh-qqbot-test-stock-agents-data-${suffix}"
readonly_stock_agents_data_volume="dsh-qqbot-test-readonly-stock-agents-data-${suffix}"
stock_agents_v0_10_data_volume="dsh-qqbot-test-stock-agents-v0-10-data-${suffix}"
readonly_stock_agents_v0_10_data_volume="dsh-qqbot-test-readonly-stock-agents-v0-10-data-${suffix}"
container="dsh-qqbot-test-${suffix}"
instructions_file="$(mktemp)"
incompatible_log="$(mktemp)"

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
    docker volume rm "$data_volume" "$workspace_volume" "$override_data_volume" "$legacy_data_volume" "$dice_legacy_data_volume" "$incompatible_data_volume" "$media_guard_data_volume" "$search_env_data_volume" "$official_data_volume" "$no_search_data_volume" "$partial_recovery_data_volume" "$recovery_v1_data_volume" "$pre_concurrency_data_volume" "$partial_concurrency_data_volume" "$stock_agents_data_volume" "$readonly_stock_agents_data_volume" "$stock_agents_v0_10_data_volume" "$readonly_stock_agents_v0_10_data_volume" >/dev/null 2>&1 || true
    rm -f "$instructions_file"
    rm -f "$incompatible_log"
}
trap cleanup EXIT
trap on_error ERR

if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required" >&2
    exit 69
fi

if [[ ! -r "$chat_policy_test" ]]; then
    echo "missing chat policy regression script: $chat_policy_test" >&2
    exit 66
fi

if [[ ! -r "$model_context_test" ]]; then
    echo "missing model context regression script: $model_context_test" >&2
    exit 66
fi

if [[ ! -r "$group_history_test" ]]; then
    echo "missing group history regression script: $group_history_test" >&2
    exit 66
fi

if [[ ! -r "$recovery_policy_test" ]]; then
    echo "missing session recovery regression script: $recovery_policy_test" >&2
    exit 66
fi

if [[ ! -r "$pre_recovery_fixture" ]]; then
    echo "missing pre-recovery volume fixture script: $pre_recovery_fixture" >&2
    exit 66
fi

if [[ ! -r "$pre_concurrency_fixture" ]]; then
    echo "missing pre-concurrency volume fixture script: $pre_concurrency_fixture" >&2
    exit 66
fi

if [[ ! -r "$previous_stock_agents_fixture" ]]; then
    echo "missing previous stock AGENTS.md fixture: $previous_stock_agents_fixture" >&2
    exit 66
fi

if [[ ! -r "$previous_stock_agents_v0_10_fixture" ]]; then
    echo "missing previous stock AGENTS.md fixture: $previous_stock_agents_v0_10_fixture" >&2
    exit 66
fi

if [[ ! -r "$previous_stock_agents_v0_11_fixture" ]]; then
    echo "missing previous stock AGENTS.md fixture: $previous_stock_agents_v0_11_fixture" >&2
    exit 66
fi

if [[ ! -r "$memory_images_test" ]]; then
    echo "missing memory-only recent images regression script: $memory_images_test" >&2
    exit 66
fi

if [[ ! -r "$provider_errors_test" ]]; then
    echo "missing provider errors regression script: $provider_errors_test" >&2
    exit 66
fi

if [[ ! -r "$concurrency_test" ]]; then
    echo "missing concurrency regression script: $concurrency_test" >&2
    exit 66
fi

if [[ ! -r "$generation_test" ]]; then
    echo "missing image generation and Markdown regression script: $generation_test" >&2
    exit 66
fi

if [[ ! -r "$recent_image_generation_test" ]]; then
    echo "missing recent image editing regression script: $recent_image_generation_test" >&2
    exit 66
fi

if [[ ! -r "$generation_scope_test" ]]; then
    echo "missing image generation provenance regression script: $generation_scope_test" >&2
    exit 66
fi

if [[ ! -r "$generation_quota_test" ]]; then
    echo "missing generation quota regression script: $generation_quota_test" >&2
    exit 66
fi

if [[ ! -r "$pending_images_test" ]]; then
    echo "missing pending image prompt regression script: $pending_images_test" >&2
    exit 66
fi

if [[ ! -r "$pending_images_native_test" ]]; then
    echo "missing native pending image prompt regression script: $pending_images_native_test" >&2
    exit 66
fi

if [[ ! -r "$onebot_direct_test" ]]; then
    echo "missing OneBot direct router regression script: $onebot_direct_test" >&2
    exit 66
fi

if [[ ! -r "$onebot_direct_native_test" ]]; then
    echo "missing native OneBot direct router regression script: $onebot_direct_native_test" >&2
    exit 66
fi

if [[ ! -r "$recovery_upgrade_test" ]]; then
    echo "missing recovery upgrade regression script: $recovery_upgrade_test" >&2
    exit 66
fi

if [[ ! -r "$persistent_reset_probe" ]]; then
    echo "missing persistent reset probe: $persistent_reset_probe" >&2
    exit 66
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
docker volume create "$legacy_data_volume" >/dev/null
docker volume create "$dice_legacy_data_volume" >/dev/null
docker volume create "$incompatible_data_volume" >/dev/null
docker volume create "$media_guard_data_volume" >/dev/null
docker volume create "$search_env_data_volume" >/dev/null
docker volume create "$official_data_volume" >/dev/null
docker volume create "$no_search_data_volume" >/dev/null
docker volume create "$partial_recovery_data_volume" >/dev/null
docker volume create "$recovery_v1_data_volume" >/dev/null
docker volume create "$pre_concurrency_data_volume" >/dev/null
docker volume create "$partial_concurrency_data_volume" >/dev/null
docker volume create "$stock_agents_data_volume" >/dev/null
docker volume create "$readonly_stock_agents_data_volume" >/dev/null

run_profile_probe() {
    local scenario="$1"
    local volume="$2"
    local expected_base_url="$3"
    shift 3
    log "Checking credential routing: $scenario"
    docker run --rm --network none \
        --volume "${volume}:/data" \
        --mount "type=bind,src=${repo_root}/scripts/test-profile-boot.mjs,dst=/tmp/test-profile-boot.mjs,readonly" \
        --env QQBOT_APPID=fixture-app-id \
        --env QQBOT_SECRET=fixture-app-secret \
        --env QQBOT_TEST_EXPECT_SEARCH_BASE_URL="$expected_base_url" \
        "$@" \
        "$IMAGE" node /tmp/test-profile-boot.mjs
}

run_profile_probe \
    "official route overrides stale LLM fields" \
    "$official_data_volume" \
    "https://api.deepseek.com/anthropic/v1" \
    --env DEEPSEEK_API_KEY=fixture-official-key \
    --env LLM_PROVIDER=stale-provider \
    --env LLM_MODEL=stale-model \
    --env LLM_API_BASE_URL=https://stale-chat.example.com/v1
run_profile_probe \
    "official route uses the default search model for an explicitly blank override" \
    "$official_data_volume" \
    "https://api.deepseek.com/anthropic/v1" \
    --env DEEPSEEK_API_KEY=fixture-official-key \
    --env LLM_MODEL=stale-chat-model \
    --env LLM_SEARCH_MODEL=
run_profile_probe \
    "official route accepts a custom search model independently from chat" \
    "$official_data_volume" \
    "https://api.deepseek.com/anthropic/v1" \
    --env DEEPSEEK_API_KEY=fixture-official-key \
    --env LLM_MODEL=stale-chat-model \
    --env LLM_SEARCH_MODEL=fixture-official-search-model
run_profile_probe \
    "third-party route with native search endpoint" \
    "$search_env_data_volume" \
    "https://search-gateway.example.com/anthropic/v1" \
    --env LLM_PROVIDER=fixture-chat \
    --env LLM_MODEL=fixture-chat-model \
    --env LLM_API_BASE_URL=https://chat-gateway.example.com/v1 \
    --env LLM_API_PROTOCOL=openai-responses \
    --env LLM_API_KEY=fixture-chat-key \
    --env LLM_SEARCH_BASE_URL=https://search-gateway.example.com/anthropic/v1 \
    --env LLM_SEARCH_MODEL=fixture-third-party-search-model
run_profile_probe \
    "third-party custom search model alone does not enable search" \
    "$no_search_data_volume" \
    "" \
    --env LLM_PROVIDER=fixture-chat \
    --env LLM_MODEL=fixture-chat-model \
    --env LLM_API_BASE_URL=https://chat-gateway.example.com/v1 \
    --env LLM_API_PROTOCOL=openai-responses \
    --env LLM_API_KEY=fixture-chat-key \
    --env LLM_SEARCH_MODEL=fixture-search-without-endpoint
run_profile_probe \
    "dedicated OpenAI image route defaults its protocol independently" \
    "$official_data_volume" \
    "https://api.deepseek.com/anthropic/v1" \
    --env DEEPSEEK_API_KEY=fixture-official-key \
    --env IMAGE_API_KEY=fixture-openai-image-key \
    --env IMAGE_API_BASE_URL=https://image-gateway.example.com/v1 \
    --env IMAGE_MODEL=fixture-image-model
run_profile_probe \
    "dedicated xAI image route stays independent and can disable Markdown export" \
    "$official_data_volume" \
    "https://api.deepseek.com/anthropic/v1" \
    --env DEEPSEEK_API_KEY=fixture-official-key \
    --env IMAGE_API_KEY=fixture-image-key \
    --env IMAGE_API_BASE_URL=https://image-gateway.example.com/v1 \
    --env IMAGE_MODEL=fixture-image-model \
    --env IMAGE_API_PROTOCOL=xai-images \
    --env QQBOT_MARKDOWN_ENABLED=false
run_profile_probe \
    "official route after third-party config persists in same volume" \
    "$search_env_data_volume" \
    "https://api.deepseek.com/anthropic/v1" \
    --env DEEPSEEK_API_KEY=fixture-official-key \
    --env LLM_PROVIDER=stale-provider \
    --env LLM_MODEL=stale-model \
    --env LLM_API_BASE_URL=https://stale-chat.example.com/v1

log "Checking keyless diagnostic command with stale LLM route fields"
docker run --rm --network none --volume "${official_data_volume}:/data" \
    --env LLM_PROVIDER=stale-provider --env LLM_MODEL=stale-model \
    --env LLM_API_BASE_URL=https://stale-chat.example.com/v1 \
    "$IMAGE" sh -c true

log "Checking credential and search endpoint validation failures"
if docker run --rm --network none --volume "${official_data_volume}:/data" \
    --env QQBOT_APPID=fixture-app-id --env QQBOT_SECRET=fixture-app-secret \
    --env DEEPSEEK_API_KEY=fixture-official-key --env LLM_API_KEY=fixture-chat-key \
    "$IMAGE" sh -c true >"$incompatible_log" 2>&1; then
    echo "entrypoint unexpectedly accepted both chat credential modes" >&2
    exit 1
fi
grep -Fq "mutually exclusive" "$incompatible_log"
if docker run --rm --network none --volume "${official_data_volume}:/data" \
    --env QQBOT_APPID=fixture-app-id --env QQBOT_SECRET=fixture-app-secret \
    --env LLM_PROVIDER=fixture-chat --env LLM_MODEL=fixture-chat-model \
    --env LLM_API_BASE_URL=https://chat-gateway.example.com/v1 --env LLM_API_KEY=fixture-chat-key \
    --env LLM_SEARCH_BASE_URL=https://user:password@search-gateway.example.com/anthropic/v1 \
    "$IMAGE" sh -c true >"$incompatible_log" 2>&1; then
    echo "entrypoint unexpectedly accepted credentials embedded in LLM_SEARCH_BASE_URL" >&2
    exit 1
fi
grep -Fq "LLM_SEARCH_BASE_URL must not contain credentials" "$incompatible_log"
if docker run --rm --network none --volume "${official_data_volume}:/data" \
    --env QQBOT_APPID=fixture-app-id --env QQBOT_SECRET=fixture-app-secret \
    --env IMAGE_API_KEY=fixture-image-key \
    "$IMAGE" sh -c true >"$incompatible_log" 2>&1; then
    echo "entrypoint unexpectedly accepted a partial image API route" >&2
    exit 1
fi
grep -Fq "IMAGE_API_KEY, IMAGE_API_BASE_URL, and IMAGE_MODEL must be set together" "$incompatible_log"
if docker run --rm --network none --volume "${official_data_volume}:/data" \
    --env QQBOT_APPID=fixture-app-id --env QQBOT_SECRET=fixture-app-secret \
    --env IMAGE_API_KEY=fixture-image-key \
    --env IMAGE_API_BASE_URL=https://image-gateway.example.com/v1 \
    --env IMAGE_MODEL=fixture-image-model --env IMAGE_API_PROTOCOL=unsupported-images \
    "$IMAGE" sh -c true >"$incompatible_log" 2>&1; then
    echo "entrypoint unexpectedly accepted an unsupported image protocol" >&2
    exit 1
fi
grep -Fq "IMAGE_API_PROTOCOL must be openai-images or xai-images" "$incompatible_log"
if docker run --rm --network none --volume "${official_data_volume}:/data" \
    --env QQBOT_APPID=fixture-app-id --env QQBOT_SECRET=fixture-app-secret \
    --env IMAGE_API_KEY=fixture-image-key \
    --env IMAGE_API_BASE_URL=http://image-gateway.example.com/v1 \
    --env IMAGE_MODEL=fixture-image-model \
    "$IMAGE" sh -c true >"$incompatible_log" 2>&1; then
    echo "entrypoint unexpectedly accepted a non-HTTPS image API base URL" >&2
    exit 1
fi
grep -Fq "IMAGE_API_BASE_URL must be a public HTTPS base URL" "$incompatible_log"

log "Checking entrypoint refuses conflicting persistent media paths"
docker run --rm --network none \
    --entrypoint sh \
    --volume "${media_guard_data_volume}:/data" \
    "$IMAGE" \
    -ec '
        mkdir -p /tmp/qqbot-media-target
        printf sentinel > /tmp/qqbot-media-target/sentinel
        ln -s /tmp/qqbot-media-target /data/qqbot-media
        if /usr/local/bin/docker-entrypoint.sh sh -c true >/tmp/media-guard.log 2>&1; then
            echo "entrypoint unexpectedly accepted a symlink at /data/qqbot-media" >&2
            exit 1
        fi
        grep -Fq "Refusing unexpected media store at /data/qqbot-media" /tmp/media-guard.log
        test "$(cat /tmp/qqbot-media-target/sentinel)" = sentinel
        test "$(readlink /data/qqbot-media)" = /tmp/qqbot-media-target
        rm /data/qqbot-media
        printf sentinel > /data/qqbot-media
        if /usr/local/bin/docker-entrypoint.sh sh -c true >/tmp/media-guard.log 2>&1; then
            echo "entrypoint unexpectedly accepted a file at /data/qqbot-media" >&2
            exit 1
        fi
        grep -Fq "Refusing unexpected media store at /data/qqbot-media" /tmp/media-guard.log
        test "$(cat /data/qqbot-media)" = sentinel
    '

# A user-provided read-only AGENTS.md must work on a fresh /data volume. This
# specifically catches accidental recursive chown/copy operations on the mount.
log "Checking read-only AGENTS.md mount on a fresh data volume"
printf 'custom mounted instructions\n' >"$instructions_file"
# A Linux host can own this fixture as a different UID than the container's node user.
chmod 0644 "$instructions_file"
docker run --rm \
    --network none \
    --volume "${override_data_volume}:/data" \
    --mount "type=bind,src=${instructions_file},dst=/data/AGENTS.md,readonly" \
    "$IMAGE" \
    sh -ec '
        test -f /data/.initialized
        test "$(cat /data/AGENTS.md)" = "custom mounted instructions"
    '

log "Checking exact stock AGENTS.md migration and read-only preservation"
docker run --rm --entrypoint sh \
    --volume "${stock_agents_v0_10_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_11_fixture},dst=/tmp/agents-stock.md,readonly" \
    "$IMAGE" -ec 'cp /tmp/agents-stock.md /data/AGENTS.md; chmod 0644 /data/AGENTS.md'
docker run --rm \
    --volume "${stock_agents_v0_10_data_volume}:/data" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /opt/qqbot-defaults/AGENTS.md'
docker run --rm \
    --volume "${readonly_stock_agents_v0_10_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_11_fixture},dst=/data/AGENTS.md,readonly" \
    --mount "type=bind,src=${previous_stock_agents_v0_11_fixture},dst=/tmp/agents-stock.md,readonly" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /tmp/agents-stock.md'
docker run --rm --entrypoint sh \
    --volume "${stock_agents_v0_10_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_10_3_fixture},dst=/tmp/agents-stock.md,readonly" \
    "$IMAGE" -ec 'cp /tmp/agents-stock.md /data/AGENTS.md; chmod 0644 /data/AGENTS.md'
docker run --rm \
    --volume "${stock_agents_v0_10_data_volume}:/data" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /opt/qqbot-defaults/AGENTS.md'
docker run --rm \
    --volume "${readonly_stock_agents_v0_10_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_10_3_fixture},dst=/data/AGENTS.md,readonly" \
    --mount "type=bind,src=${previous_stock_agents_v0_10_3_fixture},dst=/tmp/agents-stock.md,readonly" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /tmp/agents-stock.md'
docker run --rm --network none --entrypoint sh \
    --volume "${stock_agents_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_fixture},dst=/tmp/agents-v0.9.0-stock.md,readonly" \
    "$IMAGE" -ec '
        cp -a /opt/dsh-seed/. /data/
        : > /data/.initialized
        cp /tmp/agents-v0.9.0-stock.md /data/AGENTS.md
        chmod 0644 /data/AGENTS.md
    '
docker run --rm --network none \
    --volume "${stock_agents_data_volume}:/data" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /opt/qqbot-defaults/AGENTS.md'

docker run --rm --network none \
    --volume "${readonly_stock_agents_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_fixture},dst=/data/AGENTS.md,readonly" \
    --mount "type=bind,src=${previous_stock_agents_fixture},dst=/tmp/agents-v0.9.0-stock.md,readonly" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /tmp/agents-v0.9.0-stock.md'

docker run --rm --network none --entrypoint sh \
    --volume "${stock_agents_v0_10_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_10_fixture},dst=/tmp/agents-v0.10.0-stock.md,readonly" \
    "$IMAGE" -ec '
        cp -a /opt/dsh-seed/. /data/
        : > /data/.initialized
        cp /tmp/agents-v0.10.0-stock.md /data/AGENTS.md
        chmod 0644 /data/AGENTS.md
    '
docker run --rm --network none \
    --volume "${stock_agents_v0_10_data_volume}:/data" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /opt/qqbot-defaults/AGENTS.md'

docker run --rm --network none \
    --volume "${readonly_stock_agents_v0_10_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_10_fixture},dst=/data/AGENTS.md,readonly" \
    --mount "type=bind,src=${previous_stock_agents_v0_10_fixture},dst=/tmp/agents-v0.10.0-stock.md,readonly" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /tmp/agents-v0.10.0-stock.md'

# The command is deliberately finite: fixture credentials are supplied only to
# the local SDK probe, never real QQ credentials, so no QR login is attempted.
log "Preparing finite first-run validation container"
docker create \
    --name "$container" \
    --network none \
    --env QQBOT_APPID=fixture-app-id \
    --env QQBOT_SECRET=fixture-app-secret \
    --volume "${data_volume}:/data" \
    --volume "${workspace_volume}:/workspace" \
    --mount "type=bind,src=${chat_policy_test},dst=/tmp/test-chat-policy.mjs,readonly" \
    --mount "type=bind,src=${model_context_test},dst=/tmp/test-model-context.mjs,readonly" \
    --mount "type=bind,src=${group_history_test},dst=/tmp/test-group-history.mjs,readonly" \
    --mount "type=bind,src=${recovery_policy_test},dst=/tmp/test-session-recovery.mjs,readonly" \
    --mount "type=bind,src=${provider_errors_test},dst=/tmp/test-provider-errors.mjs,readonly" \
    --mount "type=bind,src=${concurrency_test},dst=/tmp/test-concurrency.mjs,readonly" \
    --mount "type=bind,src=${generation_test},dst=/tmp/test-generation.mjs,readonly" \
    --mount "type=bind,src=${recent_image_generation_test},dst=/tmp/test-recent-image-generation.mjs,readonly" \
    --mount "type=bind,src=${generation_scope_test},dst=/tmp/test-generation-scope.mjs,readonly" \
    --mount "type=bind,src=${generation_quota_test},dst=/tmp/test-generation-quotas.mjs,readonly" \
    --mount "type=bind,src=${pending_images_test},dst=/tmp/test-pending-images.mjs,readonly" \
    --mount "type=bind,src=${pending_images_native_test},dst=/tmp/test-pending-images-native.mjs,readonly" \
    --mount "type=bind,src=${memory_images_test},dst=/tmp/test-memory-images.mjs,readonly" \
    --mount "type=bind,src=${onebot_native_test},dst=/tmp/test-onebot-native.mjs,readonly" \
    --mount "type=bind,src=${onebot_direct_test},dst=/tmp/test-onebot-direct.mjs,readonly" \
    --mount "type=bind,src=${sealdice_policy_test},dst=/tmp/test-sealdice-policy.mjs,readonly" \
    --mount "type=bind,src=${sealdice_policy_fixture},dst=/tmp/onebot-bridge-policy.json,readonly" \
    --mount "type=bind,src=${onebot_direct_native_test},dst=/tmp/test-onebot-direct-native.mjs,readonly" \
    --mount "type=bind,src=${recovery_upgrade_test},dst=/tmp/test-recovery-upgrade.mjs,readonly" \
    --mount "type=bind,src=${pre_recovery_fixture},dst=/tmp/prepare-pre-recovery-fixture.mjs,readonly" \
    --mount "type=bind,src=${pre_concurrency_fixture},dst=/tmp/prepare-pre-concurrency-fixture.mjs,readonly" \
    --mount "type=bind,src=${repo_root}/scripts/test-profile-boot.mjs,dst=/tmp/test-profile-boot.mjs,readonly" \
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
        test -d /data/qqbot-media
        test ! -L /data/qqbot-media
        test -w /data/qqbot-media
        node -e "const fs=require(\"node:fs\"); const p=\"/data/qqbot-media/cache-persistence-fixture.png\"; const b=Buffer.from(\"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/g3sAAAAASUVORK5CYII=\", \"base64\"); if(fs.existsSync(p)){if(!fs.readFileSync(p).equals(b)) throw new Error(\"media fixture changed\");} else fs.writeFileSync(p,b);"
        media_cleaner=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/media/media-cleaner.js
        grep -Fq "// Chat-only persistent media root v1." "$media_cleaner"
        grep -Fq "export const MEDIA_ROOT = '\''/data/qqbot-media'\'';" "$media_cleaner"
        node --check "$media_cleaner"
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
        grep -Fq "export const inject =" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/index.js
        grep -Fq "systemPrompt" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/index.js
        middleware_setup=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/gateway/middleware-setup.js
        grep -Fq "createScopedQuoteRef" "$middleware_setup"
        grep -Fq "bot.use(createScopedQuoteRef(quoteRef));" "$middleware_setup"
        grep -Fq "import { createHistorySnapshotBuffer } from '\''/opt/qqbot-defaults/qqbot-history-snapshot.mjs'\'';" "$middleware_setup"
        grep -Fq "bot.use(createHistorySnapshotBuffer(historyBuffer, {" "$middleware_setup"
        ! grep -Fq "createDiceCommandMiddleware" "$middleware_setup"
        ! grep -Fq "createDiceAwareHistoryBuffer" "$middleware_setup"
        node --check "$middleware_setup"
        node --check /opt/qqbot-defaults/qqbot-session-recovery.mjs
        node --check /opt/qqbot-defaults/qqbot-pending-images.mjs
        node --check /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js
        node --check /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js
        node --check /opt/qqbot-defaults/qqbot-provider-errors.mjs
        node --check /opt/qqbot-defaults/qqbot-concurrency.mjs
        node --check /opt/qqbot-defaults/qqbot-history-snapshot.mjs
        node --check /opt/qqbot-defaults/qqbot-generation.mjs
        node --check /opt/qqbot-defaults/qqbot-generation-sender.mjs
        node --check /opt/qqbot-defaults/qqbot-generation-scope.mjs
        node --check /opt/qqbot-defaults/qqbot-generation-quotas.mjs
        node --check /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/transport/inbound.js
        node --check /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/transport/outbound.js
        node --check /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/model/prefs-store.js
        node --check /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/model/model-resolver.js
        node --check /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/session/session-manager.js
        dump=/tmp/qqbot-dump-config.yaml
        dsh --profile qqbot --patch /opt/qqbot-defaults/cordis.safety.patch.yml --dump-config >"$dump"
        grep -A2 -F -- "- id: tool-bash" "$dump" | grep -Fq "disabled: true"
        grep -A2 -F -- "- id: tool-fs" "$dump" | grep -Fq "disabled: true"
        grep -A12 -F -- "- id: tool-subagent" "$dump" | grep -Fq "disabled: true"
        grep -A2 -F -- "- id: ptc-runtime" "$dump" | grep -Fq "disabled: true"
        grep -A4 -F -- "- id: web" "$dump" | grep -Fq "searchProvider: deepseek-official"
        grep -A4 -F -- "- id: web" "$dump" | grep -Fq "fetchProvider: qqbot-pages"
        grep -A6 -F -- "- id: web-fetch-http" "$dump" | grep -Fq "disabled: true"
        grep -A9 -F -- "- id: tool-web" "$dump" | grep -Fq "searchMaxResults: 8"
        grep -A9 -F -- "- id: tool-web" "$dump" | grep -Fq "searchMaxQueries: 4"
        grep -A8 -F -- "- id: web-search-deepseek" "$dump" | grep -Fq "maxUses: 0"
        grep -A9 -F -- "- id: tool-web" "$dump" | grep -Fq "searchTimeoutMs: 60000"
        grep -A9 -F -- "- id: tool-web" "$dump" | grep -Fq "fetch: true"
        grep -A3 -F -- "- id: tools" "$dump" | grep -Fq "mode: native"
        grep -A4 -F -- "- id: agent-loop" "$dump" | grep -Fq "agents: []"
        test "$(grep -A6 -F -- "- id: im-qqbot" "$dump" | grep -Fc "appId: __FROM_ENV__")" -eq 1
        test "$(grep -A6 -F -- "- id: im-qqbot" "$dump" | grep -Fc "appSecret: __FROM_ENV__")" -eq 1
        node --test /tmp/test-chat-policy.mjs
        QQBOT_LLM_MODULE=/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js QQBOT_RUNTIME_ROOT=/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai QQBOT_ADAPTER_DIST=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist node --test /tmp/test-model-context.mjs
        QQBOT_HISTORY_SNAPSHOT_MODULE=/opt/qqbot-defaults/qqbot-history-snapshot.mjs node --test /tmp/test-group-history.mjs
        QQBOT_PENDING_IMAGES_MODULE=/opt/qqbot-defaults/qqbot-pending-images.mjs QQBOT_CONCURRENCY_MODULE=/opt/qqbot-defaults/qqbot-concurrency.mjs node --test /tmp/test-pending-images.mjs
        node --test /tmp/test-pending-images-native.mjs
        node --test /tmp/test-memory-images.mjs
        QQBOT_RECOVERY_MODULE=/opt/qqbot-defaults/qqbot-session-recovery.mjs QQBOT_HISTORY_SNAPSHOT_MODULE=/opt/qqbot-defaults/qqbot-history-snapshot.mjs QQBOT_PROVIDER_ERRORS_MODULE=/opt/qqbot-defaults/qqbot-provider-errors.mjs QQBOT_CONCURRENCY_MODULE=/opt/qqbot-defaults/qqbot-concurrency.mjs QQBOT_ADAPTER_DIST=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist node --test /tmp/test-session-recovery.mjs
        QQBOT_PROVIDER_ERRORS_MODULE=/opt/qqbot-defaults/qqbot-provider-errors.mjs QQBOT_ADAPTER_DIST=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist node --test /tmp/test-provider-errors.mjs
        QQBOT_CONCURRENCY_MODULE=/opt/qqbot-defaults/qqbot-concurrency.mjs QQBOT_ADAPTER_DIST=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist node --test /tmp/test-concurrency.mjs
        QQBOT_GENERATION_MODULE=/opt/qqbot-defaults/qqbot-generation.mjs QQBOT_GENERATION_SCOPE_MODULE=/opt/qqbot-defaults/qqbot-generation-scope.mjs QQBOT_ADAPTER_DIST=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist node --test --test-timeout=30000 /tmp/test-generation.mjs
        QQBOT_GENERATION_MODULE=/opt/qqbot-defaults/qqbot-generation.mjs QQBOT_GENERATION_SCOPE_MODULE=/opt/qqbot-defaults/qqbot-generation-scope.mjs QQBOT_ADAPTER_DIST=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist node --test --test-timeout=30000 /tmp/test-recent-image-generation.mjs
        QQBOT_GENERATION_SCOPE_MODULE=/opt/qqbot-defaults/qqbot-generation-scope.mjs node --test /tmp/test-generation-scope.mjs
        QQBOT_GENERATION_QUOTA_MODULE=/opt/qqbot-defaults/qqbot-generation-quotas.mjs node --test /tmp/test-generation-quotas.mjs
        QQBOT_ONEBOT_MODULE_ROOT=/opt/qqbot-defaults QQBOT_ONEBOT_PATCHER_SOURCE=/usr/local/lib/enforce-chat-only.mjs QQBOT_SDK_API_CLIENT_MODULE=/data/profiles/qqbot/node_modules/@tencent-connect/qqbot-nodejs/dist/protocol/api/api-client.js node --test /tmp/test-onebot-native.mjs
        QQBOT_ONEBOT_MODULE_ROOT=/opt/qqbot-defaults node --test /tmp/test-onebot-direct.mjs
        QQBOT_ONEBOT_MODULE_ROOT=/opt/qqbot-defaults QQBOT_SEALDICE_POLICY_FIXTURE=/tmp/onebot-bridge-policy.json node --test /tmp/test-sealdice-policy.mjs
        QQBOT_ONEBOT_DIRECT_MODULE=/opt/qqbot-defaults/qqbot-onebot-direct.mjs QQBOT_ADAPTER_DIST=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist node --test /tmp/test-onebot-direct-native.mjs
        QQBOT_ADAPTER_DIST=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist QQBOT_ENFORCER_SCRIPT=/usr/local/lib/enforce-chat-only.mjs node --test /tmp/test-recovery-upgrade.mjs
        node /tmp/test-profile-boot.mjs
        QQBOT_TEST_ONEBOT_FIXTURE=true QQBOT_APPID=123456789 node /tmp/test-profile-boot.mjs
    '

log "Starting first container run (seed initialisation, config dump, security regression)"
docker start --attach "$container"

log "Checking seeded profile, plugin version, and writable workspace"
docker run --rm \
    --network none \
    --volume "${data_volume}:/data" \
    --volume "${workspace_volume}:/workspace" \
    "$IMAGE" \
    node -e '
        const plugin = require("/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/package.json");
        if (plugin.version !== "0.5.0") process.exit(1);
        const fs = require("fs");
        if (!fs.readFileSync("/data/AGENTS.md", "utf8").includes("蓝色大肥鱼")) process.exit(1);
        if (!fs.existsSync("/workspace/.dsh-qqbot-test-writable")) process.exit(1);
        const mediaPath = "/data/qqbot-media";
        if (!fs.statSync(mediaPath).isDirectory()) throw new Error("persistent media root is not a directory");
        const fixture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/g3sAAAAASUVORK5CYII=", "base64");
        if (!fs.readFileSync(`${mediaPath}/cache-persistence-fixture.png`).equals(fixture)) throw new Error("media fixture did not survive container recreation");
    '

log "Media cache survived recreation in a fresh container with the same named /data volume"
log "Restarting the same container and named volumes (must preserve persistent data and media)"
docker start --attach "$container"

log "Checking persistent data and media marker after restart"
docker run --rm --network none --entrypoint sh --volume "${data_volume}:/data" "$IMAGE" -ec '
    test -f /data/.initialized
    test "$(cat /data/.persistence-check)" = persistent
    test -d /data/qqbot-media
    test -s /data/qqbot-media/cache-persistence-fixture.png
'

log "Preparing a legacy dice-patched volume to verify the removal migration"
docker run --rm --network none --entrypoint sh --volume "${dice_legacy_data_volume}:/data" "$IMAGE" -ec '
    cp -a /opt/dsh-seed/. /data/
    : > /data/.initialized
    printf "legacy dice user instructions\n" > /data/AGENTS.md
'
docker run --rm --network none --entrypoint node --volume "${dice_legacy_data_volume}:/data" "$IMAGE" -e '
    const fs = require("node:fs");
    const path = "/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/gateway/middleware-setup.js";
    let source = fs.readFileSync(path, "utf8");
    const replaceExactlyOnce = (before, after, label) => {
        const parts = source.split(before);
        if (parts.length !== 2) throw new Error(`legacy dice fixture expected one ${label}`);
        source = parts[0] + after + parts[1];
    };
    replaceExactlyOnce("import { createHistorySnapshotBuffer } from \x27/opt/qqbot-defaults/qqbot-history-snapshot.mjs\x27;\n", "import { createDiceCommandMiddleware, createDiceAwareHistoryBuffer } from \x27/opt/qqbot-defaults/qqbot-chat-policy.mjs\x27;\n", "group history import");
    replaceExactlyOnce("    // Chat-only history snapshot epoch guard v1.\n", "", "group history marker");
    replaceExactlyOnce("bot.use(createHistorySnapshotBuffer(historyBuffer, {", "bot.use(createDiceAwareHistoryBuffer(historyBuffer, {", "group history wrapper");
    replaceExactlyOnce("            return historyGroupKey(config.appId, gid);\n        },\n    }));", "            return historyGroupKey(config.appId, gid);\n        },\n    }, contentSanitizer));", "history buffer closure");
    replaceExactlyOnce("    bot.use(rateLimiter());\n", "    bot.use(rateLimiter());\n    // Chat-only dice command middleware v1.\n    bot.use(createDiceCommandMiddleware());\n\n", "dice command middleware");
    fs.writeFileSync(path, source);
'
docker run --rm --network none --entrypoint node \
    --volume "${dice_legacy_data_volume}:/data" \
    --mount "type=bind,src=${pre_concurrency_fixture},dst=/tmp/prepare-pre-concurrency-fixture.mjs,readonly" \
    "$IMAGE" /tmp/prepare-pre-concurrency-fixture.mjs /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist
docker run --rm --network none --entrypoint node \
    --volume "${dice_legacy_data_volume}:/data" \
    --mount "type=bind,src=${pre_recovery_fixture},dst=/tmp/prepare-pre-recovery-fixture.mjs,readonly" \
    "$IMAGE" /tmp/prepare-pre-recovery-fixture.mjs /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist
check_dice_legacy_upgrade() {
    docker run --rm --network none \
        --volume "${dice_legacy_data_volume}:/data" \
        --mount "type=bind,src=${group_history_test},dst=/tmp/test-group-history.mjs,readonly" \
        --mount "type=bind,src=${recovery_policy_test},dst=/tmp/test-session-recovery.mjs,readonly" \
        --mount "type=bind,src=${provider_errors_test},dst=/tmp/test-provider-errors.mjs,readonly" \
        --mount "type=bind,src=${concurrency_test},dst=/tmp/test-concurrency.mjs,readonly" \
        --mount "type=bind,src=${pre_recovery_fixture},dst=/tmp/prepare-pre-recovery-fixture.mjs,readonly" \
        "$IMAGE" sh -ec '
            test "$(cat /data/AGENTS.md)" = "legacy dice user instructions"
            middleware=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/gateway/middleware-setup.js
            inbound=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/transport/inbound.js
            ! grep -Fq "createDiceCommandMiddleware" "$middleware"
            ! grep -Fq "createDiceAwareHistoryBuffer" "$middleware"
            ! grep -Fq "qqbot-dice" "$middleware"
            grep -Fq "import { createHistorySnapshotBuffer } from '\''/opt/qqbot-defaults/qqbot-history-snapshot.mjs'\'';" "$middleware"
            grep -Fq "bot.use(createHistorySnapshotBuffer(historyBuffer, {" "$middleware"
            grep -Fq "// Chat-only history snapshot epoch guard v1." "$middleware"
            grep -Fq "createScopedQuoteRef" "$middleware"
            grep -Fq "Chat-only per-turn document scope v1." "$inbound"
            grep -Fq "Chat-only content-risk recovery context v1." "$inbound"
            grep -Fq "Chat-only history snapshot epoch guard v1." "$inbound"
            grep -Fq "Chat-only content-risk turn recovery v1." /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/transport/outbound.js
            grep -Fq "Chat-only friendly provider errors v1." /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/transport/outbound.js
            grep -Fq "Chat-only persistent model prefs v1." /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/model/prefs-store.js
            grep -Fq "Chat-only strict sessionId persistence v1." /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/model/model-resolver.js
            grep -Fq "Chat-only strict automatic session reset v1." /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/session/session-manager.js
            node --check "$middleware"
            QQBOT_HISTORY_SNAPSHOT_MODULE=/opt/qqbot-defaults/qqbot-history-snapshot.mjs node --test /tmp/test-group-history.mjs
            QQBOT_RECOVERY_MODULE=/opt/qqbot-defaults/qqbot-session-recovery.mjs QQBOT_HISTORY_SNAPSHOT_MODULE=/opt/qqbot-defaults/qqbot-history-snapshot.mjs QQBOT_PROVIDER_ERRORS_MODULE=/opt/qqbot-defaults/qqbot-provider-errors.mjs QQBOT_CONCURRENCY_MODULE=/opt/qqbot-defaults/qqbot-concurrency.mjs QQBOT_ADAPTER_DIST=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist node --test /tmp/test-session-recovery.mjs
            QQBOT_PROVIDER_ERRORS_MODULE=/opt/qqbot-defaults/qqbot-provider-errors.mjs QQBOT_ADAPTER_DIST=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist node --test /tmp/test-provider-errors.mjs
            QQBOT_CONCURRENCY_MODULE=/opt/qqbot-defaults/qqbot-concurrency.mjs QQBOT_ADAPTER_DIST=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist node --test /tmp/test-concurrency.mjs
        '
}
check_dice_legacy_upgrade
check_dice_legacy_upgrade

log "Checking recovery-v1 upgrade and repeated startup"
docker run --rm --network none --entrypoint sh --volume "${recovery_v1_data_volume}:/data" "$IMAGE" -ec '
    cp -a /opt/dsh-seed/. /data/
    : > /data/.initialized
'
docker run --rm --network none --entrypoint node --volume "${recovery_v1_data_volume}:/data" \
    --mount "type=bind,src=${pre_concurrency_fixture},dst=/tmp/prepare-pre-concurrency-fixture.mjs,readonly" \
    "$IMAGE" /tmp/prepare-pre-concurrency-fixture.mjs /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist
docker run --rm --network none --entrypoint node --volume "${recovery_v1_data_volume}:/data" \
    --mount "type=bind,src=${pre_recovery_fixture},dst=/tmp/prepare-pre-recovery-fixture.mjs,readonly" \
    "$IMAGE" /tmp/prepare-pre-recovery-fixture.mjs /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist recovery-v1
for recovery_boot in 1 2; do
    docker run --rm --network none --volume "${recovery_v1_data_volume}:/data" "$IMAGE" sh -ec '
        root=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist
        test "$(grep -Fc "Chat-only friendly provider errors v1." "$root/transport/outbound.js")" -eq 1
        test "$(grep -Fc "Chat-only safe inbound errors v1." "$root/transport/inbound.js")" -eq 1
        test "$(grep -Fc "Chat-only committed reset disposal v1." "$root/session/session-manager.js")" -eq 1
        node --check "$root/transport/outbound.js"
        node --check "$root/session/session-manager.js"
    '
done

log "Checking pre-concurrency/v10.2 data-volume upgrade, direct routing, and native FIFO regressions"
docker run --rm --network none --entrypoint sh --volume "${pre_concurrency_data_volume}:/data" "$IMAGE" -ec '
    cp -a /opt/dsh-seed/. /data/
    : > /data/.initialized
    printf "pre-concurrency user instructions\n" > /data/AGENTS.md
'
docker run --rm --network none --volume "${pre_concurrency_data_volume}:/data" "$IMAGE" sh -ec 'test -f /data/.initialized'
docker run --rm --network none --entrypoint node --volume "${pre_concurrency_data_volume}:/data" \
    --mount "type=bind,src=${pre_concurrency_fixture},dst=/tmp/prepare-pre-concurrency-fixture.mjs,readonly" \
    "$IMAGE" /tmp/prepare-pre-concurrency-fixture.mjs /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist
for concurrency_boot in 1 2; do
    docker run --rm --network none \
        --volume "${pre_concurrency_data_volume}:/data" \
        --mount "type=bind,src=${concurrency_test},dst=/tmp/test-concurrency.mjs,readonly" \
        --mount "type=bind,src=${onebot_direct_native_test},dst=/tmp/test-onebot-direct-native.mjs,readonly" \
        "$IMAGE" sh -ec '
            test "$(cat /data/AGENTS.md)" = "pre-concurrency user instructions"
            root=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist
            test "$(grep -Fc "Chat-only native OneBot direct router v1." "$root/gateway/bootstrap.js")" -eq 1
            test "$(grep -Fc "Chat-only OneBot /new cancellation v1." "$root/gateway/middleware-setup.js")" -eq 1
            test "$(grep -Fc "Chat-only OneBot direct router middleware v1." "$root/gateway/middleware-setup.js")" -eq 1
            test "$(grep -Fc "Chat-only serialized merge guard v1." "$root/gateway/middleware-setup.js")" -eq 1
            test "$(grep -Fc "Chat-only batch cancellation and reply binding v1." "$root/transport/inbound.js")" -eq 1
            test "$(grep -Fc "Chat-only safe batch finalization v1." "$root/transport/inbound.js")" -eq 1
            test "$(grep -Fc "Chat-only batch-bound outbound routing v1." "$root/transport/outbound.js")" -eq 1
            test "$(grep -Fc "Chat-only awaitable stream cancellation v1." "$root/transport/streaming-writer.js")" -eq 1
            test "$(grep -Fc "Chat-only awaitable stream cancellation v1." "$root/transport/outbound-buffer.js")" -eq 1
            node --check "$root/gateway/bootstrap.js"
            node --check "$root/gateway/middleware-setup.js"
            node --check "$root/transport/inbound.js"
            node --check "$root/transport/outbound.js"
            node --check "$root/transport/streaming-writer.js"
            node --check "$root/transport/outbound-buffer.js"
            QQBOT_CONCURRENCY_MODULE=/opt/qqbot-defaults/qqbot-concurrency.mjs \
                QQBOT_ADAPTER_DIST="$root" node --test /tmp/test-concurrency.mjs
            QQBOT_ONEBOT_DIRECT_MODULE=/opt/qqbot-defaults/qqbot-onebot-direct.mjs \
                QQBOT_ADAPTER_DIST="$root" node --test /tmp/test-onebot-direct-native.mjs
        '
done

log "Checking partial concurrency marker fails closed without changing adapter files"
docker run --rm --network none --entrypoint sh --volume "${partial_concurrency_data_volume}:/data" "$IMAGE" -ec '
    cp -a /opt/dsh-seed/. /data/
    : > /data/.initialized
'
docker run --rm --network none --volume "${partial_concurrency_data_volume}:/data" "$IMAGE" sh -ec 'test -f /data/.initialized'
docker run --rm --network none --entrypoint node --volume "${partial_concurrency_data_volume}:/data" "$IMAGE" -e '
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    const root = "/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist";
    const file = "gateway/middleware-setup.js";
    const path = `${root}/${file}`;
    const needle = "                await sendMergeQueueFullNotice(sender, droppedCtx);";
    const source = fs.readFileSync(path, "utf8");
    if (source.split(needle).length !== 2) throw new Error("expected one serialized overflow notification call");
    fs.writeFileSync(path, source.replace(needle, "                // fixture removed required overflow notification"));
    const files = ["gateway/bootstrap.js", file, "transport/inbound.js", "transport/outbound.js", "transport/streaming-writer.js", "transport/outbound-buffer.js"];
    fs.writeFileSync("/data/.partial-concurrency-hashes", JSON.stringify(files.map(name => [name, crypto.createHash("sha256").update(fs.readFileSync(`${root}/${name}`)).digest("hex")])));
'
if docker run --rm --network none --volume "${partial_concurrency_data_volume}:/data" "$IMAGE" sh -ec 'true' >"$incompatible_log" 2>&1; then
    echo "partial concurrency policy unexpectedly started" >&2
    exit 1
fi
grep -Fq "serialized merge middleware, overflow notice, or ordering is incomplete" "$incompatible_log"
docker run --rm --network none --entrypoint node --volume "${partial_concurrency_data_volume}:/data" "$IMAGE" -e '
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    const root = "/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist";
    for (const [file, expected] of JSON.parse(fs.readFileSync("/data/.partial-concurrency-hashes", "utf8"))) {
        if (crypto.createHash("sha256").update(fs.readFileSync(`${root}/${file}`)).digest("hex") !== expected) throw new Error("fail-closed startup modified adapter files");
    }
'

log "Checking default /data model preferences and reset ID survive fresh containers"
for reset_probe in reset verify; do
    docker run --rm --network none --volume "${data_volume}:/data" \
        --mount "type=bind,src=${persistent_reset_probe},dst=/tmp/test-persistent-reset.mjs,readonly" \
        "$IMAGE" node /tmp/test-persistent-reset.mjs "$reset_probe"
done

log "Checking partial strict recovery markers fail closed without mutating profile files"
docker run --rm --network none --entrypoint sh --volume "${partial_recovery_data_volume}:/data" "$IMAGE" -ec '
    cp -a /opt/dsh-seed/. /data/
    : > /data/.initialized
'
docker run --rm --network none --entrypoint node --volume "${partial_recovery_data_volume}:/data" "$IMAGE" -e '
    const fs = require("node:fs");
    const root = "/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist";
    const path = `${root}/session/session-manager.js`;
    const source = fs.readFileSync(path, "utf8");
    const needle = "            try { recoveryOptions.onCommitted?.(record); } catch { }";
    if (source.split(needle).length !== 2) throw new Error("expected one strict committed callback");
    fs.writeFileSync(path, source.replace(needle, ""));
    const crypto = require("node:crypto");
    const files = ["session/session-manager.js", "transport/inbound.js", "transport/outbound.js"];
    fs.writeFileSync("/data/.partial-profile-hashes", JSON.stringify(files.map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(`${root}/${file}`)).digest("hex")])));
'
if docker run --rm --network none --volume "${partial_recovery_data_volume}:/data" "$IMAGE" true >"$incompatible_log" 2>&1; then
    echo "partial recovery policy unexpectedly started" >&2
    exit 1
fi
grep -Fq "strict session reset atomic commit ordering is incomplete" "$incompatible_log"
docker run --rm --network none --entrypoint node --volume "${partial_recovery_data_volume}:/data" "$IMAGE" -e '
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    const root = "/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist";
    for (const [file, expected] of JSON.parse(fs.readFileSync("/data/.partial-profile-hashes", "utf8"))) {
        if (crypto.createHash("sha256").update(fs.readFileSync(`${root}/${file}`)).digest("hex") !== expected) throw new Error("fail-closed startup modified adapter files");
    }
'

log "Checking strict policy upgrade on an unpatched legacy profile volume"
docker run --rm --network none --entrypoint sh --volume "${legacy_data_volume}:/data" "$IMAGE" -ec '
    cp -a /opt/dsh-seed/. /data/
    : > /data/.initialized
'
docker run --rm --network none --entrypoint node --volume "${legacy_data_volume}:/data" \
    --mount "type=bind,src=${pre_concurrency_fixture},dst=/tmp/prepare-pre-concurrency-fixture.mjs,readonly" \
    "$IMAGE" /tmp/prepare-pre-concurrency-fixture.mjs /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist
docker run --rm --network none --entrypoint node --volume "${legacy_data_volume}:/data" \
    --mount "type=bind,src=${pre_recovery_fixture},dst=/tmp/prepare-pre-recovery-fixture.mjs,readonly" \
    "$IMAGE" /tmp/prepare-pre-recovery-fixture.mjs /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist
docker run --rm --network none --entrypoint node --volume "${legacy_data_volume}:/data" "$IMAGE" -e '
    const fs = require("node:fs");
    const root = "/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist";
    const originalDownload = "    const resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });\n    if (!resp.ok)\n        throw new Error(`HTTP ${resp.status}`);\n    const buf = Buffer.from(await resp.arrayBuffer());\n    if (buf.length > maxBytes) {\n        throw new Error(`Download exceeds ${Math.floor(maxBytes / 1024 / 1024)}MB`);\n    }";
    const originalQuoteBlock = [
        "            // 引用消息附件：转成 RawAttachment 结构复用下载（voice 由 downloadMediaAttachments 自动跳过）",
        "            const quoteAttachments = ctx.state.quote?.attachments;",
        "            if (quoteAttachments && quoteAttachments.length > 0) {",
        "                const rawQuote = quoteAttachments",
        "                    .filter(a => a.url)",
        "                    .map((a) => ({",
        "                    content_type: a.contentType ?? \x27\x27,",
        "                    filename: a.filename ?? \x27\x27,",
        "                    size: 0,",
        "                    url: a.url,",
        "                }));",
        "                const downloadedQuote = await downloadMediaAttachments(rawQuote, config.media, logger);",
        "                ctx.state.downloadedQuoteFiles = downloadedQuote;",
        "            }",
    ].join("\n");
    const inboundPath = `${root}/transport/inbound.js`;
    const replaceExactlyOnce = (text, before, after, label) => {
        const parts = text.split(before);
        if (parts.length !== 2) throw new Error(`legacy fixture expected one ${label}`);
        return parts[0] + after + parts[1];
    };
    let inbound = fs.readFileSync(inboundPath, "utf8");
    if (inbound.includes("// Chat-only OneBot provenance v1.") || inbound.includes("onebotMetadata") || inbound.includes("let onebotTurn;")) {
        const onebotScopeImport = "import { beginOnebotTurn, endOnebotTurn, renderOnebotRequestMetadata } from '/opt/qqbot-defaults/qqbot-onebot-scope.mjs';\n";
        if (inbound.includes(onebotScopeImport)) inbound = replaceExactlyOnce(inbound, onebotScopeImport, "", "OneBot scope import");
        const onebotPolicyImport = "import { setCurrentImages, clearCurrentImages, isOnebotToolAvailable } from '/opt/qqbot-defaults/qqbot-chat-policy.mjs';";
        if (inbound.includes(onebotPolicyImport)) inbound = replaceExactlyOnce(inbound, onebotPolicyImport,
            "import { setCurrentImages, clearCurrentImages } from '/opt/qqbot-defaults/qqbot-chat-policy.mjs';", "OneBot availability import");
        const onebotBinding = [
            "        // Chat-only OneBot provenance v1.",
            "        if (isOnebotToolAvailable()) onebotTurn = beginOnebotTurn(",
            "            chatOnlyAgent,",
            "            getMergedGenerationRequests(ctx),",
            "            { appId: config.appId, signal: ctx.signal, isCurrentRecord, record, documentScope: documentTurn },",
            "        );",
            "        const onebotMetadata = onebotTurn ? renderOnebotRequestMetadata(onebotTurn) : '';",
        ].join("\n");
        if (inbound.includes(onebotBinding + "\n")) inbound = replaceExactlyOnce(inbound, onebotBinding + "\n", "", "OneBot turn binding");
        else if (inbound.includes("// Chat-only OneBot provenance v1.") || inbound.includes("onebotMetadata")) {
            throw new Error("legacy fixture found a partial OneBot request binding");
        }
        const withOnebotMetadata = "        const requestBody = [documentBody, generationMetadata, onebotMetadata].filter(Boolean).join(\x27\\n\\n\x27);";
        const withoutOnebotMetadata = "        const requestBody = [documentBody, generationMetadata].filter(Boolean).join(\x27\\n\\n\x27);";
        if (inbound.includes(withOnebotMetadata)) inbound = replaceExactlyOnce(inbound, withOnebotMetadata, withoutOnebotMetadata, "OneBot model body");
        const onebotCleanup = "                // Chat-only OneBot scope cleanup v1.\n                if (onebotTurn) await endOnebotTurn(chatOnlyAgent, onebotTurn);\n";
        if (inbound.includes(onebotCleanup)) inbound = replaceExactlyOnce(inbound, onebotCleanup, "", "OneBot scope cleanup");
        else if (inbound.includes("endOnebotTurn(chatOnlyAgent, onebotTurn)")) throw new Error("legacy fixture found a partial OneBot cleanup");
        if (inbound.includes("    let onebotTurn;\n")) inbound = replaceExactlyOnce(inbound, "    let onebotTurn;\n", "", "OneBot turn declaration");
    }
    if (inbound.includes("onebotTurn") || inbound.includes("onebotMetadata") || inbound.includes("OneBot provenance"))
        throw new Error("legacy fixture did not remove the OneBot scope");
    const documentScopeBlock = [
        "    const chatOnlyAgent = record.agent;",
        "    let documentTurn;",
        "    try {",
        "        const documentMetadata = beginDocumentTurn(chatOnlyAgent, msg, mwState.quote);",
        "        documentTurn = getDocumentTurn(chatOnlyAgent);",
        "        const documentBody = documentMetadata.length > 0",
        "            ? `${agentBody}\\n\\n[Untrusted QQ text attachments; use qqbot_read_document with one attachmentId only]\\n${JSON.stringify(documentMetadata)}`",
        "            : agentBody;",
        "        // Chat-only per-turn document scope v1.",
        "        const content = [{ type: \x27text\x27, text: documentBody }];",
    ].join("\n");
    if (inbound.split(documentScopeBlock).length !== 2) throw new Error("legacy fixture expected one document scope block");
    inbound = inbound.replace(documentScopeBlock, "    const content = [{ type: \x27text\x27, text: agentBody }];\n    const chatOnlyAgent = record.agent;");
    inbound = inbound.replace("import { beginDocumentTurn, endDocumentTurn, getDocumentTurn } from \x27/opt/qqbot-defaults/qqbot-document-scope.mjs\x27;\n", "");
    inbound = inbound.replace("        setCurrentImages(chatOnlyAgent, [...(mwState.downloadedFiles ?? []), ...(mwState.downloadedQuoteFiles ?? [])], documentTurn);",
        "    setCurrentImages(chatOnlyAgent, [...(mwState.downloadedFiles ?? []), ...(mwState.downloadedQuoteFiles ?? [])]);");
    const documentCleanup = [
        "        await chatOnlyAgent.whenIdle();",
        "    }",
        "    catch (err) {",
        "        logger.warn(`whenIdle/followup rejected: ${err instanceof Error ? err.message : String(err)}`);",
        "    } finally {",
        "        clearCurrentImages(chatOnlyAgent, documentTurn);",
        "        if (documentTurn) endDocumentTurn(chatOnlyAgent, documentTurn);",
        "    }",
    ].join("\n");
    if (inbound.split(documentCleanup).length !== 2) throw new Error("legacy fixture expected one document cleanup");
    inbound = inbound.replace(documentCleanup, [
        "    try {",
        "        await chatOnlyAgent.whenIdle();",
        "    }",
        "    catch (err) {",
        "        logger.warn(`whenIdle rejected: ${err instanceof Error ? err.message : String(err)}`);",
        "    } finally {",
        "        clearCurrentImages(chatOnlyAgent);",
        "    }",
    ].join("\n"));
    fs.writeFileSync(inboundPath, inbound);
    const edits = {
        "gateway/bootstrap.js": [
            ["import { installChatPolicy } from \x27/opt/qqbot-defaults/qqbot-chat-policy.mjs\x27;\n", ""],
            ["    installChatPolicy(ctx);\n", ""],
            ["    // Chat-only deployment: file sending is not registered.", "    registerSendFileTool(ctx, mediaSender, manager, config, logger);"]
        ],
        "gateway/middleware-setup.js": [
            ["import {createScopedQuoteRef} from \x27/opt/qqbot-defaults/qqbot-chat-policy.mjs\x27;\n", ""],
            ["    // Chat-only scoped quote references prevent cross-peer message-key collisions.\n", ""],
            ["    // Chat-only generation quote capture v1.\n", ""],
            ["    // Chat-only quoted attachment cache v2.\n", ""],
            ["import { createPendingImageCaptureMiddleware, createPendingImagePromptMiddleware, createPendingImageNewCommandCleanup } from \x27/opt/qqbot-defaults/qqbot-pending-images.mjs\x27;\n", ""],
            ["    // Chat-only deferred image prompts v1.\n", ""],
            ["    bot.use(createPendingImageCaptureMiddleware({ appId: config.appId }));\n", ""],
            ["    // Chat-only pending image /new cleanup v1.\n", ""],
            ["    bot.use(createPendingImageNewCommandCleanup({ appId: config.appId }));\n", ""],
            ["    // Chat-only deferred image prompt association v1.\n", ""],
            ["    bot.use(createPendingImagePromptMiddleware({ appId: config.appId }));\n", ""],
            ["import { createHistorySnapshotBuffer } from \x27/opt/qqbot-defaults/qqbot-history-snapshot.mjs\x27;\n", ""],
            ["    // Chat-only history snapshot epoch guard v1.\n", ""],
            ["bot.use(createHistorySnapshotBuffer(historyBuffer, {", "bot.use(historyBuffer({"],
            [
                [
                    "    bot.use(createScopedQuoteRef(quoteRef));",
                ].join("\n"),
                [
                    "    bot.use(quoteRef({",
                    "        maxSize: 500,",
                    "        preferMsgElements: true,",
                    "    }));",
                ].join("\n"),
            ],
        ],
        "index.js": [
            ["export const inject = [\x27agents\x27, \x27tools\x27, \x27web\x27, \x27systemPrompt\x27];", "export const inject = [\x27agents\x27];"],
            ["export const inject = [\x27agents\x27, \x27tools\x27, \x27web\x27];", "export const inject = [\x27agents\x27];"]
        ],
        "transport/inbound.js": [
            ["    // Chat-only explicit-quote text trigger v1.\n", ""],
            ["    if (isEmptyMessage(userContent, [...(msg.attachments ?? []), ...(state.quote?.attachments ?? [])], isGroup, wasMentioned))", "    if (isEmptyMessage(userContent, msg.attachments, isGroup, wasMentioned))"],
            ["import { setCurrentImages, clearCurrentImages } from \x27/opt/qqbot-defaults/qqbot-chat-policy.mjs\x27;\n", ""],
            ["    const chatOnlyAgent = record.agent;\n", ""],
            ["    // Chat-only current-and-quoted image scope v2.\n", ""],
            ["// Chat-only current-and-quoted image scope v2.\n", ""],
            ["    setCurrentImages(chatOnlyAgent, [...(mwState.downloadedFiles ?? []), ...(mwState.downloadedQuoteFiles ?? [])]);\n", ""],
            ["    setCurrentImages(chatOnlyAgent, mwState.downloadedFiles ?? []);\n", ""],
            ["    chatOnlyAgent.followup(message);", "    record.agent.followup(message);"],
            ["        await chatOnlyAgent.whenIdle();", "        await record.agent.whenIdle();"],
            ["    } finally {\n        clearCurrentImages(chatOnlyAgent);\n", ""]
        ],
        "transport/attachment.js": [
            ["import { downloadCurrentQQImage } from \x27/opt/qqbot-defaults/qqbot-web-pages.mjs\x27;\n", ""],
            ["import { downloadCurrentQQImage } from \x27/opt/qqbot-defaults/qqbot-chat-policy.mjs\x27;\n", ""],
            ["// Chat-only current-image downloads v3.\n", ""],
            ["    // Chat-only current-image downloads v3.\n", ""],
            ["    // Chat-only downloads: images only.\n", ""],
            ["    const targets = (attachments ?? []).filter(a => classifyContentType(a.content_type) === \x27image\x27 && a.url);", "    const targets = (attachments ?? []).filter(a => classifyContentType(a.content_type) !== \x27voice\x27 && a.url);"],
            ["    const buf = await downloadCurrentQQImage(parsed.href, maxBytes);", "    " + "const resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });\n    if (!resp.ok)\n        throw new Error(`HTTP ${resp.status}`);\n    const buf = Buffer.from(await resp.arrayBuffer());\n    if (buf.length > maxBytes) {\n        throw new Error(`Download exceeds ${Math.floor(maxBytes / 1024 / 1024)}MB`);\n    }"],
            ["    const resp = await fetch(parsed.href, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: \x27error\x27 });", "    const resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });"],
            ["    const chunks = [];\n    let total = 0;\n    for await (const chunk of resp.body) {\n        total += chunk.length;\n        if (total > maxBytes) throw new Error(\x27QQ image download exceeds size limit\x27);\n        chunks.push(chunk);\n    }\n    const buf = Buffer.concat(chunks, total);", "    const buf = Buffer.from(await resp.arrayBuffer());\n    if (buf.length > maxBytes) {\n        throw new Error(`Download exceeds ${Math.floor(maxBytes / 1024 / 1024)}MB`);\n    }"]
        ],
        "media/vision-tool.js": [["        timeoutMs: vision.timeoutMs,\n", ""]]
    };
    for (const [file, replacements] of Object.entries(edits)) {
        const path = `${root}/${file}`;
        let text = fs.readFileSync(path, "utf8");
        for (const [before, after] of replacements) {
            if (text.includes(before)) text = text.replace(before, after);
        }
        fs.writeFileSync(path, text);
    }
    const attachmentPath = `${root}/transport/attachment.js`;
    let attachmentSource = fs.readFileSync(attachmentPath, "utf8");
    const modernTargets = attachmentSource.split("\n").find((line) => line.includes("a.url && (classifyContentType"));
    if (!modernTargets) throw new Error("legacy fixture expected the v3 image fallback target selector");
    const apostrophe = String.fromCharCode(39);
    const legacyTargets = "    const targets = (attachments ?? []).filter(a => classifyContentType(a.content_type) !== "
        + apostrophe + "voice" + apostrophe + " && a.url);";
    attachmentSource = attachmentSource.replace(modernTargets, legacyTargets);
    const sourceUrlResult = "        results.push({ filename: att.filename, contentType, localPath, sourceUrl: att.url });";
    const sourceUrlPatch = "        // Chat-only attachment source URL v2.\n" + sourceUrlResult;
    if (attachmentSource.includes(sourceUrlPatch)) {
        attachmentSource = attachmentSource.replace(sourceUrlPatch,
            "        results.push({ filename: att.filename, contentType, localPath });");
    }
    else if (attachmentSource.includes("sourceUrl: att.url")
        || attachmentSource.includes("Chat-only attachment source URL v2.")) {
        throw new Error("legacy fixture found partial source URL provenance");
    }
    else if (!attachmentSource.includes("results.push({ filename: att.filename, contentType, localPath });")) {
        throw new Error("legacy fixture did not restore the stock attachment result shape");
    }
    fs.writeFileSync(attachmentPath, attachmentSource);
    const visionPath = `${root}/media/vision-tool.js`;
    let vision = fs.readFileSync(visionPath, "utf8");
    const visionImport = "import { existsSync, readFileSync, writeFileSync } from \x27node:fs\x27;\n";
    vision = replaceExactlyOnce(vision, visionImport,
        visionImport + "import { readFile, stat } from \x27node:fs/promises\x27;\n", "stock fs imports");
    vision = replaceExactlyOnce(vision,
        "import { loadChatImageBytes } from \x27/opt/qqbot-defaults/qqbot-chat-policy.mjs\x27;\n", "", "v3 helper import");
    const v3Description = [
        "// Chat-only image schema: scoped QQ media paths or public HTTPS image URLs v3.",
        "const DESCRIPTION = \x27Inspect one image and return the text the user needs. The image must be either an absolute path \x27",
        "    + \x27of an image attached to or explicitly quoted in the current QQ message and stored inside the QQ media directory, \x27",
        "    + \x27or a public HTTPS image URL. Other local paths, non-HTTPS URLs, and non-image files are forbidden. \x27",
        "    + \x27Use this when the user references an image, or when a task needs OCR, chart/diagram reading, screenshot or UI analysis, \x27",
        "    + \x27translation of image text, or photo understanding. Always pass an explicit `prompt` with a precise \x27",
        "    + \x27instruction (e.g. \"transcribe all text\", \"extract the table as CSV\", \"translate the text into Chinese\") \x27",
        "    + \x27instead of relying on the generic default.\x27;",
    ].join("\n");
    const v2Description = [
        "// Chat-only image schema: current and explicitly quoted QQ attachments v2.",
        "const DESCRIPTION = \x27Inspect one image and return the text the user needs. The image must be an absolute path \x27",
        "    + \x27of an image attached to or explicitly quoted in the current QQ message. URLs and other files are forbidden. \x27",
        "    + \x27Use this when the user references an image, or when a task needs OCR, chart/diagram reading, screenshot or UI analysis, \x27",
        "    + \x27translation of image text, or photo understanding. Always pass an explicit `prompt` with a precise \x27",
        "    + \x27instruction (e.g. \"transcribe all text\", \"extract the table as CSV\", \"translate the text into Chinese\") \x27",
        "    + \x27instead of relying on the generic default.\x27;",
    ].join("\n");
    vision = replaceExactlyOnce(vision, v3Description, v2Description, "v3 schema description");
    vision = replaceExactlyOnce(vision,
        "                    description: \x27Absolute path of a current-message or explicitly quoted image inside the QQ media directory, or a public HTTPS image URL.\x27,",
        "                    description: \x27Absolute path of an image attached to or explicitly quoted in the current QQ message. URLs and other files are forbidden.\x27,",
        "v3 image parameter description");
    const v3Loader = [
        "// Chat-only scoped image loader v3.",
        "async function loadImageBytes(image, maxBytes, exec) {",
        "    const data = await loadChatImageBytes(image, maxBytes, exec);",
        "    const mediaType = sniffImageMediaType(data);",
        "    if (mediaType === null)",
        "        throw new Error(\x27qqbot_describe_image: unrecognized image format (png/jpeg/gif/webp only)\x27);",
        "    return { data, mediaType };",
        "}",
    ].join("\n");
    const stockLoader = [
        "/** 加载图片字节（本地路径 / http URL），校验大小 + 嗅探 MIME */",
        "async function loadImageBytes(image, maxBytes, signal) {",
        "    let data;",
        "    if (/^https?:\\/\\//i.test(image)) {",
        "        const resp = await fetch(image, { signal, redirect: \x27error\x27 });",
        "        if (!resp.ok)",
        "            throw new Error(`qqbot_describe_image: download failed (HTTP ${resp.status})`);",
        "        const buf = Buffer.from(await resp.arrayBuffer());",
        "        if (buf.length > maxBytes)",
        "            throw new Error(`qqbot_describe_image: image too large (${buf.length} bytes)`);",
        "        data = new Uint8Array(buf);",
        "    }",
        "    else {",
        "        const info = await stat(image).catch(() => null);",
        "        if (!info?.isFile())",
        "            throw new Error(`qqbot_describe_image: image file not found: ${image}`);",
        "        if (info.size > maxBytes)",
        "            throw new Error(`qqbot_describe_image: image too large (${info.size} bytes)`);",
        "        data = new Uint8Array(await readFile(image));",
        "    }",
        "    const mediaType = sniffImageMediaType(data);",
        "    if (mediaType === null)",
        "        throw new Error(\x27qqbot_describe_image: unrecognized image format (png/jpeg/gif/webp only)\x27);",
        "    return { data, mediaType };",
        "}",
    ].join("\n");
    vision = replaceExactlyOnce(vision, v3Loader, stockLoader, "v3 image loader");
    vision = replaceExactlyOnce(vision,
        "loadImageBytes(image, vision.maxBytes, exec)",
        "loadImageBytes(image, vision.maxBytes, exec.signal)", "v3 execute argument");
    fs.writeFileSync(visionPath, vision);
    const middlewarePath = `${root}/middleware/attachment.js`;
    let middleware = fs.readFileSync(middlewarePath, "utf8");
    const quoteMarker = "            // Chat-only quoted-image downloads v2.\n";
    const patchedQuote = "            // Chat-only quote attachments: never downloaded.\n            // Keep quote text/metadata available to the conversation, but only current-message images may enter the cache.\n            ctx.state.downloadedQuoteFiles = [];";
    if (middleware.includes("// Chat-only lazy quoted images v1.")) {
        const start = middleware.indexOf(quoteMarker);
        const end = middleware.indexOf("\n        }\n        catch (err)", start);
        if (start < 0 || end < start) throw new Error("legacy fixture expected the lazy quote block");
        middleware = middleware.slice(0, start) + originalQuoteBlock + middleware.slice(end);
        fs.writeFileSync(middlewarePath, middleware);
    }
    else if (middleware.includes(quoteMarker)) {
        middleware = middleware.replace(quoteMarker, "");
        fs.writeFileSync(middlewarePath, middleware);
    }
    else if (middleware.includes(patchedQuote)) {
        middleware = middleware.replace(patchedQuote, originalQuoteBlock);
        fs.writeFileSync(middlewarePath, middleware);
    }
    const mediaCleanerPath = `${root}/media/media-cleaner.js`;
    let mediaCleaner = fs.readFileSync(mediaCleanerPath, "utf8");
    mediaCleaner = replaceExactlyOnce(mediaCleaner,
        "// Chat-only persistent media root v1.\nexport const MEDIA_ROOT = \x27/data/qqbot-media\x27;",
        "export const MEDIA_ROOT = resolve(homedir(), \x27.dsh-qqbot\x27, \x27media\x27);",
        "persistent media root");
    mediaCleaner = replaceExactlyOnce(mediaCleaner,
        "import { join } from \x27node:path\x27;\n",
        "import { join, resolve } from \x27node:path\x27;\n",
        "media cleaner path import");
    mediaCleaner = replaceExactlyOnce(mediaCleaner,
        "import { join, resolve } from \x27node:path\x27;\n",
        "import { join, resolve } from \x27node:path\x27;\nimport { homedir } from \x27node:os\x27;\n",
        "legacy media cleaner os import");
    fs.writeFileSync(mediaCleanerPath, mediaCleaner);
    if (!mediaCleaner.includes("export const MEDIA_ROOT = resolve(homedir(), \x27.dsh-qqbot\x27, \x27media\x27);")
        || !mediaCleaner.includes("import { join, resolve } from \x27node:path\x27;")
        || !mediaCleaner.includes("import { homedir } from \x27node:os\x27;")
        || mediaCleaner.includes("Chat-only persistent media root v1.")) {
        throw new Error("legacy fixture did not restore the original media root");
    }
    const legacyMarkers = [
        ["gateway/bootstrap.js", "installChatPolicy"],
        ["gateway/bootstrap.js", "Chat-only deployment: file sending is not registered."],
        ["gateway/middleware-setup.js", "createScopedQuoteRef"],
        ["gateway/middleware-setup.js", "Chat-only scoped quote references prevent cross-peer message-key collisions."],
        ["gateway/middleware-setup.js", "createHistorySnapshotBuffer"],
        ["gateway/middleware-setup.js", "Chat-only history snapshot epoch guard v1."],
        ["gateway/middleware-setup.js", "createPendingImageCaptureMiddleware"],
        ["gateway/middleware-setup.js", "createPendingImageNewCommandCleanup"],
        ["gateway/middleware-setup.js", "createPendingImagePromptMiddleware"],
        ["gateway/middleware-setup.js", "Chat-only deferred image prompts v1."],
        ["gateway/middleware-setup.js", "Chat-only pending image /new cleanup v1."],
        ["gateway/middleware-setup.js", "Chat-only deferred image prompt association v1."],
        ["index.js", "export const inject = [\x27agents\x27, \x27tools\x27, \x27web\x27, \x27systemPrompt\x27];"],
        ["transport/inbound.js", "Chat-only current-and-quoted image scope v2."],
        ["transport/inbound.js", "Chat-only per-turn document scope v1."],
        ["transport/inbound.js", "Chat-only explicit-quote text trigger v1."],
        ["transport/inbound.js", "beginDocumentTurn"],
        ["transport/inbound.js", "endDocumentTurn"],
        ["transport/inbound.js", "setCurrentImages"],
        ["transport/inbound.js", "clearCurrentImages"],
        ["transport/attachment.js", "downloadCurrentQQImage"],
        ["transport/attachment.js", "Chat-only current-image downloads v3."],
        ["transport/attachment.js", "Chat-only attachment source URL v2."],
        ["transport/attachment.js", "sourceUrl: att.url"],
        ["transport/attachment.js", "a.url && (classifyContentType"],
        ["middleware/attachment.js", "Chat-only quoted-image downloads v2."],
        ["media/vision-tool.js", "timeoutMs: vision.timeoutMs"],
        ["media/vision-tool.js", "loadChatImageBytes"],
        ["media/vision-tool.js", "Chat-only scoped image loader v3."],
        ["media/vision-tool.js", "scoped QQ media paths or public HTTPS image URLs v3."],
        ["media/media-cleaner.js", "Chat-only persistent media root v1."]
    ];
    const restoredAttachment = fs.readFileSync(root + "/transport/attachment.js", "utf8");
    if (!restoredAttachment.includes("classifyContentType(a.content_type) !== \x27voice\x27 && a.url")) {
        throw new Error("legacy fixture did not restore the original non-voice attachment target selector");
    }
    for (const [file, marker] of legacyMarkers) {
        if (fs.readFileSync(`${root}/${file}`, "utf8").includes(marker)) throw new Error(`legacy fixture still patched: ${file}`);
    }
    const restoredVision = fs.readFileSync(visionPath, "utf8");
    if (!restoredVision.includes("async function loadImageBytes(image, maxBytes, signal)")
        || !restoredVision.includes("loadImageBytes(image, vision.maxBytes, exec.signal)")
        || !restoredVision.includes("Chat-only image schema: current and explicitly quoted QQ attachments v2.")) {
        throw new Error("legacy fixture did not restore the original loader and v2 schema");
    }
'
docker run --rm \
    --network none \
    --volume "${legacy_data_volume}:/data" \
    --mount "type=bind,src=${chat_policy_test},dst=/tmp/test-chat-policy.mjs,readonly" \
    --mount "type=bind,src=${group_history_test},dst=/tmp/test-group-history.mjs,readonly" \
    "$IMAGE" \
    sh -ec '
    test -f /data/.initialized
    for file in \
        gateway/bootstrap.js \
        gateway/middleware-setup.js \
        index.js \
        transport/inbound.js \
        transport/attachment.js \
        middleware/attachment.js \
        media/vision-tool.js \
        media/media-cleaner.js; do
        node --check "/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/$file"
    done
    grep -Fq "import { installChatPolicy } from '\''/opt/qqbot-defaults/qqbot-chat-policy.mjs'\'';" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/gateway/bootstrap.js
    grep -Fq "import {createScopedQuoteRef} from '\''/opt/qqbot-defaults/qqbot-chat-policy.mjs'\'';" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/gateway/middleware-setup.js
    grep -Fq "bot.use(createScopedQuoteRef(quoteRef));" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/gateway/middleware-setup.js
    grep -Fq "import { createHistorySnapshotBuffer } from '\''/opt/qqbot-defaults/qqbot-history-snapshot.mjs'\'';" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/gateway/middleware-setup.js
    grep -Fq "bot.use(createHistorySnapshotBuffer(historyBuffer, {" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/gateway/middleware-setup.js
    grep -Fq "Chat-only current-image downloads v3." /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/transport/attachment.js
    grep -Fq "Chat-only quoted-image downloads v2." /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/middleware/attachment.js
    grep -Fq "timeoutMs: vision.timeoutMs" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/media/vision-tool.js
    grep -Fq "import { loadChatImageBytes } from '\''/opt/qqbot-defaults/qqbot-chat-policy.mjs'\'';" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/media/vision-tool.js
    grep -Fq "Chat-only scoped image loader v3." /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/media/vision-tool.js
    grep -Fq "loadImageBytes(image, vision.maxBytes, exec)" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/media/vision-tool.js
    grep -Fq "// Chat-only persistent media root v1." /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/media/media-cleaner.js
    grep -Fq "export const MEDIA_ROOT = '\''/data/qqbot-media'\'';" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/media/media-cleaner.js
    node --test /tmp/test-chat-policy.mjs
    QQBOT_HISTORY_SNAPSHOT_MODULE=/opt/qqbot-defaults/qqbot-history-snapshot.mjs node --test /tmp/test-group-history.mjs
'

log "Checking incompatible QQ plugin version fails closed"
docker run --rm --network none --entrypoint sh --volume "${incompatible_data_volume}:/data" "$IMAGE" -ec '
    cp -a /opt/dsh-seed/. /data/
    : > /data/.initialized
'
docker run --rm --network none --entrypoint node --volume "${incompatible_data_volume}:/data" "$IMAGE" -e '
    const fs = require("node:fs");
    const path = "/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/package.json";
    const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
    manifest.version = "0.4.9";
    fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
'
if docker run --rm --network none --volume "${incompatible_data_volume}:/data" "$IMAGE" sh -ec 'true' >"$incompatible_log" 2>&1; then
    cat "$incompatible_log" >&2
    echo "incompatible plugin unexpectedly started" >&2
    exit 1
fi
grep -Fq "Chat-only patches require dsh-qqbot 0.5.0" "$incompatible_log"

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

log "Passed: seed, profile, plugin, workspace, persistence, config policy, chat/document regression, and image secret scan"
