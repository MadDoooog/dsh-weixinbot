/**
 * iLink 直连通道（ilink-direct）：微信 ClawBot 官方 Bot API 的最小实现。
 *
 * 协议要点（参考 @tencent-weixin/openclaw-weixin 逆向文档）：
 * - 鉴权：`Authorization: Bearer <bot_token>` + `AuthorizationType: ilink_bot_token`
 *   + 每次随机的 `X-WECHAT-UIN`（防重放）。
 * - 收消息：`POST /ilink/bot/getupdates` 长轮询（服务端 hold 约 35s），
 *   游标 `get_updates_buf` 必须逐次回传，否则重复收消息。
 * - 发消息：`POST /ilink/bot/sendmessage`，必须携带入站消息的 `context_token`，
 *   且 `client_id` / `from_user_id` / `base_info` 缺失会导致 HTTP 200 但静默丢弃。
 */
import { randomBytes } from 'node:crypto'
import { fetchJson, fileLog, formatError, ilinkHeaders, sleep, type Logger } from '../util.js'
import { loadCursor, saveCursor } from '../credentials.js'
import type { ChannelAdapter, InboundMessage, MediaAttachment } from './channel.js'
import { downloadMediaItem, type MediaItemRaw } from './cdn.js'

/** 原始 iLink 消息（部分字段，够用即可）。 */
interface WeixinMessage {
  from_user_id?: string
  to_user_id?: string
  group_id?: string
  message_type?: number
  message_state?: number
  context_token?: string
  client_msg_id?: string
  server_msg_id?: string
  create_time_ms?: number
  item_list?: MediaItemRaw[]
}

export interface CursorStore {
  load(): string
  save(buf: string): void
}

export interface ILinkDirectOptions {
  botToken: string
  baseUrl: string
  botId?: string
  pollTimeoutMs: number
  /** F8 媒体保存目录。 */
  mediaDir: string
  /** F8 媒体大小上限（字节）。 */
  maxBytes: number
  retryDelayMs: number
  /** 官方限速约 7 条/5 分钟；本地窗口按 rateLimitPer5min - 1 排队。 */
  rateLimitPer5min: number
  cursor: CursorStore
  logger: Logger
}

export interface QrCodeResult {
  qrcode: string
  qrcodeImg: string
}

export interface ConfirmedCredentials {
  botToken: string
  baseUrl: string
  botId?: string
  userId?: string
}

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000
const CHANNEL_VERSION = '1.0.2'
/** typing ticket 缓存 TTL（官方 24h）。 */
const TYPING_TICKET_TTL_MS = 24 * 60 * 60 * 1000

/** TypingStatus：1 = 输入中，2 = 取消。 */
const TYPING_STATUS = { TYPING: 1, CANCEL: 2 } as const

interface TypingTicketEntry {
  ticket: string
  nextFetchAt: number
}

function kindLabel(kind: string): string {
  return { image: '图片', voice: '语音', file: '文件', video: '视频' }[kind] ?? kind
}

export class ILinkDirectAdapter implements ChannelAdapter {
  readonly name = 'ilink-direct'

  private running = false
  private buf = ''
  private seen = new Set<string>()
  private sendTimes: number[] = []
  private handler?: (msg: InboundMessage) => Promise<void> | void
  private lastPollAt = 0
  /** userId → typing_ticket（缓存 24h）。 */
  private typingTickets = new Map<string, TypingTicketEntry>()

  constructor(private opts: ILinkDirectOptions) {}

  // ── 扫码登录（静态工具，供 CLI / 未来 wechat_login 工具复用）──

  /** 1. 申请登录二维码。 */
  static async requestQrCode(baseUrl: string, logger: Logger): Promise<QrCodeResult> {
    const data = await fetchJson(`${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`, { timeoutMs: 15000 })
    if (data?.ret !== 0) throw new Error('获取二维码失败: ' + JSON.stringify(data))
    return { qrcode: String(data.qrcode), qrcodeImg: String(data.qrcode_img_content) }
  }

