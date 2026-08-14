/**
 * dsh-weixinbot 配置：类型、默认值、归一化。
 *
 * 加载器把 bundle patch 行里的 `config`（以及 profile 级覆盖）作为插件
 * 的第二个参数传入；这里在默认值之上做深合并。
 */
import os from 'node:os'

export interface CredentialsConfig {
  /** ClawBot Bearer token（`wechat-login.mjs` 扫码后获得）。 */
  botToken: string
  /** iLink 网关地址；扫码登录返回的 baseurl 优先。 */
  baseUrl: string
  /** 机器人账号 ID（形如 `xxx@im.bot`），仅用于日志/识别。 */
  botId?: string
  /** 绑定者用户 ID（形如 `xxx@im.wechat`），主动通知的默认目标。 */
  userId?: string
}

export interface PollConfig {
  /** getupdates 长轮询超时（服务端 hold 时间）。 */
  timeoutMs: number
  /** 轮询出错后的重试间隔。 */
  retryDelayMs: number
}

export interface QueueConfig {
  /** 单轮 agent 回答超时（毫秒）。 */
  turnTimeoutMs: number
  /** 官方限速约 7 条/5 分钟；本地按此窗口排队（留 1 条余量）。 */
  rateLimitPer5min: number
}

export interface DshConfig {
  /** 专属 agent 的工作目录（默认 home）。 */
  cwd: string
  /** 可选：显式 provider 路由（缺省用 ctx.agentDefaultModel）。 */
  provider?: string
  /** 可选：显式 model id（缺省用 ctx.agentDefaultModel）。 */
  model?: string
}

export interface ServerConfig {
  enabled: boolean
  /** 本地健康检查 HTTP 端口。 */
  port: number
}

export interface Config {
  enabled: boolean
  /** 通道适配器：ilink-direct（内置协议）| openclaw-relay（预留）。 */
  adapter: 'ilink-direct' | 'openclaw-relay'
  /** iLink 凭据；为空时回退读取 $DSH_HOME/weixinbot/credentials.json。 */
  credentials: CredentialsConfig
  poll: PollConfig
  queue: QueueConfig
  /** 单聊白名单（`xxx@im.wechat`）；空数组 = 全部拒绝（fail-closed）。 */
  allowUsers: string[]
  /** 管理命令白名单；空数组 = 沿用 allowUsers。 */
  adminUsers: string[]
  /** 命令前缀（/help /new /status）。 */
  commandPrefix: string
  dsh: DshConfig
  server: ServerConfig
  /** 是否写独立日志文件 $DSH_HOME/weixinbot/weixinbot.log。 */
  logFile: boolean
}

export const DEFAULT_CONFIG: Config = {
  enabled: false,
  adapter: 'ilink-direct',
  credentials: {
    botToken: '',
    baseUrl: 'https://ilinkai.weixin.qq.com',
  },
  poll: {
    timeoutMs: 35000,
    retryDelayMs: 3000,
  },
  queue: {
    turnTimeoutMs: 120000,
    rateLimitPer5min: 6,
  },
  allowUsers: [],
  adminUsers: [],
  commandPrefix: '/',
  dsh: {
    cwd: '',
  },
  server: {
    enabled: false,
    port: 3901,
  },
  logFile: true,
}

function merge<T>(target: T, source: unknown): T {
  if (source === undefined || source === null) return target
  if (typeof source !== 'object' || Array.isArray(source)) return source as T
  const out: any = { ...(target as any) }
  for (const [k, v] of Object.entries(source as Record<string, unknown>)) {
    const cur = (target as any)?.[k]
    out[k] =
      cur !== undefined && typeof cur === 'object' && !Array.isArray(cur) && typeof v === 'object' && v !== null
        ? merge(cur, v)
        : v
  }
  return out as T
}

/** 深合并加载器配置到默认值之上。 */
export function normalizeConfig(input: Partial<Config> | undefined): Config {
  const cfg = merge(structuredClone(DEFAULT_CONFIG), input ?? {}) as Config
  if (!cfg.dsh.cwd) cfg.dsh.cwd = os.homedir()
  return cfg
}

/** 是否已有可用凭据（config 或文件）。 */
export function hasCredentials(cfg: Config): boolean {
  return Boolean(cfg.credentials?.botToken)
}
