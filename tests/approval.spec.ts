/**
 * F12 审批桥测试：waterfall 认领、微信命令决策、超时 fail-closed。
 */
import { describe, expect, it } from 'vitest'
import { ApprovalBridge, type ApprovalHost } from '../src/approval/bridge.js'
import type { ChannelAdapter, InboundMessage } from '../src/adapter/channel.js'
import type { Logger } from '../src/util.js'

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

class StubAdapter implements ChannelAdapter {
  readonly name = 'stub'
  sent: { to: string; text: string }[] = []
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(toUserId: string, _ctx: string, text: string): Promise<void> {
    this.sent.push({ to: toUserId, text })
  }
  isLoggedIn(): boolean {
    return true
  }
  status(): Record<string, unknown> {
    return {}
  }
  onMessage(_h: (msg: InboundMessage) => Promise<void> | void): void {}
}

class FakeHost implements ApprovalHost {
  handler?: (req: unknown, next: () => Promise<string>) => Promise<string>
  on(_event: string, handler: (req: unknown, next: () => Promise<string>) => Promise<string>): unknown {
    this.handler = handler
    return () => {}
  }
  async fire(req: unknown): Promise<string> {
    return this.handler!(req, async () => 'unavailable')
  }
}

function makeBridge(timeoutMs = 1000) {
  const adapter = new StubAdapter()
  const host = new FakeHost()
  const bridge = new ApprovalBridge(host, adapter, { enabled: true, defaultTarget: 'owner@im.wechat', timeoutMs }, silentLogger)
  bridge.start()
  return { adapter, host, bridge }
}

describe('ApprovalBridge', () => {
  it('approval/request 时推送卡片并挂起等待', async () => {
    const { adapter, host, bridge } = makeBridge()
    const promise = host.fire({ toolName: 'bash', reason: '执行 rm -rf' })
    expect(adapter.sent[0].to).toBe('owner@im.wechat')
    expect(adapter.sent[0].text).toContain('需要你的批准')
    expect(adapter.sent[0].text).toContain('bash')
    expect(adapter.sent[0].text).toContain('rm -rf')

    // 微信回复批准
    const reply = await bridge.handleCommand('/approve a1', 'owner@im.wechat')
    expect(reply).toContain('已批准')
    await expect(promise).resolves.toBe('allowed-once')
  })

  it('reject 返回 rejected', async () => {
    const { host, bridge } = makeBridge()
    const promise = host.fire({ toolName: 'fs', reason: '删除文件' })
    const reply = await bridge.handleCommand('/reject a1', 'owner@im.wechat')
    expect(reply).toContain('已拒绝')
    await expect(promise).resolves.toBe('rejected')
  })

  it('超时 fail-closed = rejected', async () => {
    const { host } = makeBridge(50)
    const promise = host.fire({ toolName: 'bash', reason: 'x' })
    await expect(promise).resolves.toBe('rejected')
  })

  it('未知审批 id 返回错误', async () => {
    const { bridge } = makeBridge()
    const reply = await bridge.handleCommand('/approve a999', 'owner@im.wechat')
    expect(reply).toContain('不存在')
  })

  it('非审批命令返回 null（不拦截）', async () => {
    const { bridge } = makeBridge()
    const reply = await bridge.handleCommand('/status', 'owner@im.wechat')
    expect(reply).toBeNull()
  })
})
