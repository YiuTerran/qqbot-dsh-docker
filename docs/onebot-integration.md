# 可选 OneBot TRPG 集成

qq-bot 使用专用工具调用 Gensokyo-MCP；桥将请求变成虚拟 OneBot v11 消息，海豹使用原有规则和独立持久数据执行。一个海豹实例可以支持多个用户和群，不登录真实 QQ。实际 QQ 回复与私聊由 qq-bot 投递。

## 源码与版本

两个 fork 固定为子模块：`third_party/gensokyo-mcp`、`third_party/sealdice-core`。初始化使用 `git submodule update --init --recursive`。海豹嵌套资源按其自己的 gitlink 检出，不改变 UI。

镜像分别为 `tryao/qqbot-dsh:v0.11.2`、`tryao/gensokyo-mcp:v0.2.1`、`tryao/sealdice-core:v1.6.2-bridge.5`，只使用版本标签，没有 latest。主镜像不包含两个 Go 项目源码或运行程序。

v0.11.0 新增 Markdown 投递回执、扩展命令和连接级 Master ACL；三项镜像版本须一同升级，旧后端未协商 ACL 时仍可处理普通命令。

v0.11.1 增加群主／管理员的整群规则修改权限，以及单条自然语言、混合批次原生命令的身份绑定保护；配套桥与海豹必须同时升级以协商 `group-role-v1`。

## 启动

可以直接使用仓库的 `docker-compose.qnap.yml`，或将下方完整 YAML 保存为 `docker-compose.yml`。在同一目录创建 `.env`；QQ 和聊天凭据按实际账号填写，三份 OneBot 服务密钥使用不同的随机值，不复用 QQ/LLM 密钥。已有配置可保留聊天、视觉和生图路由，只更新三个镜像版本及 OneBot 配置。

```dotenv
IMAGE_TAG=v0.11.2
QQBOT_APPID=
QQBOT_SECRET=
# 官方聊天模式填此项；不要同时配置 LLM_API_KEY。
DEEPSEEK_API_KEY=
# 第三方模式：DEEPSEEK_API_KEY 留空，以下四项一起填写。
LLM_API_KEY=
LLM_PROVIDER=
LLM_MODEL=
LLM_API_BASE_URL=
LLM_API_PROTOCOL=openai-responses
# 第三方原生搜索独立配置，留空关闭搜索，不影响聊天。
LLM_SEARCH_BASE_URL=
LLM_SEARCH_MODEL=
# 可选独立生图服务：启用时 key/base URL/model 三项一起填写。
IMAGE_API_KEY=
IMAGE_API_BASE_URL=
IMAGE_MODEL=
# 未启用生图时也留空；启用后默认 openai-images，可选 xai-images。
IMAGE_API_PROTOCOL=
QQBOT_ONEBOT_ENABLED=true
QQBOT_ONEBOT_DIRECT_ENABLED=true
QQBOT_ONEBOT_DEFAULT_BACKEND=
QQBOT_ONEBOT_MCP_URL=http://gensokyo-mcp:8090/mcp
QQBOT_ONEBOT_BACKENDS=sealdice
QQBOT_ONEBOT_MASTER_USERS=[]
QQBOT_ONEBOT_MCP_TOKEN=replace-with-random-mcp-secret
QQBOT_ONEBOT_INTERNAL_TOKEN=replace-with-different-random-internal-secret
ONEBOT_WS_TOKEN=replace-with-different-random-onebot-secret
QQBOT_ONEBOT_HIDDEN_ENABLED=false
GENSOKYO_IMAGE_TAG=v0.2.1
SEALDICE_IMAGE_TAG=v1.6.2-bridge.5
```

聊天模式的详细配置见 [运行指南](runtime-guide.md)。生图字段全部留空时不提供生图工具，Markdown 默认启用。Master 清单默认 `[]`；需授权时使用私聊 `.userid` 返回的完整身份，而非 QQ 号或 Compose 服务名称。

### 完整 Docker Compose YAML

