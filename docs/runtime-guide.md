# 运行指南

本文记录部署后常用的能力限制、排障方法和维护注意事项。首次部署请先看[项目首页](../README.md)；OneBot/TRPG 配置请看[集成说明](onebot-integration.md)。

## 启动与升级

v0.12.2 修复了从 v0.11.2 等已启用直通路由的旧数据卷升级时，日志集成迁移被跳过而导致启动失败的问题。升级镜像后重建 qqbot 容器即可，保留原有 `/data` 和 `/workspace` 卷。

入口日志会依次显示初始化、应用运行策略和启动运行程序。容器状态为 `restarting` 且退出码非零时，进程已经退出，不能仅凭 `Running=true` 判断服务正常。Container Station 未显示日志时，可查看容器退出状态及日志配置，或通过 SSH 执行 `docker logs --tail 150 dsh-qqbot`。

## 图片与附件

当前消息附带的图片、明确引用的图片和公共 HTTPS 图片 URL 可用于受限视觉分析。图片最多 10 MB；URL 必须为 HTTPS，不得带凭据或重定向，并须通过公网地址、MIME 和图片字节检查。引用图片缓存最多保留 500 条消息的文字和附件元数据，并按群/私聊目标隔离。重启或缓存淘汰后，若引用没有结构化附件或完整图片记录，或原图链接失效，请重新附图。

连续发送的纯图片会按应用、群/私聊目标和发送者分别暂存为最近图片批次，最多 8 张、最多 200 组，最后一张图片到达 5 分钟后过期。暂存只保留内存元数据，不下载图片或调用模型。群聊未 @机器人的消息不会触发模型或消费批次；普通聊天和文生图不消费批次。只有明确要求分析、OCR、询问图片内容或编辑时才可使用；一次操作消费整批，失败或取消后不会恢复。编辑底图不明确时应先询问。

图片生成路由与聊天密钥完全独立。配置 `IMAGE_API_KEY`、`IMAGE_API_BASE_URL` 和 `IMAGE_MODEL` 后才启用；协议支持 `openai-images`（默认）或 `xai-images`。需改图时，当前消息或明确引用只授权一张底图，支持 PNG、JPEG、GIF、WebP；输入与结果上限为 10 MiB。有效 GIF/WebP 和需要规范化的 PNG/JPEG 会在内存中转成 PNG，动图取第一帧；最多处理 4,000 万像素并限时 10 秒。提示词最多 4,000 字符，图片服务请求限时 120 秒，整个工具限时 180 秒。每用户每滚动小时默认 10 次生成与编辑合计；调用失败和取消也计入已开始任务额度。图片结果经当前 QQ 回复发送。

生图／改图工具会向 LLM 返回结构化 `status` 和固定 `notice`：`sent` 表示 QQ 发送已确认，`failed` 表示操作失败，`timeout` 表示超时，`unknown` 表示投递确认未知；其他状态说明额度、格式、过期或并发限制。模型按回执说明结果，不自动重试或重复发送；回执不证明用户已阅读。QQ 直接投递图片，工具回执不会额外刷成状态消息。

Markdown 导出默认开启。每份 UTF-8 Markdown 文件最多 128 KiB，每用户每滚动小时默认 30 次。只有收到 QQ 文件发送确认才表示附件已发送；正文兜底或截断应如实报告。可通过 `QQBOT_MARKDOWN_ENABLED=false` 关闭。图片和 Markdown 的并行任务默认分别最多 2 个和 4 个，可用 `QQBOT_IMAGE_MAX_CONCURRENT`、`QQBOT_MARKDOWN_MAX_CONCURRENT` 调整。

## 网页与纯文本

`web_search` 按关键词搜索，每次最多 4 个查询，合并后最多 8 个来源。官方聊天模式使用 DeepSeek 原生搜索；第三方聊天模式默认复用聊天端点，也可设置 `LLM_SEARCH_BASE_URL` 覆盖，并复用 `LLM_API_KEY`。搜索端点和额度由部署的服务决定。

