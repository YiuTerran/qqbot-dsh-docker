# dsh-qqbot Docker 镜像

本仓库提供适用于通用 Docker/Linux 容器环境的腾讯
[`dsh-qqbot`](https://github.com/tencent-connect/dsh-qqbot) 镜像，支持 `linux/amd64` 和 `linux/arm64`。使用者可通过 Docker Compose 拉取并运行带版本号的镜像，配置环境变量并挂载两个 Docker 命名卷。

镜像不会发布任何端口。QQ Bot 连接器通过出站 WebSocket
建立连接，因此按预期运行时容器无需开放入站端口。

## 镜像中固定的组件

| 组件 | 版本 |
| --- | --- |
| 基础镜像 | 官方 `node:24.14.0-bookworm-slim@sha256:d8e448a…e33d8`（Debian slim） |
| pnpm | `12.6.0` |
| dsh | `@deepseek-ai/dsh@0.1.7-rc.2` |
| QQ 插件 | `@tencent-connect/dsh-qqbot@0.5.0` |

该插件声明支持从 `0.1.0-rc.6` 开始的 dsh 组件 API。dsh 将插件安装交由 `pnpm`
处理，因此镜像会显式安装插件。Dockerfile 中固定了各软件包版本、Node 24.14.0 镜像标签及其多架构清单摘要。

镜像还包含 `bubblewrap`（`bwrap`），作为纵深防御。启动器会将 DSH 沙箱模式强制设为
`read-only`，但仅靠这个设置**并不能**禁用 Shell：只读 Shell 仍可检查数据。真正的纯聊天边界由不可变工具覆盖层和运行时守卫共同实现；它们会禁用
Shell、代码、文件、任务、子 Agent 和工作流，并在执行前拒绝未知或新注入的工具。确认操作也不能绕过该守卫。Bubblewrap
和只读设置是辅助控制措施，并非聊天策略本身；管理员若运行其他 DSH 命令并触及被 Bubblewrap
阻止的路径，命令会因安全检查失败而被拒绝执行。

构建镜像时，dsh 会创建 `qqbot` 配置档案，并将插件安装到
`/opt/dsh-seed`。运行时 `DSH_HOME=/data`。仅当 `/data/.initialized` 不存在时，入口脚本才会将初始内容复制到
`/data`；不会覆盖已初始化的卷。`tini` 是 PID 1，dsh 进程以非特权
`node` 用户运行。默认命令为：

```text
dsh --profile qqbot
```

## 纯聊天能力

本机器人定位为对话式 QQ Bot；除普通文字回复外，仅提供以下两项严格受限的能力：

- 它可以分析**当前 QQ 消息**附带的图片或 GIF、该消息明确引用的图片，或公共 HTTPS 图片 URL。
  本地路径必须是 `/data/qqbot-media` 内的普通文件，并且已登记为当前消息或引用图片；任意工作区路径、未引用的历史附件以及其他会话的附件都会被拒绝。
  两类输入均限制为 10 MB。URL 必须使用 HTTPS，且不得嵌入凭据；拒绝重定向，且只接受内联的 PNG、JPEG、GIF 或 WEBP 响应，并要求 MIME 类型与图片字节相符。在读取字节、保存图片附件或调用视觉模型前，工具内部会再次检查路径或 URL。URL 内容会先经过同一套校验公网 IP、限制大小并在内存中处理的下载器，再进入插件现有的视觉附件流程。这不会开放通用文件下载；URL 辅助程序本身不会写入缓存文件。传输缓存的 TTL 为 1 小时，并按小时清理；这不代表下游附件存储中的每个字节都会在恰好 1 小时后删除。当前消息的本地关联会在本轮结束时清除。
- 它可以对公共 `http://` 或 `https://` URL 使用 `web_fetch`，前提是响应为 HTML/XHTML。网页内容有大小限制，并在内存中转换为文本；不会运行脚本，也不会将响应保存为文件。PDF、ZIP、图片、纯文本、附件和其他文件类型的响应都会被拒绝。网页搜索已禁用，网页文本一律视为不可信数据。

私聊和群聊中均不可使用 Shell 命令、代码执行、通用文件读写、文件发送、文件下载、后台任务、子 Agent、工作流及类似环境操作。机器人可以解释命令或以文本展示代码，但绝不会运行。用户确认或自定义人设都不能取消这些限制。

## 通用 Docker Compose 部署

将以下内容保存为 `compose.yaml`，并在同一目录创建 `.env`。将 `YOUR_TAG` 替换为 Docker Hub 上已发布的镜像版本标签。`.env` 至少填写镜像标签、QQ Bot 凭据；若使用 dsh 默认的 `deepseek-official` 路由，再填写 `DEEPSEEK_API_KEY`。不要将密钥写入 `compose.yaml` 或提交到版本库。

```yaml
services:
  qqbot:
    image: "tryao/qqbot-dsh:${IMAGE_TAG:?Set IMAGE_TAG to a published version tag}"
    container_name: dsh-qqbot
    restart: unless-stopped
    environment:
      TZ: Asia/Taipei
      DSH_HOME: /data
      DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY:-}
      LLM_API_KEY: ${LLM_API_KEY:-}
      LLM_PROVIDER: ${LLM_PROVIDER:-}
      LLM_MODEL: ${LLM_MODEL:-}
      LLM_API_BASE_URL: ${LLM_API_BASE_URL:-}
      LLM_API_PROTOCOL: ${LLM_API_PROTOCOL:-}
      QQBOT_VISION_PROVIDER: ${QQBOT_VISION_PROVIDER:-}
      QQBOT_VISION_MODEL: ${QQBOT_VISION_MODEL:-}
      QQBOT_MEDIA_ENABLED: ${QQBOT_MEDIA_ENABLED:-true}
      QQBOT_VISION_ENABLED: ${QQBOT_VISION_ENABLED:-true}
      QQBOT_STARTUP_WARN_MS: ${QQBOT_STARTUP_WARN_MS:-20000}
      QQBOT_APPID: ${QQBOT_APPID}
      QQBOT_SECRET: ${QQBOT_SECRET}
    volumes:
      - dsh-data:/data
      - dsh-workspace:/workspace

volumes:
  dsh-data:
    name: dsh-qqbot-data
  dsh-workspace:
    name: dsh-qqbot-workspace
```

创建 `.env`，并把 `YOUR_TAG` 换成已发布的版本标签：

```dotenv
IMAGE_TAG=YOUR_TAG
DEEPSEEK_API_KEY=
QQBOT_APPID=
QQBOT_SECRET=
```

在包含 `compose.yaml` 和 `.env` 的目录中启动容器，并查看日志：

```sh
docker compose up -d
docker compose logs -f qqbot
```

Compose 会创建并使用命名卷 `dsh-qqbot-data` 和 `dsh-qqbot-workspace`。请勿添加端口映射、Docker socket、特权模式或主机网络；本镜像通过出站 WebSocket 连接 QQ，无需开放入站端口。入口脚本始终强制使用 `read-only`，但该设置本身不能保证 Shell 命令安全；纯聊天边界仍由禁用工具和运行时守卫实现。不要设置 `DSH_PERMISSION_MODE`。

首次启动时会初始化 `/data`，后续启动会保留其中内容。QQ 插件的媒体清理器会将传输缓存直接存放在 `/data/qqbot-media`，因此复用同一个数据卷时，更换容器后这些缓存文件仍会保留。
缓存仍采用 1 小时 TTL 并按小时清理；持久化不会延长保留时间，也不会保留图片授权。即使缓存文件仍在磁盘上，也只有通过现有检查的当前消息图片或明确引用的图片才可使用。`/home/node/.dsh-qqbot/media` 下的旧文件不会自动使用或迁移；请重新发送或明确引用图片，以便将其下载到持久缓存中。如果提供的凭据不完整，QQ 插件可能会引导完成首次凭据设置。本地测试会刻意避开交互式二维码流程。

仅存在于旧容器可写层中的媒体不会自动复制；旧容器删除后也无法恢复。替换旧容器前，请将需要的缓存文件复制到主机备份目录：

```sh
mkdir -p ./qqbot-media-backup
docker cp -a old-container:/home/node/.dsh-qqbot/media/. ./qqbot-media-backup/
```

使用现有的 `dsh-qqbot-data` 卷创建新容器，启动一次以初始化 `/data/qqbot-media`，然后停止容器再恢复文件。将下方的
`YOUR_NEW_TAG` 替换为支持媒体持久化的新镜像标签；恢复时只复制新缓存中尚不存在的文件：

```sh
docker run --rm --network none \
  --volume dsh-qqbot-data:/data \
  --volume "$PWD/qqbot-media-backup:/backup:ro" \
  --entrypoint sh tryao/qqbot-dsh:YOUR_NEW_TAG -ec \
  'test -d /data/qqbot-media && test ! -L /data/qqbot-media && cp -an /backup/. /data/qqbot-media/ && chown node:node /data/qqbot-media'
```

恢复操作只会修改 `/data/qqbot-media`，不会替换 `/data/AGENTS.md` 或卷中的其他内容。恢复的文件仍受常规 TTL 清理和当前消息/明确引用授权检查约束。

为便于运维观察，镜像会输出三条不含秘密信息的 QQ 启动日志：凭据已解析、已请求连接网关，以及 `Bot ready!` 或 SDK 启动错误。如果 20 秒后仍未就绪，会输出警告，提示检查 DNS、TLS/代理出站连接或 QQ Bot 凭据与权限。设置 `QQBOT_STARTUP_WARN_MS` 可调整警告阈值；此操作不会终止或重启仍在重试的连接。

镜像还会报告网关连接前初始化过程中的异常，包括媒体和视觉工具注册错误。现有 `/data` 卷会在启动时打补丁，因此这项诊断增强无需删除会话或设置。若要临时隔离启动问题，可设置 `QQBOT_VISION_ENABLED=false`；必要时也可设置 `QQBOT_MEDIA_ENABLED=false`。这两项默认均为启用。

## 默认人设与安全策略

首次启动时，镜像会根据内置默认内容创建 `/data/AGENTS.md`。该文件定义了 **Blue Big Fat Fish**（蓝色大肥鱼）鲸鱼娘女仆人设、优先使用中文的简洁回复风格以及通用安全约定。DSH 会将此文件作为全局 Agent 指令文件加载。

用户无需重新构建镜像即可替换人设：将自己的普通文件以**只读**方式绑定挂载到 `/data/AGENTS.md`。这可以与命名 `/data` 卷同时使用，因为入口脚本会分别初始化 dsh 配置档案和指令文件；脚本不会递归执行 `chown` `/data`，否则只读文件挂载会导致失败。

使用 Compose 时，可选的附加挂载配置如下：

```yaml
    volumes:
      - dsh-data:/data
      - ./my-bot-instructions.md:/data/AGENTS.md:ro
      - dsh-workspace:/workspace
```

将自己的文件以只读方式挂载到 `/data/AGENTS.md`，即可替换人设和软性行为指引，但不会移除镜像的传输层策略：群聊消息必须提及机器人；只有当前消息图片/GIF（包括明确引用的图片）和公共 HTTPS 图片 URL 可以进入受限视觉流程；只有公共 HTML/XHTML 可以交给 `web_fetch`；Shell、代码、文件操作、文件发送、文件下载和后台工作仍不可用。入口脚本也会强制 DSH 使用 `read-only`；不要把自定义人设当作安全机制。升级时会保留已有的 `/data/AGENTS.md`；如果其中的人设禁止图片 URL，请修改软性指引，使其与本文所述的公共 HTTPS 图片能力一致。

视觉能力会自动复用 `LLM_PROVIDER` / `LLM_MODEL`，因此第三方多模态路由无需另配模型或密钥。未配置 `LLM_*` 路由时，会使用内置的 `deepseek-official` / `deepseek-flash` 路由。只有在视觉能力需要使用不同的多模态路由时，才设置 `QQBOT_VISION_PROVIDER` 和 `QQBOT_VISION_MODEL`。所选模型必须确实支持图片输入；生成的提供者声明中的 `input: [text, image]` 只表示该路由符合 dsh 的候选条件，并不会让纯文本模型获得多模态能力。

## 第三方 / OpenAI 兼容模型提供者

QQ 不限于官方 DeepSeek API。`dsh-qqbot` 按以下顺序确定模型路由：QQ 会话通过 `/model` 选择的模型、QQ 插件中显式配置的路由、dsh 当前默认模型，最后回退到 `deepseek-official`。请在此容器使用的**同一个 `qqbot` 配置档案**中配置 OpenAI 兼容提供者，然后将其选为 dsh 默认模型，或在 QQ 中使用 `/model` 选择。

如果使用官方配置，只需在 `.env` 中设置 `DEEPSEEK_API_KEY`；dsh 会使用内置的 `deepseek-official` 默认路由。此时无需设置任何 `LLM_*` 变量。

使用第三方提供者时，请在 `.env` 中设置所需的 `LLM_*` 变量。入口脚本会将不含密钥的提供者路由写入持久化的 `qqbot` 配置档案，并设为 dsh 默认模型。可参考以下配置（替换为实际的模型名称、网关地址和 API 密钥）：

| 变量 | 示例值 |
| --- | --- |
| `LLM_PROVIDER` | `my-openai-responses` |
| `LLM_MODEL` | `your-model` |
| `LLM_API_BASE_URL` | `https://gateway.example.com/v1` |
| `LLM_API_PROTOCOL` | `openai-responses` |
| `LLM_API_KEY` | 你的网关 API 密钥 |

将这些变量追加到 `.env`，并填写实际的模型名称和 API 密钥：

```dotenv
LLM_PROVIDER=my-openai-responses
LLM_MODEL=your-model
LLM_API_BASE_URL=https://gateway.example.com/v1
LLM_API_PROTOCOL=openai-responses
LLM_API_KEY=
```

`LLM_PROVIDER`、`LLM_MODEL`、`LLM_API_BASE_URL` 和 `LLM_API_KEY` 必须同时设置。`LLM_API_PROTOCOL` 为可选项，默认值是 `openai-responses`（仅在提供者要求时使用 `openai-completions`）。`LLM_PROVIDER` 只能包含小写字母、数字和连字符。密钥绝不会写入 `/data`。修改这些值后，下次启动容器时会更新生成的路由。若要继续使用官方 `DEEPSEEK_API_KEY` 路由或手动配置的 dsh 路由，请省略所有 `LLM_*` 变量。

对于 dsh Models 界面中类似的路由，相应的提供者配置如下；其中不包含密钥：

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
          - id: your-model
            name: your-model
- id: agent-default-model
  config:
    provider: my-openai-responses
    model: your-model
```

请通过 `qqbot` 配置档案的 dsh Models/Settings 界面保存这些设置，或将等效条目添加到 `/data/profiles/qqbot/cordis.patch.yml`。可将这些变量追加到 `.env`；`LLM_API_KEY` 绝不能写入 YAML 文件。容器会将 dsh 旧版 `~/.dsh` 设置视图映射回持久化的 `/data` 卷，因此 QQ 插件与 dsh 读取的是同一份模型状态。单独桌面配置档案中的提供者不会自动供此容器使用。

## 本地验证

维护者可运行以下脚本，在本地验证镜像和安全策略：

```bash
./scripts/test-local.sh
```

该脚本会构建当前平台的镜像，为运行时状态使用临时命名卷，并且只挂载只读的回归测试脚本和配置档案探测脚本。它会验证首次初始化、`qqbot` 配置档案、插件版本、`dsh`、只读指令文件挂载、最终的 `native`/禁用/web-provider 配置（包括不启动 Agent）、镜像内真实的 `ToolRuntime` 策略测试，以及使用封装 QQ SDK 的完整本地 Cordis 配置档案启动流程。之后还会验证使用相同卷重启、容器重建前后的媒体缓存字节、为未打补丁的旧配置档案严格打补丁、拒绝不兼容的插件版本、默认命令，以及镜像历史/配置中的密钥扫描。它不会连接 QQ 或付费模型 API，也不是真实的 QQ 端到端测试。它只会删除自己创建的临时容器和卷。

## 升级、回滚与备份

持久化状态位于 `dsh-qqbot-data`；请使用 Docker 卷备份工具创建备份。删除容器时不得删除这两个命名卷。

升级前，请为两个命名卷创建可恢复的备份或快照。持久化配置档案会原地打补丁，并导入新镜像提供的策略模块，因此在新镜像通过检查前，请保留升级前的备份。升级时，拉取一个明确指定的新镜像标签，并在创建或更新容器时继续挂载**相同的** `dsh-qqbot-data` 和
`dsh-qqbot-workspace` 卷。例如：

```text
tryao/qqbot-dsh:v0.1.0
    + dsh-qqbot-data + dsh-qqbot-workspace
        -> tryao/qqbot-dsh:v0.2.0
```

如果新镜像运行异常，请先停止容器，然后同时恢复升级前的卷备份并使用旧标签。不要将缺少
`/opt/qqbot-defaults/{chat-policy,web-pages}.mjs` 的旧标签用于已经升级过的卷，也不要用空卷替换现有卷：恢复升级前的快照可以保留会话，并还原旧镜像所需的配置档案布局。每次启动时，入口脚本都会严格地将纯聊天补丁重新应用到持久化的 `@tencent-connect/dsh-qqbot@0.5.0` 布局。未打补丁的旧配置档案会原地升级且不删除会话；若插件布局缺失、已更改或不受支持，启动会因安全检查失败而被拒绝，不会在缺少策略的情况下继续运行。此保证仅针对固定的 `0.5.0` 适配器，不承诺兼容其他插件版本。

## 安全与访问控制

密钥只通过运行时环境变量提供；不会复制到镜像中。构建时不会打包宿主机的依赖目录；运行时无需挂载宿主机目录或 Docker socket，机器人的工作目录为 `/workspace`。

此镜像将私聊和群聊准入交由 QQ 开放平台自身的白名单和权限设置管理，不会在容器中重复配置这些 OpenID。群聊消息必须 @提及机器人。镜像的强制边界由不可变传输层覆盖和聊天策略守卫实现：只有用于处理 QQ 媒体目录内当前消息图片或明确引用图片，以及公共 HTTPS 图片 URL 的视觉工具，还有受限的公共 HTML `web_fetch` 可以调用。镜像还会移除网页搜索提供者、禁用自动启动的 `agent-loop` 智能体，并强制使用原生工具呈现方式。只读沙箱、容器隔离和媒体大小限制属于纵深防御；`read-only` 本身不会禁止 Shell。网页读取器会校验目标为公网地址、固定已校验的连接、直接发送请求而不使用 HTTP 代理，并且绝不写入下载文件。引用缓存键会按聊天类型和对端隔离（私聊使用发送者，群聊使用群组）；无法识别对端的消息不会缓存，但显式引用仍可使用当前 QQ 消息元素回退机制。已配置的 LLM 提供者仍可使用模型端点代理设置。

用于读取公共网页和下载当前 QQ 图片的容器 DNS 必须返回目标的真实公网 IP。公网目标检查会拒绝 `198.18.0.0/15` 等 Fake-IP 响应；如果 Docker DNS 返回此类地址，请调整 Docker DNS 配置，不要关闭检查。这些请求均为直连，不使用模型端点代理。离线回归测试无法证明能够访问公共互联网、QQ 或付费多模态模型；请使用合适的测试凭据和服务策略，分别验证这些集成。

替换 `/data/AGENTS.md` 仅支持更改人设和其他软性对话指引。它不能注册新能力、放宽守卫，也不能授权 Shell、代码、文件、下载、后台操作或跨会话访问。
