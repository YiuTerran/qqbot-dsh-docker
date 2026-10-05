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

v0.10.0 移除本地群聊上下文过滤，恢复 SDK 与模型会话的原生历史行为；旧上下文开关不再生效，已有会话可用 `/new` 重置。

当前默认指引会将纯图片消息作为最近图片批次，不因此触发图像操作。同一 QQ 应用、同一群/私聊对端、同一发送者连续发送的纯图片最多组成 8 张，最多保留 200 组，并在最后一张到达 5 分钟后过期。群聊未 @机器人的消息不触发模型或消费批次，但同一发送者的非纯图片消息仍会结束其图片段；其他发送者的消息不会切断图片段。普通聊天不消费已结束的批次，之后新发纯图片会替换旧批次。暂存只在内存保存图片元数据，不下载图片、不调用模型；`/new` 会清除本会话批次。普通聊天和文生图不读取或消费批次；用户明确要求分析、OCR、询问图片内容或编辑现有图片时，才可在当前消息/明确引用图片和用户明确写出的公共 HTTPS 图片 URL 之后使用 `recentImages`。视觉分析使用每项的不透明 `imageRef`；编辑使用同一项的 `imageAttachmentId`。批次多图而编辑目标不明确时先询问。一次有效操作原子性消费整批；同一原始请求仍可继续处理其他图片，失败或取消不恢复，也不会自动重试失败或取消的图片操作。

本机器人定位为对话式 QQ Bot；除普通文字回复外，还提供以下严格受限的能力：

- 它可以分析**当前 QQ 消息**附带的图片或 GIF、该消息明确引用的图片，或公共 HTTPS 图片 URL。
  本地路径必须是 `/data/qqbot-media` 内的普通文件，并且已登记为当前消息或引用图片；任意工作区路径、未引用的历史附件以及其他会话的附件都会被拒绝。
  引用缓存共保留最多 500 条消息的文字及附件元数据，按群/私聊对端隔离；群内未 @bot 的消息也可记录，但不会触发下载或模型调用。当前消息明确引用图片时只登记本轮编辑 ID，不下载。实际调用改图工具时，才下载并校验选中的底图，直接在内存中交给生图接口，不新增媒体缓存文件；本轮结束撤销 ID，也不保留底图字节。引用读图按 URL 在工具调用时下载。当前消息直接附图的既有下载流程不变，其传输缓存仍由下述定时机制清理。重启或缓存淘汰后，若 QQ 引用消息既没有结构化附件，也没有完整图片记录，或原图链接已失效，请重新附图。编辑缺少底图时不得自动改为生成相似场景。
  QQ 将原图信息渲染为引用文字中的完整 `[附件N] 类型:图片 文件名:… 尺寸:… 大小:… URL:…` 记录时，也会从当前明确引用中恢复图片元数据并登记编辑 ID。因此有完整记录且链接有效时，即使重启后索引未命中也能改图。只识别这种明确图片记录，不从任意文字链接、聊天历史或模型参数中自动寻找底图；下载仍受 HTTPS、公网地址、响应类型、图片字节校验和大小限制约束，并遵守媒体开关和大小限制。
  两类输入均限制为 10 MB。URL 必须使用 HTTPS，且不得嵌入凭据；拒绝重定向，且只接受内联的 PNG、JPEG、GIF 或 WEBP 响应，并要求 MIME 类型与图片字节相符。在读取字节、保存图片附件或调用视觉模型前，工具内部会再次检查路径或 URL。URL 内容会先经过同一套校验公网 IP、限制大小并在内存中处理的下载器，再进入插件现有的视觉附件流程。这不会开放通用文件下载；URL 辅助程序本身不会写入缓存文件。传输缓存的 TTL 为 1 小时，并按小时清理；这不代表下游附件存储中的每个字节都会在恰好 1 小时后删除。当前消息的本地关联会在本轮结束时清除。
  最近图片批次通过独立的 `recentImages` 元数据暴露，每项含不透明 `imageAttachmentId`、`imageRef`（`qqbot-image:<requestId>:<imageAttachmentId>`）和文件名，不暴露路径或 URL。recentImages 图片字节在模型请求期间按需临时提供给视觉工具，使用内存作用域，不写入持久附件缓存；该作用域在本次工具操作完成、失败或取消后清理。它不改变当前消息直接附图和引用图片既有的传输/附件流程。
