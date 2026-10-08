# syntax=docker/dockerfile:1.7
# Official Node 24 Debian slim image, pinned to the multi-architecture manifest
# published for 24.14.0 (linux/amd64 and linux/arm64 are both available).
FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS build

COPY scripts/instrument-qqbot-startup.mjs /usr/local/lib/instrument-qqbot-startup.mjs

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    DSH_HOME=/data \
    DSH_PERMISSION_MODE=read-only

# The profile build needs TLS roots but none of the process-supervision or
# sandbox packages. Keeping package-manager caches in this disposable stage
# prevents their downloaded tarballs from becoming part of the runtime image.
RUN sed -i 's|http://deb.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g; s|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# dsh's plugin manager delegates profile installation to the pnpm executable.
# All three runtime packages are pinned so a rebuild uses the same closure.
# dsh-qqbot 0.5.0 accepts the dsh component APIs from 0.1.0-rc.6 upward.
# dsh's default logger has no stdout sink for this profile. The following build
# step instruments the pinned adapter's compiled entry points so failed/stalled
# gateway startup is diagnosable without emitting secrets; it fails if that
# adapter layout changes.
RUN --mount=type=cache,target=/root/.npm \
    npm install --global --omit=dev \
        pnpm@12.6.0 \
        @deepseek-ai/dsh@0.1.7-rc.2 \
    && pnpm --version \
    && pnpm config set store-dir /tmp/pnpm-store \
    && DSH_HOME=/opt/dsh-seed dsh plugin --profile qqbot add @tencent-connect/dsh-qqbot@0.5.0 \
    && node /usr/local/lib/instrument-qqbot-startup.mjs /opt/dsh-seed/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist \
    && node -e "const p=require('/opt/dsh-seed/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/package.json'); if (p.version !== '0.5.0') process.exit(1)"

COPY scripts/enforce-chat-only.mjs /usr/local/lib/enforce-chat-only.mjs
RUN node /usr/local/lib/enforce-chat-only.mjs /opt/dsh-seed/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist

RUN node --check /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js \
    && node --check /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js

COPY scripts/enforce-web-search.mjs /usr/local/lib/enforce-web-search.mjs
RUN node /usr/local/lib/enforce-web-search.mjs /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-search-deepseek \
    && node /usr/local/lib/enforce-web-search.mjs /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-search-deepseek \
    && node --check /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-search-deepseek/lib/index.js

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    DSH_HOME=/data \
    DSH_PERMISSION_MODE=read-only

# Runtime-only OS packages. git is kept for agent workspace inspection, tini
# remains PID 1, and util-linux provides setpriv for dropping to node.
RUN sed -i 's|http://deb.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g; s|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        bubblewrap \
        git \
        tini \
        util-linux \
    && rm -rf /var/lib/apt/lists/*

# Copy only the installed global runtime packages and the seeded profile; npm
# and pnpm download caches exist only in the discarded build stage.
COPY --from=build /usr/local/lib/node_modules/ /usr/local/lib/node_modules/
COPY --from=build /usr/local/lib/instrument-qqbot-startup.mjs /usr/local/lib/instrument-qqbot-startup.mjs
COPY --from=build /usr/local/lib/enforce-chat-only.mjs /usr/local/lib/enforce-chat-only.mjs
COPY --from=build /opt/dsh-seed/ /opt/dsh-seed/
COPY scripts/link-global-bins.mjs /usr/local/lib/link-global-bins.mjs

