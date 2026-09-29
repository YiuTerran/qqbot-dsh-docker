#!/usr/bin/env bash
set -euo pipefail

: "${DOCKERHUB_USER:?Set DOCKERHUB_USER, for example tryao}"

IMAGE_NAME="${IMAGE_NAME:-qqbot-dsh}"
IMAGE_TAG="${IMAGE_TAG:-$(date -u +%Y.%m.%d-%H%M%S)}"

if [[ "$IMAGE_TAG" == "latest" ]]; then
    echo "IMAGE_TAG must be an explicit immutable version, not latest" >&2
    exit 64
fi

if [[ "$DOCKERHUB_USER" == */* || "$IMAGE_NAME" == */* || -z "$IMAGE_NAME" ]]; then
    echo "Use a Docker Hub namespace and a non-empty image name" >&2
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

image="${DOCKERHUB_USER}/${IMAGE_NAME}:${IMAGE_TAG}"

cat <<EOF
Building and pushing to Docker Hub: $image
Platforms: linux/amd64,linux/arm64
Authentication: uses the existing 'docker login' session.
EOF

docker buildx build \
    --platform linux/amd64,linux/arm64 \
    --tag "$image" \
    --push \
    .