- 它可以用 `web_search` 按关键词发现网页。每次最多提交 4 个查询，合并后最多返回 8 个来源；搜索结果是外部不可信数据，不是指令。
  本地不限制搜索调用频率或每回合调用次数，原生搜索请求也不发送默认的 `max_uses: 5` 次数上限；单次查询数量、结果数量和超时限制仍保留。搜索接口自身的配额或 HTTP 429 限流由服务端决定。
  搜索接口与图片下载拒绝重定向；网页读取只跟随同源重定向，最多 3 次，循环或超出跳数立即失败并关闭响应。
- 它可以用 `web_fetch` 阅读经过公网校验的公共 `http://` 或 `https://` 响应。接受 `text/*`（不含 RTF/richtext）、`application/xhtml+xml`、`application/json`、`application/*+json`、`application/yaml`、`application/x-yaml`、`application/xml` 和 `application/*+xml`。HTML 转为文本，其他允许内容按文本原样读取；不会用数据格式解析器处理、解析外部资源或执行其中的内容。每次请求限时 30 秒、响应最多 2 MiB，最多向模型返回 100,000 个字符，并标记输出截断。文本响应即使声明为下载附件也只在内存中读取，不写入磁盘。拒绝未知或 `application/octet-stream` 类型，以及伪装成文本的 PDF、Office、ZIP、图片或可执行文件。搜索到的来源可用 `web_fetch` 阅读；网页和文本均为不可信输入。
- 主人可以让机器人阅读当前 QQ 消息附带或明确引用的文本文件。机器人只会看到不透明的附件 ID 和少量元数据，再按需调用 `qqbot_read_document`；附件原始/签名下载 URL 和磁盘路径不会暴露给模型。最多每轮 4 个文件、每个 512 KiB、每次读取返回最多 50,000 个字符，每轮返回总量最多 100,000 个字符，缓存重读也计入总量。本轮结束时授权撤销、进行中的读取取消，本轮缓存清空。只支持纯文本；当 MIME 缺失、为 `application/octet-stream`，或 QQ 只提供通用文件元数据时，才会按 `.txt`、`.md`、`.markdown`、`.json`、`.yaml`、`.yml`、`.csv`、`.tsv`、`.log`、`.xml`、`.ini`、`.toml` 后缀白名单回退，并进行严格解码和二进制检查。字符集只接受有效的声明值、UTF-16 BOM 或默认 UTF-8，不猜测编码；请将无法解码的文件转成 UTF-8 后重发。PDF、Word、Excel 及其他复杂格式仍不支持。附件不会写入磁盘，原始/签名下载 URL 不会暴露给模型或写入持久配置；文档正文中的普通 URL 可能随文本交给当前配置的 LLM，并进入现有聊天历史。
- 部署配置了独立图片 API 后，机器人可以按明确请求调用 `qqbot_generate_image` 生成一张图片，或编辑当前消息附带/本轮明确引用的一张 QQ 图片。编辑底图支持 PNG/JPEG/GIF/WebP，输入与处理后图片均最大 10 MiB；有效的 GIF/WebP 或需要规范化的 PNG/JPEG 会在调用改图工具时自动转成 PNG，动图取第一帧，保留原始画面尺寸（按方向信息旋转时除外）与透明度，不缩放或重画。转换只在内存中进行，最多处理 4,000 万像素、限时 10 秒，失败或回合取消后清理；普通看图与引用元数据登记不会触发转换。损坏或超限图片会明确提示失败；提示词最多 4,000 字符；结果图片最大 10 MiB。模型在同一次聊天请求中准备工具参数时，可按下方规则优化较短或含糊的提示词；图片服务收到最终提示词及已校验、按需转换后的底图字节，不会为优化额外调用 LLM，也不使用聊天密钥。每用户每滚动小时默认 10 次，生成与编辑合计；工具每次仅生成一张。完成或失败的任务都会计入已开始任务的额度；图片服务请求限时 120 秒，整个图片工具最多 180 秒。生成结果通过 QQ 当前回复发送。调用前，当前聊天模型可把短或含糊的视觉描述整理成简洁具体的提示词，适度补充主体、构图、光线、配色和风格；保留用户明确指定的主体、风格、文字、数量和禁止项，不强加风格或扩展未请求主题。详细提示词或要求原样不改时保持原文；编辑只说明所要求的改动并保持其余内容。只根据匹配的原始 QQ 请求及其明确引用整理，不混入批次内其他用户或历史个人信息，最终提示词不超过 4,000 字符。优化使用当前聊天模型准备工具参数，不产生额外模型/API 请求；提示词润色本身也不授权生成。调用时机仍依赖模型对用户自然语言意图的判断，因此提示规则不能证明每次调用都完全符合用户意图。
- 可以按明确请求使用 `qqbot_create_markdown` 创建并发送 UTF-8 Markdown 附件，最多 128 KiB，不落盘，也不会再调用第二个模型。该能力默认启用，可用 `QQBOT_MARKDOWN_ENABLED=false` 关闭；每用户每滚动小时默认 30 次。文件发送失败时会在原回复目标尝试发送固定提示和可复制的正文，并遵循现有 QQ 消息额度；无法发送完整正文时会明确标注截断。QQ 文件发送能力取决于实际机器人账号和平台权限，部署时需要验证。