`web_fetch` 可读取经过公网校验的公共网页或纯文本。支持文本、XHTML、JSON、YAML、XML 类型；HTML 转为文本，其他允许类型按文本读取。拒绝未知或二进制类型，以及伪装成文本的 PDF、Office、ZIP、图片或可执行文件。单次请求最多 30 秒、2 MiB，返回模型的文本最多 100,000 字符；内容只在内存处理，不执行脚本或写入文件。

可按需读取当前 QQ 消息附带或明确引用的纯文本文件：每轮最多 4 个、每个 512 KiB、每次最多返回 50,000 字符，每轮总返回量最多 100,000 字符，重复读取也计入总量。仅支持纯文本；必要时按 `.txt`、`.md`、`.markdown`、`.json`、`.yaml`、`.yml`、`.csv`、`.tsv`、`.log`、`.xml`、`.ini`、`.toml` 后缀回退，并要求严格解码。PDF、Word、Excel 和压缩包不支持。附件内容会交给当前配置的 LLM，并可能进入现有会话历史。

用户消息、网页、附件和工具结果都是不可信内容，不能更改安全规则。搜索会将关键词交给部署的搜索服务。若本轮读取了文档或非 HTML 文本，远程网页读取及图片 URL 分析只允许访问用户当前消息明确写出的完整 URL 和结构化搜索结果中的来源；不会从文档正文发现或跟随链接。本轮不会生成或编辑图片。需要打开文档里的链接时，请在新消息中单独发送完整 URL。

## 模型服务商

两种聊天凭据互斥：设置 `DEEPSEEK_API_KEY` 使用内置 `deepseek-official` 路由；设置 `LLM_API_KEY` 时，必须同时设置 `LLM_PROVIDER`、`LLM_MODEL` 和 `LLM_API_BASE_URL`，并清空官方密钥。第三方 `LLM_API_PROTOCOL` 支持 `openai-responses`（默认）或 `openai-completions`，不会自动探测。提供者 ID 只能使用小写字母、数字和连字符，且不能为保留 ID `deepseek-official`。路由配置写入持久化档案，密钥只通过环境变量提供。

第三方模式下的聊天、视觉共用 `LLM_API_KEY`。`QQBOT_VISION_PROVIDER`（可选）必须与当前聊天服务商 ID 相同；`QQBOT_VISION_MODEL`（可选）覆盖视觉模型。请确认所选模型本身支持图片输入。

搜索默认复用聊天 API 地址。需要独立搜索端点时，可设置 `LLM_SEARCH_BASE_URL` 覆盖；留空或未设置时继续使用 `LLM_API_BASE_URL`。搜索使用当前模式的同一凭据，第三方模式使用 `LLM_API_KEY`。

第三方模式示例：

```dotenv
LLM_SEARCH_BASE_URL=https://gateway.example.com/anthropic/v1
LLM_SEARCH_MODEL=your-search-model
LLM_API_KEY=YOUR_GATEWAY_API_KEY
```

搜索后端须兼容 DeepSeek 原生 Anthropic Messages 搜索工具。官方模式固定使用 `https://api.deepseek.com/anthropic/v1` 和 `DEEPSEEK_API_KEY`。两种模式下 `LLM_SEARCH_MODEL` 均可选，默认 `deepseek-flash`，与聊天模型独立。

## 自定义人设

入口脚本首次启动时将默认指引放入 `/data/AGENTS.md`。可以只读绑定挂载自己的普通文件到该路径，以替换人设和软性行为指引。它不能启用新工具或放宽运行时策略。镜像只会升级与已知历史版本内置默认文件逐字节一致的可写普通文件；自定义内容、符号链接和只读挂载不会被覆盖。每次发布时同步更新 `defaults/AGENTS.md` 中声明的镜像版本，保留发布前默认文件对应的 fixture 和 SHA-256，并更新公开镜像标签。

## 启动与故障排查

容器以非特权 `node` 用户运行，`tini` 为 PID 1。首次启动时，入口脚本将镜像中的初始配置复制到 `/data`，后续启动不覆盖已初始化卷。`/data/qqbot-media` 存放 QQ 插件传输缓存；复用数据卷时缓存文件会跨容器重建保留，仍按 1 小时 TTL 清理。缓存字节留存不等于图片授权留存。

查看启动状态：

```sh
docker compose -f docker-compose.qnap.yml logs -f qqbot
```

