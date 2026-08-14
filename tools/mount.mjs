#!/usr/bin/env node
/**
 * dsh-weixinbot 一键挂载工具（在用户自己的终端运行，需要可写 $DSH_HOME）。
 *
 * 用法：
 *   node tools/mount.mjs                    # 打印将执行的命令（dry-run）
 *   node tools/mount.mjs --apply            # 执行：dsh plugin add + 写 profile 补丁
 *   node tools/mount.mjs --profile web      # 指定 profile（默认 web）
 *
 * 流程：
 *   1. 校验 lib/ 已构建（插件入口是 lib/index.js）；
 *   2. 读取 $DSH_HOME/weixinbot/credentials.json 取 userId 填白名单；
 *   3. 运行 `dsh plugin --profile <name> add file:<本仓库>`（自动 reconcile bundles）；
 *   4. 若 profile 的 cordis.patch.yml 还没有 weixinbot 行，追加完整配置行
 *      （enabled=true、allowUsers=[userId]、server.enabled=true）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

function parseArgs(argv) {
  const args = { apply: false, profile: 'web', dshBin: 'dsh', skipInstall: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') args.apply = true
    else if (a === '--profile') args.profile = argv[++i]
    else if (a === '--dsh') args.dshBin = argv[++i]
    else if (a === '--skip-install') args.skipInstall = true
    else if (a === '--help' || a === '-h') {
      console.log('用法: node tools/mount.mjs [--apply] [--profile <name>] [--dsh <dsh-bin>] [--skip-install]')
      process.exit(0)
    }
  }
  return args
}

function home() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function weixinbotRow(userId) {
  return `- insert:
    - id: weixinbot
      name: 'dsh-weixinbot'
      config:
        enabled: true
        adapter: ilink-direct
        credentials:
          botToken: ''
          baseUrl: https://ilinkai.weixin.qq.com
          botId: ''
          userId: ''
        poll:
          timeoutMs: 35000
          retryDelayMs: 3000
        queue:
          turnTimeoutMs: 120000
          rateLimitPer5min: 6
        allowUsers:
          - '${userId}'
        adminUsers: []
        commandPrefix: /
        dsh:
          cwd: ''
          provider: null
          model: null
        server:
          enabled: true
          port: 3901
        logFile: true
`
}

function main() {
  const args = parseArgs(process.argv)
  const profileDir = path.join(home(), 'profiles', args.profile)
  const patchPath = path.join(profileDir, 'cordis.patch.yml')

  // 1. lib 已构建？
  if (!fs.existsSync(path.join(repoRoot, 'lib', 'index.js'))) {
    console.error('✗ 未找到 lib/index.js，请先运行 npm run build')
    process.exit(1)
  }

  // 2. 凭据与 userId
  let userId = ''
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(home(), 'weixinbot', 'credentials.json'), 'utf8'))
    userId = creds.userId || ''
  } catch {
    // 无凭据文件：仍可挂载，但白名单留空（fail-closed，需手动配置）
  }
  if (!userId) console.warn('⚠ 未读到 credentials.json（或没有 userId），allowUsers 将留空 = 全部拒绝')

  // 3. dsh plugin add（file: 绝对路径，自动 reconcile bundles）
  const addCmd = `${args.dshBin} plugin --profile ${args.profile} add file:${repoRoot}`
  if (args.skipInstall) {
    console.log('ℹ --skip-install：跳过 ' + addCmd + '（需自行确认已挂载）')
  } else if (args.apply) {
    console.log('→ ' + addCmd)
    const r = spawnSync(args.dshBin, ['plugin', '--profile', args.profile, 'add', `file:${repoRoot}`], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    if (r.status !== 0) {
      console.error(`✗ dsh plugin add 失败（exit ${r.status}）；请手动执行：${addCmd}`)
      process.exit(r.status ?? 1)
    }
  } else {
    console.log('将执行（--apply 生效）:\n  ' + addCmd)
  }

  // 4. profile 补丁：追加 weixinbot 行（若不存在）
  if (!fs.existsSync(profileDir)) {
    console.error(`✗ profile 目录不存在：${profileDir}（先跑一次 dsh plugin 初始化）`)
    process.exit(2)
  }
  let content = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : ''
  const hasRow = /^- id: weixinbot\s*$/m.test(content)
  if (hasRow) {
    console.log(`\nℹ ${patchPath} 已有 weixinbot 行，跳过写入；请手动确认 enabled=true 与 allowUsers`)
  } else {
    const block = weixinbotRow(userId)
    if (args.apply) {
      content = content.trimEnd() + '\n\n' + block
      fs.writeFileSync(patchPath, content, 'utf8')
      console.log(`\n✅ 已写入 ${patchPath}（enabled=true, allowUsers=[${userId || '（空）'}]）`)
    } else {
      console.log(`\n将追加到 ${patchPath}:\n` + block.trimEnd())
    }
  }

  if (args.apply) {
    console.log('\n完成。重启 DSH profile 后生效：dsh --profile ' + args.profile)
  } else {
    console.log('\n（dry-run，未做任何修改；确认无误后加 --apply 执行）')
  }
}

main()
