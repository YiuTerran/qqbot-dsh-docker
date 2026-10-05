# 可选 OneBot TRPG 集成

qq-bot 使用专用工具调用 Gensokyo-MCP；桥将请求变成虚拟 OneBot v11 消息，海豹使用原有规则和独立持久数据执行。一个海豹实例可以支持多个用户和群，不登录真实 QQ。实际 QQ 回复与私聊由 qq-bot 投递。

## 源码与版本

两个 fork 固定为子模块：`third_party/gensokyo-mcp`、`third_party/sealdice-core`。初始化使用 `git submodule update --init --recursive`。海豹嵌套资源按其自己的 gitlink 检出，不改变 UI。

镜像分别为 `tryao/qqbot-dsh:v0.10.1`、`tryao/gensokyo-mcp:v0.1.0`、`tryao/sealdice-core:v1.6.2-bridge.2`，只使用版本标签，没有 latest。主镜像不包含两个 Go 项目源码或运行程序。

## 启动

保留当前聊天凭据。在 `.env` 中配置三份不同的随机服务密钥；不要复用 QQ/LLM 密钥：

```dotenv
IMAGE_TAG=v0.10.1
QQBOT_ONEBOT_ENABLED=true
QQBOT_ONEBOT_MCP_URL=http://gensokyo-mcp:8090/mcp
QQBOT_ONEBOT_BACKENDS=sealdice
QQBOT_ONEBOT_MCP_TOKEN=replace-with-random-mcp-secret
QQBOT_ONEBOT_INTERNAL_TOKEN=replace-with-different-random-internal-secret
ONEBOT_WS_TOKEN=replace-with-different-random-onebot-secret
QQBOT_ONEBOT_HIDDEN_ENABLED=false
GENSOKYO_IMAGE_TAG=v0.1.0
SEALDICE_IMAGE_TAG=v1.6.2-bridge.2
```

```sh
docker compose -f docker-compose.qnap.yml --profile trpg up -d
```

不开 profile、不启用工具时，qq-bot 独立运行；无需配置这些服务密钥。启用后端尚未就绪时聊天仍可运行，专用命令调用不可用。桥和海豹无宿主机公开端口；海豹在隔离网络运行，三者使用独立命名卷。海豹卷用于专用虚拟端点；若已有数据包含其他端点、脚本、自定义回复或未验证后台扩展，桥接启动会拒绝复用，不会覆盖它们。请使用独立卷保留原海豹部署。

## 可用能力与隐私

群聊仍需 @机器人，再提出骰子、检定或角色卡需求。LLM 根据当前原始消息选择命令，身份及回复目标由 SDK 事件绑定。首版开放 `.r`、`.rh`、`.ra`、`.rc`、`.st`、`.pc`、`.sc`、`.en`；`.set` 仅用于选择规则。管理、脚本、后台扩展、文件或图片功能不开放。外部结果是数据，不能改变本部署工具边界。

海豹及通用桥保留原来的“群通知＋私聊发送”语义，没有 bind。但[腾讯官方文档](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/send.md)明确说明，QQ 机器人主动推送能力自 2025 年 4 月 21 日起停止提供。SDK 暴露发送方法不能证明平台允许群消息触发无私聊凭据的主动发送。

因此，本版官方 QQ SDK 部署关闭群聊暗骰，在海豹执行前拒绝；即使设置 `QQBOT_ONEBOT_HIDDEN_ENABLED=true`，也不能绕过这项平台能力检查。普通群聊掷骰与用户当前私聊中的普通掷骰仍可使用。不会借用群消息 ID、旧好友事件或增加绑定流程。私密 outbox、好友/拒收事件和投递隔离通过合成身份测试；这些测试不能证明真实 QQ 支持主动私聊。未来只有平台契约及真实投递证据同时满足时，才重新开放该部署能力。

群聊工具结果只含公开输出和投递状态，暗骰正文保存在独立私密 outbox，并由 qq-bot 内部鉴权通道领取发送。投递失败不公开、不重新掷骰；不确定结果不自动重试。平台无法支持时该部署保持群聊暗骰关闭，不增加绑定替代流程。

同一条原始 QQ 消息内，重复调用相同命令会返回已有结果，不同命令排队至完整终态。已派发命令出现不确定结果，或暗骰投递失败后，该消息的后续调用会被拒绝，避免模型重试导致重新掷骰。需要新的操作时发送一条新消息；明确要求多次掷骰时使用海豹原生的多次掷骰表达式。

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

容器回归不使用 `.env`、不连接真实 QQ。当前版本的真实 QQ 验收只确认普通群聊、私聊命令和群聊暗骰执行前拒绝。群聊暗骰实际投递验收保留为未来平台重新支持后的步骤，不能以离线夹具代替平台证明。

当前真实验收步骤：

1. 默认关闭暗骰时，在测试群 @机器人要求“通过海豹掷 `1d1`”，确认普通结果；再要求暗骰，确认执行前拒绝。
2. 在测试账号与机器人当前私聊中要求普通掷骰及角色卡查询，确认原始身份与该账号对应。
3. 如需核对防护，在测试环境将暗骰开关设为 true，仍应在海豹执行前提示官方 QQ 平台不支持这条投递链路。验收后恢复 false。

未来平台重新支持时，还需用测试账号加好友，验证同一人的群/私聊身份、实际收到暗骰、好友删除、明确拒收及网络不确定结果；群模型输入与日志均不得出现私密正文，失败不得重新掷骰。这些步骤当前不宣称已通过。

普通调用和群聊暗骰分别记录验收结果。平台接受发送的 HTTP 响应与测试账号实际收到消息是两项证据；只看到工具返回成功不足以证明送达。
