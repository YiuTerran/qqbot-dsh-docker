# 通用 OneBot MCP 验证

实验日期：2026-10-02；证据复核：2026-10-03。只使用虚拟用户、群、账号及独立数据目录，不连接真实 QQ，不使用 qq-bot 的 `.env`。qq-bot 工作区和海豹源码未在此次实验中修改。

## 固定来源与环境

- Gensokyo-MCP：`a0aa7954e557190704e84e8eb3a03c8bf543f664`，原版 `/tmp/gensokyo-mcp`。
- 海豹骰：`13aeb77f7cb97466f13418a83e4f33c594ce41af`，原版源码导出副本 `sealdice-src`，独立持久数据 `sealdice-data`。
- 海豹用 `golang:1.25.0-bookworm`、`CGO_ENABLED=0` 编译；镜像摘要及来源见 `evidence`。
- Gensokyo 原版用主机 Go 1.27.0 编译。
- NoneBot2 与原生 OneBot v11 适配器：依赖版本和完整锁文件见 `nonebot/pyproject.toml`、`nonebot/uv.lock`。
- MCP 客户端直接使用 Streamable HTTP `/mcp`，进行 initialize、initialized 通知、tools/list、tools/call，并保留 MCP session header。
- 海豹容器在 internal Docker 网络；仅通过本机 TCP 转发容器访问两个测试端口，数据不会发送到真实 QQ。

## 原版基线

真实海豹握手成功：`get_login_info` 的 echo 正确回传，虚拟账号为 90001。

`.r 1d1` 已由海豹执行，原始 `send_group_msg` 返回 `1d1=1`，但 MCP 返回“等待超时”。原因是标准群回复仅含 group_id，而原版按 user_id 找等待者。

`.rh 1d1` 的公开通知和私密结果均可在原始 OneBot 收发记录中看到。原版不响应 get_group_info，私密输出延迟约 10 秒出现；send action 也没有正常 ACK。

两用户 × 两群分别写入力量 31、47、73、89；海豹查询结果已正确隔离，原版 MCP 仍全部超时。正常停止并重启海豹后，这四份属性仍保持 31、47、73、89（`original-sealdice-restart-wire.jsonl`）。因此状态隔离是原生后端能力，原版桥尚未可靠传回结果。

证据：`evidence/original-sealdice-roll.json`、`original-sealdice-hidden.json`、`original-sealdice-state.json` 及对应 `*-wire.jsonl`。首份 wire 包含本机转发建立前的连接失败记录，后续真实协议阶段不受其影响。

协议故障夹具还实际复现：同一用户跨群旧回复混入工具结果，以及私密正文泄漏到群聊工具结果。见 `evidence/original-mock/gensokyo-original-protocol-trace.json`。

## 实验修复及验收

结论：可以复用 OneBot 后端而不修改海豹核心，但 Gensokyo 原版不能直接使用；实验修复也未通过任意异步回复严格关联这一项，暂不进入正式部署。

实验代码位于 `/tmp/gensokyo-mcp-patched`。增加后端选择、每后端串行、唯一消息 ID、当前调用输出收集、标准 action ACK、私密 outbox 和超时/断线隔离，移除旧回复拼接与失败事件自动重放。使用原 mcp-go 0.30.0，不升级 SDK；结果是 text content 中的 JSON 对象。

| 验证项 | 结果 | 证据 |
|---|---|---|
| 真实海豹握手、原生掷骰 | 通过 | original-sealdice-wire.jsonl、patched-sealdice-setup.json |
| 两用户 × 两群属性与检定 | 通过 | patched-sealdice-setup.json |
| 重启后属性仍为 31/47/73/89 | 通过 | patched-sealdice-restart.json |
| 同用户跨群、四个并发请求 | 通过，后端内排队执行 | patched-sealdice-setup.json |
| 暗骰公开通知与私密正文分流 | 通过，群工具结果无私密正文 | patched-sealdice-setup.json、patched-sealdice-wire.jsonl |
| 原生 NoneBot 群聊/私聊回声、login API | 通过 | patched-nonebot.json |
| 连续、两段回复、单次延迟回复 | 通过 | patched-nonebot.json |
| request_id 去重、目标后端选择 | 通过 | native-wire-assertions.json |
| 超时后的新调用拒绝，其他后端继续 | 通过 | patched-nonebot.json |
| 成功回复后再次异步补发 | **失败：旧补发归入下一请求** | patched-async-boundary-summary.json |

