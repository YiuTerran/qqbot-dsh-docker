#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-dsh-qqbot:test-local}"
repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
chat_policy_test="${repo_root}/scripts/test-chat-policy.mjs"
suffix="$(date +%s)-$$"
data_volume="dsh-qqbot-test-data-${suffix}"
workspace_volume="dsh-qqbot-test-workspace-${suffix}"
override_data_volume="dsh-qqbot-test-override-data-${suffix}"
legacy_data_volume="dsh-qqbot-test-legacy-data-${suffix}"
incompatible_data_volume="dsh-qqbot-test-incompatible-data-${suffix}"
media_guard_data_volume="dsh-qqbot-test-media-guard-data-${suffix}"
container="dsh-qqbot-test-${suffix}"
instructions_file="$(mktemp)"
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
    docker volume rm "$data_volume" "$workspace_volume" "$override_data_volume" "$legacy_data_volume" "$incompatible_data_volume" "$media_guard_data_volume" >/dev/null 2>&1 || true
    rm -f "$instructions_file"
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
docker volume create "$incompatible_data_volume" >/dev/null
docker volume create "$media_guard_data_volume" >/dev/null

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
        media_cleaner=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/media/media-cleaner.js
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
        grep -Rqs "gateway initialization failed" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist
        grep -Rqs "QQ gateway is still not ready" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist
        grep -Fq "export const inject =" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/index.js
        grep -Fq "systemPrompt" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/index.js
        middleware_setup=/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/gateway/middleware-setup.js
        grep -Fq "createScopedQuoteRef" "$middleware_setup"
        grep -Fq "bot.use(createScopedQuoteRef(quoteRef));" "$middleware_setup"
        dump=/tmp/qqbot-dump-config.yaml
        dsh --profile qqbot --patch /opt/qqbot-defaults/cordis.safety.patch.yml --dump-config >"$dump"
        grep -A2 -F -- "- id: tool-bash" "$dump" | grep -Fq "disabled: true"
        grep -A2 -F -- "- id: tool-fs" "$dump" | grep -Fq "disabled: true"
        grep -A12 -F -- "- id: tool-subagent" "$dump" | grep -Fq "disabled: true"
        grep -A2 -F -- "- id: ptc-runtime" "$dump" | grep -Fq "disabled: true"
        grep -A5 -F -- "- id: web" "$dump" | grep -Fq "fetchProvider: qqbot-pages"
        grep -A6 -F -- "- id: web-fetch-http" "$dump" | grep -Fq "disabled: true"
        grep -A7 -F -- "- id: tool-web" "$dump" | grep -Fq "search: false"
        grep -A7 -F -- "- id: tool-web" "$dump" | grep -Fq "fetch: true"
        grep -A3 -F -- "- id: tools" "$dump" | grep -Fq "mode: native"
        grep -A4 -F -- "- id: agent-loop" "$dump" | grep -Fq "agents: []"
        test "$(grep -A6 -F -- "- id: im-qqbot" "$dump" | grep -Fc "appId: __FROM_ENV__")" -eq 1
        test "$(grep -A6 -F -- "- id: im-qqbot" "$dump" | grep -Fc "appSecret: __FROM_ENV__")" -eq 1
        node --test /tmp/test-chat-policy.mjs
        node /tmp/test-profile-boot.mjs
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
        if (plugin.version !== "0.5.0") process.exit(1);
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

log "Checking strict policy upgrade on an unpatched legacy profile volume"
docker run --rm --network none --entrypoint sh --volume "${legacy_data_volume}:/data" "$IMAGE" -ec '
    cp -a /opt/dsh-seed/. /data/
    : > /data/.initialized
