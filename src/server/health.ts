/**
 * 本地健康检查 HTTP 服务（默认 127.0.0.1:3901/health）。
 */
import http from 'node:http'
import type { ServerConfig } from '../config.js'
import type { Logger } from '../util.js'

export class StatusServer {
  private server?: http.Server

  constructor(
    private cfg: ServerConfig,
    private state: () => Record<string, unknown>,
    private log: Logger,
  ) {}

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      if (req.url === '/health' || req.url === '/') {
        const body = JSON.stringify({ ok: true, uptime: process.uptime(), ...this.state() }, null, 2)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(body)
        return
      }
      res.writeHead(404).end('not found')
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.cfg.port, '127.0.0.1', () => resolve())
    })
    this.log.info('[health] http://127.0.0.1:%d/health', this.cfg.port)
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()))
      this.server = undefined
    }
  }
}