当 QQ 消息带有文档，或 `web_fetch` 实际读到非 HTML 的文本响应时，本轮进入文档保护模式：远程 `web_fetch` 和图片 URL 视觉分析只接受当前用户消息中明确写出的完整规范化 URL，以及成功结构化搜索结果提供的来源 URL；不会从文档正文或嵌入资源中自动发现、跟随链接，也不会从普通文本生成 URL。文档正文、历史消息、引用消息或新拼出的查询参数中出现的 URL 不会自动获准；需要打开文档里的链接时，请把完整链接单独发在新的消息中。`web_search` 仍会把关键词发送到部署者配置的搜索服务，因此这不保证文本不会离开容器；文档或网页中的内容也不能更改安全规则。

私聊和群聊中均不可使用 Shell 命令、代码执行、通用文件读写/发送、通用文件下载、后台任务、子 Agent、工作流及类似环境操作。图片生成/编辑与 Markdown 导出只经上述专用工具执行，不开放一般文件 API。受限文本读取只在内存中处理，不创建下载文件。机器人可以解释命令或以文本展示代码，但绝不会运行。用户确认或自定义人设都不能取消这些限制。

群聊使用共享会话。同一群或同一私聊目标的回复按批次串行处理：正在处理时收到的消息会按到达顺序合并为下一批；默认最多等待 20 条，满后新消息不会触发模型，群聊会 @ 该消息发送者并提示稍后再试。聊天历史按 SDK 和会话原有策略提供；群聊应优先处理当前合并批次中明确 @机器人的请求。若当前批次有多个不同发送者的 @请求，应分别处理，只为每条请求使用相关上下文；无关聊天不得影响回答、图片提示词或工具选择。历史或引用文本里的旧 @不是新的当前请求。QQ 引用渲染块可能包含额外上下文，块中每条消息不都代表用户主动引用。机器人保持“本鱼”的既定自称，不得把群成员昵称当作自身身份。单独的纯图片消息只在内存中惰性暂存元数据，不触发模型、下载、提示回复或自动生成/编辑。同一应用、同一群/私聊对端、同一发送者的连续纯图片最多合并 8 张，最后一张图片到达后 5 分钟过期；最多保留 200 组，最久未更新的组先淘汰。群聊未 @消息不触发模型、不消费图片；同一发送者的非纯图片消息会结束图片段，其他发送者的消息不会切断图片段。普通聊天不会消费批次，新的纯图片段会替换旧批次。只有明确的分析、OCR、图片内容问题或编辑请求才可使用最近批次；当前消息、明确引用和用户明确写出的公共 HTTPS 图片 URL 优先。普通聊天和文生图不取用；多图编辑目标不明确时先询问。有效操作原子性消费整批，失败或取消不恢复。`/new` 会清除本会话批次。命令和待答问题保持优先。群聊空闲并接受一条通过门控的普通消息时，会先回复固定提示“收到啦，主人，本鱼正在思考中…”，且不 @ 发送者；私聊、未通过门控的消息、直接处理的斜杠命令、排队合并的后续消息不会收到这条提示。被拒绝的群消息不会单独触发模型请求。不同群及不同私聊用户互不阻塞。回复与附件授权会在本批完成并发送完毕后再交接给下一批。

