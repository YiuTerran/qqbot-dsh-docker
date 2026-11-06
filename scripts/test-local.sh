#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-dsh-qqbot:test-local}"
repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
chat_policy_test="${repo_root}/scripts/test-chat-policy.mjs"
model_context_test="${repo_root}/scripts/test-model-context.mjs"
group_history_test="${repo_root}/scripts/test-group-history.mjs"
recovery_policy_test="${repo_root}/scripts/test-session-recovery.mjs"
provider_errors_test="${repo_root}/scripts/test-provider-errors.mjs"
deepseek_status_test="${repo_root}/scripts/test-deepseek-status.mjs"
concurrency_test="${repo_root}/scripts/test-concurrency.mjs"
generation_test="${repo_root}/scripts/test-generation.mjs"
recent_image_generation_test="${repo_root}/scripts/test-recent-image-generation.mjs"
generation_scope_test="${repo_root}/scripts/test-generation-scope.mjs"
generation_quota_test="${repo_root}/scripts/test-generation-quotas.mjs"
pending_images_test="${repo_root}/scripts/test-pending-images.mjs"
pending_images_native_test="${repo_root}/scripts/test-pending-images-native.mjs"
memory_images_test="${repo_root}/scripts/test-memory-images.mjs"
onebot_native_test="${repo_root}/scripts/test-onebot-native.mjs"
onebot_log_test="${repo_root}/scripts/test-onebot-log.mjs"
onebot_direct_test="${repo_root}/scripts/test-onebot-direct.mjs"
sealdice_policy_test="${repo_root}/scripts/test-sealdice-policy.mjs"
sealdice_policy_fixture="${repo_root}/third_party/sealdice-core/dice/testdata/onebot-bridge-policy.json"
onebot_direct_native_test="${repo_root}/scripts/test-onebot-direct-native.mjs"
mention_text_test="${repo_root}/scripts/test-qqbot-mention-text.mjs"
mention_text_module="${repo_root}/defaults/qqbot-mention-text.mjs"
pending_images_module="${repo_root}/defaults/qqbot-pending-images.mjs"
sealdice_policy_module="${repo_root}/defaults/qqbot-sealdice-policy.mjs"
onebot_scope_module="${repo_root}/defaults/qqbot-onebot-scope.mjs"
enforcer_script="${repo_root}/scripts/enforce-chat-only.mjs"
recovery_upgrade_test="${repo_root}/scripts/test-recovery-upgrade.mjs"
questions_test="${repo_root}/scripts/test-questions.mjs"
questions_native_test="${repo_root}/scripts/test-questions-native.mjs"
pre_recovery_fixture="${repo_root}/scripts/prepare-pre-recovery-fixture.mjs"
pre_concurrency_fixture="${repo_root}/scripts/prepare-pre-concurrency-fixture.mjs"
previous_stock_agents_fixture="${repo_root}/scripts/fixtures/agents-v0.9.0-stock.md"
previous_stock_agents_v0_10_fixture="${repo_root}/scripts/fixtures/agents-v0.10.0-stock.md"
previous_stock_agents_v0_10_3_fixture="${repo_root}/scripts/fixtures/agents-v0.10.3-stock.md"
previous_stock_agents_v0_11_fixture="${repo_root}/scripts/fixtures/agents-v0.11.0-stock.md"
previous_stock_agents_v0_11_1_fixture="${repo_root}/scripts/fixtures/agents-v0.11.1-stock.md"
previous_stock_agents_v0_11_2_fixture="${repo_root}/scripts/fixtures/agents-v0.11.2-stock.md"
previous_stock_agents_v0_12_2_fixture="${repo_root}/scripts/fixtures/agents-v0.12.2-stock.md"
previous_stock_agents_v0_12_5_fixture="${repo_root}/scripts/fixtures/agents-v0.12.5-stock.md"
previous_stock_agents_v0_12_8_fixture="${repo_root}/scripts/fixtures/agents-v0.12.8-stock.md"
previous_stock_agents_v0_12_9_fixture="${repo_root}/scripts/fixtures/agents-v0.12.9-stock.md"
previous_stock_agents_v0_13_1_fixture="${repo_root}/scripts/fixtures/agents-v0.13.1-stock.md"
previous_stock_agents_v0_14_0_fixture="${repo_root}/scripts/fixtures/agents-v0.14.0-stock.md"
previous_stock_agents_v0_14_1_fixture="${repo_root}/scripts/fixtures/agents-v0.14.1-stock.md"
previous_stock_agents_v0_14_2_fixture="${repo_root}/scripts/fixtures/agents-v0.14.2-stock.md"
previous_stock_agents_v0_15_0_fixture="${repo_root}/scripts/fixtures/agents-v0.15.0-stock.md"
previous_stock_agents_v0_16_0_fixture="${repo_root}/scripts/fixtures/agents-v0.16.0-stock.md"
legacy_stock_agents_fixtures=(
    "${repo_root}/scripts/fixtures/agents-v0.18.2-stock.md"
    "${repo_root}/scripts/fixtures/agents-v0.18.0-stock.md"
    "${repo_root}/scripts/fixtures/agents-v0.17.0-stock.md"
    "${repo_root}/scripts/fixtures/agents-v0.16.1-stock.md"
    "${repo_root}/scripts/fixtures/agents-legacy-v0.3.0-stock.md"
    "${repo_root}/scripts/fixtures/agents-legacy-v0.3.1-stock.md"
    "${repo_root}/scripts/fixtures/agents-legacy-v0.3.10-stock.md"
    "${repo_root}/scripts/fixtures/agents-legacy-v0.3.8-stock.md"
    "${repo_root}/scripts/fixtures/agents-legacy-v0.4.0-stock.md"
    "${repo_root}/scripts/fixtures/agents-legacy-v0.4.1-stock.md"
    "${repo_root}/scripts/fixtures/agents-legacy-v0.5.0-stock.md"
    "${repo_root}/scripts/fixtures/agents-legacy-v0.6.0-stock.md"
    "${repo_root}/scripts/fixtures/agents-legacy-v0.7.0-stock.md"
    "${repo_root}/scripts/fixtures/agents-legacy-v0.7.3-stock.md"
    "${repo_root}/scripts/fixtures/agents-legacy-v0.7.6-stock.md"
    "${repo_root}/scripts/fixtures/agents-legacy-v0.7.7-stock.md"
    "${repo_root}/scripts/fixtures/agents-legacy-v0.7.8-stock.md"
    "${repo_root}/scripts/fixtures/agents-legacy-v0.8.0-stock.md"
    "${repo_root}/scripts/fixtures/agents-v0.12.9-stock.md"
    "${repo_root}/scripts/fixtures/agents-v0.12.10-stock.md"
    "${repo_root}/scripts/fixtures/agents-v0.12.10-pre-selfportrait-stock.md"
    "${repo_root}/scripts/fixtures/agents-v0.13.0-stock.md"
    "${repo_root}/scripts/fixtures/agents-v0.13.1-stock.md"
    "${repo_root}/scripts/fixtures/agents-v0.14.0-stock.md"
    "${repo_root}/scripts/fixtures/agents-v0.14.1-stock.md"
    "${repo_root}/scripts/fixtures/agents-v0.14.2-stock.md"
    "${repo_root}/scripts/fixtures/agents-v0.15.0-stock.md"
    "${repo_root}/scripts/fixtures/agents-v0.16.0-stock.md"
)
legacy_stock_agents_hashes=(
    a77b4f53d57c32234fd1b130a23b9c5d2674e8a4e576e72e596bd1bd792c6478
    ccbedd1e3662b22f16c80e8c7f5446d0175fac618eb7ce458691feeb675615e6
    1331ab3c6a3430a764f663f4bb82c19e42f80d647c639ceaf3a8db1bd05c856e
    af89bfbe1b1892d0d082fdf7de011fd63f41e38e80e76bec713896148dabd252
    c249259a60d4b04c9c9c3df1a92977adf748ba4143a3639c3e85a006ad802ef5
    9101cd863b9973e3ce7210e3d2f4e17fa23d8238564d463c18207fcf1622688d
    c1240f192f24ab877e30a5314bbaa5cb0f84856a16e2561fbf00c5040cf6f2d9
    aff7450858c1c0803ce1e290a682ce86d1f80e985f792da6a4a5eb2c3aeb14ae
    4004715b3a57d107e20261a556123e2a1500a41c1f4641758a6a31ae3a4abbe3
    b50f70c835f04501c8fb3991d4bb1c07700144910955da7de01ac87d06947f64
    561ad14f612852bf0cecd80fd5abd5a0fab0f5d7e1092d29a77c23ec761f8545
    31bc14c8a383f7acd9741a7f341f5ccb59c52b6e8cf8ae5aee47b84050984dd7
    9c3528a07dad1af2e6880420174b0d85873052c33f3ed605a970dbb645ddb64f
    a0951cf6b164b83e708ca36e6bf9dcd8f1aa637f32602de544ae8f9e4039e5e8
    f8b0cd832ad0ba81f693538e2958b92ef589e66b695870113a458614607575b0
    f71d8a3a4f3f191f141e759ba7806457444387d1dd7cbbde23486633a982b88e
    34e4892a0caceff87f54091f358eeabc26bd42fd02a2e98cd371f3264a34bcb4
    a38a9940dee2fe8183f1192a7996e84abf12deccf6b9185e581aa3b1db79da5a
    d8212769d26825832637a4522476c8623a7dd8ceaf7d1bedf05efac0d7bd3e8c
    ed63c35f9a171136374d81a5e99a3d0b48a5303afcfa4443b09164d8126579df
    53cb71cc3832cd6da1b20c9226370143afe384f4e6796893c2d7a8e7d2f3934d
    744b144ac1027820829b8c053d2a23e4396042fd88d5eab873285acb84ab6f9d
    68e05983a4bc0615bcf04c36362ebe8818995eb8e1ebbbb696c711f107829f11
    f88404f2950486567a0cc1a347abbb650cacb141ede49a80ddcee1d5e9338135
    e95de832302aae41874d2f076e4678fa8f3e84450a7a7fe1a07f3d8113781738
    c1fc913722d9b620c36ab245a2424e119035dcfa07e17d8f89127d4338d1276e
    2bfb225fe636f01df3a7ba285e27b93d99ad259563eea7beebd3f8c0329b3162
    d5a7a275a94e951b9d5e2dd4c516ba9ed780c570484e5ded2384c0de8b33c689
)
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
search_fallback_data_volume="dsh-qqbot-test-search-fallback-data-${suffix}"
partial_recovery_data_volume="dsh-qqbot-test-partial-recovery-data-${suffix}"
recovery_v1_data_volume="dsh-qqbot-test-recovery-v1-data-${suffix}"
pre_concurrency_data_volume="dsh-qqbot-test-pre-concurrency-data-${suffix}"
partial_concurrency_data_volume="dsh-qqbot-test-partial-concurrency-data-${suffix}"
stock_agents_data_volume="dsh-qqbot-test-stock-agents-data-${suffix}"
readonly_stock_agents_data_volume="dsh-qqbot-test-readonly-stock-agents-data-${suffix}"
stock_agents_v0_10_data_volume="dsh-qqbot-test-stock-agents-v0-10-data-${suffix}"
readonly_stock_agents_v0_10_data_volume="dsh-qqbot-test-readonly-stock-agents-v0-10-data-${suffix}"
symlink_stock_agents_data_volume="dsh-qqbot-test-symlink-stock-agents-data-${suffix}"
container="dsh-qqbot-test-${suffix}"
instructions_file="$(mktemp)"
custom_stock_agents_file="$(mktemp)"
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
    docker volume rm "$data_volume" "$workspace_volume" "$override_data_volume" "$legacy_data_volume" "$dice_legacy_data_volume" "$incompatible_data_volume" "$media_guard_data_volume" "$search_env_data_volume" "$official_data_volume" "$search_fallback_data_volume" "$partial_recovery_data_volume" "$recovery_v1_data_volume" "$pre_concurrency_data_volume" "$partial_concurrency_data_volume" "$stock_agents_data_volume" "$readonly_stock_agents_data_volume" "$stock_agents_v0_10_data_volume" "$readonly_stock_agents_v0_10_data_volume" "$symlink_stock_agents_data_volume" >/dev/null 2>&1 || true
    rm -f "$instructions_file"
    rm -f "$custom_stock_agents_file"
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
expected_v0_9_stock_agents_sha256=fab8af8ab708ab6103eaea6093c682a069f8289f44f73605b849064ff474bdd9
actual_v0_9_stock_agents_sha256="$(sha256sum "$previous_stock_agents_fixture" | cut -d ' ' -f 1)"
if [[ "$actual_v0_9_stock_agents_sha256" != "$expected_v0_9_stock_agents_sha256" ]]; then
    echo "unexpected v0.9.0 stock AGENTS.md fixture hash: $actual_v0_9_stock_agents_sha256" >&2
    exit 1
