/**
 * F9 主动通知工具：注册 `wechat_send` / `wechat_notify` 到 DSH 工具箱，
 * 让 agent 能主动把消息/通知发到微信。
 *
 * 实现说明：为避免与运行时 dsh-tools 版本错配，这里**不 import defineTool**，
 * 而是按 ToolDefinition 的形状手工构造注册对象（parameters 用参数规范格式，
 * 由 tools 服务内部转换为 JSON schema）。注册入口通过 `ctx.tools` 可选访问。
 */
import type { ChannelAdapter } from '../adapter/channel.js'
import type { Logger } from '../util.js'

/** 最小 ToolDefinition 形状（与 @deepseek-ai/dsh-tools 的 ToolDefinition 对齐）。 */
export interface NotifyToolDef {
  name: string
  description: string
  parameters: Record<string, ParameterSpec>
  output: {
    schema: { type: 'json' }
    render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }>
  }
  execute: (args: Record<string, unknown>) => Promise<unknown>
  timeoutMs?: number
}

interface ParameterSpec {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object'
  required?: boolean
  enum?: string[]
  description?: string
}

export interface NotifierConfig {
  enabled: boolean
  /** 默认发送目标（绑定者 userId，形如 xxx@im.wechat）。 */
  defaultTarget: string
}

export interface ToolsHost {
  tools?: {
    register(tool: NotifyToolDef): unknown
  }
}

function contentBlock(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }]
}

export function registerNotifyTools(
  host: ToolsHost,
  adapter: ChannelAdapter,
  cfg: NotifierConfig,
  log: Logger,
): void {
  const tools = host.tools
  if (!tools || !cfg.enabled) return
  if (!cfg.defaultTarget) {
    log.warn('[notifier] 未配置 defaultTarget（credentials.userId），wechat_send/wechat_notify 不可用')
    return
  }

  const sendText = async (text: string, to?: string): Promise<Record<string, unknown>> => {
    const target = to || cfg.defaultTarget
    if (!target) throw new Error('发送目标为空')
    await adapter.send(target, '', text) // 主动推送无 context_token
    return { ok: true, to: target, len: text.length }
  }

  const wechatSend: NotifyToolDef = {
    name: 'wechat_send',
    description:
      'Send a text message to the bound WeChat user (the bot owner). ' +
      'Use for proactive updates the user asked for or important results. ' +
      'Optional `to` overrides the target (a WeChat user id like xxx@im.wechat).',
    parameters: {
      text: { type: 'string', required: true, description: 'The message text to send.' },
      to: { type: 'string', description: 'Optional target WeChat user id; defaults to the bound owner.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => contentBlock(JSON.stringify(value, null, 2)),
    },
    execute: async (args) => sendText(String(args.text ?? ''), args.to ? String(args.to) : undefined),
    timeoutMs: 30000,
  }

  const wechatNotify: NotifyToolDef = {
    name: 'wechat_notify',
    description:
      'Push a notification message to the bound WeChat user. ' +
      'Use when a task finished, needs a decision, or something urgent happened. ' +
      'Unlike wechat_send it is notification-oriented (no file support yet).',
    parameters: {
      message: { type: 'string', required: true, description: 'The notification text.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => contentBlock(JSON.stringify(value, null, 2)),
    },
    execute: async (args) => sendText(String(args.message ?? '')),
    timeoutMs: 30000,
  }

  tools.register(wechatSend)
  tools.register(wechatNotify)
  log.info('[notifier] 已注册 wechat_send / wechat_notify（目标=%s）', cfg.defaultTarget)
}
