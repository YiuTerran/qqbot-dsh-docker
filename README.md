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

本机器人定位为对话式 QQ Bot；除普通文字回复外，还提供以下五项严格受限的能力：

- 它可以分析**当前 QQ 消息**附带的图片或 GIF、该消息明确引用的图片，或公共 HTTPS 图片 URL。
  本地路径必须是 `/data/qqbot-media` 内的普通文件，并且已登记为当前消息或引用图片；任意工作区路径、未引用的历史附件以及其他会话的附件都会被拒绝。
  两类输入均限制为 10 MB。URL 必须使用 HTTPS，且不得嵌入凭据；拒绝重定向，且只接受内联的 PNG、JPEG、GIF 或 WEBP 响应，并要求 MIME 类型与图片字节相符。在读取字节、保存图片附件或调用视觉模型前，工具内部会再次检查路径或 URL。URL 内容会先经过同一套校验公网 IP、限制大小并在内存中处理的下载器，再进入插件现有的视觉附件流程。这不会开放通用文件下载；URL 辅助程序本身不会写入缓存文件。传输缓存的 TTL 为 1 小时，并按小时清理；这不代表下游附件存储中的每个字节都会在恰好 1 小时后删除。当前消息的本地关联会在本轮结束时清除。
- 它可以用 `web_search` 按关键词发现网页。每次最多提交 4 个查询，合并后最多返回 8 个来源；搜索结果是外部不可信数据，不是指令。
- 它可以用 `web_fetch` 阅读经过公网校验的公共 `http://` 或 `https://` 响应。接受 `text/*`（不含 RTF/richtext）、`application/xhtml+xml`、`application/json`、`application/*+json`、`application/yaml`、`application/x-yaml`、`application/xml` 和 `application/*+xml`。HTML 转为文本，其他允许内容按文本原样读取；不会用数据格式解析器处理、解析外部资源或执行其中的内容。每次请求限时 30 秒、响应最多 2 MiB，最多向模型返回 100,000 个字符，并标记输出截断。文本响应即使声明为下载附件也只在内存中读取，不写入磁盘。拒绝未知或 `application/octet-stream` 类型，以及伪装成文本的 PDF、Office、ZIP、图片或可执行文件。搜索到的来源可用 `web_fetch` 阅读；网页和文本均为不可信输入。
- 主人可以让机器人阅读当前 QQ 消息附带或明确引用的文本文件。机器人只会看到不透明的附件 ID 和少量元数据，再按需调用 `qqbot_read_document`；附件原始/签名下载 URL 和磁盘路径不会暴露给模型。最多每轮 4 个文件、每个 512 KiB、每次读取返回最多 50,000 个字符，每轮返回总量最多 100,000 个字符，缓存重读也计入总量。本轮结束时授权撤销、进行中的读取取消，本轮缓存清空。只支持纯文本；当 MIME 缺失、为 `application/octet-stream`，或 QQ 只提供通用文件元数据时，才会按 `.txt`、`.md`、`.markdown`、`.json`、`.yaml`、`.yml`、`.csv`、`.tsv`、`.log`、`.xml`、`.ini`、`.toml` 后缀白名单回退，并进行严格解码和二进制检查。字符集只接受有效的声明值、UTF-16 BOM 或默认 UTF-8，不猜测编码；请将无法解码的文件转成 UTF-8 后重发。PDF、Word、Excel 及其他复杂格式仍不支持。附件不会写入磁盘，原始/签名下载 URL 不会暴露给模型或写入持久配置；文档正文中的普通 URL 可能随文本交给当前配置的 LLM，并进入现有聊天历史。

当 QQ 消息带有文档，或 `web_fetch` 实际读到非 HTML 的文本响应时，本轮进入文档保护模式：远程 `web_fetch` 和图片 URL 视觉分析只接受当前用户消息中明确写出的完整规范化 URL，以及成功结构化搜索结果提供的来源 URL；不会从文档正文或嵌入资源中自动发现、跟随链接，也不会从普通文本生成 URL。文档正文、历史消息、引用消息或新拼出的查询参数中出现的 URL 不会自动获准；需要打开文档里的链接时，请把完整链接单独发在新的消息中。`web_search` 仍会把关键词发送到部署者配置的搜索服务，因此这不保证文本不会离开容器；文档或网页中的内容也不能更改安全规则。

私聊和群聊中均不可使用 Shell 命令、代码执行、通用文件读写、文件发送、通用文件下载、后台任务、子 Agent、工作流及类似环境操作。受限文本读取只在内存中处理，不创建下载文件。机器人可以解释命令或以文本展示代码，但绝不会运行。用户确认或自定义人设都不能取消这些限制。

