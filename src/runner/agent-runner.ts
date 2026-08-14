/**
 * AgentRunner：通过 DSH 官方 agent 运行时回答消息。
 *
 * 每个微信会话（channelKey）对应一组**代次会话**（generation）：
 * - 同一个 channelKey 在同一代次内永远复用同一个 sessionId（跨消息、跨热重载、跨重启）；
 * - `/new` 切换到新一代次（旧代次**保留**，可 `/list` + `/switch <n>` 切回）；
 * - 代次记录持久化在 $DSH_HOME/weixinbot/session-map.json，重启后连续。
 *
 * API 契约（@deepseek-ai/dsh-agent）：
 * - `ctx.agents.resume({ resumeSessionId })` — 恢复持久会话；
 * - `ctx.agents.create({ sessionId, meta })` — 首次联系；
 * - `ctx.agents.get(sessionId)` — 取注册表里仍存活的 live Agent（热重载残留复用）；
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
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { fileLog, formatError, type Logger } from '../util.js'

/** 微信聊天风格提示词（注册为 system-prompt section，order 50：persona 之后、工具指引之前）。 */
export const WECHAT_CHAT_STYLE_PROMPT = `你是通过微信与用户对话的助手，请遵守微信聊天的阅读习惯：
1. 回复简洁、口语化，像真人发微信，不要像写报告。
2. 优先短句与要点：每条一两行，分条列出；不要一次性输出大段文字。
3. 单条回复尽量控制在 200 字以内；内容确实多时，先给最关键的结论，其余用要点简述，并提示用户可追问展开。
4. 避免 Markdown 表格、代码块、长链接等微信不适配的排版，用「- 要点」或 emoji 即可。
5. 先给结论，再给必要依据，不要铺垫和客套。`

/** systemPrompt.section 的最小形状（避免依赖 dsh-system-prompt 类型版本）。 */
interface SystemPromptSectionHost {
  systemPrompt?: {
    section(s: { name: string; order: number; text: string }): unknown
  }
}

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

/** 一个微信会话的代次记录（持久化）。gens = 已实际创建过会话的代次。 */
export interface ConversationRecord {
  /** 当前代次（下一条消息使用）。 */
  current: number
  /** 已创建过的代次（/list 展示，/switch 可切）。 */
  gens: number[]
}

/** Bridge 依赖的最小 runner 契约。 */
export interface MessageRunner {
  ask(key: string, text: string): Promise<string>
  /** /new：切换到新一代次（旧代次保留）。返回新记录。 */
  next(key: string): Promise<ConversationRecord>
  /** /list：列出本会话已创建的代次。 */
  list(key: string): ConversationRecord
  /** /switch：切到指定代次（仅限已创建代次）。 */
  switchTo(key: string, gen: number): Promise<ConversationRecord>
  /** /cancel：取消该会话正在运行的 turn；返回是否有 turn 被取消。 */
  cancel(key: string): Promise<boolean>
  dispose(): Promise<void>
}

function agentOptions(cfg: AgentRunnerConfig): { provider?: string; model?: string } {
  const opts: { provider?: string; model?: string } = {}
  if (cfg.provider) opts.provider = cfg.provider
  if (cfg.model) opts.model = cfg.model
  return opts
}

/**
 * 进程级共享 live Agent 句柄表（按 sessionId 索引）：插件热重载/重复 apply 后，
 * 新实例直接复用旧实例仍在内存中的 live Agent，避免同 id 会话冲突。
 */
const liveAgents = new Map<string, AgentHandle>()

export class AgentRunner implements MessageRunner {
  private handles = new Map<string, AgentHandle>()
  private inflight = new Map<string, Promise<string>>()
  /** channelKey → 代次记录（持久化）。 */
  private registry = new Map<string, ConversationRecord>()
  /** channelKey → 当前运行 turn 的 agent（/cancel 用）。 */
  private active = new Map<string, Agent>()
  /** channelKey → 已请求取消（turn 收敛后抛「已取消」）。 */
  private cancelled = new Set<string>()

  constructor(private cfg: AgentRunnerConfig, private ctx: Context, private log: Logger) {
    this.registry = this.loadRegistry()
  }

  /** 串行化同一会话：同一时刻只有一个 turn 在跑（跨代次同样串行）。 */
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

