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

The image also includes `bubblewrap` (`bwrap`) as defense in depth. The launcher
forces DSH's sandbox mode to `read-only`, but that setting alone does **not**
disable Shell: a read-only Shell can still inspect data. The actual chat-only
boundary is the immutable tool overlay plus the runtime guard, which disables
Shell/code/files/jobs/subagents/workflows and rejects unknown or newly injected
tools before execution. Confirmation cannot override that guard. Bubblewrap
and the read-only setting are supporting controls, not the chat policy itself;
an administrator running an alternate DSH command that reaches a blocked
Bubblewrap path should treat that command as failed closed.

During image build, dsh creates the `qqbot` profile and installs the plugin in
`/opt/dsh-seed`. At runtime `DSH_HOME=/data`. The entrypoint copies the seed to
`/data` only when `/data/.initialized` is absent. It never overwrites an
initialized volume. `tini` is PID 1 and the dsh process runs as the unprivileged
`node` user. Its default command is:

```text
dsh --profile qqbot
```

## Chat-only capabilities

The bot is intentionally a conversational QQ bot, with two narrowly bounded
capabilities in addition to ordinary text replies:

- It may analyze an image or GIF attached to the **current QQ message**, or an
  image explicitly quoted by that current message. The adapter temporarily
  downloads only those image attachments and caps them at 10 MB; unrelated
  history attachments are not downloaded or authorized.
  The transport cache uses a one-hour TTL with hourly cleanup; this is not a
  promise that every downstream attachment-storage byte is deleted at exactly
  one hour. Vision never accepts arbitrary URLs, paths, workspace files,
  unquoted history attachments, or unrelated session attachments; the current-message
  association is cleared when the turn ends.
- It may use `web_fetch` for a public `http://` or `https://` URL when the
  response is HTML/XHTML. The page is bounded and converted to text in memory;
  scripts are not run, and no response is saved as a file. PDF, ZIP, image,
  plain-text, attachment, and other file responses are rejected. Web search is
  disabled, and webpage text is treated as untrusted data.

Shell commands, code execution, general file read/write, file sending, file
downloads, background jobs, subagents, workflows, and similar environment
actions are unavailable in both private and group chats. The bot may explain a
command or show code as text, but never runs it. A user's confirmation or a
custom persona cannot remove these restrictions.

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

   Do not set `DSH_PERMISSION_MODE`: the entrypoint always forces `read-only`.
   This is a sandbox defense, not the chat-only boundary; the disabled tools and
   runtime guard remain necessary because `read-only` by itself does not make a
   Shell command safe.

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

The image also reports exceptions from the setup that precedes the Gateway
connection, including media and vision-tool registration. Existing `/data`
volumes are patched at startup, so this diagnostic upgrade does not require
removing sessions or settings. To isolate a startup problem temporarily, set
`QQBOT_VISION_ENABLED=false`; if necessary, also set `QQBOT_MEDIA_ENABLED=false`.
Both remain enabled by default.

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
the bot; only current-message images/GIFs (including explicitly quoted images)
may enter the bounded vision pipeline;
only public HTML/XHTML may enter `web_fetch`; and Shell, code, file operations,
file sending, file downloads, and background work remain unavailable. The
entrypoint also forces DSH to `read-only`; do not use a custom persona as a
security mechanism.

Vision automatically reuses `LLM_PROVIDER` / `LLM_MODEL`, so a third-party
multimodal route needs no second model or key. Without an `LLM_*` route, it uses
the built-in `deepseek-official` / `deepseek-flash` route. Set
`QQBOT_VISION_PROVIDER` and `QQBOT_VISION_MODEL` only when vision should use a
different multimodal route. The selected model must genuinely accept image
input; the generated provider declaration's `input: [text, image]` only tells
dsh that the route is eligible and does not add multimodal capability to a
text-only model.

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
secrets `DOCKERHUB_USER` and `DOCKERHUB_SECRET`. Before publishing, it builds a
`linux/amd64` validation image and runs `scripts/test-local.sh`, including the
chat-policy regression, final config assertions, persistence restart, legacy
volume upgrade, and fail-closed version check. Only after that gate passes does
it push one multi-platform manifest for `linux/amd64` and `linux/arm64`. It
publishes only the tag you pushed; it never creates `latest`.

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