fi
if [[ ! -r "$previous_stock_agents_v0_12_5_fixture" ]]; then
    echo "missing previous stock AGENTS.md fixture: $previous_stock_agents_v0_12_5_fixture" >&2
    exit 1
fi
if [[ ! -r "$previous_stock_agents_v0_12_8_fixture" ]]; then
    echo "missing previous stock AGENTS.md fixture: $previous_stock_agents_v0_12_8_fixture" >&2
    exit 1
fi
if [[ ! -r "$previous_stock_agents_v0_12_9_fixture" ]]; then
    echo "missing previous stock AGENTS.md fixture: $previous_stock_agents_v0_12_9_fixture" >&2
    exit 1
fi
if [[ ! -r "$previous_stock_agents_v0_13_1_fixture" ]]; then
    echo "missing previous stock AGENTS.md fixture: $previous_stock_agents_v0_13_1_fixture" >&2
    exit 1
fi
if [[ ! -r "$previous_stock_agents_v0_14_0_fixture" ]]; then
    echo "missing previous stock AGENTS.md fixture: $previous_stock_agents_v0_14_0_fixture" >&2
    exit 1
fi
if [[ ! -r "$previous_stock_agents_v0_14_1_fixture" ]]; then
    echo "missing previous stock AGENTS.md fixture: $previous_stock_agents_v0_14_1_fixture" >&2
    exit 1