# npm installs /usr/local/bin/dsh and /usr/local/bin/pnpm as symlinks into
# /usr/local/lib/node_modules. Copying them out of the build stage lands a real
# file in /usr/local/bin instead of a link, and Node's ESM resolver then only
# looks for node_modules under /usr/local/bin, never in the global package root
# (ESM ignores the CJS global folders). dsh therefore died at startup with
# ERR_MODULE_NOT_FOUND for @deepseek-ai/dsh-app-boot. Rebuild the links from
# each package's own bin field so the running module stays inside the global
# node_modules tree, then prove the launcher actually boots before publishing.
RUN set -eu \
    && node /usr/local/lib/link-global-bins.mjs \
    && rm -f /usr/local/lib/link-global-bins.mjs \
    && test -L /usr/local/bin/dsh \
    && test -L /usr/local/bin/pnpm \
    && mkdir -p /tmp/dsh-launch-check \
    && timeout 60 env HOME=/tmp/dsh-launch-check DSH_HOME=/tmp/dsh-launch-check /usr/local/bin/dsh --version >/dev/null \
    && rm -rf /tmp/dsh-launch-check

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY defaults/AGENTS.md /opt/qqbot-defaults/AGENTS.md
COPY defaults/cordis.safety.patch.yml /opt/qqbot-defaults/cordis.safety.patch.yml
COPY defaults/qqbot-chat-policy.mjs /opt/qqbot-defaults/qqbot-chat-policy.mjs
COPY defaults/qqbot-onebot.mjs /opt/qqbot-defaults/qqbot-onebot.mjs
COPY defaults/qqbot-onebot-log.mjs /opt/qqbot-defaults/qqbot-onebot-log.mjs
COPY defaults/qqbot-log-text.mjs /opt/qqbot-defaults/qqbot-log-text.mjs
COPY defaults/qqbot-onebot-scope.mjs /opt/qqbot-defaults/qqbot-onebot-scope.mjs
COPY defaults/qqbot-onebot-direct.mjs /opt/qqbot-defaults/qqbot-onebot-direct.mjs
COPY defaults/qqbot-sealdice-policy.mjs /opt/qqbot-defaults/qqbot-sealdice-policy.mjs
COPY defaults/qqbot-mention-text.mjs /opt/qqbot-defaults/qqbot-mention-text.mjs
COPY defaults/qqbot-image-diagnostics.mjs /opt/qqbot-defaults/qqbot-image-diagnostics.mjs
COPY defaults/qqbot-quote-images.mjs /opt/qqbot-defaults/qqbot-quote-images.mjs
COPY defaults/qqbot-web-pages.mjs /opt/qqbot-defaults/qqbot-web-pages.mjs
COPY defaults/qqbot-document-scope.mjs /opt/qqbot-defaults/qqbot-document-scope.mjs
COPY defaults/qqbot-session-recovery.mjs /opt/qqbot-defaults/qqbot-session-recovery.mjs
COPY defaults/qqbot-provider-errors.mjs /opt/qqbot-defaults/qqbot-provider-errors.mjs
COPY defaults/qqbot-text-documents.mjs /opt/qqbot-defaults/qqbot-text-documents.mjs
COPY defaults/qqbot-documents.mjs /opt/qqbot-defaults/qqbot-documents.mjs
COPY defaults/qqbot-history-snapshot.mjs /opt/qqbot-defaults/qqbot-history-snapshot.mjs
COPY defaults/qqbot-pending-images.mjs /opt/qqbot-defaults/qqbot-pending-images.mjs
COPY defaults/qqbot-memory-images.mjs /opt/qqbot-defaults/qqbot-memory-images.mjs
COPY defaults/qqbot-concurrency.mjs /opt/qqbot-defaults/qqbot-concurrency.mjs
COPY defaults/qqbot-generation.mjs /opt/qqbot-defaults/qqbot-generation.mjs
COPY defaults/qqbot-image-input.mjs /opt/qqbot-defaults/qqbot-image-input.mjs
COPY defaults/qqbot-image-input-worker.mjs /opt/qqbot-defaults/qqbot-image-input-worker.mjs
COPY defaults/qqbot-generation-scope.mjs /opt/qqbot-defaults/qqbot-generation-scope.mjs
COPY defaults/qqbot-generation-quotas.mjs /opt/qqbot-defaults/qqbot-generation-quotas.mjs
COPY defaults/qqbot-generation-sender.mjs /opt/qqbot-defaults/qqbot-generation-sender.mjs

RUN node --check /opt/qqbot-defaults/qqbot-onebot-direct.mjs
RUN node --check /opt/qqbot-defaults/qqbot-mention-text.mjs \
    && node --check /opt/qqbot-defaults/qqbot-pending-images.mjs \
    && node --check /opt/qqbot-defaults/qqbot-sealdice-policy.mjs \
    && node --check /opt/qqbot-defaults/qqbot-onebot-scope.mjs

RUN node --input-type=module -e "import '/opt/qqbot-defaults/qqbot-chat-policy.mjs'; import '/opt/qqbot-defaults/qqbot-generation-scope.mjs'; import '/opt/qqbot-defaults/qqbot-memory-images.mjs'; import sharp from '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/sharp/dist/index.cjs'; import { normalizeEditImage } from '/opt/qqbot-defaults/qqbot-image-input.mjs'; const source = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).webp({ lossless: true }).toBuffer(); const output = await normalizeEditImage(source, { inspectImage: bytes => bytes[0] === 137 ? 'image/png' : undefined }); const metadata = await sharp(output).metadata(); if (metadata.format !== 'png' || metadata.width !== 1 || metadata.height !== 1) process.exit(1)"

RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
    && chown -R node:node /opt/dsh-seed /opt/qqbot-defaults

# tini remains PID 1; docker-entrypoint drops the dsh process to the unprivileged
# node user after it has initialized a newly-mounted named volume.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["dsh", "--profile", "qqbot"]