本镜像不内置 TRPG 骰子。外部 OneBot/海豹骰集成默认关闭；启用 `QQBOT_ONEBOT_ENABLED=true` 并启动 `trpg` Compose profile 后，可由下述精确命令路由处理限定的单行命令，也可关闭直达路由恢复 LLM 工具选择。

当前源码的直达命令与模型工具使用同一策略。可用命令包括 `.r/.roll/.ra/.rc/.st/.pc/.sc/.en`、规则选择或查询用 `.set`，以及 `.ww/.dx/.ek/.rsr/.coc/.dnd/.dndx/.ti/.li`。查询支持 `.userid`、`.find/查询`、`.setcoc` 无参或 `details`、`.ss/.buff` 无参、`.ds stat`、`.init` 无参或 `list`；娱乐支持 `.jrrp/.gugu/咕咕/.ping`。只允许操作本人角色卡，不允许跨用户代写、代骰或对抗检定。制卡候选与多轮执行分别最多 10 份/次，均为单次调用上限，不限制累计次数或已保存角色卡数量。群聊仍需 @机器人。 多行、未知命令、自然语言及附件混合消息仍走原有模型链路；直达成功不调用 LLM、不发送思考中提示。命令参数由海豹原生解析。

`QQBOT_ONEBOT_DIRECT_ENABLED=false` 会关闭直达路由，并恢复原有 LLM 对 `qqbot_onebot_command` 的工具选择。`QQBOT_ONEBOT_DEFAULT_BACKEND` 留空时，会自动选择唯一匹配该命令的后端；若命令同时匹配多个后端，可设置为其中一个匹配的后端 ID。每条命令只发送给所选后端，不广播，也不在失败时切换后端。直达命令与普通聊天可以并行处理；同一后端仍按既有队列串行执行，最多等待 20 条，命令执行超时为 30 秒。`/new` 会取消待处理工作并抑制晚到回复，但无法撤销已执行的角色卡或规则变更。桥返回的公开结果原样交给当前 QQ 回复目标；私密输出仍受现有隔离、领取和投递限制。日志不记录命令文本、骰子结果或私密正文。模型不能指定身份、群、私聊目标或服务地址。详细部署、协议边界和验收说明见 [OneBot 集成](docs/onebot-integration.md)。

直达调用被后端拒绝、超时、结果不确定或后端未就绪时，原始消息和有界、脱敏的公开错误交给当前 LLM，优先解释失败原因；误判为命令的普通请求可继续按原意处理。不会先发送一条后端失败提示，再补模型回复。进入兜底的原始消息禁止再次调用 OneBot，即使模型换命令或换后端也不能重试；合并批次中其他成员的授权保持独立。身份校验失败、取消及 QQ 投递失败不会因此重新执行后端。海豹正常完成并返回的业务提示仍按公开结果直接发送；不根据任意文本猜测后端失败。私密正文、原始异常和服务凭据不进入模型兜底输入。

Master 默认关闭。`QQBOT_ONEBOT_MASTER_USERS=[]` 为 JSON 身份数组，使用私聊 `.userid` 返回的 `应用ID:原始用户openid`，不要填昵称或海豹虚拟数字 ID。配置后仅允许该人员在私聊明确发送 `.master list/backup`、`.ban list/query/add/rm/trust`；后台必须完成 `master-acl-v1` 协商。封禁目标只接受本后端已知的虚拟用户/群 ID。`trust` 不授予 Master，空清单不会触发原生的人人管理行为。备份写入独立命名卷，不外发。所有暗骰与别名均拒绝，保留私密 outbox 的协议隔离。

