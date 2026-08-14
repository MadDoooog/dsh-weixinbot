/**
 * AgentRunner：通过 DSH 官方 agent 运行时回答消息。
 *
 * 每个微信会话（channelKey）对应一个独立持久 Agent（`im-wechat-*` 会话），
 * 与 GUI 会话隔离；agent 的持久日志即其记忆，跨消息、跨重启上下文连续。
 *
 * API 契约（@deepseek-ai/dsh-agent）：
 * - `ctx.agents.resume({ resumeSessionId })` — 恢复持久会话；
 * - `ctx.agents.create({ sessionId, meta })` — 首次联系；
 * - `agent.followup(userMessage)` — 排队一个普通 turn 并唤醒循环；
 * - `agent.whenIdle()` — 等整轮 agent 活动收敛；
 * - `agent.cancel({ kind, reason })` — 超时取消；
 * - 最终答案 = 本轮新增的最后一个 `assistant/message` 会话事件。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { fileLog, formatError, type Logger } from '../util.js'

export interface AgentRunnerConfig {
  /** 专属 agent 的工作目录。 */
  cwd: string
  /** 单轮回答超时（毫秒）。 */
  timeoutMs: number
  /** 可选 provider 路由（缺省用 ctx.agentDefaultModel）。 */
  provider?: string
  /** 可选 model id。 */
  model?: string
}

/** Bridge 依赖的最小 runner 契约。 */
export interface MessageRunner {
  ask(key: string, text: string): Promise<string>
  /** 开新会话：丢弃旧上下文。 */
  reset(key: string): Promise<void>
  dispose(): Promise<void>
}

function agentOptions(cfg: AgentRunnerConfig): { provider?: string; model?: string } {
  const opts: { provider?: string; model?: string } = {}
  if (cfg.provider) opts.provider = cfg.provider
  if (cfg.model) opts.model = cfg.model
  return opts
}

/**
 * 进程级共享 Agent 句柄表：插件热重载（apply 再次执行）后，新实例
 * 直接复用旧实例仍在内存中的 live Agent，避免同 id 会话冲突。
 */
const liveAgents = new Map<string, AgentHandle>()

export class AgentRunner implements MessageRunner {
  private handles = new Map<string, AgentHandle>()
  private inflight = new Map<string, Promise<string>>()
  /**
   * 每个会话的开新计数（持久化到 $DSH_HOME/weixinbot/session-map.json）：
   * /new 显式开新会话时才轮换 sessionId；普通消息/热重载绝不轮换。
   */
  private generation = new Map<string, number>()

  constructor(private cfg: AgentRunnerConfig, private ctx: Context, private log: Logger) {
    this.generation = this.loadGenerations()
  }

  /** 串行化同一会话：同一时刻只有一个 turn 在跑。 */
  ask(key: string, text: string): Promise<string> {
    const prev = this.inflight.get(key) ?? Promise.resolve('')
    const run = prev.then(() => this.runOnce(key, text))
    this.inflight.set(key, run)
    // run 失败时 finally 链会再产生 rejection，必须显式吞掉，
    // 否则 Node（默认 --unhandled-rejections=throw）会让整个进程退出。
    void run.then(
      () => {
        if (this.inflight.get(key) === run) this.inflight.delete(key)
      },
      () => {
        if (this.inflight.get(key) === run) this.inflight.delete(key)
      },
    )
    return run
  }

  /** /new：显式开新会话——代次 +1（持久化），dispose 旧 handle，下次 ask 用新 sessionId。 */
  async reset(key: string): Promise<void> {
    const gen = (this.generation.get(key) ?? 0) + 1
    this.generation.set(key, gen)
    this.persistGenerations()
    const handle = this.handles.get(key) ?? liveAgents.get(key)
    this.handles.delete(key)
    liveAgents.delete(key)
    if (handle) {
      try {
        await handle.dispose()
        this.log.info('会话 %s 已重置（gen=%d）', key, gen)
        fileLog('reset', 'key=' + key + ' gen=' + gen)
      } catch (e) {
        this.log.warn('重置会话 %s 失败: %s', key, formatError(e))
      }
    }
  }

  async dispose(): Promise<void> {
    // 不 dispose 共享句柄：热重载后新 apply 实例复用仍在内存中的 live Agent；
    // 进程退出时由 DSH 清理。
    this.handles.clear()
  }

  // ── 内部 ──

