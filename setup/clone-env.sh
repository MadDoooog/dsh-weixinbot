#!/usr/bin/env bash
# =============================================================================
# dsh-weixinbot 一键克隆脚本 —— 在另一台机器（WSL/Linux）重建相同的 DSH 环境
#
# 用法：
#   bash setup/clone-env.sh                 # 全流程（含微信扫码绑定）
#   bash setup/clone-env.sh --skip-wechat   # 跳过微信绑定（稍后手动做）
#   bash setup/clone-env.sh --workspace ~/dsh-env
#
# 会创建/修改：
#   $DSH_HOME (~/.dsh)          DSH 数据目录（profiles/plugin-src/settings）
#   $WORKSPACE (~/dsh-env)      dsh-weixinbot 仓库克隆位置
#   ~/.local/bin/dsh-web-start.sh、~/.config/systemd/user/dsh-web.service
#
# 注意：微信凭据不在此脚本内（各机器独立扫码）；本机现有凭据不会被克隆。
# =============================================================================
set -euo pipefail

# ────────────────────────── 可配置项 ──────────────────────────
WORKSPACE="${WORKSPACE:-$HOME/dsh-env}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
export DSH_HOME   # 让 wechat-login 等子进程使用同一路径
DSH_VERSION="0.1.0-rc.6"
GIT_TOOLKIT="https://github.com/omdsh-dev/dsh-toolkit.git"
GIT_PROMPT_STUDIO="https://github.com/Moeblack/dsh-prompt-studio.git"
GIT_WEIXINBOT="https://github.com/MadDoooog/dsh-weixinbot.git"
DO_WECHAT="true"
PORT_GUI="${DSH_WEB_PORT:-3080}"
PORT_HEALTH="${DSH_HEALTH_PORT:-3901}"

# 参数解析
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-wechat) DO_WECHAT="false"; shift ;;
    --workspace)   WORKSPACE="$2"; shift 2 ;;
    --dsh-home)    DSH_HOME="$2"; shift 2 ;;
    --help|-h)     sed -n '4,16p' "$0"; exit 0 ;;
    *) die "未知参数: $1（--help 查看用法）" ;;
  esac
done

