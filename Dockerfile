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
RUN apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update \
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

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    DSH_HOME=/data \
    DSH_PERMISSION_MODE=read-only

# Runtime-only OS packages. git is kept for agent workspace inspection, tini
# remains PID 1, and util-linux provides setpriv for dropping to node.
RUN apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update \
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
COPY --from=build /usr/local/bin/dsh /usr/local/bin/dsh
COPY --from=build /usr/local/bin/pnpm /usr/local/bin/pnpm
COPY --from=build /usr/local/lib/instrument-qqbot-startup.mjs /usr/local/lib/instrument-qqbot-startup.mjs
COPY --from=build /opt/dsh-seed/ /opt/dsh-seed/

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY defaults/AGENTS.md /opt/qqbot-defaults/AGENTS.md
COPY defaults/cordis.safety.patch.yml /opt/qqbot-defaults/cordis.safety.patch.yml

RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
    && chown -R node:node /opt/dsh-seed /opt/qqbot-defaults

# tini remains PID 1; docker-entrypoint drops the dsh process to the unprivileged
# node user after it has initialized a newly-mounted named volume.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["dsh", "--profile", "qqbot"]