fi
if [[ ! -r "$previous_stock_agents_v0_15_0_fixture" ]]; then
    echo "missing previous stock AGENTS.md fixture: $previous_stock_agents_v0_15_0_fixture" >&2
    exit 1
fi
if [[ ! -r "$previous_stock_agents_v0_16_0_fixture" ]]; then
    echo "missing previous stock AGENTS.md fixture: $previous_stock_agents_v0_16_0_fixture" >&2
    exit 1
fi

expected_v0_13_1_stock_agents_sha256=68e05983a4bc0615bcf04c36362ebe8818995eb8e1ebbbb696c711f107829f11
actual_v0_13_1_stock_agents_sha256="$(sha256sum "$previous_stock_agents_v0_13_1_fixture" | cut -d ' ' -f 1)"
if [[ "$actual_v0_13_1_stock_agents_sha256" != "$expected_v0_13_1_stock_agents_sha256" ]]; then
    echo "unexpected v0.13.1 stock AGENTS.md fixture hash: $actual_v0_13_1_stock_agents_sha256" >&2
    exit 1
fi

expected_v0_14_0_stock_agents_sha256=f88404f2950486567a0cc1a347abbb650cacb141ede49a80ddcee1d5e9338135
actual_v0_14_0_stock_agents_sha256="$(sha256sum "$previous_stock_agents_v0_14_0_fixture" | cut -d ' ' -f 1)"
if [[ "$actual_v0_14_0_stock_agents_sha256" != "$expected_v0_14_0_stock_agents_sha256" ]]; then
    echo "unexpected v0.14.0 stock AGENTS.md fixture hash: $actual_v0_14_0_stock_agents_sha256" >&2
    exit 1
fi

expected_v0_14_1_stock_agents_sha256=e95de832302aae41874d2f076e4678fa8f3e84450a7a7fe1a07f3d8113781738
actual_v0_14_1_stock_agents_sha256="$(sha256sum "$previous_stock_agents_v0_14_1_fixture" | cut -d ' ' -f 1)"
if [[ "$actual_v0_14_1_stock_agents_sha256" != "$expected_v0_14_1_stock_agents_sha256" ]]; then
    echo "unexpected v0.14.1 stock AGENTS.md fixture hash: $actual_v0_14_1_stock_agents_sha256" >&2
    exit 1
fi

expected_v0_14_2_stock_agents_sha256=c1fc913722d9b620c36ab245a2424e119035dcfa07e17d8f89127d4338d1276e
actual_v0_14_2_stock_agents_sha256="$(sha256sum "$previous_stock_agents_v0_14_2_fixture" | cut -d ' ' -f 1)"
if [[ "$actual_v0_14_2_stock_agents_sha256" != "$expected_v0_14_2_stock_agents_sha256" ]]; then
    echo "unexpected v0.14.2 stock AGENTS.md fixture hash: $actual_v0_14_2_stock_agents_sha256" >&2
    exit 1
fi

expected_v0_15_0_stock_agents_sha256=2bfb225fe636f01df3a7ba285e27b93d99ad259563eea7beebd3f8c0329b3162
actual_v0_15_0_stock_agents_sha256="$(sha256sum "$previous_stock_agents_v0_15_0_fixture" | cut -d ' ' -f 1)"
if [[ "$actual_v0_15_0_stock_agents_sha256" != "$expected_v0_15_0_stock_agents_sha256" ]]; then
    echo "unexpected v0.15.0 stock AGENTS.md fixture hash: $actual_v0_15_0_stock_agents_sha256" >&2
    exit 1
fi

expected_v0_16_0_stock_agents_sha256=d5a7a275a94e951b9d5e2dd4c516ba9ed780c570484e5ded2384c0de8b33c689
actual_v0_16_0_stock_agents_sha256="$(sha256sum "$previous_stock_agents_v0_16_0_fixture" | cut -d ' ' -f 1)"
if [[ "$actual_v0_16_0_stock_agents_sha256" != "$expected_v0_16_0_stock_agents_sha256" ]]; then
    echo "unexpected v0.16.0 stock AGENTS.md fixture hash: $actual_v0_16_0_stock_agents_sha256" >&2
    exit 1
fi

expected_v0_12_8_stock_agents_sha256=1b917f9daca010d80b69185a9b4b6d7bb89792a26ae2ac79deb09647aa9c0235
actual_v0_12_8_stock_agents_sha256="$(sha256sum "$previous_stock_agents_v0_12_8_fixture" | cut -d ' ' -f 1)"
if [[ "$actual_v0_12_8_stock_agents_sha256" != "$expected_v0_12_8_stock_agents_sha256" ]]; then
    echo "unexpected v0.12.8 stock AGENTS.md fixture hash: $actual_v0_12_8_stock_agents_sha256" >&2
    exit 1
fi

for legacy_stock_agents_index in "${!legacy_stock_agents_fixtures[@]}"; do
    legacy_stock_agents_fixture="${legacy_stock_agents_fixtures[$legacy_stock_agents_index]}"
    expected_legacy_stock_agents_sha256="${legacy_stock_agents_hashes[$legacy_stock_agents_index]}"
    if [[ ! -r "$legacy_stock_agents_fixture" ]]; then
        echo "missing legacy stock AGENTS.md fixture: $legacy_stock_agents_fixture" >&2
        exit 66
    fi
    actual_legacy_stock_agents_sha256="$(sha256sum "$legacy_stock_agents_fixture" | cut -d ' ' -f 1)"
    if [[ "$actual_legacy_stock_agents_sha256" != "$expected_legacy_stock_agents_sha256" ]]; then
        echo "unexpected legacy stock AGENTS.md fixture hash for $legacy_stock_agents_fixture: $actual_legacy_stock_agents_sha256" >&2
        exit 1
    fi
done

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

if [[ ! -r "$deepseek_status_test" ]]; then
    echo "missing DeepSeek status regression script: $deepseek_status_test" >&2
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

if [[ ! -r "$mention_text_test" || ! -r "$mention_text_module" || ! -r "$pending_images_module" \
    || ! -r "$sealdice_policy_module" || ! -r "$onebot_scope_module" || ! -r "$enforcer_script" ]]; then
    echo "missing current-event mention normalization regression inputs" >&2
    exit 66
fi