等待 500ms 静默只是一种收集窗口，不能证明指令完成。真实 NoneBot 的 `.splitlate` 先立即返回第一段，1.5 秒后补第二段；紧接着调用 `.late`，第二段被绑定到新的 request_id。这是运行复现，不是仅从源码推测。扩大等待时间只能改变复现所需的延迟，不能解决协议缺少关联依据的问题。

最终副本修复了运行发现的协议类型错误：get_group_info 的 group_id 使用数字；私聊事件包含 font:0。修复后海豹最新启动段没有 group-info 解码错误或 OneBot Echo 超时。原版、预览失败与修复成功的证据均保留。

最终实验二进制 SHA256：`8a4370d1efbba9d35be42ca969630dd6707444b41cd4914c230942444d64efd1`。`go test -race ./...`、构建和 `git diff --check` 均通过，记录见 `evidence/patched-go-test-race.log`、`patched-build.log`、`patched-diff-check.log`。

最终二进制的协议故障夹具 9 项通过，包括实际断开 WebSocket 并观察重连、保持故障后端隔离、不重放事件、其他后端仍可调用。见 `evidence/patched-mock/patched-protocol-summary.json` 及其指向的原始 trace。同目录 `patched-protocol-trace-failed.json` 是早期夹具失败记录，不是最终结果。最终二进制的真实海豹状态查询、普通骰、暗骰与 NoneBot 群聊/私聊回声复核也通过，见 `evidence/final-native-smoke.json` 和 `.log`。这些通过项不覆盖上表已复现的异步补发失败。

`request_id` 去重只在当前进程保留的有界记录内有效；它不是跨重启的持久化 exactly-once 保证。私密 outbox 仅验证虚拟协议分流，未验证真实 QQ 临时私聊权限或送达。

## 后续方向

保留 OneBot 作为机器人生态边界。正式通用桥需要后端提供可验证的请求关联（例如 reply/message_id 或扩展 request_id）以及完整回复结束约定，或明确限定已知同步指令并接受能力范围。qq-bot 注入可信用户、群与目标后端；不能让模型自行填写身份。私密输出应走独立授权投递通道，不能进入群聊模型结果。

海豹专用 HTTP 改造继续暂缓；如果需要完整异步工具语义，可只扩展海豹 OneBot 适配器的关联/完成契约，再使其他机器人通过同一契约接入，避免改骰子核心规则。

## 复现文件

- `scripts/mcp_call.py`：直接 MCP 调用客户端。
- `scripts/ws_proxy.py`：透明 OneBot WS 记录器，不改写消息。
- `scripts/real_suite.py`：真实海豹状态、并发、暗骰与 NoneBot 测试。
- `scripts/protocol_fixture.py`：故障与并发协议夹具。
- `nonebot/bot.py`：真实 NoneBot2 最小插件，使用原生 Bot.send/Matcher 及 OneBot adapter。

## 适用边界

OneBot v11 的发送 action 没有必需的入站请求关联 ID，也没有通用的命令完成标记。按后端串行和等待窗口收集能够支持有界、同步回复，不能证明任意延迟后台任务的严格关联。正式集成仍需可信身份注入、私聊投递授权以及后端生命周期管理；本实验不证明真实 QQ 临时私聊、LLM 行为、文件/图片消息或正式部署。

此次不发布镜像、不提交或推送代码、不添加子模块，不启动海豹专用 HTTP API 改造。

收尾时 qq-bot 为 `d8434b1`（`feat: remove built-in TRPG dice`），工作区干净；本实验没有恢复用户已移除的骰子功能。已停止并移除此次创建的海豹、转发容器及独立网络；检查本机 18082/18083/18084/18091 未发现监听进程。实验源码、独立数据、二进制及证据全部保留在 `/tmp`，需要长期保存时应另行归档。
