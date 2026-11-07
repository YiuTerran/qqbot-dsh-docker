#!/usr/bin/env bash
# Keep active deployment examples aligned; historical upgrade fixtures are exempt.
set -euo pipefail
repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
tag="$(sed -n 's/^IMAGE_TAG=//p' "${repo_root}/.env.example")"
if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo 'Expected one explicit stable IMAGE_TAG in .env.example' >&2
    exit 1
fi
for path in README.md docs/onebot-integration.md docs/runtime-guide.md defaults/AGENTS.md; do
    refs="$(grep -oE 'tryao/qqbot-dsh:v[0-9]+\.[0-9]+\.[0-9]+' "${repo_root}/${path}" | sort -u)"
    # runtime-guide also documents the intentional v0.18.2 migration source.
    if [[ "$path" = docs/runtime-guide.md ]]; then
        refs="$(grep -v 'LEGACY_IMAGE=' "${repo_root}/${path}" | grep -oE 'tryao/qqbot-dsh:v[0-9]+\.[0-9]+\.[0-9]+' | sort -u)"
    fi
    if [[ "$refs" != "tryao/qqbot-dsh:${tag}" ]]; then
        echo "Current image references disagree with .env.example in ${path}: ${refs}" >&2
        exit 1
    fi
done
example_tag="$(sed -nE 's/^IMAGE_TAG=(v[0-9]+\.[0-9]+\.[0-9]+)$/\1/p' "${repo_root}/docs/onebot-integration.md")"
[[ "$example_tag" = "$tag" ]] || { echo 'OneBot IMAGE_TAG example is out of date' >&2; exit 1; }
if [[ "${GITHUB_REF_TYPE:-}" = tag && "${GITHUB_REF_NAME:-}" != "$tag" ]]; then
    echo "Release tag ${GITHUB_REF_NAME:-} does not match IMAGE_TAG=${tag}" >&2
    exit 1
fi
printf '[release-version] Deployment examples agree on %s\n' "$tag"