启动日志会报告凭据解析、网关连接请求及 `Bot ready!` 或 SDK 启动错误。超过默认 20 秒仍未就绪会输出警告；可调整 `QQBOT_STARTUP_WARN_MS`。先检查 DNS、TLS/代理出站连接、QQ 凭据和平台权限。工具错误会默认写入脱敏的 `[qqbot-tool-error]` 日志，可筛选最近日志：

```sh
docker compose -f docker-compose.qnap.yml logs --since 10m qqbot 2>&1 | grep -F '[qqbot-tool-error]'
```

若要临时隔离视觉或媒体初始化问题，可在 `.env` 中设置 `QQBOT_VISION_ENABLED=false` 或 `QQBOT_MEDIA_ENABLED=false`，然后重建 `qqbot` 容器。排查引用图片缺失时，可暂时设置 `QQBOT_IMAGE_DEBUG=true` 并重建容器，查看精简诊断日志：

```sh
docker logs --since 10m dsh-qqbot 2>&1 | grep -F '[qqbot-image-debug]'
```

调试日志用于检查引用解析、媒体下载和图片请求中的附件数量，不含消息正文、原始用户/群/消息 ID、文件名、URL、查询签名、磁盘路径、密钥或授权 ID。诊断结束后关闭该开关。重建会清除内存中的引用缓存；复测时请在重建后重新发送图片。

图片和网页读取要求容器 DNS 返回真实公网 IP；若 DNS 返回 `198.18.0.0/15` 等 Fake-IP 地址，请调整 Docker DNS，不要关闭公网地址检查。相关请求直连，不使用 HTTP 代理。离线本地验证不能证明 QQ、公共互联网或付费多模态服务可访问。

## 本地验证

维护者可执行：

```sh
./scripts/test-local.sh
```

脚本会构建当前平台镜像并使用临时命名卷，检查首次初始化、固定 QQ 插件、持久化升级、启动配置、运行策略和密钥未进入镜像等内容。它不会连接 QQ 或付费模型 API，也不是 QQ 端到端测试；脚本只删除自身创建的临时容器和卷。

如需额外验证真实图片服务，设置好 `.env` 中的 `IMAGE_*` 后，可执行以下付费探测。输出需使用新的空目录；探测图片保存在该目录，QQ 发送使用测试替身：

```sh
mkdir -p /tmp/qqbot-image-probe
docker run --rm --entrypoint node --env-file .env \
  --mount "type=bind,src=$PWD/scripts/verify-image-route.mjs,dst=/tmp/verify-image-route.mjs,readonly" \
  --mount type=bind,src=/tmp/qqbot-image-probe,dst=/probe-output \
  tryao/qqbot-dsh:v0.13.0 /tmp/verify-image-route.mjs /probe-output
```

探测会发起真实图片服务请求并消耗服务额度；不会发送真实 QQ 消息或修改生产额度。真实 QQ 图片和文件投递仍需用机器人账号验证。

## 升级、回滚与备份

持久化状态位于 `dsh-qqbot-data` 和 `dsh-qqbot-workspace` 命名卷。升级前备份两个卷；升级时使用明确版本标签并继续挂载相同的卷。启动器会原地更新固定 `@tencent-connect/dsh-qqbot@0.5.0` 配置档案的安全策略，不删除会话。若插件布局缺失、被更改或不受支持，启动会停止，不会在缺少策略时继续运行；此保障仅针对固定的 `0.5.0` 插件，不承诺兼容其他插件版本。

新版启动异常时，先停止容器，再同时恢复升级前的数据卷备份并使用旧镜像标签。不要用空卷替换现有卷，也不要把缺少 `/opt/qqbot-defaults/{chat-policy,web-pages}.mjs` 的旧镜像用于已升级的卷。保留完整快照可恢复会话及旧镜像需要的配置档案。

v0.10.0 移除了旧的群聊历史过滤补丁并恢复 SDK 原生上下文；`QQBOT_GROUP_CURRENT_ONLY` 与 `QQBOT_CONTEXT_DEBUG` 已不再生效。已有会话不会自动清空；需重置时在对应对话使用 `/new`。自定义人设若仍描述已移除的行为，请自行更新。
