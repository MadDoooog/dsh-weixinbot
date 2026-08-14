/**
 * dsh-weixinbot — DeepSeek Harness 微信 ClawBot（iLink）消息桥插件。
 *
 * 微信发消息 → 专属持久 agent 会话（ctx.agents）回答 → 回发到微信。
 * M1 原型范围：文本单向桥 + 扫码登录 + 白名单 + 健康检查 + 命令（/help /status /new）。
 */
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// 激活 dsh-agent-default-model 对 Context 的类型扩展（ctx.agentDefaultModel）
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { normalizeConfig, type Config } from './config.js'
import { fileLog, formatError, setLogFile, type Logger } from './util.js'
import { loadCredentials, loadCursor, saveCursor } from './credentials.js'
import { ILinkDirectAdapter } from './adapter/ilink-direct.js'
import { Bridge } from './bridge/bridge.js'
import { AgentRunner } from './runner/agent-runner.js'
import { StatusServer } from './server/health.js'
import { registerNotifyTools, type ToolsHost } from './notifier/tools.js'
import { ApprovalBridge, type ApprovalHost } from './approval/bridge.js'

export const name = 'dsh-weixinbot'
/** 需要的服务：AgentRegistry（ctx.agents）+ 默认模型选择器。 */
export const inject = ['agents', 'agentDefaultModel']
export type { Config } from './config.js'

export function apply(ctx: Context, config: Config = {} as Config): () => Promise<void> {
  const logger: Logger = ctx.logger('weixinbot')
  const cfg = normalizeConfig(config)
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

  // ── 崩溃诊断：文件日志 + 进程级错误钩子（止血并留证）──
  if (cfg.logFile) setLogFile(path.join(home, 'weixinbot', 'weixinbot.log'))
  const onUnhandled = (reason: unknown) => {
    fileLog('unhandledRejection', reason)
    logger.error('未处理的 Promise 拒绝: %s', formatError(reason))
  }
  const onUncaught = (err: Error) => {
    fileLog('uncaughtException', err)
    logger.error('未捕获异常: %s', err.stack ?? err.message)
  }
  process.on('unhandledRejection', onUnhandled)
  process.on('uncaughtException', onUncaught)

  // ── 默认模型：配置显式值优先，否则读 ctx.agentDefaultModel ──
  let provider = cfg.dsh.provider
  let model = cfg.dsh.model
  try {
    const sel = ctx.agentDefaultModel.currentSelection()
    provider = provider ?? sel.provider
    model = model ?? sel.model
  } catch (e) {
    logger.warn('读取默认模型失败: %s', formatError(e))
  }

  // ── 凭据：config 优先，回退文件（$DSH_HOME/weixinbot/credentials.json）──
  let botToken = cfg.credentials?.botToken
  let baseUrl = cfg.credentials?.baseUrl || 'https://ilinkai.weixin.qq.com'
  let botId = cfg.credentials?.botId
  const fileCreds = !botToken ? loadCredentials(home) : null
  if (!botToken && fileCreds?.botToken) {
    botToken = fileCreds.botToken
    baseUrl = fileCreds.baseUrl || baseUrl
    botId = fileCreds.botId
  }

  const runner = new AgentRunner(
    { cwd: cfg.dsh.cwd, timeoutMs: cfg.queue.turnTimeoutMs, provider, model },
    ctx,
    logger,
  )
  const adapter = new ILinkDirectAdapter({
    botToken: botToken ?? '',
    baseUrl,
    botId,
    pollTimeoutMs: cfg.poll.timeoutMs,
    retryDelayMs: cfg.poll.retryDelayMs,
    rateLimitPer5min: cfg.queue.rateLimitPer5min,
    mediaDir: cfg.media.dir || path.join(home, 'weixinbot', 'media'),
    maxBytes: cfg.media.maxBytes,
    cursor: { load: () => loadCursor(home), save: (b) => saveCursor(b, home) },
    logger,
  })
  // F12 审批桥：监听 approval/request，微信里 /approve|/reject 决策
  const ownerUserId = (botToken && (cfg.credentials?.userId || fileCreds?.userId)) || ''
  const approval = new ApprovalBridge(ctx as ApprovalHost, adapter, {
    enabled: cfg.approval.enabled,
    defaultTarget: ownerUserId,
    timeoutMs: cfg.approval.timeoutMs,
  }, logger)
  approval.start()

  const bridge = new Bridge(
    {
      allowUsers: cfg.allowUsers,
      adminUsers: cfg.adminUsers,
      commandPrefix: cfg.commandPrefix,
      approval,
    },
    runner,
    adapter,
    logger,
  )
  const server = new StatusServer(cfg.server, () => bridge.status(), logger)

  // F9 主动通知工具（wechat_send / wechat_notify）——注册进 DSH 工具箱
  try {
    const defaultTarget = (botToken && (cfg.credentials?.userId || fileCreds?.userId)) || ''
    registerNotifyTools(ctx as ToolsHost, adapter, { enabled: cfg.notifier?.enabled ?? true, defaultTarget }, logger)
  } catch (e) {
    logger.warn('注册通知工具失败: %s', formatError(e))
  }

  const state = { enabled: cfg.enabled, loggedIn: adapter.isLoggedIn(), adapter: cfg.adapter }
  if (cfg.enabled && adapter.isLoggedIn()) {
    void bridge.start().catch((e) => logger.error('微信通道启动失败: %s', formatError(e)))
  } else if (cfg.enabled && !adapter.isLoggedIn()) {
    logger.warn('微信通道未启用：缺少 bot_token（先运行 tools/wechat-login.mjs 扫码，或配置 credentials）')
  }
  if (cfg.server.enabled) {
    void server.start().catch((e) => logger.error('健康检查服务启动失败: %s', formatError(e)))
  }
  logger.info('dsh-weixinbot 已启动: %s', JSON.stringify(state))
  fileLog('apply', 'dsh-weixinbot loaded state=' + JSON.stringify(state))

  return async () => {
    process.removeListener('unhandledRejection', onUnhandled)
    process.removeListener('uncaughtException', onUncaught)
    await Promise.allSettled([bridge.stop(), server.stop(), runner.dispose()])
    logger.info('dsh-weixinbot 已停止')
    fileLog('dispose', 'dsh-weixinbot stopped')
  }
}