以下示例与仓库 Compose 使用相同配置；通过 `trpg` profile 启动两个后端。环境变量值传入容器后均为字符串，服务端再校验布尔、整数及 JSON 清单。

```yaml
services:
  qqbot:
    image: "tryao/qqbot-dsh:${IMAGE_TAG:?Set IMAGE_TAG to a versioned Docker Hub image tag}"
    container_name: dsh-qqbot
    restart: unless-stopped
    environment:
      TZ: Asia/Taipei
      DSH_HOME: /data
      # Mutually exclusive with LLM_API_KEY; selects the official chat/search mode.
      DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY:-}
      # Selects third-party chat mode; reused by native search when enabled.
      # Optional: use this generic key name from an OpenAI-compatible dsh
      # provider configuration (apiKeyEnv: LLM_API_KEY).
      LLM_API_KEY: ${LLM_API_KEY:-}
      # Set the four required LLM_* values together to configure a third-party
      # route. LLM_API_PROTOCOL is optional and defaults to openai-responses.
      LLM_PROVIDER: ${LLM_PROVIDER:-}
      LLM_MODEL: ${LLM_MODEL:-}
      LLM_API_BASE_URL: ${LLM_API_BASE_URL:-}
      LLM_API_PROTOCOL: ${LLM_API_PROTOCOL:-}
      # Optional independent DeepSeek-native Messages search endpoint. Empty
      # disables web_search in LLM_API_KEY mode.
      LLM_SEARCH_BASE_URL: ${LLM_SEARCH_BASE_URL:-}
      # Optional model alias for native search; defaults to deepseek-flash.
      LLM_SEARCH_MODEL: ${LLM_SEARCH_MODEL:-}
      QQBOT_VISION_PROVIDER: ${QQBOT_VISION_PROVIDER:-}
      QQBOT_VISION_MODEL: ${QQBOT_VISION_MODEL:-}
      QQBOT_MEDIA_ENABLED: ${QQBOT_MEDIA_ENABLED:-true}
      QQBOT_VISION_ENABLED: ${QQBOT_VISION_ENABLED:-true}
      QQBOT_IMAGE_DEBUG: ${QQBOT_IMAGE_DEBUG:-false}
      # Independent image API route; leave all four blank to hide image tools.
      IMAGE_API_KEY: ${IMAGE_API_KEY:-}
      IMAGE_API_BASE_URL: ${IMAGE_API_BASE_URL:-}
      IMAGE_MODEL: ${IMAGE_MODEL:-}
      IMAGE_API_PROTOCOL: ${IMAGE_API_PROTOCOL:-}
      QQBOT_MARKDOWN_ENABLED: ${QQBOT_MARKDOWN_ENABLED:-true}
      QQBOT_IMAGE_USER_HOURLY_LIMIT: ${QQBOT_IMAGE_USER_HOURLY_LIMIT:-10}
      QQBOT_MARKDOWN_USER_HOURLY_LIMIT: ${QQBOT_MARKDOWN_USER_HOURLY_LIMIT:-30}
      QQBOT_IMAGE_MAX_CONCURRENT: ${QQBOT_IMAGE_MAX_CONCURRENT:-2}
      QQBOT_MARKDOWN_MAX_CONCURRENT: ${QQBOT_MARKDOWN_MAX_CONCURRENT:-4}
      QQBOT_ONEBOT_ENABLED: ${QQBOT_ONEBOT_ENABLED:-false}
      # Directly route supported commands only when OneBot is enabled.
      QQBOT_ONEBOT_DIRECT_ENABLED: ${QQBOT_ONEBOT_DIRECT_ENABLED:-true}
      # Empty auto-selects a command's unique matching backend; set an ID for ambiguous matches.
      QQBOT_ONEBOT_DEFAULT_BACKEND: ${QQBOT_ONEBOT_DEFAULT_BACKEND:-}
      QQBOT_ONEBOT_MCP_URL: ${QQBOT_ONEBOT_MCP_URL:-http://gensokyo-mcp:8090/mcp}
      QQBOT_ONEBOT_MCP_TOKEN: ${QQBOT_ONEBOT_MCP_TOKEN:-}
      QQBOT_ONEBOT_INTERNAL_TOKEN: ${QQBOT_ONEBOT_INTERNAL_TOKEN:-}
      QQBOT_ONEBOT_BACKENDS: ${QQBOT_ONEBOT_BACKENDS:-sealdice}
      # JSON array of appId:SDK-openid identities from private .userid results.
      QQBOT_ONEBOT_MASTER_USERS: ${QQBOT_ONEBOT_MASTER_USERS:-[]}
      QQBOT_ONEBOT_HIDDEN_ENABLED: ${QQBOT_ONEBOT_HIDDEN_ENABLED:-false}
      # A diagnostic only; it does not contain or print credentials.
      QQBOT_STARTUP_WARN_MS: ${QQBOT_STARTUP_WARN_MS:-20000}
      QQBOT_APPID: ${QQBOT_APPID}
      QQBOT_SECRET: ${QQBOT_SECRET}
    volumes:
      - dsh-data:/data
      - dsh-workspace:/workspace
    networks:
      - default
      - trpg-control

  gensokyo-mcp:
    profiles: [trpg]
    image: "tryao/gensokyo-mcp:${GENSOKYO_IMAGE_TAG:-v0.2.1}"
    restart: unless-stopped
    environment:
      TZ: Asia/Shanghai
      LLM_BRIDGE_ENABLED: "true"
      LLM_BRIDGE_DATA_DIR: /data
      LLM_BRIDGE_MCP_TOKEN: ${QQBOT_ONEBOT_MCP_TOKEN:-}
      LLM_BRIDGE_INTERNAL_TOKEN: ${QQBOT_ONEBOT_INTERNAL_TOKEN:-}
      LLM_BRIDGE_MASTER_USER_KEYS: ${QQBOT_ONEBOT_MASTER_USERS:-[]}
      ONEBOT_WS_TOKEN: ${ONEBOT_WS_TOKEN:-}
      ONEBOT_WS_URL: ws://sealdice:18081/ws
      ONEBOT_BACKEND_ID: sealdice
    volumes:
      - gensokyo-data:/data
    networks:
      - trpg-control
      - trpg-backend
    depends_on:
      - sealdice

  sealdice:
    profiles: [trpg]
    image: "tryao/sealdice-core:${SEALDICE_IMAGE_TAG:-v1.6.2-bridge.5}"
    restart: unless-stopped
    environment:
      TZ: Asia/Shanghai
      SEALDICE_LLM_BRIDGE_ENABLED: "true"
      SEALDICE_ONEBOT_BIND: 0.0.0.0:18081
      ONEBOT_WS_TOKEN: ${ONEBOT_WS_TOKEN:-}
    volumes:
      - sealdice-data:/app/data
      - sealdice-backups:/app/backups
    networks:
      - trpg-backend

volumes:
  dsh-data:
    name: dsh-qqbot-data
  dsh-workspace:
    name: dsh-qqbot-workspace
  gensokyo-data:
    name: dsh-qqbot-gensokyo-data
  sealdice-data:
    name: dsh-qqbot-sealdice-data
  sealdice-backups:
    name: dsh-qqbot-sealdice-backups

networks:
  trpg-control:
    internal: true
  trpg-backend:
    internal: true
```

