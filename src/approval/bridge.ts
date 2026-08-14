/**
 * F12 审批流桥接：监听 DSH 的 `approval/request` waterfall 事件，
 * 把审批请求推送到微信，用户在微信回复 `/approve <id>` / `/reject <id>` 决策。
 *
 * - 启用时本桥**认领**审批请求（返回 outcome），GUI 不再重复弹窗；
 * - 超时未回复 → fail-closed（rejected）；
 * - 请求被中止（signal abort）→ cancelled；
 * - 通过 Bridge 的 ApprovalHandler 钩子接收微信命令。
 *
 * 注意：为规避 dsh-user-approval 版本耦合，事件与请求对象按最小形状访问，
 * 不 import 该包（outcome 词汇：allowed-once / rejected / cancelled / unavailable）。
 */
import type { ChannelAdapter } from '../adapter/channel.js'
import type { Logger } from '../util.js'

/** 微信侧审批命令处理器：Bridge 在 runCommand 前调用。 */
export interface ApprovalHandler {
  /** 消费 /approve|/reject 命令；返回要发送的回复文本，未命中返回 null。 */
  handleCommand(text: string, fromUserId: string): Promise<string | null>
}

/** 最小 ctx 形状（真实 cordis Context 结构兼容）。 */
export interface ApprovalHost {
  on(event: string, handler: (req: unknown, next: () => Promise<string>) => Promise<string>): unknown
}

export interface ApprovalConfig {
  enabled: boolean
  /** 审批卡片发送目标（绑定者 userId）。 */
  defaultTarget: string
  /** 等待用户决策的超时（毫秒），超时 fail-closed = rejected。 */
  timeoutMs: number
}

export interface ApprovalRequestLike {
  toolName?: string
  reason?: string
  signal?: AbortSignal
}

type Resolver = (outcome: string) => void

export class ApprovalBridge implements ApprovalHandler {
  private pending = new Map<string, Resolver>()
  private seq = 0

  constructor(
    private host: ApprovalHost,
    private adapter: ChannelAdapter,
    private cfg: ApprovalConfig,
    private log: Logger,
  ) {}

  /** 注册 waterfall 监听（在插件 apply 时调用）。 */
  start(): void {
    if (!this.cfg.enabled || !this.cfg.defaultTarget) return
    this.host.on('approval/request', (rawReq, next) => this.onApprovalRequest(rawReq as ApprovalRequestLike, next))
    this.log.info('[approval] 审批桥已启用（目标=%s，超时 %ds）', this.cfg.defaultTarget, this.cfg.timeoutMs / 1000)
  }

  private async onApprovalRequest(req: ApprovalRequestLike, next: () => Promise<string>): Promise<string> {
    if (!this.cfg.enabled) return next()
    const id = `a${++this.seq}`
    const card =
      `🔐 需要你的批准（ID: ${id}）\n` +
      `- 工具：${req.toolName ?? '(未知)'}\n` +
      (req.reason ? `- 原因：${req.reason}\n` : '') +
      `回复「/approve ${id}」或「/reject ${id}」`

    let resolve!: Resolver
    const outcome = new Promise<string>((r) => (resolve = r))
    const timer = setTimeout(() => {
      if (this.pending.delete(id)) {
        this.log.warn('[approval] %s 决策超时，fail-closed=rejected', id)
        resolve('rejected')
      }
    }, this.cfg.timeoutMs)
    const onAbort = () => {
      if (this.pending.delete(id)) {
        clearTimeout(timer)
        resolve('cancelled')
      }
    }
    req.signal?.addEventListener('abort', onAbort, { once: true })

    this.pending.set(id, (outcomeValue) => {
      clearTimeout(timer)
      req.signal?.removeEventListener('abort', onAbort)
      resolve(outcomeValue)
    })

    // 推送审批卡片（主动消息无 context_token）
    this.adapter
      .send(this.cfg.defaultTarget, '', card)
      .then(() => this.log.info('[approval] 已推送审批 %s（%s）', id, req.toolName))
      .catch((e) => this.log.error('[approval] 推送审批 %s 失败: %s', id, e instanceof Error ? e.message : String(e)))

    return outcome
  }

  /** 微信侧 /approve|/reject <id>。 */
  async handleCommand(text: string, fromUserId: string): Promise<string | null> {
    if (!this.cfg.enabled) return null
    const m = /^\/(approve|reject)\s+([A-Za-z0-9-]+)\s*$/i.exec(text.trim())
    if (!m) return null
    const action = m[1].toLowerCase()
    const id = m[2]
    const resolver = this.pending.get(id)
    if (!resolver) return `❌ 审批 ${id} 不存在或已过期`
    resolver(action === 'approve' ? 'allowed-once' : 'rejected')
    return `✅ 已${action === 'approve' ? '批准' : '拒绝'} ${id}`
  }

  status(): Record<string, unknown> {
    return { enabled: this.cfg.enabled, pending: this.pending.size, target: this.cfg.defaultTarget }
  }
}