'
docker run --rm --network none --entrypoint node --volume "${legacy_data_volume}:/data" "$IMAGE" -e '
    const fs = require("node:fs");
    const root = "/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist";
    const originalDownload = "    const resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });\n    if (!resp.ok)\n        throw new Error(`HTTP ${resp.status}`);\n    const buf = Buffer.from(await resp.arrayBuffer());\n    if (buf.length > maxBytes) {\n        throw new Error(`Download exceeds ${Math.floor(maxBytes / 1024 / 1024)}MB`);\n    }";
    const originalQuoteBlock = [
        "            // 引用消息附件：转成 RawAttachment 结构复用下载（voice 由 downloadMediaAttachments 自动跳过）",
        "            const quoteAttachments = ctx.state.quote?.attachments;",
        "            if (quoteAttachments && quoteAttachments.length > 0) {",
        "                const rawQuote = quoteAttachments",
        "                    .filter(a => a.url)",
        "                    .map((a) => ({",
        "                    content_type: a.contentType ?? \x27\x27,",
        "                    filename: a.filename ?? \x27\x27,",
        "                    size: 0,",
        "                    url: a.url,",
        "                }));",
        "                const downloadedQuote = await downloadMediaAttachments(rawQuote, config.media, logger);",
        "                ctx.state.downloadedQuoteFiles = downloadedQuote;",
        "            }",
    ].join("\n");
    const edits = {
        "gateway/bootstrap.js": [
            ["import { installChatPolicy } from \x27/opt/qqbot-defaults/qqbot-chat-policy.mjs\x27;\n", ""],
            ["    installChatPolicy(ctx);\n", ""],
            ["    // Chat-only deployment: file sending is not registered.", "    registerSendFileTool(ctx, mediaSender, manager, config, logger);"]
        ],
        "gateway/middleware-setup.js": [
            ["import {createScopedQuoteRef} from \x27/opt/qqbot-defaults/qqbot-chat-policy.mjs\x27;\n", ""],
            ["    // Chat-only scoped quote references prevent cross-peer message-key collisions.\n", ""],
            [
                [
                    "    bot.use(createScopedQuoteRef(quoteRef));",
                ].join("\n"),
                [
                    "    bot.use(quoteRef({",
                    "        maxSize: 500,",
                    "        preferMsgElements: true,",
                    "    }));",
                ].join("\n"),
            ],
        ],
        "index.js": [
            ["export const inject = [\x27agents\x27, \x27tools\x27, \x27web\x27, \x27systemPrompt\x27];", "export const inject = [\x27agents\x27];"],
            ["export const inject = [\x27agents\x27, \x27tools\x27, \x27web\x27];", "export const inject = [\x27agents\x27];"]
        ],
        "transport/inbound.js": [
            ["import { setCurrentImages, clearCurrentImages } from \x27/opt/qqbot-defaults/qqbot-chat-policy.mjs\x27;\n", ""],
            ["    const chatOnlyAgent = record.agent;\n", ""],
            ["    // Chat-only current-and-quoted image scope v2.\n", ""],
            ["// Chat-only current-and-quoted image scope v2.\n", ""],
            ["    setCurrentImages(chatOnlyAgent, [...(mwState.downloadedFiles ?? []), ...(mwState.downloadedQuoteFiles ?? [])]);\n", ""],
            ["    setCurrentImages(chatOnlyAgent, mwState.downloadedFiles ?? []);\n", ""],
            ["    chatOnlyAgent.followup(message);", "    record.agent.followup(message);"],
            ["        await chatOnlyAgent.whenIdle();", "        await record.agent.whenIdle();"],
            ["    } finally {\n        clearCurrentImages(chatOnlyAgent);\n", ""]
        ],
        "transport/attachment.js": [
            ["import { downloadCurrentQQImage } from \x27/opt/qqbot-defaults/qqbot-web-pages.mjs\x27;\n", ""],
            ["import { downloadCurrentQQImage } from \x27/opt/qqbot-defaults/qqbot-chat-policy.mjs\x27;\n", ""],
            ["// Chat-only current-image downloads v2.\n", ""],
            ["    // Chat-only current-image downloads v2.\n", ""],
            ["    // Chat-only downloads: images only.\n", ""],
            ["    const targets = (attachments ?? []).filter(a => classifyContentType(a.content_type) === \x27image\x27 && a.url);", "    const targets = (attachments ?? []).filter(a => classifyContentType(a.content_type) !== \x27voice\x27 && a.url);"],
            ["    const buf = await downloadCurrentQQImage(parsed.href, maxBytes);", "    " + "const resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });\n    if (!resp.ok)\n        throw new Error(`HTTP ${resp.status}`);\n    const buf = Buffer.from(await resp.arrayBuffer());\n    if (buf.length > maxBytes) {\n        throw new Error(`Download exceeds ${Math.floor(maxBytes / 1024 / 1024)}MB`);\n    }"],
            ["    const resp = await fetch(parsed.href, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: \x27error\x27 });", "    const resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });"],
            ["    const chunks = [];\n    let total = 0;\n    for await (const chunk of resp.body) {\n        total += chunk.length;\n        if (total > maxBytes) throw new Error(\x27QQ image download exceeds size limit\x27);\n        chunks.push(chunk);\n    }\n    const buf = Buffer.concat(chunks, total);", "    const buf = Buffer.from(await resp.arrayBuffer());\n    if (buf.length > maxBytes) {\n        throw new Error(`Download exceeds ${Math.floor(maxBytes / 1024 / 1024)}MB`);\n    }"]
        ],
        "media/vision-tool.js": [["        timeoutMs: vision.timeoutMs,\n", ""]]
    };
    for (const [file, replacements] of Object.entries(edits)) {
        const path = `${root}/${file}`;
        let text = fs.readFileSync(path, "utf8");
        for (const [before, after] of replacements) {
            if (text.includes(before)) text = text.replace(before, after);
        }
        fs.writeFileSync(path, text);
    }
    const replaceExactlyOnce = (text, before, after, label) => {
        const parts = text.split(before);
        if (parts.length !== 2) throw new Error(`legacy fixture expected one ${label}`);
        return parts[0] + after + parts[1];
    };
    const visionPath = `${root}/media/vision-tool.js`;
    let vision = fs.readFileSync(visionPath, "utf8");
    const visionImport = "import { existsSync, readFileSync, writeFileSync } from \x27node:fs\x27;\n";
    vision = replaceExactlyOnce(vision, visionImport,
        visionImport + "import { readFile, stat } from \x27node:fs/promises\x27;\n", "stock fs imports");
    vision = replaceExactlyOnce(vision,
        "import { loadChatImageBytes } from \x27/opt/qqbot-defaults/qqbot-chat-policy.mjs\x27;\n", "", "v3 helper import");
    const v3Description = [
        "// Chat-only image schema: scoped QQ media paths or public HTTPS image URLs v3.",
        "const DESCRIPTION = \x27Inspect one image and return the text the user needs. The image must be either an absolute path \x27",
        "    + \x27of an image attached to or explicitly quoted in the current QQ message and stored inside the QQ media directory, \x27",
        "    + \x27or a public HTTPS image URL. Other local paths, non-HTTPS URLs, and non-image files are forbidden. \x27",
        "    + \x27Use this when the user references an image, or when a task needs OCR, chart/diagram reading, screenshot or UI analysis, \x27",
        "    + \x27translation of image text, or photo understanding. Always pass an explicit `prompt` with a precise \x27",
        "    + \x27instruction (e.g. \"transcribe all text\", \"extract the table as CSV\", \"translate the text into Chinese\") \x27",
        "    + \x27instead of relying on the generic default.\x27;",
    ].join("\n");
    const v2Description = [
        "// Chat-only image schema: current and explicitly quoted QQ attachments v2.",
        "const DESCRIPTION = \x27Inspect one image and return the text the user needs. The image must be an absolute path \x27",
        "    + \x27of an image attached to or explicitly quoted in the current QQ message. URLs and other files are forbidden. \x27",
        "    + \x27Use this when the user references an image, or when a task needs OCR, chart/diagram reading, screenshot or UI analysis, \x27",
        "    + \x27translation of image text, or photo understanding. Always pass an explicit `prompt` with a precise \x27",
        "    + \x27instruction (e.g. \"transcribe all text\", \"extract the table as CSV\", \"translate the text into Chinese\") \x27",
        "    + \x27instead of relying on the generic default.\x27;",
    ].join("\n");
    vision = replaceExactlyOnce(vision, v3Description, v2Description, "v3 schema description");
    vision = replaceExactlyOnce(vision,
        "                    description: \x27Absolute path of a current-message or explicitly quoted image inside the QQ media directory, or a public HTTPS image URL.\x27,",
        "                    description: \x27Absolute path of an image attached to or explicitly quoted in the current QQ message. URLs and other files are forbidden.\x27,",
        "v3 image parameter description");
    const v3Loader = [
        "// Chat-only scoped image loader v3.",
        "async function loadImageBytes(image, maxBytes, exec) {",
        "    const data = await loadChatImageBytes(image, maxBytes, exec);",
        "    const mediaType = sniffImageMediaType(data);",
        "    if (mediaType === null)",
        "        throw new Error(\x27qqbot_describe_image: unrecognized image format (png/jpeg/gif/webp only)\x27);",
        "    return { data, mediaType };",
        "}",
    ].join("\n");
    const stockLoader = [
        "/** 加载图片字节（本地路径 / http URL），校验大小 + 嗅探 MIME */",
        "async function loadImageBytes(image, maxBytes, signal) {",
        "    let data;",
        "    if (/^https?:\\/\\//i.test(image)) {",
        "        const resp = await fetch(image, { signal, redirect: \x27error\x27 });",
        "        if (!resp.ok)",
        "            throw new Error(`qqbot_describe_image: download failed (HTTP ${resp.status})`);",
        "        const buf = Buffer.from(await resp.arrayBuffer());",
        "        if (buf.length > maxBytes)",
        "            throw new Error(`qqbot_describe_image: image too large (${buf.length} bytes)`);",
        "        data = new Uint8Array(buf);",
        "    }",
        "    else {",
        "        const info = await stat(image).catch(() => null);",
        "        if (!info?.isFile())",
        "            throw new Error(`qqbot_describe_image: image file not found: ${image}`);",
        "        if (info.size > maxBytes)",
        "            throw new Error(`qqbot_describe_image: image too large (${info.size} bytes)`);",
        "        data = new Uint8Array(await readFile(image));",
        "    }",
        "    const mediaType = sniffImageMediaType(data);",
        "    if (mediaType === null)",
        "        throw new Error(\x27qqbot_describe_image: unrecognized image format (png/jpeg/gif/webp only)\x27);",
        "    return { data, mediaType };",
        "}",
    ].join("\n");
    vision = replaceExactlyOnce(vision, v3Loader, stockLoader, "v3 image loader");
    vision = replaceExactlyOnce(vision,
        "loadImageBytes(image, vision.maxBytes, exec)",
        "loadImageBytes(image, vision.maxBytes, exec.signal)", "v3 execute argument");
    fs.writeFileSync(visionPath, vision);
    const middlewarePath = `${root}/middleware/attachment.js`;
    let middleware = fs.readFileSync(middlewarePath, "utf8");
    const quoteMarker = "            // Chat-only quoted-image downloads v2.\n";
    const patchedQuote = "            // Chat-only quote attachments: never downloaded.\n            // Keep quote text/metadata available to the conversation, but only current-message images may enter the cache.\n            ctx.state.downloadedQuoteFiles = [];";
    if (middleware.includes(quoteMarker)) {
        middleware = middleware.replace(quoteMarker, "");
        fs.writeFileSync(middlewarePath, middleware);
    }
    else if (middleware.includes(patchedQuote)) {
        middleware = middleware.replace(patchedQuote, originalQuoteBlock);
        fs.writeFileSync(middlewarePath, middleware);
    }
    const mediaCleanerPath = `${root}/media/media-cleaner.js`;
    let mediaCleaner = fs.readFileSync(mediaCleanerPath, "utf8");
    mediaCleaner = replaceExactlyOnce(mediaCleaner,
        "// Chat-only persistent media root v1.\nexport const MEDIA_ROOT = \x27/data/qqbot-media\x27;",
        "export const MEDIA_ROOT = resolve(homedir(), \x27.dsh-qqbot\x27, \x27media\x27);",
        "persistent media root");
    mediaCleaner = replaceExactlyOnce(mediaCleaner,
        "import { join } from \x27node:path\x27;\n",
        "import { join, resolve } from \x27node:path\x27;\n",
        "media cleaner path import");
    mediaCleaner = replaceExactlyOnce(mediaCleaner,
        "import { join, resolve } from \x27node:path\x27;\n",
        "import { join, resolve } from \x27node:path\x27;\nimport { homedir } from \x27node:os\x27;\n",
        "legacy media cleaner os import");
    fs.writeFileSync(mediaCleanerPath, mediaCleaner);
    if (!mediaCleaner.includes("export const MEDIA_ROOT = resolve(homedir(), \x27.dsh-qqbot\x27, \x27media\x27);")
        || !mediaCleaner.includes("import { join, resolve } from \x27node:path\x27;")
        || !mediaCleaner.includes("import { homedir } from \x27node:os\x27;")
        || mediaCleaner.includes("Chat-only persistent media root v1.")) {
        throw new Error("legacy fixture did not restore the original media root");
    }
    const legacyMarkers = [
        ["gateway/bootstrap.js", "installChatPolicy"],
        ["gateway/bootstrap.js", "Chat-only deployment: file sending is not registered."],
        ["gateway/middleware-setup.js", "createScopedQuoteRef"],
        ["gateway/middleware-setup.js", "Chat-only scoped quote references prevent cross-peer message-key collisions."],
        ["index.js", "export const inject = [\x27agents\x27, \x27tools\x27, \x27web\x27, \x27systemPrompt\x27];"],
        ["transport/inbound.js", "Chat-only current-and-quoted image scope v2."],
        ["transport/inbound.js", "setCurrentImages"],
        ["transport/inbound.js", "clearCurrentImages"],
        ["transport/attachment.js", "downloadCurrentQQImage"],
        ["transport/attachment.js", "Chat-only current-image downloads v2."],
        ["middleware/attachment.js", "Chat-only quoted-image downloads v2."],
        ["media/vision-tool.js", "timeoutMs: vision.timeoutMs"],
        ["media/vision-tool.js", "loadChatImageBytes"],
        ["media/vision-tool.js", "Chat-only scoped image loader v3."],
        ["media/vision-tool.js", "scoped QQ media paths or public HTTPS image URLs v3."],
        ["media/media-cleaner.js", "Chat-only persistent media root v1."]
    ];
    for (const [file, marker] of legacyMarkers) {
        if (fs.readFileSync(`${root}/${file}`, "utf8").includes(marker)) throw new Error(`legacy fixture still patched: ${file}`);
    }
    const restoredVision = fs.readFileSync(visionPath, "utf8");
    if (!restoredVision.includes("async function loadImageBytes(image, maxBytes, signal)")
        || !restoredVision.includes("loadImageBytes(image, vision.maxBytes, exec.signal)")
        || !restoredVision.includes("Chat-only image schema: current and explicitly quoted QQ attachments v2.")) {
        throw new Error("legacy fixture did not restore the original loader and v2 schema");
    }
