# dsh-qqbot for QNAP Container Station

This repository produces a QNAP-friendly Docker image for Tencent's
[`dsh-qqbot`](https://github.com/tencent-connect/dsh-qqbot) plugin. Build the
image on a Mac or in CI, push a versioned tag to Harbor, then use QNAP Container
Station only to pull the image, set environment variables, attach two Docker
named volumes, and start it.

No port is published. The QQ Bot connector uses an outbound WebSocket
connection, so the container does not need an inbound port for the expected
operation.

## What is fixed in the image

| Component | Version |
| --- | --- |
| Base | Official `node:24.14.0-bookworm-slim@sha256:d8e448a…e33d8` (Debian slim) |
| dsh | `@deepseek-ai/dsh@0.1.7-rc.2` |
| QQ plugin | `@tencent-connect/dsh-qqbot@0.5.0` |

The plugin declares support for the dsh component APIs from `0.1.0-rc.6`; npm's
stable dsh release was `0.1.7-rc.2` when this project was checked. Both package
versions, the Node 24.14.0 image tag, and its multi-architecture manifest digest
are explicitly pinned in the Dockerfile.

During image build, dsh creates the `qqbot` profile and installs the plugin in
`/opt/dsh-seed`. At runtime `DSH_HOME=/data`. The entrypoint copies the seed to
`/data` only when `/data/.initialized` is absent. It never overwrites an
initialized volume. `tini` is PID 1 and the dsh process runs as the unprivileged
`node` user. Its default command is:

```text
dsh --profile qqbot
```

## QNAP Container Station GUI deployment

1. In **Container Station**, add your private Harbor registry under Registry
   (enter the registry hostname, then sign in there). Do not put this password
   in this repository or image.
2. Pull one explicit image tag, for example
   `harbor.example.com/ai/dsh-qqbot:2026.09.29-01`. Do not select `latest`.
3. Create a container from that image, name it `dsh-qqbot`, and set restart
   policy to **unless stopped** (or Container Station's equivalent).
4. Add these environment variables in the GUI:

   | Variable | Value |
   | --- | --- |
   | `DSH_HOME` | `/data` |
   | `TZ` | `Asia/Taipei` |
   | `DEEPSEEK_API_KEY` | your secret |
   | `QQBOT_APPID` | your QQ Bot AppID |
   | `QQBOT_SECRET` | your QQ Bot secret |

5. Create and attach Docker **volumes** (not host directories):

   | Volume name | Container path | Purpose |
   | --- | --- | --- |
   | `dsh-qqbot-data` | `/data` | dsh settings, `qqbot` profile, sessions, model preferences, and runtime state |
   | `dsh-qqbot-workspace` | `/workspace` | Agent working directory and files generated or handled by the bot |

6. Do not add a port mapping, bind mount, Docker socket, privileged mode, or
   host network. Start the container and use Container Station's log view for
   first-run diagnostics.

The first start seeds `/data`; later starts retain it. The QQ plugin may guide a
first credential setup when the supplied credentials are incomplete. The local
test intentionally avoids that interactive QR flow.

## Compose option

For command-line Docker Compose, copy `.env.example` to `.env`, enter only the
three secrets, and keep `.env` out of Git. Set `HARBOR_IMAGE` in your shell to a
fully versioned reference, then run:

```bash
export HARBOR_IMAGE=harbor.example.com/ai/dsh-qqbot:2026.09.29-01
docker compose --env-file .env -f docker-compose.qnap.yml up -d
```

`.env` is solely for Compose users. In Container Station, set the secrets
directly through the GUI instead. The Compose file creates the same named
volumes, `dsh-qqbot-data` and `dsh-qqbot-workspace`.

## Build and push to Harbor

Log in yourself first; the script never accepts, stores, or prints a Harbor
password. It makes a multi-platform manifest for `linux/amd64` and
`linux/arm64` and pushes it directly.

```bash
docker login harbor.example.com
HARBOR_REGISTRY=harbor.example.com \
HARBOR_PROJECT=ai \
IMAGE_TAG=2026.09.29-01 \
./scripts/build-and-push.sh
```

`IMAGE_NAME` defaults to `dsh-qqbot`. If `IMAGE_TAG` is omitted, the script
generates a UTC tag such as `2026.09.29-143000`; it refuses `latest`.

## Local validation

Run this before publishing:

```bash
./scripts/test-local.sh
```

It builds a current-platform image, uses two temporary named volumes (never a
bind mount), verifies first-run seeding, the `qqbot` profile, plugin version,
`dsh`, writable workspace, a restart against the same volumes, default command,
and a basic image history/configuration secret scan. It deletes only the
temporary container and temporary test volumes it created.

## Upgrade, rollback, and backup

The persistent state is `dsh-qqbot-data`; back it up with Container Station / QNAP
container backup facilities or another Docker-volume backup solution. Removing a
container must not remove either named volume.

To upgrade, pull a new explicit image tag and create/update the container while
continuing to mount **the same** `dsh-qqbot-data` and `dsh-qqbot-workspace`
volumes. For example:

```text
harbor.example.com/ai/dsh-qqbot:2026.09.29-01
    + dsh-qqbot-data + dsh-qqbot-workspace
        -> harbor.example.com/ai/dsh-qqbot:2026.10.03-01
```

If the new image misbehaves, switch back to the old tag and retain those exact
volumes. Do not replace them with empty volumes during an image upgrade or
rollback.

## Security and access control

Secrets are runtime environment variables only; none are copied into the image.
The image does not contain a Docker socket, QNAP host path, or Mac
`node_modules`, and it restricts the bot's working directory to `/workspace`.

Upstream `dsh-qqbot` defaults both `access.c2cMode` (private chats) and
`access.groupMode` (groups) to `open`. Consequently, any permitted QQ user or
group member can trigger an Agent. Before production use, configure the plugin
profile with `allowlist` or `disabled` as appropriate, use restrictive presets
and tool permissions, and keep the workspace permissions narrow. The plugin's
file sending path restriction is enabled by default; do not add unrestricted
extra roots casually.