v0.11.0 提供以上新增命令、Markdown 回执与 Master 权限。完整部署请同时使用 `tryao/gensokyo-mcp:v0.2.0` 和 `tryao/sealdice-core:v1.6.2-bridge.4`，配置见 [OneBot 集成说明](docs/onebot-integration.md)。

### 图片生成路由与 Markdown 限额

Markdown 工具会向模型提供结构化投递回执。只有收到最终 QQ 发送确认才报告附件成功；正文兜底和截断单独标明。已派发但确认丢失时报告未知，不自动重复投递。此回执不证明用户已经阅读或实际下载文件。

图片生成/编辑走独立的服务商密钥和模型，不会复用 `DEEPSEEK_API_KEY`、`LLM_API_KEY` 或视觉模型。留空全部图片路由变量时，图片生成工具不可用；设置路由时，`IMAGE_API_KEY`、`IMAGE_API_BASE_URL` 和 `IMAGE_MODEL` 必须同时提供。`IMAGE_API_PROTOCOL` 可省略，默认 `openai-images`，也可设为 `xai-images`；不会自动探测协议或失败后切换。基础地址必须是无凭据、无查询参数、无片段的 HTTPS URL；基础地址应包含服务商要求的版本前缀（例如 `/v1`）；服务请求会追加固定的 `/images/generations` 或 `/images/edits` 路径，并在连接前校验和固定公网地址。密钥只从环境变量读取，不写入 `/data`。图片路由长度上限分别为密钥 4,096、基础地址 2,048、模型名 256 个字符，且拒绝控制字符。部分路由、非法协议/地址、非正整数额度或并发值会拒绝启动；Markdown 开关只接受 `true` 或 `false`。

图片生成与编辑合计按 QQ SDK 提供的发送者 ID 共享每用户额度，不按昵称识别；同一机器人应用的用户跨群共享额度。默认每滚动小时 10 次，可通过 `QQBOT_IMAGE_USER_HOURLY_LIMIT` 调整。Markdown 默认每滚动小时每用户 30 次，可通过 `QQBOT_MARKDOWN_USER_HOURLY_LIMIT` 调整。活动任务槽默认图片 2 个、Markdown 4 个，分别由 `QQBOT_IMAGE_MAX_CONCURRENT` 与 `QQBOT_MARKDOWN_MAX_CONCURRENT` 配置；它们限制同时运行数，不是累计次数。实例按单进程运行；额度时间戳保存在 `/data`，重启不清零，状态损坏时停止生成以避免绕过额度。正在读取文档或网页本轮进入文档保护模式后，图片生成/编辑不可调用，Markdown 导出仍可用。模型仍基于自然语言决定是否调用工具。

配置示例：

```dotenv
IMAGE_API_KEY=
IMAGE_API_BASE_URL=https://api.example.com/v1
IMAGE_MODEL=your-image-model
IMAGE_API_PROTOCOL=openai-images
QQBOT_MARKDOWN_ENABLED=true
QQBOT_IMAGE_USER_HOURLY_LIMIT=10
QQBOT_MARKDOWN_USER_HOURLY_LIMIT=30
QQBOT_IMAGE_MAX_CONCURRENT=2
QQBOT_MARKDOWN_MAX_CONCURRENT=4
```