log() { printf '\033[1;36m[setup]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[setup][ERROR]\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ────────────────────────── 步骤 0：预检 ──────────────────────────
log "预检环境…"
for c in git curl; do have "$c" || die "缺少 $c，请先安装（sudo apt install $c）"; done
have node || die "缺少 node，将尝试通过 nvm 安装（也可手动安装后重跑）"
have pnpm || log "未检测到 pnpm，稍后通过 corepack 启用"
# systemd 用户会话（WSL2 需在 /etc/wsl.conf 启用 systemd 并 wsl --shutdown 重启）
if ! systemctl --user is-system-running >/dev/null 2>&1 && ! systemctl --user show-environment >/dev/null 2>&1; then
  die "用户级 systemd 不可用。WSL2 请设置 /etc/wsl.conf 的 [boot] systemd=true 后执行 wsl --shutdown 再进"
fi
mkdir -p "$WORKSPACE" "$DSH_HOME/plugin-src" "$DSH_HOME/profiles" "$DSH_HOME/weixinbot"

# ────────────────────────── 步骤 1：Node / pnpm ──────────────────────────
if ! have node; then
  log "安装 Node（nvm lts）…"
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install --lts && nvm alias default 'lts/*'
fi
if ! have pnpm; then
  log "启用 pnpm（corepack）…"
  corepack enable pnpm 2>/dev/null || npm install -g pnpm@10
fi
NODE_BIN="$(command -v node)"
log "node: $("$NODE_BIN" -v) / pnpm: $(pnpm -v)"

# ────────────────────────── 步骤 2：DSH_HOME 与 dsh CLI ──────────────────────────
log "初始化 $DSH_HOME 并预拉取 dsh CLI…"
cat > "$DSH_HOME/settings.yaml" <<'YAML'
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
locale:
  preference: zh
ui-conversation:
  busyEnter: steer
YAML

# 预拉取 dsh（填充 npx 缓存；--version 立即退出）
npx -y "@deepseek-ai/dsh@${DSH_VERSION}" --version >/dev/null 2>&1 || \
  die "dsh CLI 预拉取失败（网络？）"
DSH_BIN="$(find "$HOME/.npm/_npx" -maxdepth 2 -path '*/node_modules/.bin/dsh' -type l 2>/dev/null | head -1 || true)"
[ -n "$DSH_BIN" ] || DSH_BIN="$(find "$HOME/.npm/_npx" -maxdepth 2 -path '*/node_modules/.bin/dsh' 2>/dev/null | head -1)"
[ -n "$DSH_BIN" ] || die "未找到 dsh CLI（npx 缓存路径异常）"
log "dsh CLI: $DSH_BIN"

# ────────────────────────── 步骤 3：本地插件源 ──────────────────────────
log "克隆本地插件源到 $DSH_HOME/plugin-src…"
[ -d "$DSH_HOME/plugin-src/dsh-toolkit" ] || \
  git clone --depth 1 "$GIT_TOOLKIT" "$DSH_HOME/plugin-src/dsh-toolkit"
[ -d "$DSH_HOME/plugin-src/dsh-prompt-studio" ] || \
  git clone --depth 1 "$GIT_PROMPT_STUDIO" "$DSH_HOME/plugin-src/dsh-prompt-studio"

# 共享解析依赖（工具包运行期从 plugin-src/node_modules 解析 @deepseek-ai/*）
if [ ! -f "$DSH_HOME/plugin-src/package.json" ]; then
  cat > "$DSH_HOME/plugin-src/package.json" <<'JSON'
{
  "name": "dsh-plugin-src-shared",
  "private": true,
  "dependencies": {
    "@deepseek-ai/cordis": "4.0.1",
    "@deepseek-ai/dsh-invariants": "0.1.0-rc.6",
    "@deepseek-ai/dsh-tools": "0.1.0-rc.6"
  }
}
JSON
fi
[ -d "$DSH_HOME/plugin-src/node_modules" ] || (
  cd "$DSH_HOME/plugin-src" && npm install --no-audit --no-fund
)

# ────────────────────────── 步骤 4：web profile ──────────────────────────
log "创建 web profile（package.json / pnpm-workspace / cordis.patch）…"
PROFILE_DIR="$DSH_HOME/profiles/web"
mkdir -p "$PROFILE_DIR"

# 4a. profile package.json（依赖 + bundles，与当前环境一致）
cat > "$PROFILE_DIR/package.json" <<'JSON'
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "@bill9109/dsh-web-ui-notify": "github:bill9109/dsh-web-ui-notify",
    "@deepseek-ai/dsh-tool-calculator": "link:__DSH_HOME__/plugin-src/dsh-toolkit/packages/dsh-tool-calculator",
    "@deepseek-ai/dsh-tool-csv": "link:__DSH_HOME__/plugin-src/dsh-toolkit/packages/dsh-tool-csv",
    "@deepseek-ai/dsh-tool-diff": "link:__DSH_HOME__/plugin-src/dsh-toolkit/packages/dsh-tool-diff",
    "@deepseek-ai/dsh-tool-encoding": "link:__DSH_HOME__/plugin-src/dsh-toolkit/packages/dsh-tool-encoding",
    "@deepseek-ai/dsh-tool-json": "link:__DSH_HOME__/plugin-src/dsh-toolkit/packages/dsh-tool-json",
    "@deepseek-ai/dsh-tool-markdown": "link:__DSH_HOME__/plugin-src/dsh-toolkit/packages/dsh-tool-markdown",
    "@deepseek-ai/dsh-tool-regex": "link:__DSH_HOME__/plugin-src/dsh-toolkit/packages/dsh-tool-regex",
    "@deepseek-ai/dsh-tool-schema": "link:__DSH_HOME__/plugin-src/dsh-toolkit/packages/dsh-tool-schema",
    "@deepseek-ai/dsh-tool-stat": "link:__DSH_HOME__/plugin-src/dsh-toolkit/packages/dsh-tool-stat",
    "@deepseek-ai/dsh-tool-time": "link:__DSH_HOME__/plugin-src/dsh-toolkit/packages/dsh-tool-time",
    "dsh-at-file": "https://github.com/omdsh-dev/dsh-at-file/archive/refs/tags/v0.3.1.tar.gz",
    "dsh-better-sidebar": "0.10.3",
    "dsh-cost-meter": "github:Han-1413141/dsh-cost-meter",
    "dsh-notify-windows": "^0.5.0",
    "dsh-prompt-studio": "link:__DSH_HOME__/plugin-src/dsh-prompt-studio",
    "dsh-recommend": "^0.2.0",
    "dsh-web-attention-badge": "^0.3.2",
    "dsh-weixinbot": "link:__WORKSPACE__/dsh-weixinbot"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-better-sidebar",
        "dsh-at-file",
        "dsh-prompt-studio",
        "dsh-cost-meter",
        "dsh-recommend",
        "@deepseek-ai/dsh-tool-calculator",
        "@deepseek-ai/dsh-tool-csv",
        "@deepseek-ai/dsh-tool-diff",
        "@deepseek-ai/dsh-tool-encoding",
        "@deepseek-ai/dsh-tool-json",
        "@deepseek-ai/dsh-tool-markdown",
        "@deepseek-ai/dsh-tool-regex",
        "@deepseek-ai/dsh-tool-schema",
        "@deepseek-ai/dsh-tool-stat",
        "@deepseek-ai/dsh-tool-time",
        "@bill9109/dsh-web-ui-notify",
        "dsh-web-attention-badge",
        "dsh-weixinbot"
      ]
    }
  }
}
JSON

