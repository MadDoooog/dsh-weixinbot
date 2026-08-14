/**
 * Bridge：会话映射、白名单、去重、串行队列、命令、回复分块。
 * 只依赖 ChannelAdapter 接口与 MessageRunner 契约，不感知具体协议。
 */
import { chunkText, fileLog, formatError, type Logger } from '../util.js'
import type { ChannelAdapter, InboundMessage } from '../adapter/channel.js'
import type { MessageRunner } from '../runner/agent-runner.js'

export interface BridgeConfig {
  /** 单聊白名单（`xxx@im.wechat`）；空数组 = 全部拒绝（fail-closed）。 */
  allowUsers: string[]
  /** 管理命令白名单；空数组 = 沿用 allowUsers。 */
  adminUsers: string[]
  /** 命令前缀（/help /new /status）。 */
  commandPrefix: string
}

const DEDUPE_CAP = 2000

export class Bridge {
  private handler?: (msg: InboundMessage) => Promise<void>
  private dedupe = new Set<string>()
  private inflight = new Map<string, Promise<void>>()
  private stats = { inbound: 0, rejected: 0, replies: 0, commands: 0, lastActivityAt: 0 }

  constructor(
    private cfg: BridgeConfig,
    private runner: MessageRunner,
    private adapter: ChannelAdapter,
    private log: Logger,
  ) {}

  async start(): Promise<void> {
    this.adapter.onMessage((msg) => this.handle(msg))
    await this.adapter.start()
  }

  async stop(): Promise<void> {
    await this.adapter.stop()
  }

  status(): Record<string, unknown> {
    return {
      ...this.stats,
      queueDepth: this.inflight.size,
      sessions: this.inflight.size,
      adapter: this.adapter.status(),
    }
  }

  // ── 入站处理 ──

  private async handle(msg: InboundMessage): Promise<void> {
    this.stats.inbound++
    this.stats.lastActivityAt = Date.now()

    // M1 只处理单聊（群聊 F13 降级 P2）
    if (msg.kind === 'group') {
      this.log.info('微信: 忽略群消息 %s', msg.channelKey)
      return
    }

    // 白名单 fail-closed：空列表 = 全部拒绝
    if (this.cfg.allowUsers.length === 0 || !this.cfg.allowUsers.includes(msg.fromUserId)) {
      this.stats.rejected++
      this.log.info('微信: 忽略未授权发送者 %s（allowUsers=%d）', msg.fromUserId, this.cfg.allowUsers.length)
      return
    }

    // 去重（游标重放保护）
    if (this.dedupe.has(msg.msgId)) return
    this.dedupe.add(msg.msgId)
    if (this.dedupe.size > DEDUPE_CAP) this.dedupe.clear()

    const key = `wechat:${msg.channelKey}`
    // 串行队列：同一会话同一时刻一个 turn
    const prev = this.inflight.get(key) ?? Promise.resolve()
    const run = prev.then(() => this.process(key, msg))
    this.inflight.set(key, run)
    void run.finally(() => {
      if (this.inflight.get(key) === run) this.inflight.delete(key)
    })
    await run
  }

  private async process(key: string, msg: InboundMessage): Promise<void> {
    try {
      if (this.isCommand(msg.text)) {
        this.stats.commands++
        const handled = await this.runCommand(key, msg)
        if (handled) return
      }
      const reply = await this.runner.ask(key, msg.text)
      this.stats.replies++
      for (const chunk of chunkText(reply)) {
        await this.adapter.send(msg.fromUserId, msg.contextToken, chunk)
      }
    } catch (e) {
      const err = formatError(e)
      this.log.warn('回答失败: %s', err)
      fileLog('answer-fail', 'key=' + key + ' err=' + err)
      try {
        await this.adapter.send(msg.fromUserId, msg.contextToken, `❌ 处理失败：${err}`)
      } catch (e2) {
        this.log.error('失败回执也发送失败: %s', formatError(e2))
      }
    }
  }

  // ── 命令（M1 最小集：/help /status /new）──

  private isCommand(text: string): boolean {
    return text.startsWith(this.cfg.commandPrefix)
  }

  private async runCommand(key: string, msg: InboundMessage): Promise<boolean> {
    const cmd = msg.text.slice(this.cfg.commandPrefix.length).trim().split(/\s+/)[0].toLowerCase()
    const from = msg.fromUserId
    const isAdmin = (this.cfg.adminUsers.length > 0 ? this.cfg.adminUsers : this.cfg.allowUsers).includes(from)
    const send = (text: string) => this.adapter.send(msg.fromUserId, msg.contextToken, text)

    switch (cmd) {
      case 'help':
        await send('可用命令：/help 帮助 · /status 状态 · /new 开启新会话')
        return true
      case 'status': {
        const s = this.status() as unknown as {
          adapter?: { loggedIn?: boolean; pollAlive?: boolean }
          queueDepth?: number
          inbound?: number
          rejected?: number
          replies?: number
        }
        await send(
          '📊 状态\n' +
            `- 登录：${s.adapter?.loggedIn ? '✅' : '❌'}\n` +
            `- 轮询：${s.adapter?.pollAlive ? '✅' : '❌'}\n` +
            `- 队列：${s.queueDepth ?? 0}\n` +
            `- 已收/已拒/已回：${s.inbound ?? 0}/${s.rejected ?? 0}/${s.replies ?? 0}`,
        )
        return true
      }
      case 'new':
        if (!isAdmin) {
          await send('⛔ 无权执行 /new（仅管理员）')
          return true
        }
        await this.runner.reset(key)
        await send('✅ 已开启新会话（旧上下文已丢弃）')
        return true
      default:
        return false
    }
  }
}