### 启动与检查

使用复制出的 `docker-compose.yml`：

```sh
docker compose --profile trpg config --quiet
docker compose --profile trpg pull
docker compose --profile trpg up -d
docker compose --profile trpg logs -f qqbot gensokyo-mcp sealdice
```

若直接使用仓库文件，将上述命令加上 `-f docker-compose.qnap.yml`，例如：

```sh
docker compose -f docker-compose.qnap.yml --profile trpg up -d
```

不开 profile、不启用工具时，qq-bot 独立运行；无需配置这些服务密钥。启用后端尚未就绪时聊天仍可运行，专用命令调用不可用。桥和海豹无宿主机公开端口；海豹在隔离网络运行，三者使用独立命名卷。海豹卷用于专用虚拟端点；若已有数据包含其他端点、脚本、自定义回复或未验证后台扩展，桥接启动会拒绝复用，不会覆盖它们。请使用独立卷保留原海豹部署。

qq-bot 容器日志中的 `[qqbot-onebot] ready backends=1 available=true` 表示后端探测和真实 Harness 工具注册均已成功。`config-invalid`、`probe-failed`、`backend-not-ready`、`call-ws-missing`、`register-failed` 分别表示配置无效、探测失败、后端未就绪、MCP 缺少调用工具和本地工具注册失败。运行日志不包含密钥、命令文本、骰子正文或私密输出。