'
docker run --rm \
    --network none \
    --volume "${legacy_data_volume}:/data" \
    --mount "type=bind,src=${chat_policy_test},dst=/tmp/test-chat-policy.mjs,readonly" \
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
        node --check "/data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/$file"
    done
    grep -Fq "import { installChatPolicy } from '\''/opt/qqbot-defaults/qqbot-chat-policy.mjs'\'';" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/gateway/bootstrap.js
    grep -Fq "import {createScopedQuoteRef} from '\''/opt/qqbot-defaults/qqbot-chat-policy.mjs'\'';" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/gateway/middleware-setup.js
    grep -Fq "bot.use(createScopedQuoteRef(quoteRef));" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/gateway/middleware-setup.js
    grep -Fq "Chat-only current-image downloads v2." /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/transport/attachment.js
    grep -Fq "Chat-only quoted-image downloads v2." /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/middleware/attachment.js
    grep -Fq "timeoutMs: vision.timeoutMs" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/media/vision-tool.js
    grep -Fq "import { loadChatImageBytes } from '\''/opt/qqbot-defaults/qqbot-chat-policy.mjs'\'';" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/media/vision-tool.js
    grep -Fq "Chat-only scoped image loader v3." /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/media/vision-tool.js
    grep -Fq "loadImageBytes(image, vision.maxBytes, exec)" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/media/vision-tool.js
    grep -Fq "// Chat-only persistent media root v1." /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/media/media-cleaner.js
    grep -Fq "export const MEDIA_ROOT = '\''/data/qqbot-media'\'';" /data/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/dist/media/media-cleaner.js
    node --test /tmp/test-chat-policy.mjs
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
grep -Fq "Chat-only patches require dsh-qqbot 0.5.0" "$incompatible_log"

cmd="$(docker image inspect --format '{{json .Config.Cmd}}' "$IMAGE")"
log "Checking default image command"
if [[ "$cmd" != '["dsh","--profile","qqbot"]' ]]; then
    echo "Unexpected default image command: $cmd" >&2
    exit 1
fi

log "Scanning image configuration for injected secret names"
if docker image inspect "$IMAGE" | grep -Eqi 'DEEPSEEK_API_KEY|LLM_API_KEY|QQBOT_SECRET'; then
    echo "Secret variable name unexpectedly present in image configuration" >&2
    exit 1
fi

log "Scanning image history for injected secret names"
if docker history --no-trunc "$IMAGE" | grep -Eqi 'DEEPSEEK_API_KEY|LLM_API_KEY|QQBOT_SECRET'; then
    echo "Secret variable name unexpectedly present in image history" >&2
    exit 1
fi

log "Passed: seed, profile, plugin, workspace, persistence, config policy, chat regression, and image secret scan"
