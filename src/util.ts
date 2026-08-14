/**
 * 共享工具：日志、分块、HTTP、iLink 请求头。
 */
import fs from 'node:fs'

export type Logger = {
  info: (fmt: string, ...args: any[]) => void
  warn: (fmt: string, ...args: any[]) => void
  error: (fmt: string, ...args: any[]) => void
}

/** 按行/空格边界切分长文本，避免单条微信消息过长。 */
export function chunkText(text: string, maxLen = 3500): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen)
    if (cut < maxLen * 0.5) cut = rest.lastIndexOf(' ', maxLen)
    if (cut < maxLen * 0.5) cut = maxLen
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).trimStart()
  }
  if (rest) out.push(rest)
  return out
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 随机 uint32 → 十进制字符串 → base64，即 iLink 的 `X-WECHAT-UIN`。 */
export function randomUin(): string {
  const n = Math.floor(Math.random() * 0xffffffff)
  return Buffer.from(String(n), 'utf8').toString('base64')
}

export interface FetchJsonOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

/** 带超时的 JSON fetch；非 2xx 抛出带 status/data 的错误。 */
export async function fetchJson(url: string, opts: FetchJsonOptions = {}): Promise<any> {
  const { method = 'GET', headers, body, timeoutMs = 30000 } = opts
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal })
    const data: any = await res.json().catch(() => null)
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${res.statusText}`) as Error & { status?: number; data?: any }
      err.status = res.status
      err.data = data
      throw err
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

/** iLink 请求头：Bearer + AuthorizationType + 每次随机的 X-WECHAT-UIN。 */
export function ilinkHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomUin(),
  }
}

export function formatError(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

/** 文件诊断日志（崩溃安全）：进程退出后仍可排查。 */
let logFilePath = ''
export function setLogFile(p: string): void {
  logFilePath = p
}
export function fileLog(tag: string, ...args: any[]): void {
  if (!logFilePath) return
  try {
    const parts = args.map((a) =>
      a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a),
    )
    const line = `[${new Date().toISOString()}] ${tag} ${parts.join(' ')}\n`
    fs.appendFileSync(logFilePath, line)
  } catch {
    /* 诊断日志永不抛错 */
  }
}
