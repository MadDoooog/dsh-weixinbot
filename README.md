# dsh-weixinbot

把 **DeepSeek Harness（DSH）** 接入 **微信 ClawBot（腾讯官方 iLink Bot API）** 的 DSH 插件：
微信里发消息，DSH 用专属持久 agent 会话（`im-wechat-*`）回答并回发；DSH / agent 可主动推送通知、审批请求到微信。

- 接入方式：`ilink-direct`（插件内置 iLink 协议，扫码登录 + 长轮询 + 发送，零外部服务依赖）
- 合规：只走微信官方 ClawBot 能力，GUI 始终可用作降级通道

## 文档

- **[功能设计](./docs/功能设计.md)** —— 完整功能设计（架构、功能清单 P0/P1/P2、里程碑）

## 状态

- [x] 功能设计 v0.2
- [x] **M1 原型**：工程骨架 + ChannelAdapter + ilink-direct 协议客户端 + 扫码 CLI + 文本单向桥（已通过 typecheck 与 17 项单测）
- [ ] M2 MVP：断网重连打磨、限速队列校验、真实扫码联调
- [ ] M3 增强：typing、多模态、管理命令完善、审批桥
- [ ] M4 进阶：群聊、会话 TTL、GUI 微信目录、统计

## 安装

### 1. 构建

```sh
git clone <本仓库> && cd dsh-weixinbot
npm install        # 安装依赖
npm run build      # 产出 lib/
npm test           # 17 项单测（mock iLink 服务器）
```

### 2. 挂载到 profile

```sh
dsh plugin --profile web add file:/绝对/路径/dsh-weixinbot
```

然后把 `dsh-weixinbot` 加入 profile 的 `dsh.profile.bundles`（如 `$DSH_HOME/profiles/web/package.json`）。

### 3. 微信扫码绑定

```sh
node tools/wechat-login.mjs --write          # 扫码，凭据写入 $DSH_HOME/weixinbot/credentials.json
node tools/wechat-login.mjs --patch          # 或直接更新 profile 的 cordis.patch.yml（enabled=true）
```

### 4. 配置（profile 的 cordis.patch.yml，覆盖层）

> ⚠️ weixinbot 行由插件 bundle patch 插入，profile 层必须用 **id 定向覆盖**（非 `insert`），
> 否则会产生重复 id 导致 loader 报错（`duplicate loader entry id`）。可用
> `node tools/mount.mjs --apply` 自动写入，或手写：

```yaml
- id: weixinbot
  name: dsh-weixinbot
  config:
    enabled: true
    allowUsers:
      - '<你的 userId，扫码输出里有>'   # 空 = 全部拒绝（fail-closed）
    server:
      enabled: true
      port: 3901
```

### 5. 生效

```sh
dsh web        # 或 dsh --profile <name>
```

重启后给机器人发一条微信消息即可使用；健康检查：`curl http://127.0.0.1:3901/health`。

## 微信命令

| 命令 | 说明 | 权限 |
|---|---|---|
| `/help` | 帮助 | 白名单用户 |
| `/status` | 登录态 / 轮询 / 队列 / 收发统计 | 白名单用户 |
| `/whoami` | 你的 ID / 管理员 / 当前会话 | 白名单用户 |
| `/new` | **切换**到新会话（旧会话保留，可切回） | 管理员（缺省=白名单用户） |
| `/list` | 列出本会话的所有代次（会话号） | 白名单用户 |
| `/switch <n>` | 切回指定会话号（上下文保留） | 白名单用户 |
| `/cancel` | 取消正在运行的任务 | 管理员 |
| `/approve <id>` / `/reject <id>` | 审批决策（agent 请求批准时） | 白名单用户 |

> 会话切换：同一微信会话内，普通消息永远复用当前会话；`/new` 开启新一代次，
> 旧代次连同上下文完整保留，`/list` + `/switch <n>` 可随时切回。
> 代次记录持久化在 `$DSH_HOME/weixinbot/session-map.json`。

## M3 增强功能

- **typing「正在输入」**：agent 回答期间微信显示输入状态（自动，失败静默降级）
- **主动通知工具**：agent 可调用 `wechat_send` / `wechat_notify` 把消息推到你的微信（默认发给你本人）
- **审批桥**：agent 需要批准的操作（如执行危险命令）会推送审批卡片到微信，
  回复 `/approve <id>` 或 `/reject <id>` 即可决策；超时自动拒绝（fail-closed）

