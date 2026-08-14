# 一键克隆 DSH 开发环境（新机器 / WSL）

`setup/clone-env.sh` 在另一台 Linux/WSL 机器上重建与当前机器**一致的 DSH 环境**：
DSH web GUI + 全部插件（toolkit 10 工具 / prompt-studio / 侧边栏 / 推荐 / 成本计 / 文件附件 /
通知 / weixinbot）+ 微信桥 + 联网搜索 + systemd 自启。

## 在旧机器上：环境清单（当前安装的插件/配置汇总）

| 组件 | 来源 | 说明 |
|---|---|---|
| DSH CLI | `npx @deepseek-ai/dsh@0.1.0-rc.6` | web profile（base + web-app 内建） |
| dsh-toolkit（10 个工具） | `omdsh-dev/dsh-toolkit` | 克隆即用（lib 已入库），link 进 profile |
| dsh-prompt-studio | `Moeblack/dsh-prompt-studio` | 克隆即用（index.mjs/client.js 已入库） |
| dsh-better-sidebar / dsh-at-file / dsh-cost-meter / dsh-recommend / dsh-web-attention-badge / @bill9109/dsh-web-ui-notify / dsh-notify-windows | npm / GitHub | profile `dependencies` 声明 |
| **dsh-weixinbot** | `MadDoooog/dsh-weixinbot`（本仓库） | `npm install && npm run build`，link 进 profile |
| 微信凭据 | 每台机器独立扫码 | **不会克隆**（wechat-login 重新绑定） |
| systemd 服务 | 脚本生成 | `dsh-web.service` → `dsh-web-start.sh`，WSL 开机自动拉起 |

## 新机器用法

```bash
# 1. 准备（WSL2 需先启用 systemd）
#    /etc/wsl.conf 加：
#      [boot]
#      systemd=true
#    然后 PowerShell 执行：wsl --shutdown && wsl

# 2. 拿到脚本（任选其一）
curl -fsSL https://raw.githubusercontent.com/MadDoooog/dsh-weixinbot/main/setup/clone-env.sh -o clone-env.sh
#   或：git clone https://github.com/MadDoooog/dsh-weixinbot.git && cd dsh-weixinbot

# 3. 运行
bash clone-env.sh                # 全流程（结尾微信扫码）
bash clone-env.sh --skip-wechat  # 先不绑微信
bash clone-env.sh --workspace ~/dsh-env   # 自定义 weixinbot 位置
```

流程：预检 → node/pnpm → DSH_HOME + dsh CLI → 克隆本地插件源 → 写 web profile
（package.json / pnpm-workspace / cordis.patch）→ 克隆构建 dsh-weixinbot → pnpm install
→ systemd 服务 → 微信扫码 → 启动验证。

## 安装后

- **Windows 浏览器**访问 `http://127.0.0.1:3080`（WSL2 localhost 转发默认可用）
- 微信：给机器人发消息；`/status` 看状态，`/new` `/list` `/switch` 管会话
- 联网搜索已启用（tool-web），回复用北京时间（UTC+8）
- 重启：`systemctl --user restart dsh-web`（claudecode 自愈流程见主 README「运维」）

## 排错

| 现象 | 处理 |
|---|---|
| systemd 不可用 | 检查 `/etc/wsl.conf` 的 `[boot] systemd=true`，`wsl --shutdown` 重启 |
| dsh CLI 找不到 | npx 缓存被清；脚本会自动回退 `npx @deepseek-ai/dsh@0.1.0-rc.6 web` |
| 微信消息被忽略 | `allowUsers` 没填：把 `wechat-login --write` 输出的 `userId` 填入 profile 的 `cordis.patch.yml` |
| profile 依赖装不上 | 网络（npm/github）；`cd ~/.dsh/profiles/web && pnpm install` 重试 |
| GUI 打不开 | `journalctl --user -u dsh-web -n 100 --no-pager` 看日志 |

## 注意

- **凭据不克隆**：`$DSH_HOME/weixinbot/credentials.json`、`cursor.json`、`session-map.json` 为新机器各自独立
- 脚本幂等：已存在的克隆目录/依赖会跳过，可重复运行
- 版本锁定：DSH 0.1.0-rc.6、cordis 4.0.1、dsh-tools/invariants 0.1.0-rc.6（与当前环境一致）