仅当确实需要图片能力时填写前三项；`api.example.com` 和模型名是占位示例。图片编辑会将用户指定的当前/引用图片字节及编辑提示词发给图片服务商。Markdown 正文可能已经随聊天请求发送给当前 LLM，也会随附件/回退正文发送到 QQ；图片工具不持久化生成字节，但这不代表聊天历史或 QQ 平台不会保留相应内容。

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
      QQBOT_IMAGE_DEBUG: ${QQBOT_IMAGE_DEBUG:-false}
      IMAGE_API_KEY: ${IMAGE_API_KEY:-}
      IMAGE_API_BASE_URL: ${IMAGE_API_BASE_URL:-}
      IMAGE_MODEL: ${IMAGE_MODEL:-}
      IMAGE_API_PROTOCOL: ${IMAGE_API_PROTOCOL:-}
      QQBOT_MARKDOWN_ENABLED: ${QQBOT_MARKDOWN_ENABLED:-true}
      QQBOT_IMAGE_USER_HOURLY_LIMIT: ${QQBOT_IMAGE_USER_HOURLY_LIMIT:-10}
      QQBOT_MARKDOWN_USER_HOURLY_LIMIT: ${QQBOT_MARKDOWN_USER_HOURLY_LIMIT:-30}
      QQBOT_IMAGE_MAX_CONCURRENT: ${QQBOT_IMAGE_MAX_CONCURRENT:-2}
      QQBOT_MARKDOWN_MAX_CONCURRENT: ${QQBOT_MARKDOWN_MAX_CONCURRENT:-4}
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
# QQ and the SDK provide native context; focus on the current @request and related messages.
IMAGE_API_KEY=
IMAGE_API_BASE_URL=
IMAGE_MODEL=
IMAGE_API_PROTOCOL=
QQBOT_MARKDOWN_ENABLED=true
QQBOT_IMAGE_USER_HOURLY_LIMIT=10
QQBOT_MARKDOWN_USER_HOURLY_LIMIT=30
QQBOT_IMAGE_MAX_CONCURRENT=2
QQBOT_MARKDOWN_MAX_CONCURRENT=4
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

搜索、生图和内部工具失败时，默认输出 `[qqbot-tool-error]` 日志，无需开启调试开关。日志记录工具名、失败阶段、错误类别，以及可识别的 HTTP 状态码和网络错误码；不输出工具参数、提示词、原始服务响应、密钥、URL 或暗骰正文。工具重试后成功仍保留失败日志供排查，但不会因此额外向用户发送失败提示。

```sh
docker compose logs --since 10m qqbot 2>&1 | grep -F '[qqbot-tool-error]'
```

### 引用图片诊断

排查“引用图片可见，但生成请求 `images: []`”时，在 Compose 服务的 `environment` 中添加 `QQBOT_IMAGE_DEBUG: "true"`，再执行 `docker compose up -d --force-recreate qqbot`。使用仓库的 Compose 文件时也可以在 `.env` 中设置 `QQBOT_IMAGE_DEBUG=true`；仅修改 `.env` 而未将变量传入容器不会生效。默认关闭，只有精确值 `true` 才开启。

先引用旧图片复现一次，再发送一张新图片并引用它，分别观察以下日志：

```sh
docker logs --since 10m dsh-qqbot 2>&1 | grep -F '[qqbot-image-debug]'
```

- `quote`：`hasReference`、`cacheHit`、`elementCount`/`rawElementCount`、各元素的结构化附件、`recoveredTextImages` 和最终 `resolved.count`。`recoveredTextImages>0` 表示从 QQ 当前引用文字中的完整图片记录恢复了附件；缓存未命中且结构化附件数、文字恢复数均为零时，没有可用于改图的图片元数据。
- `download`：`metadata_skipped`、`media_disabled`、`start`、`success` 或 `failed`。失败会给出固定错误类别；识别到 HTTP 错误时记录 `httpStatus`（如 403），不会猜测是否为 rkey 过期。
- `generation_batch` / `generation`：下载结果数量、每条原始消息规范化前后的附件数量、`unsupportedType`、`missingDownload` 和最终 `images` 数量。引用图片惰性加载时，`downloads=0` 且 `images>0` 是正常情况，实际改图调用才出现底图下载日志。`resolved.count>0` 但附件规范化后减少，说明部分元数据不符合要求；`missingDownload>0` 表示既没有可绑定的下载结果，也不符合惰性引用图片授权条件。