### TRPG 骰子

主人可以让机器人充当 TRPG 骰娘。群聊仍遵循 @bot 门控；自然语言掷骰由专用 `qqbot_roll_dice` 工具完成，多个相同骰式可通过 `repeat` 合并为一次调用。直接命令 `.r` 不调用模型、不写入模型会话历史或额外结果存储；需要后续解读时，请引用 QQ 返回的骰子结果或粘贴骰式与结果。直接命令按发送者和群限流：每 10 秒每位发送者最多 10 次、每个群最多 30 次，没有机器人实例总次数限制；超限时静默拒绝，限流窗口恢复后可再试。

命令格式为 `.r <骰式> [x次数]`；单独发送 `.r` 等于掷一次 d20。骰式忽略 ASCII 空格和大小写，必须以骰组开头，之后可用 `+` 或 `-` 添加骰组或整数修正值。

| 命令 | 含义 |
| --- | --- |
| `.r d20+5` | d20 检定并加 5 |
| `.r 2d6+1d4+3` | 混合伤害骰 |
| `.r 2d20kh1+5` | 优势检定，保留最高一颗 |
| `.r 2d20kl1+5` | 劣势检定，保留最低一颗 |
| `.r 4d6kh3 x6` | 掷六组属性骰，每组保留最高三颗 |
| `.r d100` | 百分骰 |

结果显示实际骰点、合计及舍弃的骰子（以 `×` 标记）。限制为最多 128 个字符、8 项、每骰面数 `1～1,000,000`、整数修正值绝对值不超过 `1,000,000`、每次最多重复 20 次且总计生成不超过 100 颗骰子；自然语言工具每轮最多 8 次独立调用、累计 200 颗骰子。骰点由 Node `crypto.randomInt` 生成。不执行 Python、Bash 或其他代码；不支持括号、乘除、爆骰、条件重掷、宏、暗骰或游戏规则裁定。机器人不得编造或修改骰点，也不得为挑选结果擅自重掷。普通跑团使用即可，不提供公开可验证或防部署者操纵的随机证明。

## 通用 Docker Compose 部署

将以下内容保存为 `compose.yaml`，并在同一目录创建 `.env`。将 `YOUR_TAG` 替换为 Docker Hub 上已发布的镜像版本标签。`.env` 至少填写镜像标签和 QQ Bot 凭据。选择官方模式时填写 `DEEPSEEK_API_KEY`；选择第三方模式时填写 `LLM_API_KEY` 和对应的 `LLM_*` 路由值。两种密钥不能同时设置。不要将密钥写入 `compose.yaml` 或提交到版本库。

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
      LLM_SEARCH_BASE_URL: ${LLM_SEARCH_BASE_URL:-}
      LLM_SEARCH_MODEL: ${LLM_SEARCH_MODEL:-}
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
# Set exactly one chat key. The official key enables official chat, vision, and search.
DEEPSEEK_API_KEY=
# Third-party mode: also set LLM_PROVIDER, LLM_MODEL, and LLM_API_BASE_URL.
LLM_API_KEY=
LLM_PROVIDER=
LLM_MODEL=
LLM_API_BASE_URL=
LLM_API_PROTOCOL=
# Optional in third-party mode. Blank disables only web_search.
LLM_SEARCH_BASE_URL=
# Optional native search model alias in either mode; blank defaults to deepseek-flash.
LLM_SEARCH_MODEL=
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
缓存仍采用 1 小时 TTL 并按小时清理；持久化不会延长保留时间，也不会保留图片授权。即使缓存文件仍在磁盘上，也只有通过现有检查的当前消息图片或明确引用的图片才可使用。

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

将自己的文件以只读方式挂载到 `/data/AGENTS.md`，即可替换人设和软性行为指引，但不会移除镜像的传输层策略：群聊消息必须提及机器人；当前消息或明确引用的图片和公共 HTTPS 图片 URL 才能进入受限视觉流程；网页通过关键词搜索和受限的公共网页/纯文本读取能力访问；当前消息或明确引用的纯文本附件可按需读取。Shell、代码执行、通用文件操作、文件发送、通用文件下载和后台工作仍不可用。入口脚本也会强制 DSH 使用 `read-only`；不要把自定义人设当作安全机制。升级时会保留已有的 `/data/AGENTS.md`，不会自动覆盖旧人设文件；如需同步更新其中的软性指引，请手动修改该文件。