## 可用能力与隐私

群聊仍需 @机器人。启用直达后完整匹配的当前单行命令跳过 LLM。可用命令包括 `.r/.roll/.ra/.rc/.st/.pc/.sc/.en`、规则选择或查询用 `.set`，以及 `.ww/.dx/.ek/.rsr/.coc/.dnd/.dndx/.ti/.li`。查询支持 `.userid`、`.find/查询`、`.setcoc` 无参或 `details`、`.ss/.buff` 无参、`.ds stat`、`.init` 无参或 `list`；娱乐支持 `.jrrp/.gugu/咕咕/.ping`。只允许操作本人角色卡，不允许跨用户代写、代骰或对抗检定。制卡候选与多轮执行分别最多 10 份/次，均为单次调用上限，不限制累计次数或已保存角色卡数量。群聊仍需 @机器人。 自然语言、未知命令和附件混合消息保留现有模型链路，不从引用或历史提取指令。

直达成功时不会调用 LLM，也不会先发“思考中”提示。直达命令与普通聊天并行；相同后端内继续由既有队列串行处理，每个后端最多等待 20 条，命令执行超时为 30 秒。`QQBOT_ONEBOT_DEFAULT_BACKEND` 留空时，会自动选择唯一匹配该命令的后端；若命令同时匹配多个后端，可设置为其中一个匹配的后端 ID。命令只发送给所选后端，不广播，不在不可用、超时或结果不确定时故障转移。将 `QQBOT_ONEBOT_DIRECT_ENABLED=false` 可恢复原有 LLM 工具选择。

后端明确失败、超时、结果不确定或未就绪时，路由只交接一次到现有 LLM 链路，保留 SDK 当前原文，并额外提供固定错误类别和有界、脱敏的公开错误。模型优先解释错误；若原请求被误判为命令，则按原意处理。后端文本作为不可信诊断数据，不能授权工具操作。兜底对应的原始消息在新模型回合内禁止任何 OneBot 再执行，防止重新掷骰或重复修改角色卡；同批其他原始消息不被一并禁止。工具暂不可用时仍保留兜底诊断。取消、无效身份和 QQ 发送失败不会重新执行命令，暗骰正文不会进入群聊模型输入。海豹以成功终态返回的业务提示保持原样投递，不做错误关键词猜测。

直达命令的公开结果按桥返回内容交给当前 QQ 回复目标，不再经过 LLM 改写；私密输出仍遵循现有私密 outbox、鉴权领取和投递限制。`/new` 会取消待处理命令并抑制晚到回复；已派发且已改变角色卡或规则状态的命令无法撤销。运行日志不记录命令文本、骰子正文或私密输出。管理仅按下述 Master 边界开放；脚本、后台扩展、任意文件或图片命令不开放。外部结果是数据，不能改变本部署工具边界。

海豹及通用桥保留原来的“群通知＋私聊发送”语义，没有 bind。但[腾讯官方文档](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/send.md)明确说明，QQ 机器人主动推送能力自 2025 年 4 月 21 日起停止提供。SDK 暴露发送方法不能证明平台允许群消息触发无私聊凭据的主动发送。

