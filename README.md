# dsh-qqbot Docker 镜像

本仓库构建腾讯 [`dsh-qqbot`](https://github.com/tencent-connect/dsh-qqbot) 的 Docker 镜像，支持 `linux/amd64` 和 `linux/arm64`。机器人通过出站 WebSocket 连接 QQ，不需要开放入站端口。

## 镜像组件

| 组件 | 固定版本 |
| --- | --- |
| Node.js | `24.14.0`（Debian bookworm slim） |
| pnpm | `12.6.0` |
| dsh | `@deepseek-ai/dsh@0.1.7-rc.2` |
| QQ 插件 | `@tencent-connect/dsh-qqbot@0.5.0` |

当前镜像标签为 `tryao/qqbot-dsh:v0.12.10`。可选 TRPG 组件独立发布：Gensokyo-MCP `v0.3.1`、海豹骰 `v1.6.2-bridge.8`。Dockerfile 固定基础镜像摘要及软件包版本；不发布 `latest` 标签。

## 快速部署

```sh
cp .env.example .env
```

编辑 `.env`，填写 QQ 开放平台的 `QQBOT_APPID` 和 `QQBOT_SECRET`，并选择一种聊天凭据模式：

- 官方 DeepSeek：填写 `DEEPSEEK_API_KEY`，清空 `LLM_API_KEY`。
- OpenAI 兼容服务：填写 `LLM_API_KEY`、`LLM_PROVIDER`、`LLM_MODEL`、`LLM_API_BASE_URL`，清空 `DEEPSEEK_API_KEY`。`LLM_API_PROTOCOL` 可选 `openai-responses`（默认）或 `openai-completions`。

然后启动：

```sh
docker compose -f docker-compose.qnap.yml up -d
docker compose -f docker-compose.qnap.yml logs -f qqbot
```

Compose 使用 `dsh-qqbot-data` 和 `dsh-qqbot-workspace` 命名卷。升级或重建容器时保留这两个卷；不要添加端口映射、Docker socket、特权模式或主机网络。升级、回滚和备份说明见[运行指南](docs/runtime-guide.md#升级回滚与备份)。

## 可选能力

基础聊天使用上面选定的聊天服务。官方模式默认启用 DeepSeek 原生网页搜索；第三方模式默认用 `LLM_API_BASE_URL` 搜索，也可用 `LLM_SEARCH_BASE_URL` 覆盖。`LLM_SEARCH_MODEL` 默认 `deepseek-flash`，与聊天模型独立。

视觉模型使用当前聊天凭据模式的服务。可选图片生成/编辑路由使用独立密钥；在 `.env` 中一起设置 `IMAGE_API_KEY`、`IMAGE_API_BASE_URL` 和 `IMAGE_MODEL`，`IMAGE_API_PROTOCOL` 可选 `openai-images`（默认）或 `xai-images`。未配置时不会提供图片生成工具。

可选 OneBot/TRPG 集成默认关闭。启用 `QQBOT_ONEBOT_ENABLED=true` 并启动 `trpg` Compose profile 后，可通过 Gensokyo-MCP 调用海豹骰的掷骰、检定、角色卡和规则查询等能力。完整匹配已开放原生命令的消息直接转发后端；自然语言请求、命令帮助及后端错误解释由 LLM 处理。完整配置、权限和 YAML 实例见 [OneBot 集成说明](docs/onebot-integration.md)。

OneBot 启用后，实时跑团日志默认可用；群主或管理员需 @机器人执行 `.log new/on` 才开始记录。日志可导出为人物配色 Markdown 或原始 TXT，机器人回复保留 Markdown 渲染。导出文件隐藏内部虚拟 ID 和系统缺口提示，`.log stat` 保留诊断统计。设置 `QQBOT_ONEBOT_LOG_ENABLED=false` 可关闭；记录范围、导出用法及权限见 [日志说明](docs/onebot-integration.md#实时跑团日志与导出)。

## 能力与边界

- 群聊需要 @机器人。模型上下文由 QQ 平台和 SDK 提供；机器人应优先处理当前 @请求及相关消息。
- 支持对当前消息或明确引用的图片进行受限分析；明确请求后，可用独立图片服务生成图片或编辑获准的图片。
- 可搜索网页、读取经过公网校验的公共网页和纯文本，以及按需读取当前消息或明确引用的纯文本附件。
- 生图和 Markdown 操作会向模型返回结果回执；确认未知时不重复投递。
- 可按请求创建 Markdown 附件。图片、Markdown 和 OneBot 仅通过各自的专用工具执行。
- 不提供 Shell、代码执行、通用文件读写或发送、任意文件下载、后台任务或子 Agent 能力。`read-only` 沙箱是辅助措施，并不单独构成安全边界。

图片、文本附件和网页均有大小、数量、格式或访问限制；详细行为见[运行指南](docs/runtime-guide.md)。人设文件只控制软性对话指引，不能改变这些强制边界。

## 自定义人设

可将自己的指引文件只读挂载到 `/data/AGENTS.md`：

```yaml
services:
  qqbot:
    volumes:
      - dsh-data:/data
      - ./my-bot-instructions.md:/data/AGENTS.md:ro
      - dsh-workspace:/workspace
```

不要为自定义文件开放额外权限。入口脚本仅自动升级与已发布默认文件逐字节相同的可写普通文件；自定义文件、符号链接和只读挂载会保留。能力和默认指引见 [`defaults/AGENTS.md`](defaults/AGENTS.md)。

## 文档与维护

- [运行指南](docs/runtime-guide.md)：功能细节、额度、日志诊断、服务商配置、升级备份和本地验证。
- [OneBot 集成说明](docs/onebot-integration.md)：可选骰子后端的部署与权限。

维护者可运行 `./scripts/test-local.sh` 验证当前平台镜像和运行策略。该脚本不连接 QQ 或付费模型服务，也不等同于 QQ 端到端验证。详细说明见[本地验证](docs/runtime-guide.md#本地验证)。
