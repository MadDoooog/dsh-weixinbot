/**
 * 凭据 / 游标持久化：$DSH_HOME/weixinbot/ 下。
 * 凭据文件权限 0600；token 绝不写日志。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface Credentials {
  botToken: string
  baseUrl?: string
  botId?: string
  userId?: string
}

/** 插件数据目录（默认 $DSH_HOME/weixinbot）。 */
export function weixinbotHome(base: string = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')): string {
  return path.join(base, 'weixinbot')
}

export function loadCredentials(base?: string): Credentials | null {
  try {
    const raw = fs.readFileSync(path.join(weixinbotHome(base), 'credentials.json'), 'utf8')
    return JSON.parse(raw) as Credentials
  } catch {
    return null
  }
}

export function saveCredentials(creds: Credentials, base?: string): void {
  const dir = weixinbotHome(base)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'credentials.json')
  fs.writeFileSync(file, JSON.stringify(creds, null, 2) + '\n', 'utf8')
  fs.chmodSync(file, 0o600)
}

/** getupdates 游标：崩溃后不重收消息。 */
export function loadCursor(base?: string): string {
  try {
    return fs.readFileSync(path.join(weixinbotHome(base), 'cursor.json'), 'utf8').trim()
  } catch {
    return ''
  }
}

export function saveCursor(buf: string, base?: string): void {
  const dir = weixinbotHome(base)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'cursor.json'), buf, 'utf8')
}