因此，本次命令策略拒绝全部暗骰及其别名，包括私聊中的暗骰，在海豹执行前拒绝；即使设置 `QQBOT_ONEBOT_HIDDEN_ENABLED=true`，也不能绕过这项平台能力检查。普通群聊掷骰与用户当前私聊中的普通掷骰仍可使用。不会借用群消息 ID、旧好友事件或增加绑定流程。私密 outbox、好友/拒收事件和投递隔离通过合成身份测试；这些测试不能证明真实 QQ 支持主动私聊。未来只有平台契约及真实投递证据同时满足时，才重新开放该部署能力。

群聊工具结果只含公开输出和投递状态，暗骰正文保存在独立私密 outbox，并由 qq-bot 内部鉴权通道领取发送。投递失败不公开、不重新掷骰；不确定结果不自动重试。平台无法支持时该部署保持群聊暗骰关闭，不增加绑定替代流程。

同一条原始 QQ 消息内，重复调用相同命令会返回已有结果，不同命令排队至完整终态。已派发命令出现不确定结果，或暗骰投递失败后，该消息的后续调用会被拒绝，避免模型重试导致重新掷骰。需要新的操作时发送一条新消息；明确要求多次掷骰时使用海豹原生的多次掷骰表达式。

## 群角色与规则修改

当前开放的 `.set dnd/dnd5e/coc/coc7` 修改整群规则，仅允许当前群 `owner/admin`，单条原始请求可通过自然语言要求修改；混合批次要求该人员原消息完整匹配所执行的 `.set` 命令，不能把其他成员的需求绑定到管理员的无关请求 ID。批次数量在入队快照后按全部原始请求计数，不因空文本或无效授权被过滤而变成单条。`.set info`、`.setcoc` 无参或 `details` 为查询，普通成员可用；掷骰、检定与本人角色卡写入也不受该限制。私聊不能修改群规则，Master 或信任用户不会因此获得群管理权限。

qq-bot 从本条 SDK 原始事件的 `author.member_role` 获取角色，核对 `author.member_openid`、`group_openid` 与当前发送者和群，再在入队前固定。缺失、非法或身份不一致时拒绝群规则修改；不从历史、引用、昵称或同批其他成员补取权限。每条原始请求的只读角色元数据供模型解释，模型不能指定角色。

桥将可信内部 `group_role` 转为标准 OneBot `sender.role`，海豹解析原生命令后再次校验。必须协商 `group-role-v1`；不支持时普通命令继续工作，但群规则修改明确要求升级配套后端。无新增开关，不自动重试或换身份。该保护自 v0.11.1 镜像组合提供，源码验证也需同时构建 qq-bot、Gensokyo 和 SeaDice。

真实 QQ 验收需分别由群主、管理员、普通成员发送规则切换，确认允许／拒绝与实际群身份一致，并确认 `.set info`、角色卡和掷骰仍可使用。合成身份容器测试不代表平台一定返回角色字段。

## Master 授权与备份

默认 `QQBOT_ONEBOT_MASTER_USERS=[]`。测试用户在机器人私聊发送 `.userid`，将回复中的配置用身份（`应用ID:原始用户openid`）放入该 JSON 数组，例如 `["123456789:fixtureOwnerA"]`，然后重建 qq-bot 与桥容器。不要使用昵称、QQ 号码或 SeaDice 虚拟 ID。群聊与私聊身份只按实际 SDK 字段判断，不自动认为相同。

Compose 将清单同步给桥的 `LLM_BRIDGE_MASTER_USER_KEYS`；每个后端按持久身份映射分配虚拟 ID，并通过可选 `master-acl-v1` 协商返回连接级 ACL。无效配置、空清单或未协商能力不能授予管理权限。旧服务仍可处理普通命令。