  // ── 会话切换（/new /list /switch）──

  /** /new：切到新一代次。旧代次不 dispose（保留上下文，可 /switch 切回）。 */
  async next(key: string): Promise<ConversationRecord> {
    const rec = this.ensure(key)
    // 当前代次还没实际创建过会话（刚 /new 过但没发过消息）→ 无需再开
    if (!rec.gens.includes(rec.current)) return rec
    const nextGen = (rec.gens.length ? Math.max(...rec.gens) : -1) + 1
    rec.current = nextGen
    this.persistRegistry()
    this.log.info('会话 %s 切换到 gen=%d（旧代次保留）', key, nextGen)
    fileLog('next', 'key=' + key + ' current=' + nextGen + ' gens=' + JSON.stringify(rec.gens))
    return rec
  }

  /** /list：列出已创建的代次。 */
  list(key: string): ConversationRecord {
    return this.ensure(key)
  }

  /** /switch：切到指定代次（仅限已创建代次）。 */
  async switchTo(key: string, gen: number): Promise<ConversationRecord> {
    const rec = this.ensure(key)
    if (!Number.isInteger(gen) || !rec.gens.includes(gen)) {
      throw new Error(`会话 ${gen} 不存在（/list 查看可用代次）`)
    }
    rec.current = gen
    this.persistRegistry()
    this.log.info('会话 %s 切回 gen=%d', key, gen)
    fileLog('switch', 'key=' + key + ' current=' + gen)
    return rec
  }

  /** /cancel：取消该会话正在运行的 turn。 */
  async cancel(key: string): Promise<boolean> {
    const agent = this.active.get(key)
    if (!agent) return false
    this.cancelled.add(key)
    try {
      await agent.cancel({ kind: 'hook', reason: 'user /cancel' })
    } catch (e) {
      this.log.warn('取消 turn 失败: %s', formatError(e))
    }
    fileLog('cancel', 'key=' + key)
    return true
  }

  async dispose(): Promise<void> {
    // 不 dispose 共享句柄：热重载后新 apply 实例复用仍在内存中的 live Agent；
    // 进程退出时由 DSH 清理。
    this.handles.clear()
  }

  // ── 内部 ──

  /** 在 agent 的 scoped world 里注册微信聊天风格提示词（create/resume 都执行）。 */
  private registerChatStyle(agentCtx: Context): void {
    const host = agentCtx as unknown as SystemPromptSectionHost
    const sp = host.systemPrompt
    if (!sp?.section) return
    try {
      sp.section({
        name: 'weixinbot:chat-style',
        order: 50,
        text: WECHAT_CHAT_STYLE_PROMPT,
      })
    } catch (e) {
      this.log.warn('注册微信回复风格提示词失败: %s', formatError(e))
    }
  }

  private ensure(key: string): ConversationRecord {
    let rec = this.registry.get(key)
    if (!rec) {
      rec = { current: 0, gens: [] }
      this.registry.set(key, rec)
    }
    return rec
  }