视觉能力使用当前密钥模式选定的提供者：官方模式为 `deepseek-official`，第三方模式为 `LLM_PROVIDER`。设置 `QQBOT_VISION_PROVIDER` 时，它必须与当前模式的提供者相同；可用 `QQBOT_VISION_MODEL` 覆盖模型。第三方聊天和视觉共用 `LLM_API_KEY`。所选模型必须确实支持图片输入；提供者声明中的 `input: [text, image]` 只表示该路由符合 dsh 的候选条件，并不会让纯文本模型获得多模态能力。

## 第三方 / OpenAI 兼容模型提供者

QQ 不限于官方 DeepSeek API。`dsh-qqbot` 按以下顺序确定模型路由：QQ 会话通过 `/model` 选择的模型、QQ 插件中显式配置的路由、dsh 当前默认模型，最后回退到 `deepseek-official`。容器以当前密钥模式设置部署默认模型；若需要，可在 QQ 中使用 `/model` 为会话选择其他已配置模型。切换密钥模式会更新部署默认值，不会覆盖已有的会话级 `/model` 选择。

只设置 `DEEPSEEK_API_KEY` 会选择内置的 `deepseek-official` 聊天和视觉路由，并启用使用同一密钥的官方原生搜索。即使环境或持久化配置中残留 `LLM_PROVIDER` 等字段，也不会切换到第三方模式。启动时同时设置 `DEEPSEEK_API_KEY` 和 `LLM_API_KEY` 会被拒绝。

使用第三方提供者时，请在 `.env` 中设置所需的 `LLM_*` 变量。入口脚本会将不含密钥的提供者路由写入持久化的 `qqbot` 配置档案，并设为 dsh 默认模型。可参考以下配置（替换为实际的模型名称、网关地址和 API 密钥）：

| 变量 | 示例值 |
| --- | --- |
| `LLM_PROVIDER` | `my-openai-responses` |
| `LLM_MODEL` | `your-model` |
| `LLM_API_BASE_URL` | `https://gateway.example.com/v1` |
| `LLM_API_PROTOCOL` | `openai-responses` |
| `LLM_API_KEY` | 你的网关 API 密钥 |
| `LLM_SEARCH_BASE_URL` | 可选的 Anthropic Messages 原生搜索地址；留空时关闭第三方模式的搜索 |
| `LLM_SEARCH_MODEL` | 可选的原生搜索模型名；两种密钥模式均适用，留空时为 `deepseek-flash` |

将这些变量追加到 `.env`，并填写实际的模型名称和 API 密钥：

```dotenv
LLM_PROVIDER=my-openai-responses
LLM_MODEL=your-model
LLM_API_BASE_URL=https://gateway.example.com/v1
LLM_API_PROTOCOL=openai-responses
LLM_API_KEY=
```

`LLM_PROVIDER`、`LLM_MODEL`、`LLM_API_BASE_URL` 和 `LLM_API_KEY` 必须同时设置。

`LLM_API_PROTOCOL` 为可选项，**仅支持以下两个值**：

- `openai-responses`：OpenAI Responses API；未设置或留空时的默认值。
- `openai-completions`：OpenAI Chat Completions API（不是旧版文本 Completions API）；提供者仅支持 Chat Completions 时使用。

请按提供者支持的接口选择，容器不会自动探测协议；其他值会导致启动校验失败。该变量只控制第三方聊天和视觉接口，不控制 `LLM_SEARCH_BASE_URL` 对应的原生搜索协议。

`LLM_PROVIDER` 只能包含小写字母、数字和连字符，且不能使用内置 ID `deepseek-official`。密钥绝不会写入 `/data`。修改路由值后，下次启动容器时会更新生成的路由。若要切回官方模式，移除 `LLM_API_KEY` 并设置 `DEEPSEEK_API_KEY`；若两者都未设置，诊断类命令仍可运行，但聊天和视觉没有凭据。

## 网页搜索后端

`web_search` 使用 DeepSeek 原生 Anthropic Messages 搜索工具，要求搜索服务支持 `web_search_20250305`，并返回 `web_search_tool_result`。搜索模型默认是 `deepseek-flash`。官方模式使用 `DEEPSEEK_API_KEY` 和官方地址 `https://api.deepseek.com/anthropic/v1`。第三方模式只有在设置 `LLM_SEARCH_BASE_URL` 后才启用搜索；搜索请求发往该地址，并复用 `LLM_API_KEY`。该地址与聊天的 OpenAI 兼容地址相互独立。留空或省略 `LLM_SEARCH_BASE_URL` 只会关闭 `web_search`，聊天、视觉和 `web_fetch` 仍可用。

第三方搜索示例：

