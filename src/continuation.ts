/**
 * 续跑（continuation）：agent 自重启后的自动唤醒。
 *
 * 流程：agent 需要重启自己时，先把待办写入 pending-continuation.json
 * （含自己的 DSH_SESSION_ID），再委托 claudecode 重启；新进程启动后，
 * 插件读到标记，向该会话注入一条用户消息，唤醒 agent 继续处理重启后的待办。
 *
 * 标记在注入成功后才删除；注入失败则保留，下次启动重试。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { fileLog, formatError, sleep, type Logger } from './util.js'

export interface PendingContinuation {
  /** 目标会话 id（agent 自己的 DSH_SESSION_ID）。 */
  sessionId: string
  /** 重启后要继续执行的待办描述。 */
  message: string
  createdAt: string
}

const RETRY_MS = 3000
const MAX_ATTEMPTS = 15 // 约 45s
const TURN_TIMEOUT_MS = 180000

export function continuationMarkerPath(home: string): string {
  return path.join(home, 'weixinbot', 'pending-continuation.json')
}

/** 读取续跑标记（不删除）。无标记/损坏返回 null。 */
export function readPendingContinuation(home: string): PendingContinuation | null {
  try {
    const raw = fs.readFileSync(continuationMarkerPath(home), 'utf8')
    const data = JSON.parse(raw)
    if (data && typeof data.sessionId === 'string' && data.sessionId && typeof data.message === 'string') {
      return { sessionId: data.sessionId, message: data.message, createdAt: String(data.createdAt ?? '') }
    }
  } catch {
    /* 无标记或损坏 */
  }
  return null
}

/** 注入成功后清除标记。 */
export function clearPendingContinuation(home: string): void {
  try {
    fs.rmSync(continuationMarkerPath(home), { force: true })
  } catch {
    /* 忽略 */
  }
}

/** 重启后把续跑消息注入目标会话，唤醒 agent；返回是否注入成功。 */
export async function maybeInjectContinuation(
  ctx: Context,
  home: string,
  logger: Logger,
  options?: { provider?: string; model?: string },
): Promise<boolean> {
  const pending = readPendingContinuation(home)
  if (!pending) return false

  const text = `（重启完成通知）DSH 已重启并恢复健康。请继续执行重启前的待办：${pending.message}`
  const userMessage = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
  const agentOptions: { provider?: string; model?: string } = {}
  if (options?.provider) agentOptions.provider = options.provider
  if (options?.model) agentOptions.model = options.model

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // 1) 优先 resume（从磁盘恢复持久会话）
      const handle = await ctx.agents.resume({ resumeSessionId: SessionId(pending.sessionId), agentOptions })
      handle.agent.followup(userMessage)
      await Promise.race([handle.agent.whenIdle(), sleep(TURN_TIMEOUT_MS)])
      clearPendingContinuation(home)
      logger.info('[continuation] 已注入续跑消息到会话 %s（attempt %d）', pending.sessionId, attempt)
      fileLog('continuation', 'injected session=' + pending.sessionId)
      return true
    } catch (e) {
      const err = formatError(e)
      // 2) 会话已被（web 应用）恢复为 live → 复用注册表里的 live agent
      if (/while it is live|cannot prepare/i.test(err)) {
        try {
          const agent = ctx.agents.get(SessionId(pending.sessionId))
          if (agent) {
            agent.followup(userMessage)
            await Promise.race([agent.whenIdle(), sleep(TURN_TIMEOUT_MS)])
            clearPendingContinuation(home)
            logger.info('[continuation] 已注入续跑消息到 live 会话 %s', pending.sessionId)
            fileLog('continuation', 'injected-live session=' + pending.sessionId)
            return true
          }
        } catch (e2) {
          fileLog('continuation', 'live-inject fail session=' + pending.sessionId + ' err=' + formatError(e2))
        }
      }
      if (attempt >= MAX_ATTEMPTS) {
        logger.error('[continuation] 注入续跑失败（%d 次，标记保留）: %s', attempt, err)
        fileLog('continuation-fail', 'session=' + pending.sessionId + ' err=' + err)
        return false
      }
      logger.warn('[continuation] 注入续跑重试 %d/%d: %s', attempt, MAX_ATTEMPTS, err)
      await sleep(RETRY_MS)
    }
  }
  return false
}
