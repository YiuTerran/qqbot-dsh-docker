#!/usr/bin/env bash
set -euo pipefail

: "${HARBOR_REGISTRY:?Set HARBOR_REGISTRY, for example harbor.example.com}"
: "${HARBOR_PROJECT:?Set HARBOR_PROJECT, for example ai}"

IMAGE_NAME="${IMAGE_NAME:-dsh-qqbot}"
IMAGE_TAG="${IMAGE_TAG:-$(date -u +%Y.%m.%d-%H%M%S)}"

if [[ "$IMAGE_TAG" == "latest" ]]; then
    echo "IMAGE_TAG must be an explicit immutable version, not latest" >&2
    exit 64
fi

if [[ "$HARBOR_REGISTRY" == */* || "$HARBOR_PROJECT" == */* || -z "$IMAGE_NAME" ]]; then
    echo "Use a registry host, a single Harbor project name, and a non-empty image name" >&2
    exit 64
fi

if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required" >&2
    exit 69
fi

if ! docker buildx version >/dev/null 2>&1; then
    echo "Docker Buildx is required" >&2
    exit 69
fi

image="${HARBOR_REGISTRY}/${HARBOR_PROJECT}/${IMAGE_NAME}:${IMAGE_TAG}"

cat <<EOF
Building and pushing: $image
Platforms: linux/amd64,linux/arm64
Authentication: uses the existing 'docker login $HARBOR_REGISTRY' session.
EOF

docker buildx build \
    --platform linux/amd64,linux/arm64 \
    --tag "$image" \
    --push \
    .