同一进程内用匿名 `trace` 关联引用与登记日志，用 `asset` 关联附件与下载日志，用 `cacheKey`/`refKey` 对照缓存引用；这些标识重启后变化。每组附件/引用元素详情最多显示 16 项。该前缀的日志不输出消息正文、原始用户/群/消息 ID、文件名、URL、查询签名、磁盘路径、密钥或工具授权 ID。请提供复现期间带此前缀的完整日志，而非完整容器日志。调试结束后删除开关或改为 `"false"` 并重建容器。开启日志需要包含本次诊断代码的新镜像；v0.7.3 不支持此开关。重建会清空内存引用缓存，因此新图对照测试需在重建后发送。

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

将自己的文件以只读方式挂载到 `/data/AGENTS.md`，即可替换人设和软性行为指引，但不会移除镜像的传输层策略：群聊消息必须提及机器人；当前消息、明确引用图片、用户明确写出的公共 HTTPS 图片 URL，以及符合提示规则的最近图片批次才可进入受限视觉流程；网页通过关键词搜索和受限的公共网页/纯文本读取能力访问；当前消息或明确引用的纯文本附件可按需读取。通用 Shell、代码、文件操作/发送、通用文件下载和后台工作仍不可用；启用图片路由后只允许使用专用图片工具，Markdown 只允许使用专用导出工具。入口脚本也会强制 DSH 使用 `read-only`；不要把自定义人设当作安全机制。启动器只自动更新与 v0.9.0、v0.10.0 或 v0.10.3 内置默认文件逐字节一致、可写且非符号链接的 `/data/AGENTS.md`；自定义内容、符号链接和只读挂载都会保留。若自定义文件仍写着“不能生成图片/文件”，或仍描述已移除的 `.r` / `qqbot_roll_dice` 骰子能力，请在保留个人软性指引的前提下，手动按新版 [默认指引](defaults/AGENTS.md)同步能力说明。

视觉能力使用当前密钥模式选定的提供者：官方模式为 `deepseek-official`，第三方模式为 `LLM_PROVIDER`。设置 `QQBOT_VISION_PROVIDER` 时，它必须与当前模式的提供者相同；可用 `QQBOT_VISION_MODEL` 覆盖模型。第三方聊天和视觉共用 `LLM_API_KEY`。所选模型必须确实支持图片输入；提供者声明中的 `input: [text, image]` 只表示该路由符合 dsh 的候选条件，并不会让纯文本模型获得多模态能力。

### 服务错误与内容审核

模型服务或工具调用失败时，机器人使用简短的人设提示，不向用户展示底层错误正文、凭据、服务地址或请求 ID。余额或额度不足会提示联系管理员检查额度或充值；凭据、权限和模型配置问题提示联系管理员；限流、网络中断、超时和服务器故障提示稍后再试。上下文过长提示使用 `/new`。未知错误使用通用提示，不猜测服务商错误正文，也不自动重试。

v0.7.9 起，通用工具失败提示会等本轮处理结束后再决定是否发送。工具中途失败，但模型随后给出最终文字回复时，不额外发送“暂时拿不到结果”；正常结束且仍无最终回复时，多个工具失败合并为一次提示。工具调用前言不算最终回复；模型终止错误使用对应服务错误提示，取消回合不会补发通用工具提示。

如果 OpenAI 兼容服务商明确返回 `Content Exists Risk` 审核拒绝，机器人会等本轮结束并撤销本轮附件授权后，自动开启一个新会话，不会重试被拒绝的消息。私聊只重置当前用户；群聊会重置该群共享会话并清除该群的短期历史缓存，因此旧群聊上下文不会带入新会话。每位用户或群已选的模型和人设偏好会保留。新会话不保证后续请求一定通过审核；如果新会话无法可靠保存，机器人会提示手动发送 `/new`。其他审核错误只显示审核提示，不自动重置会话。

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

设置好 `.env` 中的 `IMAGE_*` 后，可单独验证真实图片服务：

```bash
mkdir -p /tmp/qqbot-image-probe
docker run --rm --entrypoint node --env-file .env \
  --mount "type=bind,src=$PWD/scripts/verify-image-route.mjs,dst=/tmp/verify-image-route.mjs,readonly" \
  --mount type=bind,src=/tmp/qqbot-image-probe,dst=/probe-output \
  dsh-qqbot:test-local /tmp/verify-image-route.mjs /probe-output
```