if [[ ! -r "$recovery_upgrade_test" ]]; then
    echo "missing recovery upgrade regression script: $recovery_upgrade_test" >&2
    exit 66
fi

if [[ ! -r "$questions_test" ]]; then
    echo "missing question tool regression script: $questions_test" >&2
    exit 66
fi

if [[ ! -r "$questions_native_test" ]]; then
    echo "missing native question delivery regression script: $questions_native_test" >&2
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
docker volume create "$search_fallback_data_volume" >/dev/null
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
    "official route uses independent search credentials without changing chat mode" \
    "$official_data_volume" \
    "https://api.deepseek.com/anthropic/v1" \
    --env DEEPSEEK_API_KEY=fixture-official-key \
    --env LLM_SEARCH_API_KEY=fixture-official-search-key \
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
    --env LLM_SEARCH_API_KEY=fixture-search-key \
    --env LLM_SEARCH_BASE_URL=https://search-gateway.example.com/anthropic/v1 \
    --env LLM_SEARCH_MODEL=fixture-third-party-search-model
run_profile_probe \
    "third-party route falls back to chat credentials when search key is absent" \
    "$search_fallback_data_volume" \
    "https://chat-gateway.example.com/v1" \
    --env LLM_PROVIDER=fixture-chat \
    --env LLM_MODEL=fixture-chat-model \
    --env LLM_API_BASE_URL=https://chat-gateway.example.com/v1 \
    --env LLM_API_PROTOCOL=openai-responses \
    --env LLM_API_KEY=fixture-chat-key
run_profile_probe \
    "third-party route adds independent search credentials on the same volume" \
    "$search_fallback_data_volume" \
    "https://chat-gateway.example.com/v1" \
    --env LLM_PROVIDER=fixture-chat \
    --env LLM_MODEL=fixture-chat-model \
    --env LLM_API_BASE_URL=https://chat-gateway.example.com/v1 \
    --env LLM_API_PROTOCOL=openai-responses \
    --env LLM_API_KEY=fixture-chat-key \
    --env LLM_SEARCH_API_KEY=fixture-search-key
log "Seeding a stale persisted disabled search provider before the next overlay probe"
docker run --rm --network none --volume "${search_fallback_data_volume}:/data" --entrypoint node "$IMAGE" -e '
const fs = require("node:fs");
const yaml = require("/data/profiles/qqbot/node_modules/js-yaml");
const path = "/data/profiles/qqbot/cordis.patch.yml";
const entries = yaml.load(fs.readFileSync(path, "utf8")) || [];
let provider = entries.find((entry) => entry && entry.id === "web-search-deepseek");
if (!provider) {
  provider = { id: "web-search-deepseek", config: {} };
  entries.push(provider);
}
provider.disabled = true;
provider.config ||= {};
provider.config.apiKey = "fixture-stale-search-key";
fs.writeFileSync(path, yaml.dump(entries));
'
run_profile_probe \
    "safety overlay clears stale literal key and empty independent key falls back to chat key" \
    "$search_fallback_data_volume" \
    "https://chat-gateway.example.com/v1" \
    --env LLM_PROVIDER=fixture-chat \
    --env LLM_MODEL=fixture-chat-model \
    --env LLM_API_BASE_URL=https://chat-gateway.example.com/v1 \
    --env LLM_API_PROTOCOL=openai-responses \
    --env LLM_API_KEY=fixture-chat-key \
    --env LLM_SEARCH_API_KEY= \
    --env LLM_SEARCH_BASE_URL= \
    --env LLM_SEARCH_MODEL=
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
    "dedicated Gemini image route accepts a versioned API root and bare model name" \
    "$official_data_volume" \
    "https://api.deepseek.com/anthropic/v1" \
    --env DEEPSEEK_API_KEY=fixture-official-key \
    --env IMAGE_API_KEY=fixture-gemini-image-key \
    --env IMAGE_API_BASE_URL=https://generativelanguage.googleapis.com/v1beta \
    --env IMAGE_MODEL=fixture-gemini-image-model \
    --env IMAGE_API_PROTOCOL=gemini
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
grep -Fq "IMAGE_API_PROTOCOL must be openai-images, xai-images, or gemini" "$incompatible_log"
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
    --mount "type=bind,src=${previous_stock_agents_v0_12_2_fixture},dst=/tmp/agents-stock.md,readonly" \
    "$IMAGE" -ec 'cp /tmp/agents-stock.md /data/AGENTS.md; chmod 0644 /data/AGENTS.md'
docker run --rm \
    --volume "${stock_agents_v0_10_data_volume}:/data" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /opt/qqbot-defaults/AGENTS.md'
docker run --rm \
    --volume "${readonly_stock_agents_v0_10_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_12_2_fixture},dst=/data/AGENTS.md,readonly" \
    --mount "type=bind,src=${previous_stock_agents_v0_12_2_fixture},dst=/tmp/agents-stock.md,readonly" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /tmp/agents-stock.md'
docker run --rm --entrypoint sh \
    --volume "${stock_agents_v0_10_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_12_5_fixture},dst=/tmp/agents-stock.md,readonly" \
    "$IMAGE" -ec 'cp /tmp/agents-stock.md /data/AGENTS.md; chmod 0644 /data/AGENTS.md'
docker run --rm \
    --volume "${stock_agents_v0_10_data_volume}:/data" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /opt/qqbot-defaults/AGENTS.md'
docker run --rm \
    --volume "${readonly_stock_agents_v0_10_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_12_5_fixture},dst=/data/AGENTS.md,readonly" \
    --mount "type=bind,src=${previous_stock_agents_v0_12_5_fixture},dst=/tmp/agents-stock.md,readonly" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /tmp/agents-stock.md'
docker run --rm --entrypoint sh \
    --volume "${stock_agents_v0_10_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_12_8_fixture},dst=/tmp/agents-stock.md,readonly" \
    "$IMAGE" -ec 'cp /tmp/agents-stock.md /data/AGENTS.md; chmod 0644 /data/AGENTS.md'
docker run --rm \
    --volume "${stock_agents_v0_10_data_volume}:/data" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /opt/qqbot-defaults/AGENTS.md'
docker run --rm \
    --volume "${stock_agents_v0_10_data_volume}:/data" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /opt/qqbot-defaults/AGENTS.md'
docker run --rm \
    --volume "${readonly_stock_agents_v0_10_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_12_8_fixture},dst=/data/AGENTS.md,readonly" \
    --mount "type=bind,src=${previous_stock_agents_v0_12_8_fixture},dst=/tmp/agents-stock.md,readonly" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /tmp/agents-stock.md'
