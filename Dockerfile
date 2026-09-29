# syntax=docker/dockerfile:1.7
# Official Node 24 Debian slim image, pinned to the multi-architecture manifest
# published for 24.14.0 (linux/amd64 and linux/arm64 are both available).
FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    DSH_HOME=/data \
    DSH_PERMISSION_MODE=read-only

RUN apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        git \
        tini \
        util-linux \
    && rm -rf /var/lib/apt/lists/*

# dsh's plugin manager delegates profile installation to the pnpm executable.
# All three runtime packages are pinned so a rebuild uses the same closure.
# dsh-qqbot 0.5.0 accepts the dsh component APIs from 0.1.0-rc.6 upward.
RUN npm install --global --omit=dev \
        pnpm@12.6.0 \
        @deepseek-ai/dsh@0.1.7-rc.2 \
    && pnpm --version \
    && DSH_HOME=/opt/dsh-seed dsh plugin --profile qqbot add @tencent-connect/dsh-qqbot@0.5.0 \
    && node -e "const p=require('/opt/dsh-seed/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/package.json'); if (p.version !== '0.5.0') process.exit(1)"

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY defaults/AGENTS.md /opt/qqbot-defaults/AGENTS.md
COPY defaults/cordis.safety.patch.yml /opt/qqbot-defaults/cordis.safety.patch.yml

RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
    && chown -R node:node /opt/dsh-seed /opt/qqbot-defaults

# tini remains PID 1; docker-entrypoint drops the dsh process to the unprivileged
# node user after it has initialized a newly-mounted named volume.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["dsh", "--profile", "qqbot"]