仅允许当前原始私聊正文完整匹配 `.master list`、`.master backup` 或 `.ban list/query/add/rm/trust`。自然语言、引用和模型改写不能授权管理命令。授权仅作用于当前命令，不写全局 DiceMasters。封禁目标限本后端已登记的 `QQ:<虚拟用户ID>` / `QQ-Group:<虚拟群ID>`；用户可用 `.userid` 查询自己的虚拟 ID。`trust` 不提权。Master 增删、解锁、重启、更新、脚本重载、退群均不开放。

备份通过原生海豹实现写入 `/app/backups` 的独立 `sealdice-backups` 命名卷；不自动发送文件或上传外部服务。完成提示必须反映实际备份结果，超时不自动再次备份。升级需备份桥身份数据、海豹数据及备份卷。

## 生命周期与升级

标准 OneBot v11 的 echo 关联 API 请求，reply 段关联源消息；完整命令结束使用明确标注的项目扩展。详见 [契约](onebot-bridge-contract.md)。每次连接重新协商，不使用静默窗口宣布完成。旧连接、缺少关联及完成后补发的输出拒绝，未知状态不自动重放。

海豹桥接端点静默忽略标准 `meta_event/heartbeat` 和 `meta_event/lifecycle`；它们是连接控制事件，不是骰子命令。其他不支持的非消息事件仍会告警，普通 OneBot 模式沿用原来的事件处理。

派发后超时、取消或断线时，后端旧任务可能仍在改变角色数据，桥会暂停该运行实例。只有原连接的有效完成通知，或海豹进程重启后的新实例协商，才能恢复；同一进程仅重新连接不够。桥重启会保留该隔离状态。用户需要查询实际状态，不能自动补执行不确定的指令。

桥保存请求去重和消息 ID 分配，去重窗口 24 小时；不能理解为永久 exactly-once。私密 outbox 最长保留 10 分钟，投递完成删除正文。海豹数据独立保存，升级前备份海豹卷、桥卷与 qq-bot 卷，并保留对应镜像版本。回滚须恢复兼容的数据快照，不能仅替换一个服务镜像。

部署日志只记录阶段、后端、请求标识、数量和错误分类。服务密钥、身份凭据及私密正文不得写入日志。诊断抓取仅使用专用测试用户和测试群，不采集生产私密结果。

## 检查

本地完整验证包括普通 qq-bot 离线启动回归，以及合成身份的真实容器 MCP→海豹测试：

```sh
docker build -t dsh-qqbot:onebot-integration .
docker build -t qqbot-gensokyo:integration third_party/gensokyo-mcp
docker build -t qqbot-sealdice:integration third_party/sealdice-core
python3 scripts/test-onebot-integration.py
```

容器回归不使用 `.env`、不连接真实 QQ。此前真实 QQ 验收只覆盖普通群聊、私聊命令和群聊暗骰执行前拒绝，并未验证本次直达命令路由。群聊暗骰实际投递验收保留为未来平台重新支持后的步骤，不能以离线夹具代替平台证明。

以下真实 QQ 验收步骤仍待部署者执行；当前内容不表示直达路由已通过真实 QQ 验证：

1. 默认关闭暗骰时，在测试群 @机器人发送 `.r2d1`，确认普通掷骰结果；再发送自然语言请求“帮我掷一次 1d1”，确认仍走原有 LLM 工具选择；要求暗骰时确认执行前拒绝。
2. 在测试账号与机器人当前私聊中发送 `.r2d1` 和 `.st` 查询，确认直达命令结果与原始账号对应。
3. 如需核对防护，在测试环境将暗骰开关设为 true，仍应在海豹执行前拒绝并交给模型解释当前部署或平台限制。验收后恢复 false。

未来平台重新支持时，还需用测试账号加好友，验证同一人的群/私聊身份、实际收到暗骰、好友删除、明确拒收及网络不确定结果；群模型输入与日志均不得出现私密正文，失败不得重新掷骰。这些步骤当前不宣称已通过。

普通调用和群聊暗骰分别记录验收结果。平台接受发送的 HTTP 响应与测试账号实际收到消息是两项证据；只看到工具返回成功不足以证明送达。
