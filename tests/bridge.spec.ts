/**
 * Bridge 测试：白名单（fail-closed）、去重、命令、回复分块。
 * 用桩 adapter + 桩 runner，不触真实 HTTP / agent。
 */
import { describe, expect, it } from 'vitest'
import { Bridge } from '../src/bridge/bridge.js'
import type { ChannelAdapter, InboundMessage } from '../src/adapter/channel.js'
import type { MessageRunner } from '../src/runner/agent-runner.js'
import type { Logger } from '../src/util.js'

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

class StubAdapter implements ChannelAdapter {
  readonly name = 'stub'
  sent: { to: string; ctx: string; text: string }[] = []
  started = false
  stopped = false
  private handler?: (msg: InboundMessage) => Promise<void> | void

  async start(): Promise<void> {
    this.started = true
  }
  async stop(): Promise<void> {
    this.stopped = true
  }
  async send(toUserId: string, contextToken: string, text: string): Promise<void> {
    this.sent.push({ to: toUserId, ctx: contextToken, text })
  }
  isLoggedIn(): boolean {
    return true
  }
  status(): Record<string, unknown> {
    return { loggedIn: true }
  }
  onMessage(handler: (msg: InboundMessage) => Promise<void> | void): void {
    this.handler = handler
  }
  /** 测试辅助：模拟收到消息。 */
  async emit(msg: InboundMessage): Promise<void> {
    if (this.handler) await this.handler(msg)
  }
}

class StubRunner implements MessageRunner {
  calls: { key: string; text: string }[] = []
  nexts = 0
  switches: number[] = []
  reply = 'ok'
  rec = { current: 0, gens: [0] }

  async ask(key: string, text: string): Promise<string> {
    this.calls.push({ key, text })
    return this.reply
  }
  async next(): Promise<{ current: number; gens: number[] }> {
    this.nexts++
    const g = Math.max(...this.rec.gens) + 1
    this.rec = { current: g, gens: [...this.rec.gens, g] }
    return this.rec
  }
  list(): { current: number; gens: number[] } {
    return this.rec
  }
  async switchTo(_key: string, gen: number): Promise<{ current: number; gens: number[] }> {
    if (!this.rec.gens.includes(gen)) throw new Error(`会话 ${gen} 不存在（/list 查看可用代次）`)
    this.switches.push(gen)
    this.rec = { ...this.rec, current: gen }
    return this.rec
  }
  async dispose(): Promise<void> {}
}

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    kind: 'direct',
    channelKey: 'user@im.wechat',
    senderId: 'user@im.wechat',
    fromUserId: 'user@im.wechat',
    contextToken: 'ctx-1',
    msgId: 'm1',
    text: '你好',
    items: [],
    receivedAt: Date.now(),
    ...overrides,
  }
}