# 4b. pnpm-workspace.yaml
cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<'YAML'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

onlyBuiltDependencies:
  - node-pty
  - protobufjs

minimumReleaseAgeExclude:
  - dsh-better-sidebar
YAML

# 4c. cordis.patch.yml（weixinbot 覆盖 + tool-web 联网搜索启用；allowUsers 待登录后填充）
cat > "$PROFILE_DIR/cordis.patch.yml" <<'YAML'
- insert:
    - id: dsh-notify
      name: 'dsh-notify-windows'
      config:
        enabled: false
        reasons: [completed, error, max-tokens]
        includeSubagents: false
        notifyOnStart: true
        notifyOnApproval: true
        notifyOnAskUser: true
        appName: 'DeepSeek Harness'
        aumid: 'DeepSeekHarness.Notify'
        log: true
        debug: false

# dsh-weixinbot 行由插件 bundle patch 插入；这里按 id 定向覆盖（非 insert）
- id: weixinbot
  name: dsh-weixinbot
  config:
    enabled: true
    adapter: ilink-direct
    credentials:
      botToken: ''
      baseUrl: https://ilinkai.weixin.qq.com
      botId: ''
      userId: ''
    poll:
      timeoutMs: 35000
      retryDelayMs: 3000
    queue:
      turnTimeoutMs: 120000
      rateLimitPer5min: 6
    allowUsers:
      - '__USERID__'
    adminUsers: []
    commandPrefix: /
    notifyOnStart: true
    dsh:
      cwd: ''
    server:
      enabled: true
      port: __HEALTH_PORT__
    logFile: true

# 启用模型侧联网搜索工具（dsh-web-app 默认禁用）
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  disabled: false
  config:
    fetch: false
    searchTimeoutMs: 60000
YAML

# 占位符替换
sed -i "s|__DSH_HOME__|$DSH_HOME|g; s|__WORKSPACE__|$WORKSPACE|g; s|__HEALTH_PORT__|$PORT_HEALTH|g" "$PROFILE_DIR/package.json" "$PROFILE_DIR/cordis.patch.yml"

# ────────────────────────── 步骤 5：dsh-weixinbot ──────────────────────────
log "克隆并构建 dsh-weixinbot → $WORKSPACE/dsh-weixinbot…"
[ -d "$WORKSPACE/dsh-weixinbot" ] || git clone --depth 1 "$GIT_WEIXINBOT" "$WORKSPACE/dsh-weixinbot"
( cd "$WORKSPACE/dsh-weixinbot" && npm install --no-audit --no-fund && npm run build )
[ -f "$WORKSPACE/dsh-weixinbot/lib/index.js" ] || die "dsh-weixinbot 构建失败（lib/index.js 缺失）"

# ────────────────────────── 步骤 6：profile 依赖安装 ──────────────────────────
# 放在 weixinbot 构建之后：package.json 里的 link: 目标此时才全部存在
log "安装 profile 依赖（pnpm install）…"
( cd "$PROFILE_DIR" && pnpm install )

