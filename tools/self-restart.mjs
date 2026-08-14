#!/usr/bin/env node
/**
 * agent 自重启助手：把「重启后待办」写入续跑标记，并委托 claudecode
 * （在独立 systemd transient unit 里，dsh-web 重启不会杀掉它）重启自己。
 *
 * 用法（在 agent 的 bash 环境里，$DSH_SESSION_ID 已注入）：
 *   node tools/self-restart.mjs "重启后请验证 xxx 并汇报"
 *
 * 流程：
 *   1. 读 $DSH_SESSION_ID（缺省从 ~/.dsh/sessions 推断当前会话）；
 *   2. 写 $DSH_HOME/weixinbot/pending-continuation.json（续跑标记）；
 *   3. systemd-run 启动 claudecode 执行 $DSH_HOME/weixinbot/restart-prompt.txt
 *      （restart dsh-web → 健康检查 → 出问题自修 → 写 restart-result.json）；
 *   4. 打印提示：重启完成后插件会向本会话注入「重启完成通知」，agent 自动续跑。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

function findSessionId() {
  if (process.env.DSH_SESSION_ID) return process.env.DSH_SESSION_ID
  // 兜底：取 cwd 对应 project 目录里最新的 session-*
  const cwdProject = '--' + (process.cwd() || os.homedir()).replace(/[/.]/g, '-').replace(/-+/g, '-') + '--'
  const dir = path.join(home, 'sessions', cwdProject)
  try {
    const ids = fs
      .readdirSync(dir)
      .filter((d) => d.startsWith('session-'))
      .sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs)
    return ids[0]
  } catch {
    return ''
  }
}

function main() {
  const message = process.argv[2]
  if (!message) {
    console.error('用法: node tools/self-restart.mjs "<重启后要执行的待办>"')
    process.exit(1)
  }
  const sessionId = findSessionId()
  if (!sessionId) {
    console.error('✗ 找不到本 agent 的会话 id（$DSH_SESSION_ID 未设置）')
    process.exit(2)
  }

  // 1) 续跑标记
  const marker = {
    sessionId,
    message,
    createdAt: new Date().toISOString(),
  }
  const markerPath = path.join(home, 'weixinbot', 'pending-continuation.json')
  fs.mkdirSync(path.dirname(markerPath), { recursive: true })
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2) + '\n', 'utf8')
  console.log(`✅ 续跑标记已写入 ${markerPath}`)
  console.log(`   会话：${sessionId}`)

  // 2) 委托 claudecode 重启（独立 transient unit，重启不杀它）
  const promptFile = path.join(home, 'weixinbot', 'restart-prompt.txt')
  if (!fs.existsSync(promptFile)) {
    console.error(`✗ 缺少重启任务文件 ${promptFile}（见 README 运维章节）`)
    process.exit(3)
  }
  const claude = path.join(os.homedir(), '.local', 'bin', 'claude')
  const logFile = path.join(home, 'weixinbot', 'restart-log.txt')
  const unit = `dsh-weixinbot-restart-${Date.now()}`
  const script = `${claude} -p --dangerously-skip-permissions < ${promptFile} > ${logFile} 2>&1`
  console.log(`→ systemd-run --user --unit=${unit} --collect /bin/bash -c "${script}"`)
  const r = spawnSync('systemd-run', ['--user', `--unit=${unit}`, '--collect', '/bin/bash', '-c', script], {
    stdio: 'inherit',
    shell: false,
  })
  if (r.status !== 0) {
    console.error('✗ systemd-run 启动 claudecode 失败，请手动执行上面的命令')
    process.exit(4)
  }
  console.log('\n已委托 claudecode 重启 dsh-web。')
  console.log('重启完成后：插件会向本会话注入「重启完成通知」，本 agent 自动醒来继续执行待办；')
  console.log('同时微信会收到启动通知。结果见 ' + path.join(home, 'weixinbot', 'restart-result.json'))
}

main()