log "Checking every distinct legacy stock AGENTS.md hash migrates"
for legacy_stock_agents_fixture in "${legacy_stock_agents_fixtures[@]}"; do
    docker run --rm --network none --entrypoint sh \
        --volume "${stock_agents_v0_10_data_volume}:/data" \
        --mount "type=bind,src=${legacy_stock_agents_fixture},dst=/tmp/agents-legacy-stock.md,readonly" \
        "$IMAGE" -ec 'cp /tmp/agents-legacy-stock.md /data/AGENTS.md; chmod 0644 /data/AGENTS.md'
    docker run --rm --network none \
        --volume "${stock_agents_v0_10_data_volume}:/data" \
        "$IMAGE" sh -ec 'cmp /data/AGENTS.md /opt/qqbot-defaults/AGENTS.md'
done

log "Checking legacy custom suffix and read-only preservation"
legacy_v0_7_stock_agents_fixture="${repo_root}/scripts/fixtures/agents-legacy-v0.7.0-stock.md"
cp "$legacy_v0_7_stock_agents_fixture" "$custom_stock_agents_file"
printf '\n\nUser customization that must survive migration.\n' >> "$custom_stock_agents_file"
chmod 0644 "$custom_stock_agents_file"
docker run --rm --network none --entrypoint sh \
    --volume "${stock_agents_v0_10_data_volume}:/data" \
    --mount "type=bind,src=${custom_stock_agents_file},dst=/tmp/custom-legacy-stock.md,readonly" \
    "$IMAGE" -ec 'cp /tmp/custom-legacy-stock.md /data/AGENTS.md; chmod 0644 /data/AGENTS.md'
docker run --rm --network none \
    --volume "${stock_agents_v0_10_data_volume}:/data" \
    --mount "type=bind,src=${custom_stock_agents_file},dst=/tmp/custom-legacy-stock.md,readonly" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /tmp/custom-legacy-stock.md'
docker run --rm --network none \
    --volume "${readonly_stock_agents_v0_10_data_volume}:/data" \
    --mount "type=bind,src=${legacy_v0_7_stock_agents_fixture},dst=/data/AGENTS.md,readonly" \
    --mount "type=bind,src=${legacy_v0_7_stock_agents_fixture},dst=/tmp/agents-legacy-stock.md,readonly" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /tmp/agents-legacy-stock.md'
docker run --rm --entrypoint sh \
    --volume "${symlink_stock_agents_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_12_5_fixture},dst=/tmp/agents-stock.md,readonly" \
    "$IMAGE" -ec 'cp /tmp/agents-stock.md /data/previous-stock.md; ln -s previous-stock.md /data/AGENTS.md'
docker run --rm \
    --volume "${symlink_stock_agents_data_volume}:/data" \
    "$IMAGE" sh -ec 'test -L /data/AGENTS.md && cmp /data/AGENTS.md /data/previous-stock.md'
docker run --rm --entrypoint sh \
    --volume "${stock_agents_v0_10_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_11_2_fixture},dst=/tmp/agents-stock.md,readonly" \
    "$IMAGE" -ec 'cp /tmp/agents-stock.md /data/AGENTS.md; chmod 0644 /data/AGENTS.md'
docker run --rm \
    --volume "${stock_agents_v0_10_data_volume}:/data" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /opt/qqbot-defaults/AGENTS.md'
docker run --rm \
    --volume "${readonly_stock_agents_v0_10_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_11_2_fixture},dst=/data/AGENTS.md,readonly" \
    --mount "type=bind,src=${previous_stock_agents_v0_11_2_fixture},dst=/tmp/agents-stock.md,readonly" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /tmp/agents-stock.md'
docker run --rm --entrypoint sh \
    --volume "${stock_agents_v0_10_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_11_1_fixture},dst=/tmp/agents-stock.md,readonly" \
    "$IMAGE" -ec 'cp /tmp/agents-stock.md /data/AGENTS.md; chmod 0644 /data/AGENTS.md'
docker run --rm \
    --volume "${stock_agents_v0_10_data_volume}:/data" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /opt/qqbot-defaults/AGENTS.md'
docker run --rm \
    --volume "${readonly_stock_agents_v0_10_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_11_1_fixture},dst=/data/AGENTS.md,readonly" \
    --mount "type=bind,src=${previous_stock_agents_v0_11_1_fixture},dst=/tmp/agents-stock.md,readonly" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /tmp/agents-stock.md'
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

docker run --rm --network none --entrypoint sh \
    --volume "${stock_agents_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_13_1_fixture},dst=/tmp/agents-v0.13.1-stock.md,readonly" \
    "$IMAGE" -ec 'cp /tmp/agents-v0.13.1-stock.md /data/AGENTS.md; chmod 0644 /data/AGENTS.md'
docker run --rm --network none \
    --volume "${stock_agents_data_volume}:/data" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /opt/qqbot-defaults/AGENTS.md'

docker run --rm --network none \
    --volume "${readonly_stock_agents_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_13_1_fixture},dst=/data/AGENTS.md,readonly" \
    --mount "type=bind,src=${previous_stock_agents_v0_13_1_fixture},dst=/tmp/agents-v0.13.1-stock.md,readonly" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /tmp/agents-v0.13.1-stock.md'

docker run --rm --network none --entrypoint sh \
    --volume "${stock_agents_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_14_0_fixture},dst=/tmp/agents-v0.14.0-stock.md,readonly" \
    "$IMAGE" -ec 'cp /tmp/agents-v0.14.0-stock.md /data/AGENTS.md; chmod 0644 /data/AGENTS.md'
docker run --rm --network none \
    --volume "${stock_agents_data_volume}:/data" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /opt/qqbot-defaults/AGENTS.md'

docker run --rm --network none \
    --volume "${readonly_stock_agents_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_14_0_fixture},dst=/data/AGENTS.md,readonly" \
    --mount "type=bind,src=${previous_stock_agents_v0_14_0_fixture},dst=/tmp/agents-v0.14.0-stock.md,readonly" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /tmp/agents-v0.14.0-stock.md'

docker run --rm --network none --entrypoint sh \
    --volume "${stock_agents_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_14_1_fixture},dst=/tmp/agents-v0.14.1-stock.md,readonly" \
    "$IMAGE" -ec 'cp /tmp/agents-v0.14.1-stock.md /data/AGENTS.md; chmod 0644 /data/AGENTS.md'
docker run --rm --network none \
    --volume "${stock_agents_data_volume}:/data" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /opt/qqbot-defaults/AGENTS.md'

docker run --rm --network none \
    --volume "${readonly_stock_agents_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_14_1_fixture},dst=/data/AGENTS.md,readonly" \
    --mount "type=bind,src=${previous_stock_agents_v0_14_1_fixture},dst=/tmp/agents-v0.14.1-stock.md,readonly" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /tmp/agents-v0.14.1-stock.md'

docker run --rm --network none --entrypoint sh \
    --volume "${stock_agents_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_14_2_fixture},dst=/tmp/agents-v0.14.2-stock.md,readonly" \
    "$IMAGE" -ec 'cp /tmp/agents-v0.14.2-stock.md /data/AGENTS.md; chmod 0644 /data/AGENTS.md'
docker run --rm --network none \
    --volume "${stock_agents_data_volume}:/data" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /opt/qqbot-defaults/AGENTS.md'