  /** 稳定、文件系统安全的会话 id：im-wechat-<sha256(key) 前 16 位>；gen>0 追加代次。 */
  private sidFor(key: string, gen: number): string {
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 16)
    return gen > 0 ? `im-wechat-${hash}-${gen}` : `im-wechat-${hash}`
  }

  private sessionIdFor(key: string): string {
    return this.sidFor(key, this.ensure(key).current)
  }

  private async runOnce(key: string, text: string): Promise<string> {
    const handle = await this.getOrCreate(key)
    const agent = handle.agent
    this.active.set(key, agent)
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
    this.active.delete(key)
    if (this.cancelled.delete(key)) {
      fileLog('cancelled', 'turn cancelled by user, session=' + agent.id)
      throw new Error('任务已取消')
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
    const sid = this.sessionIdFor(key)

    // 跨实例复用：热重载/重复 apply 后旧 Agent 仍 live，直接续用（按 sessionId 索引）
    const shared = liveAgents.get(sid)
    if (shared) {
      this.handles.set(sid, shared)
      return shared
    }
    const existing = this.handles.get(sid)
    if (existing) return existing

    // 1) 优先恢复既有会话（含跨进程重启：从磁盘恢复持久上下文）
    let resumeErr = ''
    try {
      const handle = await this.ctx.agents.resume({
        resumeSessionId: SessionId(sid),
        agentOptions: agentOptions(this.cfg),
        setup: (agentCtx) => this.registerChatStyle(agentCtx),
      })
      this.log.info('恢复会话 %s', sid)
      fileLog('resume', 'OK session=' + sid)
      this.recordCreated(key)
      this.cache(sid, handle)
      return handle
    } catch (e) {
      resumeErr = formatError(e)
      fileLog('resume', 'FAIL session=' + sid + ' err=' + resumeErr)
    }

    // 2) 会话仍被（旧实例热重载残留的）live agent 占用 → 复用注册表里的
    //    live Agent，绝不 purge/轮换（purge 会连上下文一起删掉）。
    if (/while it is live|cannot prepare/i.test(resumeErr)) {
      const agent = this.ctx.agents.get(SessionId(sid))
      if (agent) {
        const handle: AgentHandle = { agent, dispose: async () => {} }
        this.log.info('复用仍存活的会话 %s（热重载残留，保留上下文）', sid)
        fileLog('reuse-live', 'session=' + sid)
        this.recordCreated(key)
        this.cache(sid, handle)
        return handle
      }
    }

    // 3) 创建新会话。只有「磁盘残留」冲突（already exists，非 live）才清掉重试；
    //    绝不因 live 冲突轮换 id（否则每条消息/每次重载都生成新会话）。
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await this.createAgent(SessionId(sid))
        this.recordCreated(key)
        this.cache(sid, handle)
        return handle
      } catch (e2) {
        const msg2 = formatError(e2)
        if (attempt === 0 && /already exists|does not match/i.test(msg2)) {
          // 磁盘残留（上个进程崩溃遗留的持久目录）→ 清掉后重试同 id
          await this.purgeSession(sid)
          fileLog('heal', 'purged disk residue, retry session=' + sid + ' err=' + msg2)
          continue
        }
        throw e2
      }
    }
    throw new Error('无法创建会话（' + sid + '）')
  }

  /** 记录当前代次已实际创建过会话（持久化）。 */
  private recordCreated(key: string): void {
    const rec = this.ensure(key)
    const gen = rec.current
    if (!rec.gens.includes(gen)) {
      rec.gens.push(gen)
      this.persistRegistry()
      fileLog('record', 'key=' + key + ' created gen=' + gen + ' gens=' + JSON.stringify(rec.gens))
    }
  }

  private cache(sid: string, handle: AgentHandle): void {
    liveAgents.set(sid, handle)
    this.handles.set(sid, handle)
  }

  private async createAgent(sessionId: SessionId): Promise<AgentHandle> {
    const cwdOk = this.cfg.cwd && fs.existsSync(this.cfg.cwd)
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: cwdOk ? { cwd: this.cfg.cwd } : undefined,
      agentOptions: agentOptions(this.cfg),
      setup: (agentCtx) => this.registerChatStyle(agentCtx),
    })
    this.log.info('创建会话 %s%s', sessionId, cwdOk ? `（cwd=${this.cfg.cwd}）` : '')
    fileLog('create', 'OK session=' + sessionId)
    if (!cwdOk) this.log.warn('cwd 不存在: %s，会话未绑定工作目录', this.cfg.cwd)
    return handle
  }

  /** 删除本插件创建的 im-* 会话的持久化目录（仅磁盘残留自愈用）。 */
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

  // ── 代次记录持久化（$DSH_HOME/weixinbot/session-map.json）──

  private sessionMapPath(): string {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    return path.join(home, 'weixinbot', 'session-map.json')
  }

  private loadRegistry(): Map<string, ConversationRecord> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.sessionMapPath(), 'utf8')) as Record<string, unknown>
      const out = new Map<string, ConversationRecord>()
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v === 'object' && Array.isArray((v as ConversationRecord).gens)) {
          out.set(k, v as ConversationRecord)
        } else if (typeof v === 'number') {
          // 旧格式迁移：{ key: gen } → { current: gen, gens: [0..gen] }
          out.set(k, { current: v, gens: Array.from({ length: v + 1 }, (_, i) => i) })
        }
      }
      return out
    } catch {
      return new Map()
    }
  }

  private persistRegistry(): void {
    try {
      const file = this.sessionMapPath()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(Object.fromEntries(this.registry), null, 2), 'utf8')
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
