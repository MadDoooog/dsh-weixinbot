/**
 * ilink-direct 适配器测试：本地 mock iLink 服务器（真实 HTTP）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { ILinkDirectAdapter } from '../src/adapter/ilink-direct.js'
import type { InboundMessage } from '../src/adapter/channel.js'
import { ilinkHeaders, randomUin, chunkText } from '../src/util.js'

/** 记录发送请求，供断言。 */
const sentBodies: any[] = []
const sentHeaders: Record<string, string>[] = []

let server: http.Server
let baseUrl = ''

// mock 状态
let qrcodeStatus = 'pending'
let updatesBuf = ''
let pollCount = 0

function json(res: http.ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`)
    if (url.pathname === '/ilink/bot/get_bot_qrcode') {
      json(res, { ret: 0, qrcode: 'qr-123', qrcode_img_content: 'https://weixin.qq.com/qr-123' })
      return
    }
    if (url.pathname === '/ilink/bot/get_qrcode_status') {
      if (qrcodeStatus === 'confirmed') {
        json(res, {
          status: 'confirmed',
          bot_token: 'tok-abc',
          baseurl: baseUrl,
          ilink_bot_id: 'bot@im.bot',
          ilink_user_id: 'user@im.wechat',
        })
      } else if (qrcodeStatus === 'expired') {
        json(res, { status: 'expired' })
      } else {
        json(res, { status: 'pending' })
      }
      return
    }
    if (url.pathname === '/ilink/bot/getupdates') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}')
        pollCount++
        updatesBuf = parsed.get_updates_buf ?? ''
        if (pollCount === 1) {
          // 第一轮返回一条用户消息
          json(res, {
            msgs: [
              {
                from_user_id: 'user@im.wechat',
                to_user_id: 'bot@im.bot',
                message_type: 1,
                message_state: 2,
                context_token: 'ctx-1',
                client_msg_id: 'm1',
                create_time_ms: 1710000000000,
                item_list: [{ type: 1, text_item: { text: '你好' } }],
              },
            ],
            get_updates_buf: 'buf-1',
            longpolling_timeout_ms: 35000,
          })
        } else {
          json(res, { msgs: [], get_updates_buf: 'buf-' + pollCount, longpolling_timeout_ms: 35000 })
        }
      })
      return
    }
    if (url.pathname === '/ilink/bot/sendmessage') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        sentBodies.push(JSON.parse(body))
        sentHeaders.push(Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])))
        json(res, { ret: 0 })
      })
      return
    }
    json(res, { errcode: 404, errmsg: 'not found' }, 404)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }

function makeAdapter(overrides: Record<string, unknown> = {}) {
  return new ILinkDirectAdapter({
    botToken: 'tok-abc',
    baseUrl,
    pollTimeoutMs: 1000,
    retryDelayMs: 50,
    rateLimitPer5min: 100,
    cursor: { load: () => '', save: () => {} },
    logger: silentLogger,
    ...overrides,
  })
}

describe('ILinkDirectAdapter', () => {
  it('requestQrCode 返回二维码', async () => {
    const qr = await ILinkDirectAdapter.requestQrCode(baseUrl, silentLogger)
    expect(qr.qrcode).toBe('qr-123')
    expect(qr.qrcodeImg).toContain('weixin.qq.com')
  })

  it('waitForConfirm 轮询直到 confirmed', async () => {
    qrcodeStatus = 'confirmed'
    const creds = await ILinkDirectAdapter.waitForConfirm(baseUrl, 'qr-123', 5000, silentLogger)
    expect(creds.botToken).toBe('tok-abc')
    expect(creds.baseUrl).toBe(baseUrl)
    expect(creds.botId).toBe('bot@im.bot')
    expect(creds.userId).toBe('user@im.wechat')
    qrcodeStatus = 'pending'
  })

  it('waitForConfirm 处理 expired', async () => {
    qrcodeStatus = 'expired'
    await expect(ILinkDirectAdapter.waitForConfirm(baseUrl, 'qr-x', 3000, silentLogger)).rejects.toThrow('过期')
    qrcodeStatus = 'pending'
  })

  it('start 后收到入站消息，游标推进', async () => {
    pollCount = 0
    const adapter = makeAdapter()
    const received: InboundMessage[] = []
    adapter.onMessage((m) => {
      received.push(m)
    })
    await adapter.start()
    await new Promise((r) => setTimeout(r, 300))
    await adapter.stop()

    expect(received.length).toBe(1)
    expect(received[0]).toMatchObject({
      kind: 'direct',
      channelKey: 'user@im.wechat',
      senderId: 'user@im.wechat',
      fromUserId: 'user@im.wechat',
      contextToken: 'ctx-1',
      msgId: 'm1',
      text: '你好',
    })
    // 游标推进（第二轮带上了 buf-1）
    expect(updatesBuf).toBe('buf-1')
  })

  it('send 携带 context_token / client_id / base_info 与鉴权头', async () => {
    sentBodies.length = 0
    sentHeaders.length = 0
    const adapter = makeAdapter()
    await adapter.send('user@im.wechat', 'ctx-9', '回复内容')

    expect(sentBodies.length).toBe(1)
    const body = sentBodies[0]
    expect(body.msg.to_user_id).toBe('user@im.wechat')
    expect(body.msg.context_token).toBe('ctx-9')
    expect(body.msg.client_id).toMatch(/^dsh-weixinbot-/)
    expect(body.msg.message_type).toBe(2)
    expect(body.msg.item_list[0]).toEqual({ type: 1, text_item: { text: '回复内容' } })
    expect(body.base_info).toEqual({ channel_version: '1.0.2' })

    const h = sentHeaders[0]
    expect(h.authorization).toBe('Bearer tok-abc')
    expect(h.authorizationtype).toBe('ilink_bot_token')
    expect(h['x-wechat-uin']).toBeTruthy()
  })

  it('isLoggedIn / status 反映登录态', () => {
    const adapter = makeAdapter()
    expect(adapter.isLoggedIn()).toBe(true)
    const s = adapter.status()
    expect(s.loggedIn).toBe(true)
  })
})

describe('util', () => {
  it('ilinkHeaders 包含全部鉴权头', () => {
    const h = ilinkHeaders('tok')
    expect(h.Authorization).toBe('Bearer tok')
    expect(h.AuthorizationType).toBe('ilink_bot_token')
    expect(h['X-WECHAT-UIN']).toBeTruthy()
  })

  it('randomUin 是十进制字符串的 base64', () => {
    const uin = randomUin()
    const decoded = Buffer.from(uin, 'base64').toString('utf8')
    expect(/^\d+$/.test(decoded)).toBe(true)
  })

  it('chunkText 按边界切分长文本', () => {
    const long = 'a'.repeat(8000)
    const chunks = chunkText(long, 3500)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(long)
  })
})
