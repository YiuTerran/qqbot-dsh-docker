# dsh-qqbot for QNAP Container Station

This repository produces a QNAP-friendly Docker image for Tencent's
[`dsh-qqbot`](https://github.com/tencent-connect/dsh-qqbot) plugin. Build the
image on a Mac or in CI, push a versioned tag to Docker Hub, then use QNAP Container
Station only to pull the image, set environment variables, attach two Docker
named volumes, and start it.

No port is published. The QQ Bot connector uses an outbound WebSocket
connection, so the container does not need an inbound port for the expected
operation.

## What is fixed in the image

| Component | Version |
| --- | --- |
| Base | Official `node:24.14.0-bookworm-slim@sha256:d8e448a…e33d8` (Debian slim) |
| pnpm | `12.6.0` |
| dsh | `@deepseek-ai/dsh@0.1.7-rc.2` |
| QQ plugin | `@tencent-connect/dsh-qqbot@0.5.0` |

The plugin declares support for the dsh component APIs from `0.1.0-rc.6`; npm's
stable dsh release was `0.1.7-rc.2` when this project was checked. dsh delegates
plugin installation to `pnpm`, so it is installed explicitly. The package
versions, Node 24.14.0 image tag, and its multi-architecture manifest digest are
all pinned in the Dockerfile.

The image also includes `bubblewrap` (`bwrap`). DSH uses it on Linux to enforce
the selected Shell sandbox policy; without a usable Bubblewrap or Landlock
backend, DSH refuses to run a Shell command rather than executing it outside the
sandbox. Installing it does not grant the bot extra container privileges:
`read-only` remains the default, and `workspace-write` remains confined to
`/workspace`. Some Docker hosts block unprivileged user namespaces; in that
case DSH will keep failing closed and the Container Station log will show the
Bubblewrap runner error rather than silently running an unrestricted command.

During image build, dsh creates the `qqbot` profile and installs the plugin in
`/opt/dsh-seed`. At runtime `DSH_HOME=/data`. The entrypoint copies the seed to
`/data` only when `/data/.initialized` is absent. It never overwrites an
initialized volume. `tini` is PID 1 and the dsh process runs as the unprivileged
`node` user. Its default command is:

```text
dsh --profile qqbot
```

## QNAP Container Station GUI deployment

1. In **Container Station**, find the Docker Hub image `tryao/qqbot-dsh` under
   Registry. If the Docker Hub repository is private, sign in to Docker Hub in
   Container Station; never put its password in this repository or image.
2. Pull one explicit image tag, for example `tryao/qqbot-dsh:v0.1.0`. Do not
   select `latest`.
3. Create a container from that image, name it `dsh-qqbot`, and set restart
   policy to **unless stopped** (or Container Station's equivalent).
4. Add these environment variables in the GUI:

   | Variable | Value |
   | --- | --- |
   | `DSH_HOME` | `/data` |
   | `TZ` | `Asia/Taipei` |
   | `DEEPSEEK_API_KEY` | Optional; only for dsh's default `deepseek-official` route |
   | `LLM_API_KEY` | Optional; API key for a custom OpenAI-compatible route configured with `apiKeyEnv: LLM_API_KEY` |
   | `QQBOT_APPID` | your QQ Bot AppID |
   | `QQBOT_SECRET` | your QQ Bot secret |
   | `QQBOT_STARTUP_WARN_MS` | Optional; emit a gateway diagnostic after this many ms (default `20000`) |
   | `QQBOT_VISION_PROVIDER` | Optional visual-model route override; empty reuses `LLM_PROVIDER`, then `deepseek-official` |
   | `QQBOT_VISION_MODEL` | Optional visual-model override; empty reuses `LLM_MODEL`, then `deepseek-flash` |
   | `DSH_PERMISSION_MODE` | `read-only` (default) or `workspace-write` for deliberate `/workspace` changes |

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

For operational visibility, this image adds three secret-free QQ startup lines:
credentials resolved, gateway connection requested, and either `Bot ready!` or
the SDK startup error. If it is still not ready after 20 seconds it prints a
warning pointing to DNS, TLS/proxy egress, or QQ Bot credential/permission
checks. Set `QQBOT_STARTUP_WARN_MS` to adjust that warning threshold; it does
not terminate or restart a connection that is still retrying.

## Default persona and safety policy

On the first start, the image creates `/data/AGENTS.md` from its built-in
default. It defines the **Blue Big Fat Fish** (蓝色大肥鱼) whale-maid persona,
Chinese-first concise replies, and general safety conventions. DSH loads this
file as its global agent instruction file.

Users can replace the persona without rebuilding the image: bind mount their
own regular file at `/data/AGENTS.md` as **read-only**. This works alongside
the named `/data` volume because the entrypoint seeds the dsh profile and the
instruction file separately; it intentionally does not recursively `chown`
`/data`, which would fail against a read-only file mount.

For Compose, the optional additional mount is:

```yaml
    volumes:
      - dsh-data:/data
      - ./my-bot-instructions.md:/data/AGENTS.md:ro
      - dsh-workspace:/workspace
```

In QNAP Container Station, add the equivalent read-only **host-file** mount.
Replacing `AGENTS.md` changes the persona and soft behavioral guidance, but it
does not remove the image's transport-level policy: group messages must mention
the bot; images and GIFs attached to the current QQ message may be read through
a 10 MB, one-hour media pipeline; file sending remains restricted to
`/workspace`; and DSH is read-only unless the deployer explicitly opts into
`workspace-write`.

Vision automatically reuses `LLM_PROVIDER` / `LLM_MODEL`, so a third-party
multimodal route needs no second model or key. Without an `LLM_*` route, it uses
the built-in `deepseek-official` / `deepseek-flash` route. Set
`QQBOT_VISION_PROVIDER` and `QQBOT_VISION_MODEL` only when vision should use a
different multimodal route.

## Third-party / OpenAI-compatible model providers

QQ is not limited to the official DeepSeek API. `dsh-qqbot` resolves its model
route in this order: a QQ conversation's `/model` selection, an explicit QQ
plugin route, dsh's active default model, then the `deepseek-official` fallback.
Configure an OpenAI-compatible provider in the **same `qqbot` profile** used by
this container, then select it as dsh's default model or use `/model` in QQ.

For QNAP Container Station, retain the simple official configuration by setting
only `DEEPSEEK_API_KEY`; dsh will use its built-in `deepseek-official` default
route. Do not set any `LLM_*` variables for that case.

For a third-party provider, set the required `LLM_*` variables in the GUI. The
entrypoint writes a secret-free provider route to the persisted `qqbot` profile
and makes it dsh's default model. For the endpoint in the screenshot, use this
pattern (substitute the actual provider key):

| Variable | Example value |
| --- | --- |
| `LLM_PROVIDER` | `fan-openai` |
| `LLM_MODEL` | `deepseek-v4-pro` |
| `LLM_API_BASE_URL` | `https://slb-v1.api.fan/v1` |
| `LLM_API_PROTOCOL` | `openai-responses` |
| `LLM_API_KEY` | the gateway API key |

`LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_BASE_URL`, and `LLM_API_KEY` are required
together. `LLM_API_PROTOCOL` is optional and defaults to `openai-responses`
(use `openai-completions` only for a provider that requires it).
`LLM_PROVIDER` must use lowercase letters, digits, and hyphens. The key is
never written to `/data`. Changing these values updates the generated route on
the next container start. Omit every `LLM_*` variable to keep the official
`DEEPSEEK_API_KEY` route or use a manually configured dsh route instead.

For a route like the one shown in the dsh Models UI, the equivalent provider
configuration has this shape; it contains no secret:

```yaml
- id: llm-pi-ai
  config:
    providers:
      my-openai-responses:
        displayName: My OpenAI Responses gateway
        apiKeyEnv: LLM_API_KEY
        api: openai-responses
        baseURL: https://gateway.example.com/v1
        models:
          - id: deepseek-v4-pro
            name: deepseek-v4-pro
- id: agent-default-model
  config:
    provider: my-openai-responses
    model: deepseek-v4-pro
```

Save this through dsh's Models/Settings UI for the `qqbot` profile, or add the
equivalent rows to `/data/profiles/qqbot/cordis.patch.yml`. Set `LLM_API_KEY`
only in Container Station's environment-variable UI (or local `.env`), never in
that YAML file. The container maps dsh's legacy `~/.dsh` settings view back to
the persistent `/data` volume, so the QQ plugin and dsh resolve the same model
state. A provider configured in a separate desktop profile is not automatically
visible to this container.

## Compose option

For command-line Docker Compose, copy `.env.example` to `.env`, enter the QQ
credentials and the credentials for the selected model route (official
`DEEPSEEK_API_KEY` or the third-party `LLM_*` route), plus an explicit
`IMAGE_TAG`; then keep `.env` out of Git. Run:

```bash
export IMAGE_TAG=v0.1.0
docker compose --env-file .env -f docker-compose.qnap.yml up -d
```

`.env` is solely for Compose users. It also contains the immutable `IMAGE_TAG`.
In Container Station, set the secrets directly through the GUI instead. The
Compose file creates the same named volumes, `dsh-qqbot-data` and
`dsh-qqbot-workspace`.

## GitHub Actions release to Docker Hub

Pushing a Git tag beginning with `v` runs
`.github/workflows/dockerhub-release.yml`. It logs in using the GitHub Actions
secrets `DOCKERHUB_USER` and `DOCKERHUB_SECRET`, then pushes one multi-platform
manifest for `linux/amd64` and `linux/arm64`. It publishes only the tag you
pushed; it never creates `latest`.

```bash
git tag v0.1.0
git push origin v0.1.0
```

This creates `tryao/qqbot-dsh:v0.1.0`. The tag must point to a commit already
pushed to GitHub. The workflow uses GitHub-hosted runners, so it does not depend
on the local OrbStack build network.

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
tryao/qqbot-dsh:v0.1.0
    + dsh-qqbot-data + dsh-qqbot-workspace
        -> tryao/qqbot-dsh:v0.2.0
```

If the new image misbehaves, switch back to the old tag and retain those exact
volumes. Do not replace them with empty volumes during an image upgrade or
rollback.

## Security and access control

Secrets are runtime environment variables only; none are copied into the image.
The image does not contain a Docker socket, QNAP host path, or Mac
`node_modules`, and it restricts the bot's working directory to `/workspace`.

This image leaves private-chat and group admission to the QQ Open Platform's own
allowlist and permission settings rather than duplicating those OpenIDs in the
container. Group messages require an @mention. The image adds a group system
prompt forbidding general tool use and environment-changing actions, with one
narrow exception for visual analysis of the current QQ attachment. The upstream
plugin does not offer a separate, hard per-group tool-permission boundary;
treat `DSH_PERMISSION_MODE`, container isolation, media size/retention limits,
and the confirmation flow as the actual enforcement layers. The plugin's file
sending path restriction remains enabled; do not add unrestricted extra roots
casually.
