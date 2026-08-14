/**
 * 续跑标记（continuation）解析/清除测试（不依赖 ctx.agents）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  continuationMarkerPath,
  readPendingContinuation,
  clearPendingContinuation,
} from '../src/continuation.js'

const home = path.join(process.cwd(), 'node_modules', '.tmp-cont-test')

function writeMarker(data: unknown): void {
  fs.mkdirSync(path.dirname(continuationMarkerPath(home)), { recursive: true })
  fs.writeFileSync(continuationMarkerPath(home), JSON.stringify(data), 'utf8')
}

describe('continuation marker', () => {
  it('无标记返回 null', () => {
    fs.rmSync(path.dirname(continuationMarkerPath(home)), { recursive: true, force: true })
    expect(readPendingContinuation(home)).toBeNull()
  })

  it('解析合法标记', () => {
    writeMarker({ sessionId: 'session-abc', message: '验证搜索', createdAt: '2026-08-14T00:00:00Z' })
    const p = readPendingContinuation(home)
    expect(p).not.toBeNull()
    expect(p!.sessionId).toBe('session-abc')
    expect(p!.message).toBe('验证搜索')
    // 读取不删除
    expect(fs.existsSync(continuationMarkerPath(home))).toBe(true)
  })

  it('损坏标记返回 null', () => {
    writeMarker({ foo: 1 })
    expect(readPendingContinuation(home)).toBeNull()
    fs.rmSync(path.dirname(continuationMarkerPath(home)), { recursive: true, force: true })
  })

  it('clear 删除标记', () => {
    writeMarker({ sessionId: 's1', message: 'm' })
    clearPendingContinuation(home)
    expect(fs.existsSync(continuationMarkerPath(home))).toBe(false)
    fs.rmSync(path.dirname(continuationMarkerPath(home)), { recursive: true, force: true })
  })
})