```dotenv
LLM_SEARCH_BASE_URL=https://gateway.example.com/anthropic/v1
LLM_SEARCH_MODEL=your-search-model
LLM_API_KEY=YOUR_GATEWAY_API_KEY
```

镜像最终覆盖层以 `LLM_SEARCH_MODEL`（或上述默认值）为准；若之前在持久化的 `web-search-deepseek` 插件配置中自定义了 `model`，请将该值迁移到此环境变量。

`LLM_SEARCH_BASE_URL` 必须是 HTTP(S) URL，不能在 URL 中嵌入用户名或密码；它应指向 Anthropic Messages API 基础地址，原生客户端会在后面追加 `/messages`。聊天的 OpenAI Responses/Completions 地址不能用于此处。可通过 `LLM_SEARCH_MODEL` 为官方或第三方搜索指定模型别名；未设置或留空时使用 `deepseek-flash`。它独立于聊天的 `LLM_MODEL`，设置它本身不会启用第三方搜索；第三方模式仍须配置 `LLM_SEARCH_BASE_URL`。搜索工具只接收关键词，不能指定任意 URL 抓取；搜索服务端点由部署者配置。阅读搜索来源正文时，仍由 `web_fetch` 执行现有的公网地址校验、HTML/XHTML 类型检查、响应大小限制和内存转换，不运行脚本或保存文件。图片 URL 请交给视觉工具处理。

## 本地验证

维护者可运行以下脚本，在本地验证镜像和安全策略：

```bash
./scripts/test-local.sh
```

该脚本会构建当前平台的镜像，为运行时状态使用临时命名卷，并且只挂载只读的回归测试脚本和配置档案探测脚本。它会验证首次初始化、`qqbot` 配置档案、插件版本、`dsh`、只读指令文件挂载、最终的 `native`/禁用/web-provider 配置（包括搜索和读取 provider 以及不启动 Agent）、镜像内真实的 `ToolRuntime` 策略测试，以及使用封装 QQ SDK 的完整本地 Cordis 配置档案启动流程。之后还会验证使用相同卷重启、容器重建前后的媒体缓存字节、为未打补丁的旧配置档案严格打补丁、拒绝不兼容的插件版本、默认命令，以及镜像历史/配置中的密钥扫描。它不会连接 QQ 或付费模型 API，也不是真实的 QQ 端到端测试。它只会删除自己创建的临时容器和卷。

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

此镜像将私聊和群聊准入交由 QQ 开放平台自身的白名单和权限设置管理，不会在容器中重复配置这些 OpenID。群聊消息必须 @提及机器人。镜像的强制边界由不可变传输层覆盖和聊天策略守卫实现：允许的专用能力包括当前消息或明确引用图片、公共 HTTPS 图片 URL 的视觉分析，`web_search` 与 `web_fetch`，以及当前消息/明确引用纯文本附件的按需读取。网页搜索固定选择 `deepseek-official` provider ID；搜索端点、模型和凭据由部署环境根据密钥模式确定，以支持原生搜索 API 兼容的中转站。`web_search` 只接收关键词，不能让模型指定任意抓取 URL；搜索服务端点由部署者配置。`web_fetch` 只读取通过公网地址校验的公共网页或纯文本，限时限量并在内存中处理，不运行内容、不写入下载文件；文档保护模式还会限制可访问的 URL。镜像会禁用自动启动的 `agent-loop` 智能体，并强制使用原生工具呈现方式。只读沙箱、容器隔离和媒体大小限制属于纵深防御；`read-only` 本身不会禁止 Shell。网页读取器会固定已校验的连接并直接发送请求，不使用 HTTP 代理。引用缓存键会按聊天类型和对端隔离（私聊使用发送者，群聊使用群组）；无法识别对端的消息不会缓存，但显式引用仍可使用当前 QQ 消息元素回退机制。已配置的 LLM 提供者仍可使用模型端点代理设置。

用于读取公共网页和下载当前 QQ 图片的容器 DNS 必须返回目标的真实公网 IP。公网目标检查会拒绝 `198.18.0.0/15` 等 Fake-IP 响应；如果 Docker DNS 返回此类地址，请调整 Docker DNS 配置，不要关闭检查。这些请求均为直连，不使用模型端点代理。离线回归测试无法证明能够访问公共互联网、QQ 或付费多模态模型；请使用合适的测试凭据和服务策略，分别验证这些集成。

替换 `/data/AGENTS.md` 仅支持更改人设和其他软性对话指引。它不能注册新能力、放宽守卫，也不能授权 Shell、代码、文件、下载、后台操作或跨会话访问。
