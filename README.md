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

```yaml
- insert:
    - id: weixinbot
      name: 'dsh-weixinbot'
      config:
        enabled: true
        allowUsers: ['<你的 userId，扫码输出里有>']   # 空 = 全部拒绝（fail-closed）
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
| `/new` | 开启新会话（丢弃旧上下文） | 管理员（缺省=白名单用户） |

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

## M1 范围与已知限制

- 仅**文本**单向桥（微信 → DSH → 微信），上下文持久、跨重启连续。
- 仅**单聊**；群聊（F13）降级 P2。
- 凭据/游标持久化：`$DSH_HOME/weixinbot/`（credentials.json 0600、cursor.json）。
- 掉线检测（`errcode=-14` / 401）→ 日志与健康检查标记，重新扫码即可恢复。

## 参考

- [功能设计](./docs/功能设计.md)
- [微信 ClawBot iLink 协议解析](https://github.com/hao-ji-xing/openclaw-weixin/blob/main/weixin-bot-api.md)
- 参照实现：[wuyuanjiang1/dsh2wechat](https://github.com/wuyuanjiang1/dsh2wechat)