  /** 2. 轮询扫码确认，拿到 bot_token / baseurl。 */
  static async waitForConfirm(
    baseUrl: string,
    qrcode: string,
    timeoutMs: number,
    logger: Logger,
  ): Promise<ConfirmedCredentials> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const s = await fetchJson(`${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, {
        timeoutMs: 15000,
      })
      if (s?.status === 'confirmed') {
        return {
          botToken: String(s.bot_token),
          baseUrl: String(s.baseurl || baseUrl),
          botId: s.ilink_bot_id ? String(s.ilink_bot_id) : undefined,
          userId: s.ilink_user_id ? String(s.ilink_user_id) : undefined,
        }
      }
      if (s?.status === 'expired') throw new Error('二维码已过期，请重新获取')
      await sleep(2000)
    }
    throw new Error(`等待扫码确认超时（${Math.round(timeoutMs / 1000)}s）`)
  }

  // ── ChannelAdapter ──

  isLoggedIn(): boolean {
    return Boolean(this.opts.botToken)
  }

  status(): Record<string, unknown> {
    return {
      loggedIn: this.isLoggedIn(),
      pollAlive: this.running && Date.now() - this.lastPollAt < 120000,
      lastPollAt: this.lastPollAt || null,
      baseUrl: this.opts.baseUrl,
      botId: this.opts.botId ?? null,
    }
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void> | void): void {
    this.handler = handler
  }

  // ── F7 typing「正在输入」──

  async typingStart(userId: string, contextToken: string): Promise<void> {
    try {
      const ticket = await this.getTypingTicket(userId, contextToken)
      if (!ticket) return
      await this.sendTyping(userId, ticket, TYPING_STATUS.TYPING)
    } catch (e) {
      this.opts.logger.warn('[ilink-direct] typing 发送失败（降级）: %s', formatError(e))
    }
  }

  async typingStop(userId: string): Promise<void> {
    try {
      const entry = this.typingTickets.get(userId)
      if (!entry?.ticket) return
      await this.sendTyping(userId, entry.ticket, TYPING_STATUS.CANCEL)
    } catch (e) {
      this.opts.logger.warn('[ilink-direct] typing 取消失败（降级）: %s', formatError(e))
    }
  }

  /** getconfig 取 typing_ticket（per-user 缓存 24h）。 */
  private async getTypingTicket(userId: string, contextToken: string): Promise<string> {
    const entry = this.typingTickets.get(userId)
    if (entry && Date.now() < entry.nextFetchAt) return entry.ticket
    const data = await fetchJson(`${this.opts.baseUrl}/ilink/bot/getconfig`, {
      method: 'POST',
      headers: ilinkHeaders(this.opts.botToken),
      body: JSON.stringify({
        ilink_user_id: userId,
        context_token: contextToken,
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      timeoutMs: 15000,
    })
    this.checkError(data, 'getconfig')
    const ticket = String(data?.typing_ticket ?? '')
    this.typingTickets.set(userId, {
      ticket,
      nextFetchAt: Date.now() + TYPING_TICKET_TTL_MS,
    })
    return ticket
  }

  private async sendTyping(userId: string, ticket: string, status: number): Promise<void> {
    const data = await fetchJson(`${this.opts.baseUrl}/ilink/bot/sendtyping`, {
      method: 'POST',
      headers: ilinkHeaders(this.opts.botToken),
      body: JSON.stringify({
        ilink_user_id: userId,
        typing_ticket: ticket,
        status,
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      timeoutMs: 15000,
    })
    this.checkError(data, 'sendtyping')
  }

  async start(): Promise<void> {
    if (!this.isLoggedIn()) throw new Error('ilink-direct 需要 bot_token（先扫码登录或配置 credentials）')
    this.buf = this.opts.cursor.load() || ''
    this.running = true
    void this.pollLoop()
    this.opts.logger.info('[ilink-direct] 轮询已启动 baseUrl=%s', this.opts.baseUrl)
  }

  async stop(): Promise<void> {
    this.running = false
  }

  async send(toUserId: string, contextToken: string, text: string): Promise<void> {
    await this.acquireSendSlot()
    try {
      // 官方 SDK 必填：client_id / from_user_id / base_info，缺失会静默丢弃
      const data = await fetchJson(`${this.opts.baseUrl}/ilink/bot/sendmessage`, {
        method: 'POST',
        headers: ilinkHeaders(this.opts.botToken),
        body: JSON.stringify({
          msg: {
            from_user_id: '',
            to_user_id: toUserId,
            client_id: 'dsh-weixinbot-' + randomBytes(8).toString('hex'),
            message_type: 2,
            message_state: 2,
            context_token: contextToken,
            item_list: [{ type: 1, text_item: { text } }],
          },
          base_info: { channel_version: CHANNEL_VERSION },
        }),
        timeoutMs: 30000,
      })
      this.checkError(data, 'sendmessage')
      fileLog(
        'send',
        'ok to=' + toUserId + ' ctx=' + (contextToken ? contextToken.slice(0, 12) + '…' : '(EMPTY!)') + ' len=' + text.length,
      )
    } finally {
      this.sendTimes.push(Date.now())
    }
  }

  // ── 内部：长轮询 ──

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const res = await this.getUpdates()
        const msgs: WeixinMessage[] = Array.isArray(res?.msgs) ? res.msgs : []
        this.lastPollAt = Date.now()
        for (const msg of msgs) {
          if (!this.running) break
          await this.handleMessage(msg)
        }
        if (res && typeof res.get_updates_buf === 'string' && res.get_updates_buf !== this.buf) {
          this.buf = res.get_updates_buf
          this.opts.cursor.save(this.buf)
        }
        if (msgs.length === 0) await sleep(1000)
      } catch (e) {
        const msg = formatError(e)
        this.opts.logger.warn('[ilink-direct] 轮询错误: %s', msg)
        if (/errcode=-14|会话过期|401|token/i.test(msg)) {
          this.opts.logger.error('[ilink-direct] 微信会话可能已过期，请重新扫码登录')
          fileLog('expired', msg)
        }
        await sleep(this.opts.retryDelayMs)
      }
    }
  }

  private async getUpdates(): Promise<any> {
    const data = await fetchJson(`${this.opts.baseUrl}/ilink/bot/getupdates`, {
      method: 'POST',
      headers: ilinkHeaders(this.opts.botToken),
      body: JSON.stringify({
        get_updates_buf: this.buf,
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      timeoutMs: this.opts.pollTimeoutMs + 10000,
    })
    this.checkError(data, 'getupdates')
    return data
  }

  /**
   * iLink 成功响应可能没有 `ret` 字段（直接返回 msgs / get_updates_buf），
   * 失败响应带 `errcode`（如 -14 session timeout）。两者都容忍。
   */
  private checkError(data: any, op: string): void {
    if (data == null) throw new Error(`${op}: 空响应`)
    if (data.errcode !== undefined && data.errcode !== 0) {
      throw new Error(`${op} errcode=${data.errcode} ${data.errmsg ?? ''}`)
    }
    if (data.ret !== undefined && data.ret !== 0) {
      throw new Error(`${op} ret=${data.ret}`)
    }
  }

  private async handleMessage(msg: WeixinMessage): Promise<void> {
    if (msg.message_type !== 1) return // 只处理用户消息
    const from = msg.from_user_id
    const items = msg.item_list ?? []
    const textItem = items.find((i) => i.type === 1)
    let text = textItem?.text_item?.text?.trim() ?? ''
    if (!from || (items.length === 0 && !text)) return
    const msgId = msg.client_msg_id ?? msg.server_msg_id ?? `${from}:${msg.create_time_ms ?? Date.now()}`
    if (this.seen.has(msgId)) return
    this.seen.add(msgId)
    if (this.seen.size > 2000) this.seen.clear()

    // F8：下载解密多媒体附件（图片/语音/文件/视频）
    const media: MediaAttachment[] = []
    let seq = 0
    for (const item of items) {
      const att = await downloadMediaItem(item, this.opts.mediaDir, this.opts.maxBytes, this.opts.logger, seq++)
      if (att) {
        media.push(att)
        text += `\n[${kindLabel(att.kind)}附件已保存: ${att.path}${att.kind === 'file' ? `（${att.name}，${att.size} 字节）` : ''}]`
      }
    }

    const groupId = msg.group_id
    const inbound: InboundMessage = {
      kind: groupId ? 'group' : 'direct',
      channelKey: groupId ?? from,
      senderId: from,
      fromUserId: from,
      contextToken: msg.context_token ?? '',
      msgId,
      text,
      items,
      media,
      receivedAt: msg.create_time_ms ?? Date.now(),
    }
    fileLog('inbound', 'kind=' + inbound.kind + ' from=' + from + ' media=' + media.length + ' text=' + text.slice(0, 40))
    if (this.handler) await this.handler(inbound)
  }

  // ── 内部：发送限速 ──

  private async acquireSendSlot(): Promise<void> {
    const max = Math.max(1, this.opts.rateLimitPer5min - 1) // 留 1 条余量
    for (;;) {
      const now = Date.now()
      this.sendTimes = this.sendTimes.filter((t) => now - t < RATE_LIMIT_WINDOW_MS)
      if (this.sendTimes.length < max) return
      const wait = RATE_LIMIT_WINDOW_MS - (now - this.sendTimes[0])
      this.opts.logger.info('[ilink-direct] 限速，等待 %d ms', wait)
      await sleep(Math.min(wait, 30000))
    }
  }
}
