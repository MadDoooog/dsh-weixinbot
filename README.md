# dsh-weixinbot

把 **DeepSeek Harness（DSH）** 接入 **微信 ClawBot（腾讯官方 iLink Bot API）** 的 DSH 插件：
微信里发消息，DSH 用专属持久 agent 会话回答并回发；DSH / agent 可主动推送通知、审批请求到微信。

## 文档

- **[功能设计](./docs/功能设计.md)** —— 背景、总体架构、功能清单（P0/P1/P2）、关键流程、配置、安全合规、里程碑（当前阶段：设计评审）

## 评审决策（已确认）

- 接入方式：**ilink-direct**（内置 iLink 协议，自包含）
- 审批桥：**纳入首版**（P1，`approval.enabled` 默认开启）
- 群聊：**降级 P2**（协议层保留识别能力）
- GUI：微信会话归入**独立「微信」目录**（F15）

## 状态

- [x] 功能设计 v0.2（已按评审决策更新）
- [ ] 原型 M1：文本单向桥 + 扫码登录
- [ ] MVP M2：双向桥、白名单、健康检查、日志、限速
- [ ] 增强 M3：typing、多模态、管理命令、审批桥
- [ ] 进阶 M4：群聊、会话 TTL、GUI 微信目录、统计

## 技术要点

- 插件形态：npm 包 + `cordis.patch.yml`（`dsh.bundle.patch`），经 `dsh plugin --profile web add` 挂载
- 消息驱动：`ctx.agents.create/resume` + `agent.followup/whenIdle`，每会话独立持久 agent（`im-wechat-*`）
- 微信侧：内置 iLink 协议客户端（扫码登录 / getupdates 长轮询 / sendmessage / sendtyping / CDN 媒体），可选 openclaw-relay 适配器
- GUI：随附 browser-only 客户端插件渲染侧边栏「微信」目录（F15）
- 合规：只走微信官方 ClawBot 能力，GUI 始终可用作降级通道

详见 [功能设计](./docs/功能设计.md)。