脚本通过镜像内原生工具调用、授权和生产图片传输发起一次付费生图请求，检查返回图片、Markdown 工具和请求结束后的授权清理。图片保存到输出目录；重复执行时请使用新的空目录。QQ 发送在此脚本中使用测试替身，不会发送真实 QQ 消息或修改生产额度。此验证不在离线 CI 中运行；实际 QQ 图片和文件发送仍需在机器人账号中验证。

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

升级后会移除旧的本地群聊历史过滤补丁并恢复 SDK 原生上下文；群聊历史范围由 QQ 平台控制。旧环境变量 `QQBOT_GROUP_CURRENT_ONLY` 和 `QQBOT_CONTEXT_DEBUG` 不再生效。已有会话历史不会自动清空；如果需要清除某个对话历史，在该会话使用 `/new`。启动器会自动更新与 v0.9.0 或 v0.10.0 默认 `AGENTS.md` 逐字节一致的可写普通文件；自定义文件、符号链接和只读挂载会保留。自定义指引若仍写有已移除的上下文过滤行为，请自行更新。旧版本内置骰子相关补丁会继续按启动器兼容迁移规则清理。

## 安全与访问控制

密钥只通过运行时环境变量提供；不会复制到镜像中。构建时不会打包宿主机的依赖目录；运行时无需挂载宿主机目录或 Docker socket，机器人的工作目录为 `/workspace`。

此镜像将私聊和群聊准入交由 QQ 开放平台自身的白名单和权限设置管理，不会在容器中重复配置这些 OpenID。群聊消息必须 @提及机器人；QQ 平台与 SDK 决定实际送达的原生上下文。机器人应优先回答当前 @请求，只在语义相关时参考其他聊天。最近图片仅在明确看图请求中可用，普通聊天和文生图不消费它。镜像的强制边界由不可变传输层覆盖和聊天策略守卫实现：允许的专用能力包括当前消息或明确引用图片、公共 HTTPS 图片 URL 和符合提示规则的 recentImages 图片的视觉分析，`web_search` 与 `web_fetch`，以及当前消息/明确引用纯文本附件的按需读取。网页搜索固定选择 `deepseek-official` provider ID；搜索端点、模型和凭据由部署环境根据密钥模式确定，以支持原生搜索 API 兼容的中转站。`web_search` 只接收关键词，不能让模型指定任意抓取 URL；搜索服务端点由部署者配置。`web_fetch` 只读取通过公网地址校验的公共网页或纯文本，限时限量并在内存中处理，不运行内容、不写入下载文件；文档保护模式还会限制可访问的 URL。镜像会禁用自动启动的 `agent-loop` 智能体，并强制使用原生工具呈现方式。只读沙箱、容器隔离和媒体大小限制属于纵深防御；`read-only` 本身不会禁止 Shell。网页读取器会固定已校验的连接并直接发送请求，不使用 HTTP 代理。引用缓存键会按聊天类型和对端隔离（私聊使用发送者，群聊使用群组）；无法识别对端的消息不会缓存，但显式引用仍可使用当前 QQ 消息元素回退机制。已配置的 LLM 提供者仍可使用模型端点代理设置。

用于读取公共网页和下载当前 QQ 图片的容器 DNS 必须返回目标的真实公网 IP。公网目标检查会拒绝 `198.18.0.0/15` 等 Fake-IP 响应；如果 Docker DNS 返回此类地址，请调整 Docker DNS 配置，不要关闭检查。这些请求均为直连，不使用模型端点代理。离线回归测试无法证明能够访问公共互联网、QQ 或付费多模态模型；请使用合适的测试凭据和服务策略，分别验证这些集成。

替换 `/data/AGENTS.md` 仅支持更改人设和其他软性对话指引。它不能注册新能力、放宽守卫，也不能授权 Shell、代码、文件、下载、后台操作或跨会话访问。
