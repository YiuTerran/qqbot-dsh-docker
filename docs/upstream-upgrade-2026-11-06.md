# 上游依赖升级（2026-11-06）

本次为源码升级，未发布镜像、未修改线上部署。dsh 继续跟随 `next` 通道并固定精确版本，不切换 alpha。

| 组件 | 原版本 | 目标版本 |
| --- | --- | --- |
| Node.js（bookworm-slim） | 24.14.0 | 24.22.2 |
| pnpm | 12.6.0 | 12.18.0 |
| @deepseek-ai/dsh | 0.2.1-rc.2 | 0.2.2-rc.1 |
| @tencent-connect/dsh-qqbot | 0.5.2 | 0.5.5 |
| @tencent-connect/qqbot-nodejs | 1.0.5 | 1.0.5（最新版本，无变化） |

版本来自 npm registry；Node 镜像通过 Docker Hub Registry v2 核对精确版本的多架构 manifest，包含 linux/amd64、linux/arm64。新基础镜像摘要为 `sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9`。两个 TRPG 子模块的远端 HEAD 与现有固定提交一致，未改变。

## 兼容与安全

- QQ 编译代码从 `dist` 移到 `lib`，同步构建、启动和原生回归路径。
- 持久化迁移继续支持真实旧版 `0.5.0`、`0.5.2` profile，按版本验证源代码布局；新 profile 目标为 `0.5.5`。
- CI 对 v0.17.0 和 v0.18.2 两个真实已发布镜像分别验证离线迁移、故障恢复、用户数据保留及整卷回滚，不使用重标版本的假旧包。
- 关闭新增自动 presented-files 投递，继续仅允许受限专用工具发送附件。
- 默认指引旧版快照加入迁移白名单，自定义、符号链接和只读指引继续保留。

## 本地验证与边界

- Node 24.22.1 环境完成 161 项可独立运行的回归，29 项依赖容器内原生环境的测试跳过。最终 Node 24.22.2 镜像需要 CI 验证。
- 新 dsh 实际安装完成，`dsh --version` 返回 0.2.2-rc.1；Cordis 核心 session、agent、LLM、tools 和 agent-loop 插件加载通过。
- 搜索和模型工具投影补丁在实际 0.2.2-rc.1 npm 包上应用并重复应用通过。
- QQ 0.5.5 安全补丁在实际 npm 包上通过干净应用、重复应用及生成 JS 语法检查；新回归覆盖自动文件投递阻断、专用生图保留、严格会话持久化与瞬时流式帧跨批次隔离。
- 本地 JavaScript、Shell 语法与 diff 空白检查通过。
- 当前执行环境没有 Docker，不能将本地检查等同于镜像、旧卷迁移、双架构或真实 QQ 验收。pnpm 在本地受限环境的 store lock 初始化受文件系统限制，完整 profile 安装也留给容器 CI。
- 未登录 QQ、未调用付费模型、未进行生产投递。