docker run --rm --network none \
    --volume "${readonly_stock_agents_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_14_2_fixture},dst=/data/AGENTS.md,readonly" \
    --mount "type=bind,src=${previous_stock_agents_v0_14_2_fixture},dst=/tmp/agents-v0.14.2-stock.md,readonly" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /tmp/agents-v0.14.2-stock.md'

docker run --rm --network none --entrypoint sh \
    --volume "${stock_agents_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_15_0_fixture},dst=/tmp/agents-v0.15.0-stock.md,readonly" \
    "$IMAGE" -ec 'cp /tmp/agents-v0.15.0-stock.md /data/AGENTS.md; chmod 0644 /data/AGENTS.md'
docker run --rm --network none \
    --volume "${stock_agents_data_volume}:/data" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /opt/qqbot-defaults/AGENTS.md'

docker run --rm --network none \
    --volume "${readonly_stock_agents_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_15_0_fixture},dst=/data/AGENTS.md,readonly" \
    --mount "type=bind,src=${previous_stock_agents_v0_15_0_fixture},dst=/tmp/agents-v0.15.0-stock.md,readonly" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /tmp/agents-v0.15.0-stock.md'

docker run --rm --network none --entrypoint sh \
    --volume "${stock_agents_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_16_0_fixture},dst=/tmp/agents-v0.16.0-stock.md,readonly" \
    "$IMAGE" -ec 'cp /tmp/agents-v0.16.0-stock.md /data/AGENTS.md; chmod 0644 /data/AGENTS.md'
docker run --rm --network none \
    --volume "${stock_agents_data_volume}:/data" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /opt/qqbot-defaults/AGENTS.md'