describe('Bridge', () => {
  it('allowUsers 为空时拒绝所有（fail-closed）', async () => {
    const adapter = new StubAdapter()
    const runner = new StubRunner()
    const bridge = new Bridge({ allowUsers: [], adminUsers: [], commandPrefix: '/' }, runner, adapter, silentLogger)
    await bridge.start()
    await adapter.emit(msg())
    expect(runner.calls.length).toBe(0)
    expect(adapter.sent.length).toBe(0)
  })

  it('白名单命中才放行', async () => {
    const adapter = new StubAdapter()
    const runner = new StubRunner()
    const bridge = new Bridge(
      { allowUsers: ['user@im.wechat'], adminUsers: [], commandPrefix: '/' },
      runner,
      adapter,
      silentLogger,
    )
    await bridge.start()
    await adapter.emit(msg({ fromUserId: 'other@im.wechat' }))
    expect(runner.calls.length).toBe(0)
    await adapter.emit(msg())
    expect(runner.calls.length).toBe(1)
    expect(runner.calls[0].text).toBe('你好')
    expect(adapter.sent[0]).toMatchObject({ to: 'user@im.wechat', ctx: 'ctx-1', text: 'ok' })
  })

  it('群消息 M1 直接忽略', async () => {
    const adapter = new StubAdapter()
    const runner = new StubRunner()
    const bridge = new Bridge(
      { allowUsers: ['user@im.wechat'], adminUsers: [], commandPrefix: '/' },
      runner,
      adapter,
      silentLogger,
    )
    await bridge.start()
    await adapter.emit(msg({ kind: 'group', channelKey: 'group-1', text: '@bot hi' }))
    expect(runner.calls.length).toBe(0)
  })

  it('同 msgId 去重', async () => {
    const adapter = new StubAdapter()
    const runner = new StubRunner()
    const bridge = new Bridge(
      { allowUsers: ['user@im.wechat'], adminUsers: [], commandPrefix: '/' },
      runner,
      adapter,
      silentLogger,
    )
    await bridge.start()
    await adapter.emit(msg())
    await adapter.emit(msg())
    expect(runner.calls.length).toBe(1)
  })

  it('/status 返回状态文本', async () => {
    const adapter = new StubAdapter()
    const runner = new StubRunner()
    const bridge = new Bridge(
      { allowUsers: ['user@im.wechat'], adminUsers: [], commandPrefix: '/' },
      runner,
      adapter,
      silentLogger,
    )
    await bridge.start()
    await adapter.emit(msg({ text: '/status' }))
    expect(runner.calls.length).toBe(0) // 命令不交给 agent
    expect(adapter.sent[0].text).toContain('登录')
  })

  it('/new 切到新会话（next 被调用，旧代次保留）', async () => {
    const adapter = new StubAdapter()
    const runner = new StubRunner()
    const bridge = new Bridge(
      { allowUsers: ['user@im.wechat'], adminUsers: [], commandPrefix: '/' },
      runner,
      adapter,
      silentLogger,
    )
    await bridge.start()
    await adapter.emit(msg({ text: '/new' }))
    expect(runner.nexts).toBe(1)
    expect(adapter.sent[0].text).toContain('会话 1')
  })

  it('/list 列出会话代次并标记当前', async () => {
    const adapter = new StubAdapter()
    const runner = new StubRunner()
    runner.rec = { current: 1, gens: [0, 1] }
    const bridge = new Bridge(
      { allowUsers: ['user@im.wechat'], adminUsers: [], commandPrefix: '/' },
      runner,
      adapter,
      silentLogger,
    )
    await bridge.start()
    await adapter.emit(msg({ text: '/list' }))
    expect(adapter.sent[0].text).toContain('[0]')
    expect(adapter.sent[0].text).toContain('[1] （当前）')
  })

  it('/switch 切回旧会话；无效代次回错误', async () => {
    const adapter = new StubAdapter()
    const runner = new StubRunner()
    runner.rec = { current: 1, gens: [0, 1] }
    const bridge = new Bridge(
      { allowUsers: ['user@im.wechat'], adminUsers: [], commandPrefix: '/' },
      runner,
      adapter,
      silentLogger,
    )
    await bridge.start()
    await adapter.emit(msg({ text: '/switch 0' }))
    expect(runner.switches).toEqual([0])
    expect(adapter.sent[0].text).toContain('会话 0')
    await adapter.emit(msg({ text: '/switch 9', msgId: 'm2' }))
    expect(adapter.sent[1].text).toContain('❌')
  })

  it('长回复按块发送', async () => {
    const adapter = new StubAdapter()
    const runner = new StubRunner()
    runner.reply = '长'.repeat(8000)
    const bridge = new Bridge(
      { allowUsers: ['user@im.wechat'], adminUsers: [], commandPrefix: '/' },
      runner,
      adapter,
      silentLogger,
    )
    await bridge.start()
    await adapter.emit(msg())
    expect(adapter.sent.length).toBeGreaterThan(1)
    expect(adapter.sent.map((s) => s.text).join('')).toBe('长'.repeat(8000))
  })

  it('runner 抛错时回发失败提示', async () => {
    const adapter = new StubAdapter()
    const runner = new StubRunner()
    runner.ask = async () => {
      throw new Error('boom')
    }
    const bridge = new Bridge(
      { allowUsers: ['user@im.wechat'], adminUsers: [], commandPrefix: '/' },
      runner,
      adapter,
      silentLogger,
    )
    await bridge.start()
    await adapter.emit(msg())
    expect(adapter.sent.length).toBe(1)
    expect(adapter.sent[0].text).toContain('❌ 处理失败')
    expect(adapter.sent[0].text).toContain('boom')
  })
})