# ────────────────────────── 步骤 7：systemd 用户服务 ──────────────────────────
log "安装 systemd 用户服务 dsh-web…"
mkdir -p "$HOME/.local/bin" "$HOME/.config/systemd/user"
cat > "$HOME/.local/bin/dsh-web-start.sh" <<EOF
#!/usr/bin/env bash
# dsh-web-start.sh（由 setup/clone-env.sh 生成）
set -u
NODE_BIN="$NODE_BIN"
DSH_BIN="$DSH_BIN"
HOST="\${DSH_WEB_HOST:-127.0.0.1}"
PORT="\${DSH_WEB_PORT:-$PORT_GUI}"
export HOME="\$HOME" LANG="\${LANG:-C.UTF-8}" NODE="\$NODE_BIN"
export PATH="\$(dirname "\$NODE_BIN"):\$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
if ss -tln 2>/dev/null | awk '{print \$4}' | grep -q ":\${PORT}\$"; then
  echo "dsh-web-start: port \${PORT} in use — leaving existing instance" >&2
  exit 0
fi
if [ ! -x "\$DSH_BIN" ]; then
  exec npx --yes "@deepseek-ai/dsh@$DSH_VERSION" web --host "\$HOST" --port "\$PORT" "\$@"
fi
exec "\$NODE_BIN" "\$DSH_BIN" web --host "\$HOST" --port "\$PORT" "\$@"
EOF
chmod +x "$HOME/.local/bin/dsh-web-start.sh"

cat > "$HOME/.config/systemd/user/dsh-web.service" <<EOF
[Unit]
Description=DeepSeek Harness web GUI (dsh web) on 127.0.0.1:$PORT_GUI
Documentation=https://github.com/deepseek-ai/deepseek-harness

[Service]
Type=simple
WorkingDirectory=$HOME
ExecStart=$HOME/.local/bin/dsh-web-start.sh
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable dsh-web.service
log "systemd 服务已安装（WSL 开机自动拉起；Windows 浏览器访问 http://127.0.0.1:$PORT_GUI）"

# ────────────────────────── 步骤 8：微信绑定（可选）──────────────────────────
if [ "$DO_WECHAT" = "true" ]; then
  log "微信扫码绑定…"
  ( cd "$WORKSPACE/dsh-weixinbot" && node tools/wechat-login.mjs --write ) || \
    die "扫码登录失败（可稍后手动重跑 tools/wechat-login.mjs --write）"
  # 用登录返回的 userId 填充白名单（fail-closed 需要）
  USERID="$(node -e "try{console.log(require('$DSH_HOME/weixinbot/credentials.json').userId||'')}catch(e){console.log('')}")"
  if [ -n "$USERID" ]; then
    sed -i "s|'__USERID__'|'$USERID'|" "$PROFILE_DIR/cordis.patch.yml"
    log "allowUsers 已填入: $USERID"
  else
    log "警告：未取到 userId，请手动把 allowUsers 填入 $PROFILE_DIR/cordis.patch.yml"
  fi
else
  log "跳过微信绑定（--skip-wechat）。之后运行: cd $WORKSPACE/dsh-weixinbot && node tools/wechat-login.mjs --write"
  log "并把 userId 填入 $PROFILE_DIR/cordis.patch.yml 的 allowUsers"
  sed -i "s|'__USERID__'|'替换为你的userId'|" "$PROFILE_DIR/cordis.patch.yml"
fi

# ────────────────────────── 步骤 9：启动与验证 ──────────────────────────
log "启动 dsh-web 并验证…"
systemctl --user start dsh-web.service || true
for i in $(seq 1 40); do
  if curl -s -m 3 "http://127.0.0.1:$PORT_GUI" -o /dev/null 2>/dev/null; then break; fi
  sleep 3
done
HEALTH="$(curl -s -m 5 "http://127.0.0.1:$PORT_HEALTH/health" 2>/dev/null || true)"
echo
log "════════════════════════════════════════════════"
log "安装完成！"
log "  GUI:      http://127.0.0.1:$PORT_GUI"
log "  health:   http://127.0.0.1:$PORT_HEALTH/health  → ${HEALTH:0:80}"
log "  服务:     systemctl --user status dsh-web"
log "  日志:     journalctl --user -u dsh-web -f"
log "  微信:     给机器人发消息即可；发 /status 看状态、/new /list /switch 管会话"
log "  重启:     systemctl --user restart dsh-web"
log "════════════════════════════════════════════════"