docker run --rm --network none \
    --volume "${readonly_stock_agents_data_volume}:/data" \
    --mount "type=bind,src=${previous_stock_agents_v0_16_0_fixture},dst=/data/AGENTS.md,readonly" \
    --mount "type=bind,src=${previous_stock_agents_v0_16_0_fixture},dst=/tmp/agents-v0.16.0-stock.md,readonly" \
    "$IMAGE" sh -ec 'cmp /data/AGENTS.md /tmp/agents-v0.16.0-stock.md'

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
    --mount "type=bind,src=${deepseek_status_test},dst=/tmp/test-deepseek-status.mjs,readonly" \
    --mount "type=bind,src=${concurrency_test},dst=/tmp/test-concurrency.mjs,readonly" \
    --mount "type=bind,src=${generation_test},dst=/tmp/test-generation.mjs,readonly" \
    --mount "type=bind,src=${recent_image_generation_test},dst=/tmp/test-recent-image-generation.mjs,readonly" \
    --mount "type=bind,src=${generation_scope_test},dst=/tmp/test-generation-scope.mjs,readonly" \
    --mount "type=bind,src=${generation_quota_test},dst=/tmp/test-generation-quotas.mjs,readonly" \
    --mount "type=bind,src=${pending_images_test},dst=/tmp/test-pending-images.mjs,readonly" \
    --mount "type=bind,src=${pending_images_native_test},dst=/tmp/test-pending-images-native.mjs,readonly" \
    --mount "type=bind,src=${memory_images_test},dst=/tmp/test-memory-images.mjs,readonly" \
    --mount "type=bind,src=${repo_root},dst=/repo,readonly" \
    --mount "type=bind,src=${onebot_native_test},dst=/tmp/test-onebot-native.mjs,readonly" \
    --mount "type=bind,src=${onebot_log_test},dst=/tmp/test-onebot-log.mjs,readonly" \
    --mount "type=bind,src=${onebot_direct_test},dst=/tmp/test-onebot-direct.mjs,readonly" \
    --mount "type=bind,src=${sealdice_policy_test},dst=/tmp/test-sealdice-policy.mjs,readonly" \
    --mount "type=bind,src=${sealdice_policy_fixture},dst=/tmp/onebot-bridge-policy.json,readonly" \
    --mount "type=bind,src=${onebot_direct_native_test},dst=/tmp/test-onebot-direct-native.mjs,readonly" \
    --mount "type=bind,src=${mention_text_test},dst=/tmp/test-qqbot-mention-text.mjs,readonly" \
    --mount "type=bind,src=${mention_text_module},dst=/opt/qqbot-defaults/qqbot-mention-text.mjs,readonly" \
    --mount "type=bind,src=${pending_images_module},dst=/opt/qqbot-defaults/qqbot-pending-images.mjs,readonly" \
    --mount "type=bind,src=${sealdice_policy_module},dst=/opt/qqbot-defaults/qqbot-sealdice-policy.mjs,readonly" \
    --mount "type=bind,src=${onebot_scope_module},dst=/opt/qqbot-defaults/qqbot-onebot-scope.mjs,readonly" \
    --mount "type=bind,src=${enforcer_script},dst=/usr/local/lib/enforce-chat-only.mjs,readonly" \
    --mount "type=bind,src=${recovery_upgrade_test},dst=/tmp/test-recovery-upgrade.mjs,readonly" \
    --mount "type=bind,src=${questions_test},dst=/tmp/test-questions.mjs,readonly" \
    --mount "type=bind,src=${questions_native_test},dst=/tmp/test-questions-native.mjs,readonly" \
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
        media_cleaner=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/media/media-cleaner.js
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
        grep -Rqs "gateway initialization failed" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib
        grep -Rqs "QQ gateway is still not ready" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib
        grep -Fq "export const inject =" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/index.js
        grep -Fq "systemPrompt" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/index.js
        middleware_setup=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/gateway/middleware-setup.js
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
        node --check /opt/qqbot-defaults/qqbot-deepseek-status.mjs
        node --check /opt/qqbot-defaults/qqbot-concurrency.mjs
        node --check /opt/qqbot-defaults/qqbot-history-snapshot.mjs
        node --check /opt/qqbot-defaults/qqbot-generation.mjs
        node --check /opt/qqbot-defaults/qqbot-generation-sender.mjs
        node --check /opt/qqbot-defaults/qqbot-generation-scope.mjs
        node --check /opt/qqbot-defaults/qqbot-generation-quotas.mjs
        node --check /opt/qqbot-defaults/qqbot-mention-text.mjs
        node --check /opt/qqbot-defaults/qqbot-pending-images.mjs
        node --check /opt/qqbot-defaults/qqbot-sealdice-policy.mjs
        node --check /opt/qqbot-defaults/qqbot-onebot-scope.mjs
        node --check /opt/qqbot-defaults/qqbot-onebot-log.mjs
        node --check /opt/qqbot-defaults/qqbot-log-text.mjs
        node --check /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/transport/inbound.js
        node --check /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/transport/outbound.js
        node --check /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/model/prefs-store.js
        node --check /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/model/model-resolver.js
        node --check /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/session/session-manager.js
        dump=/tmp/qqbot-dump-config.yaml
        dsh --profile qqbot --patch /opt/qqbot-defaults/cordis.safety.patch.yml --dump-config >"$dump"
        node /repo/scripts/verify-config-policy.mjs "$dump"
        node --test /tmp/test-chat-policy.mjs
        QQBOT_DEEPSEEK_STATUS_MODULE=/opt/qqbot-defaults/qqbot-deepseek-status.mjs node --test /tmp/test-deepseek-status.mjs
        node --test /tmp/test-qqbot-mention-text.mjs
        QQBOT_LLM_MODULE=/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js QQBOT_RUNTIME_ROOT=/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai QQBOT_ADAPTER_DIST=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib node --test /tmp/test-model-context.mjs
        QQBOT_HISTORY_SNAPSHOT_MODULE=/opt/qqbot-defaults/qqbot-history-snapshot.mjs node --test /tmp/test-group-history.mjs
        QQBOT_PENDING_IMAGES_MODULE=/opt/qqbot-defaults/qqbot-pending-images.mjs QQBOT_CONCURRENCY_MODULE=/opt/qqbot-defaults/qqbot-concurrency.mjs node --test /tmp/test-pending-images.mjs
        node --test /tmp/test-pending-images-native.mjs
        node --test /tmp/test-memory-images.mjs
        QQBOT_RECOVERY_MODULE=/opt/qqbot-defaults/qqbot-session-recovery.mjs QQBOT_HISTORY_SNAPSHOT_MODULE=/opt/qqbot-defaults/qqbot-history-snapshot.mjs QQBOT_PROVIDER_ERRORS_MODULE=/opt/qqbot-defaults/qqbot-provider-errors.mjs QQBOT_CONCURRENCY_MODULE=/opt/qqbot-defaults/qqbot-concurrency.mjs QQBOT_ADAPTER_DIST=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib node --test /tmp/test-session-recovery.mjs
        QQBOT_PROVIDER_ERRORS_MODULE=/opt/qqbot-defaults/qqbot-provider-errors.mjs QQBOT_ADAPTER_DIST=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib node --test /tmp/test-provider-errors.mjs
        QQBOT_CONCURRENCY_MODULE=/opt/qqbot-defaults/qqbot-concurrency.mjs QQBOT_ADAPTER_DIST=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib node --test /tmp/test-concurrency.mjs
        QQBOT_GENERATION_MODULE=/opt/qqbot-defaults/qqbot-generation.mjs QQBOT_GENERATION_SCOPE_MODULE=/opt/qqbot-defaults/qqbot-generation-scope.mjs QQBOT_ADAPTER_DIST=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib node --test --test-timeout=30000 /tmp/test-generation.mjs
        QQBOT_GENERATION_MODULE=/opt/qqbot-defaults/qqbot-generation.mjs QQBOT_GENERATION_SCOPE_MODULE=/opt/qqbot-defaults/qqbot-generation-scope.mjs QQBOT_ADAPTER_DIST=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib node --test --test-timeout=30000 /tmp/test-recent-image-generation.mjs
        QQBOT_GENERATION_SCOPE_MODULE=/opt/qqbot-defaults/qqbot-generation-scope.mjs node --test /tmp/test-generation-scope.mjs
        QQBOT_GENERATION_QUOTA_MODULE=/opt/qqbot-defaults/qqbot-generation-quotas.mjs node --test /tmp/test-generation-quotas.mjs
        QQBOT_ONEBOT_MODULE_ROOT=/opt/qqbot-defaults QQBOT_ONEBOT_PATCHER_SOURCE=/usr/local/lib/enforce-chat-only.mjs QQBOT_SDK_API_CLIENT_MODULE=/data/profiles/qqbot/node_modules/@tencent-connect/qqbot-nodejs/dist/protocol/api/api-client.js node --test /tmp/test-onebot-native.mjs
        QQBOT_ONEBOT_MODULE_ROOT=/opt/qqbot-defaults QQBOT_ONEBOT_PATCHER_SOURCE=/usr/local/lib/enforce-chat-only.mjs QQBOT_ADAPTER_DIST=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib node --test /tmp/test-onebot-log.mjs
        QQBOT_ONEBOT_MODULE_ROOT=/opt/qqbot-defaults node --test /tmp/test-onebot-direct.mjs
        QQBOT_ONEBOT_MODULE_ROOT=/opt/qqbot-defaults QQBOT_SEALDICE_POLICY_FIXTURE=/tmp/onebot-bridge-policy.json node --test /tmp/test-sealdice-policy.mjs
        QQBOT_ONEBOT_DIRECT_MODULE=/opt/qqbot-defaults/qqbot-onebot-direct.mjs QQBOT_ADAPTER_DIST=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib node --test /tmp/test-onebot-direct-native.mjs
        QQBOT_ADAPTER_DIST=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib QQBOT_ENFORCER_SCRIPT=/usr/local/lib/enforce-chat-only.mjs node --test /tmp/test-recovery-upgrade.mjs
        QQBOT_NATIVE_DEFAULTS_ROOT=/opt/qqbot-defaults QQBOT_QUESTIONS_MODULE=/opt/qqbot-defaults/qqbot-questions.mjs node --test /tmp/test-questions.mjs
        QQBOT_NATIVE_DEFAULTS_ROOT=/opt/qqbot-defaults QQBOT_QUESTIONS_MODULE=/opt/qqbot-defaults/qqbot-questions.mjs QQBOT_ADAPTER_DIST=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib QQBOT_SDK_ROOT=/data/profiles/qqbot/node_modules/@tencent-connect/qqbot-nodejs/dist node --test /tmp/test-questions-native.mjs
        QQBOT_CAPABILITY_ROOT=/opt/qqbot-defaults node --test /repo/scripts/test-capabilities.mjs
        node --test /repo/scripts/test-capabilities-provider.mjs
        QQBOT_ADAPTER_DIST=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib node --test /repo/scripts/test-compaction-native.mjs
        node --test /repo/scripts/test-vision-response.mjs
        node --test /repo/scripts/test-image-sources.mjs
        QQBOT_GENERATION_MODULE=/opt/qqbot-defaults/qqbot-generation.mjs node --test /repo/scripts/test-image-source-native.mjs
        node /repo/scripts/test-qqbot-055-patches.mjs /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot
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
        if (plugin.version !== "0.5.5") process.exit(1);
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
    const path = "/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/gateway/middleware-setup.js";
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
    "$IMAGE" /tmp/prepare-pre-concurrency-fixture.mjs /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib
docker run --rm --network none --entrypoint node \
    --volume "${dice_legacy_data_volume}:/data" \
    --mount "type=bind,src=${pre_recovery_fixture},dst=/tmp/prepare-pre-recovery-fixture.mjs,readonly" \
    "$IMAGE" /tmp/prepare-pre-recovery-fixture.mjs /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib
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
            middleware=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/gateway/middleware-setup.js
            inbound=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/transport/inbound.js
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
            grep -Fq "Chat-only content-risk turn recovery v1." /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/transport/outbound.js
            grep -Fq "Chat-only friendly provider errors v1." /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/transport/outbound.js
            grep -Fq "Chat-only persistent model prefs v1." /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/model/prefs-store.js
            grep -Fq "Chat-only strict sessionId persistence v1." /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/model/model-resolver.js
            grep -Fq "Chat-only strict automatic session reset v1." /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/session/session-manager.js
            node --check "$middleware"
            QQBOT_HISTORY_SNAPSHOT_MODULE=/opt/qqbot-defaults/qqbot-history-snapshot.mjs node --test /tmp/test-group-history.mjs
            QQBOT_RECOVERY_MODULE=/opt/qqbot-defaults/qqbot-session-recovery.mjs QQBOT_HISTORY_SNAPSHOT_MODULE=/opt/qqbot-defaults/qqbot-history-snapshot.mjs QQBOT_PROVIDER_ERRORS_MODULE=/opt/qqbot-defaults/qqbot-provider-errors.mjs QQBOT_CONCURRENCY_MODULE=/opt/qqbot-defaults/qqbot-concurrency.mjs QQBOT_ADAPTER_DIST=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib node --test /tmp/test-session-recovery.mjs
            QQBOT_PROVIDER_ERRORS_MODULE=/opt/qqbot-defaults/qqbot-provider-errors.mjs QQBOT_ADAPTER_DIST=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib node --test /tmp/test-provider-errors.mjs
            QQBOT_CONCURRENCY_MODULE=/opt/qqbot-defaults/qqbot-concurrency.mjs QQBOT_ADAPTER_DIST=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib node --test /tmp/test-concurrency.mjs
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
    "$IMAGE" /tmp/prepare-pre-concurrency-fixture.mjs /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib
docker run --rm --network none --entrypoint node --volume "${recovery_v1_data_volume}:/data" \
    --mount "type=bind,src=${pre_recovery_fixture},dst=/tmp/prepare-pre-recovery-fixture.mjs,readonly" \
    "$IMAGE" /tmp/prepare-pre-recovery-fixture.mjs /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib recovery-v1
for recovery_boot in 1 2; do
    docker run --rm --network none --volume "${recovery_v1_data_volume}:/data" "$IMAGE" sh -ec '
        root=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib
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
    "$IMAGE" /tmp/prepare-pre-concurrency-fixture.mjs /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib
for concurrency_boot in 1 2; do
    docker run --rm --network none \
        --volume "${pre_concurrency_data_volume}:/data" \
        --mount "type=bind,src=${concurrency_test},dst=/tmp/test-concurrency.mjs,readonly" \
        --mount "type=bind,src=${onebot_direct_native_test},dst=/tmp/test-onebot-direct-native.mjs,readonly" \
        "$IMAGE" sh -ec '
            test "$(cat /data/AGENTS.md)" = "pre-concurrency user instructions"
            root=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib
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
    const root = "/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib";
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
    const root = "/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib";
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
    const root = "/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib";
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
    const root = "/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib";
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
    "$IMAGE" /tmp/prepare-pre-concurrency-fixture.mjs /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib
docker run --rm --network none --entrypoint node --volume "${legacy_data_volume}:/data" \
    --mount "type=bind,src=${pre_recovery_fixture},dst=/tmp/prepare-pre-recovery-fixture.mjs,readonly" \
    "$IMAGE" /tmp/prepare-pre-recovery-fixture.mjs /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib
docker run --rm --network none --entrypoint node --volume "${legacy_data_volume}:/data" \
    --mount "type=bind,src=${repo_root}/scripts/prepare-legacy-policy-fixture.mjs,dst=/tmp/prepare-legacy-policy-fixture.mjs,readonly" \
    "$IMAGE" /tmp/prepare-legacy-policy-fixture.mjs /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib
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
        node --check "/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/$file"
    done
    grep -Fq "import { installChatPolicy } from '\''/opt/qqbot-defaults/qqbot-chat-policy.mjs'\'';" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/gateway/bootstrap.js
    grep -Fq "import {createScopedQuoteRef} from '\''/opt/qqbot-defaults/qqbot-chat-policy.mjs'\'';" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/gateway/middleware-setup.js
    grep -Fq "bot.use(createScopedQuoteRef(quoteRef));" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/gateway/middleware-setup.js
    grep -Fq "import { createHistorySnapshotBuffer } from '\''/opt/qqbot-defaults/qqbot-history-snapshot.mjs'\'';" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/gateway/middleware-setup.js
    grep -Fq "bot.use(createHistorySnapshotBuffer(historyBuffer, {" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/gateway/middleware-setup.js
    grep -Fq "Chat-only current-image downloads v3." /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/transport/attachment.js
    grep -Fq "Chat-only quoted-image downloads v2." /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/middleware/attachment.js
    grep -Fq "timeoutMs: vision.timeoutMs" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/media/vision-tool.js
    grep -Fq "import { loadChatImageBytes } from '\''/opt/qqbot-defaults/qqbot-chat-policy.mjs'\'';" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/media/vision-tool.js
    grep -Fq "Chat-only scoped image loader v3." /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/media/vision-tool.js
    grep -Fq "Chat-only image schema: fixed bundled Dayu image assets v5." /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/media/vision-tool.js
    grep -Fq "/opt/qqbot-assets/dayu/" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/media/vision-tool.js
    grep -Fq "loadImageBytes(image, vision.maxBytes, exec)" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/media/vision-tool.js
    grep -Fq "// Chat-only persistent media root v1." /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/media/media-cleaner.js
    grep -Fq "export const MEDIA_ROOT = '\''/data/qqbot-media'\'';" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/media/media-cleaner.js
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
grep -Fq "QQ profile manifest and installed adapter version disagree" "$incompatible_log"

cmd="$(docker image inspect --format '{{json .Config.Cmd}}' "$IMAGE")"
log "Checking default image command"
if [[ "$cmd" != '["dsh","--profile","qqbot"]' ]]; then
    echo "Unexpected default image command: $cmd" >&2
    exit 1
fi

log "Scanning image configuration for injected secret names"
if docker image inspect "$IMAGE" | grep -Eqi 'DEEPSEEK_API_KEY|LLM_API_KEY|LLM_SEARCH_API_KEY|QQBOT_SECRET'; then
    echo "Secret variable name unexpectedly present in image configuration" >&2
    exit 1
fi

log "Scanning image history for injected secret names"
if docker history --no-trunc "$IMAGE" | grep -Eqi 'DEEPSEEK_API_KEY|LLM_API_KEY|LLM_SEARCH_API_KEY|QQBOT_SECRET'; then
    echo "Secret variable name unexpectedly present in image history" >&2
    exit 1
fi

log "Passed: seed, profile, plugin, workspace, persistence, config policy, chat/document regression, and image secret scan"