## 配置项（cordis.patch.yml `config:` 段）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关 |
| `adapter` | `ilink-direct` | 通道适配器（`openclaw-relay` 预留） |
| `credentials` | 空 | botToken/baseUrl/botId/userId；为空回退读 `credentials.json` |
| `poll.timeoutMs` | `35000` | getupdates 长轮询超时 |
| `poll.retryDelayMs` | `3000` | 轮询出错重试间隔 |
| `queue.turnTimeoutMs` | `120000` | 单轮 agent 回答超时 |
| `queue.rateLimitPer5min` | `6` | 官方限速窗口（留 1 条余量） |
| `allowUsers` | `[]` | 单聊白名单；**空 = 全部拒绝** |
| `adminUsers` | `[]` | 管理命令白名单；空 = 沿用 allowUsers |
| `commandPrefix` | `/` | 命令前缀 |
| `dsh.cwd` | home | 专属 agent 工作目录 |
| `server.port` | `3901` | 健康检查端口 |
| `notifier.enabled` | `true` | 注册 wechat_send / wechat_notify 工具 |
| `approval.enabled` | `true` | 审批桥（agent 请求批准 → 微信卡片） |
| `approval.timeoutMs` | `300000` | 审批等待超时（超时自动拒绝） |
| `media.dir` | `$DSH_HOME/weixinbot/media` | 多媒体保存目录 |
| `media.maxBytes` | `26214400` | 单个媒体大小上限（25MB） |

## M3 范围与已知限制

- **typing**、**主动通知工具**、**审批桥**、**多模态接收**（图片/语音/文件/视频，CDN + AES-128-ECB 解密后保存，agent 以附件路径方式读取）已实现。
- 已知限制：
  - 语音以原始 SILK 格式保存（silk→wav 转码未内置），agent 直接读文件路径；
  - 图片尚未以视觉 block 注入模型（设计 R5，需视觉模型支持）；
  - 主动推送（wechat_send / 审批卡片）不带 context_token，若腾讯端静默丢弃需实测确认。

- 仅**单聊**；群聊（F13）降级 P2。
- 凭据/游标/代次/会话映射持久化：`$DSH_HOME/weixinbot/`（credentials.json 0600、cursor.json、session-map.json、media/）。
- 掉线检测（`errcode=-14` / 401）→ 日志与健康检查标记，重新扫码即可恢复。

## 运维

- **重启**：dsh web 是 systemd 用户服务，`systemctl --user restart dsh-web`（不要用 PID）
- **联网搜索**：微信 agent 的 `web_search` 工具由 `@deepseek-ai/dsh-tool-web` 提供，
  dsh-web-app 默认禁用；在 profile 的 `cordis.patch.yml` 按 id 覆盖启用：

  ```yaml
  - id: tool-web
    name: '@deepseek-ai/dsh-tool-web'
    disabled: false
    config:
      fetch: false
      searchTimeoutMs: 60000
  ```

- **启动通知**：`notifyOnStart: true` 时插件每次启动向绑定者微信推送「启动好了」（进程级去重）
- **agent 自重启 + 续跑**：agent 需要重启自己时，先写续跑标记
  `$DSH_HOME/weixinbot/pending-continuation.json`（含自己的 `DSH_SESSION_ID` 与待办），
  再委托 claudecode（`systemd-run --user` 独立 unit，重启不杀它）执行
  `systemctl --user restart dsh-web`；新实例启动后插件读到标记，向该会话注入
  「重启完成通知」唤醒 agent 继续待办（成功才删标记，失败保留重试）。
  辅助脚本：`node tools/self-restart.mjs "<重启后待办>"`。
  ⚠️ 续跑回合只挂载 dsh 工具（如 web_search），**无 bash/文件等宿主工具**——
  重活会在用户下一条消息（工具齐全）时继续。
- 健康检查：`curl http://127.0.0.1:3901/health`；日志：`journalctl --user -u dsh-web`

## 参考

- [功能设计](./docs/功能设计.md)
- [微信 ClawBot iLink 协议解析](https://github.com/hao-ji-xing/openclaw-weixin/blob/main/weixin-bot-api.md)
- 参照实现：[wuyuanjiang1/dsh2wechat](https://github.com/wuyuanjiang1/dsh2wechat)