It builds a current-platform image, uses temporary named volumes for runtime
state, and mounts only the read-only regression and profile-probe scripts. It verifies first-run
seeding, the `qqbot` profile, plugin version, `dsh`, the read-only instruction
mount, the final `native`/disabled/web-provider configuration (including no
startup agents), the real in-image `ToolRuntime` policy tests, and a full local
Cordis profile boot with a wrapped QQ SDK, followed by a restart against the
same volumes, strict patching of an unpatched legacy profile, refusal of an
incompatible plugin version, the default command, and image history/configuration
secret scans. It does not contact QQ or a paid model API and is not a real QQ
end-to-end test. It deletes only the temporary container and volumes it creates.

## Upgrade, rollback, and backup

The persistent state is `dsh-qqbot-data`; back it up with Container Station / QNAP
container backup facilities or another Docker-volume backup solution. Removing a
container must not remove either named volume.

Before upgrading, create a recoverable backup/snapshot of both named volumes.
The persisted profile is patched in place and imports the policy modules shipped
by the new image, so keep this pre-upgrade backup until the new image has passed
your checks. To upgrade, pull a new explicit image tag and create/update the
container while continuing to mount **the same** `dsh-qqbot-data` and
`dsh-qqbot-workspace` volumes. For example:

```text
tryao/qqbot-dsh:v0.1.0
    + dsh-qqbot-data + dsh-qqbot-workspace
        -> tryao/qqbot-dsh:v0.2.0
```

If the new image misbehaves, first stop it and restore the pre-upgrade volume
backup together with the old tag. Do not point an older tag that lacks
`/opt/qqbot-defaults/{chat-policy,web-pages}.mjs` at an already-upgraded volume,
and do not replace the volumes with empty ones: restoring the pre-upgrade
snapshot preserves sessions while providing the old image's expected profile
layout. On every startup the entrypoint strictly reapplies the chat-only patch
to the persisted `@tencent-connect/dsh-qqbot@0.5.0` layout. An old unpatched
profile is upgraded in place without deleting sessions; a missing, changed, or
unsupported plugin layout fails closed instead of silently starting without the
policy. This guarantee is specific to the pinned `0.5.0` adapter; it does not
promise compatibility with another plugin version.

## Security and access control

Secrets are runtime environment variables only; none are copied into the image.
The image does not contain a Docker socket, QNAP host path, or Mac
`node_modules`, and it restricts the bot's working directory to `/workspace`.

This image leaves private-chat and group admission to the QQ Open Platform's own
allowlist and permission settings rather than duplicating those OpenIDs in the
container. Group messages require an @mention. The image's hard boundary is
the immutable transport overlay and chat-policy guard: only the current-message
(including an explicitly quoted image) vision tool and bounded public-HTML
`web_fetch` remain callable. It also removes
the web search provider, disables automatic `agent-loop` startup agents, and
forces native tool presentation. A read-only sandbox, container isolation, and
media limits are defense in depth; `read-only` alone would not prohibit Shell.
The web reader validates public destinations, pins the validated connection,
uses direct requests rather than an HTTP proxy, and never writes a downloaded
file. Quote-reference cache keys are isolated by chat kind and peer (sender for
private chat, group for group chat); messages without a recognized peer are not
cached, while the current QQ message-elements fallback remains available for an
explicit quote. Model-endpoint proxy settings remain available for the
configured LLM provider.

The NAS/container DNS used for public webpage fetching and current QQ image
downloads must return the destination's real public IP. Fake-IP answers such as
`198.18.0.0/15` are rejected by the public-destination check; if deployment DNS
uses such answers, adjust the NAS/Docker DNS configuration instead of disabling
the check. These requests are direct and do not use the model-endpoint proxy.
The offline regression suite does not prove access to the public Internet, QQ,
or a paid multimodal model; verify those integrations separately with suitable
test credentials and service policies.

Replacing `/data/AGENTS.md` is supported only for persona and other soft
conversation guidance. It cannot register capabilities, relax the guard, or
authorize Shell, code, file, download, background, or cross-session access.
