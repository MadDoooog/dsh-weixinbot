/**
 * 通道抽象：ChannelAdapter 接口与规范化消息模型。
 * ilink-direct 与（预留的）openclaw-relay 都实现本接口；
 * Bridge 只依赖本接口，不感知具体协议。
 */
import type { Logger } from '../util.js'

/** 入站消息媒体项（item_list 规范化）。 */
export interface MediaItem {
  type: number
  text_item?: { text?: string }
}

/** 规范化入站消息（协议无关）。 */
export interface InboundMessage {
  kind: 'direct' | 'group'
  /** 会话键：单聊为 from_user_id，群聊为 group_id。 */
  channelKey: string
  /** 发言者（群聊时区别于会话键）。 */
  senderId: string
  /** 回发目标（原样透传）。 */
  fromUserId: string
  /** 回发时必须携带的上下文令牌。 */
  contextToken: string
  /** 去重 ID。 */
  msgId: string
  text: string
  items: MediaItem[]
  receivedAt: number
}

export interface ChannelAdapter {
  readonly name: string
  /** 启动收消息（getupdates 长轮询）。 */
  start(): Promise<void>
  stop(): Promise<void>
  /** 发送文本到指定用户，携带原 context_token。 */
  send(toUserId: string, contextToken: string, text: string): Promise<void>
  isLoggedIn(): boolean
  /** 健康检查用状态。 */
  status(): Record<string, unknown>
  /** 注册入站消息处理器（Bridge 调用一次）。 */
  onMessage(handler: (msg: InboundMessage) => Promise<void> | void): void
  /** 发送「正在输入」状态（F7；可选，失败静默降级）。 */
  typingStart?(userId: string, contextToken: string): Promise<void>
  /** 结束「正在输入」状态（可选）。 */
  typingStop?(userId: string): Promise<void>
}

/** Bridge 可用的最小 Logger（与 cordis logger 兼容）。 */
export type { Logger }