  private async runOnce(key: string, text: string): Promise<string> {
    const handle = await this.getOrCreate(key)
    const agent = handle.agent
    const startTurn = this.lastTurn(agent.session.events)
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    agent.followup(message)
    fileLog('followup', 'sent to session=' + agent.id + ' status=' + agent.status + ' text=' + text.slice(0, 80))

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try {
          agent.cancel({ kind: 'hook', reason: 'dsh-weixinbot timeout' })
        } catch (e) {
          this.log.warn('取消 agent 失败: %s', formatError(e))
        }
        fileLog('timeout', 'turn aborted after ' + this.cfg.timeoutMs + 'ms')
        reject(new Error(`agent 回答超时（${this.cfg.timeoutMs}ms），已取消该轮`))
      }, this.cfg.timeoutMs)
    })
    try {
      fileLog('whenIdle', 'waiting, status=' + agent.status + ' events=' + agent.session.events.length)
      await Promise.race([agent.whenIdle(), timeout])
      fileLog('whenIdle', 'settled, status=' + agent.status + ' events=' + agent.session.events.length)
    } finally {
      if (timer) clearTimeout(timer)
    }
    try {
      const reply = this.extractReply(agent.session.events, startTurn)
      fileLog('reply', 'len=' + reply.length + ' head=' + reply.slice(0, 60).replace(/\n/g, ' '))
      return reply
    } catch (e) {
      fileLog('extract-fail', 'afterTurn=' + startTurn + ' err=' + formatError(e))
      throw e
    }
  }

  private async getOrCreate(key: string): Promise<AgentHandle> {
    // 跨实例复用：热重载/重复 apply 后旧 Agent 仍 live，直接续用
    const shared = liveAgents.get(key)
    if (shared) {
      this.handles.set(key, shared)
      return shared
    }
    const existing = this.handles.get(key)
    if (existing) return existing
    const sessionId = SessionId(this.sessionIdFor(key))

    // 1) 优先恢复既有会话（含跨进程重启：从磁盘恢复持久上下文）
    let resumeErr = ''
    try {
      const handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: agentOptions(this.cfg),
      })
      this.log.info('恢复会话 %s', sessionId)
      fileLog('resume', 'OK session=' + sessionId)
      this.cache(key, handle)
      return handle
    } catch (e) {
      resumeErr = formatError(e)
      fileLog('resume', 'FAIL session=' + sessionId + ' err=' + resumeErr)
    }

    // 2) 会话仍被（旧实例热重载残留的）live agent 占用 → 复用注册表里的
    //    live Agent，绝不 purge/轮换（purge 会连上下文一起删掉）。
    if (/while it is live|cannot prepare/i.test(resumeErr)) {
      const agent = this.ctx.agents.get(sessionId)
      if (agent) {
        const handle: AgentHandle = { agent, dispose: async () => {} }
        this.log.info('复用仍存活的会话 %s（热重载残留，保留上下文）', sessionId)
        fileLog('reuse-live', 'session=' + sessionId)
        this.cache(key, handle)
        return handle
      }
    }

    // 3) 创建新会话。只有「磁盘残留」冲突（already exists，非 live）才清掉重试；
    //    绝不因 live 冲突轮换 id（否则每条消息/每次重载都生成新会话）。
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await this.createAgent(sessionId)
        this.cache(key, handle)
        return handle
      } catch (e2) {
        const msg2 = formatError(e2)
        if (attempt === 0 && /already exists|does not match/i.test(msg2)) {
          // 磁盘残留（上个进程崩溃遗留的持久目录）→ 清掉后重试同 id
          await this.purgeSession(String(sessionId))
          fileLog('heal', 'purged disk residue, retry session=' + sessionId + ' err=' + msg2)
          continue
        }
        throw e2
      }
    }
    throw new Error('无法创建会话（' + sessionId + '）')
  }

  private cache(key: string, handle: AgentHandle): void {
    liveAgents.set(key, handle)
    this.handles.set(key, handle)
  }

  private async createAgent(sessionId: SessionId): Promise<AgentHandle> {
    const cwdOk = this.cfg.cwd && fs.existsSync(this.cfg.cwd)
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: cwdOk ? { cwd: this.cfg.cwd } : undefined,
      agentOptions: agentOptions(this.cfg),
    })
    this.log.info('创建会话 %s%s', sessionId, cwdOk ? `（cwd=${this.cfg.cwd}）` : '')
    fileLog('create', 'OK session=' + sessionId)
    if (!cwdOk) this.log.warn('cwd 不存在: %s，会话未绑定工作目录', this.cfg.cwd)
    return handle
  }

  /** 删除本插件创建的 im-* 会话的持久化目录（自愈用）。 */
  private async purgeSession(sessionId: string): Promise<boolean> {
    try {
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
      const root = path.join(home, 'sessions')
      const dirs = fs.readdirSync(root)
      for (const d of dirs) {
        const projectDir = path.join(root, d)
        if (!fs.statSync(projectDir).isDirectory()) continue
        const target = path.join(projectDir, sessionId)
        if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
          fs.rmSync(target, { recursive: true, force: true })
          fileLog('heal', 'purged ' + target)
          return true
        }
      }
      return false
    } catch (e) {
      fileLog('heal', 'purge failed err=' + formatError(e))
      return false
    }
  }

  /** 稳定、文件系统安全的会话 id：im-wechat-<sha256(key) 前 16 位>；/new 后追加代次。 */
  private sessionIdFor(key: string): string {
    const gen = this.generation.get(key) ?? 0
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 16)
    return gen > 0 ? `im-wechat-${hash}-${gen}` : `im-wechat-${hash}`
  }

  // ── 代次持久化：保证跨重启 /new 计数连续，普通消息永不轮换会话 ──

  private sessionMapPath(): string {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    return path.join(home, 'weixinbot', 'session-map.json')
  }

  private loadGenerations(): Map<string, number> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.sessionMapPath(), 'utf8')) as Record<string, number>
      return new Map(Object.entries(raw))
    } catch {
      return new Map()
    }
  }

  private persistGenerations(): void {
    try {
      const file = this.sessionMapPath()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(Object.fromEntries(this.generation), null, 2), 'utf8')
    } catch (e) {
      this.log.warn('写入 session-map 失败: %s', formatError(e))
    }
  }

  private lastTurn(events: readonly SessionEvent[]): number {
    let turn = -1
    for (const e of events) {
      if (e.type === 'turn/start' && e.data.turn > turn) turn = e.data.turn
    }
    return turn
  }

  private extractReply(events: readonly SessionEvent[], afterTurn: number): string {
    let reply = ''
    for (const e of events) {
      if (e.type !== 'assistant/message') continue
      if (afterTurn >= 0 && e.data.turn <= afterTurn) continue
      const text = extractText(e.data.message.content)
      if (text) reply = text
    }
    if (!reply) throw new Error('agent 本轮未产生回答文本')
    return reply
  }
}

function extractText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const b of blocks) {
    if (b.type === 'text' && b.text) parts.push(b.text)
  }
  return parts.join('\n').trim()
}
