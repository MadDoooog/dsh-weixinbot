#!/usr/bin/env node
/**
 * 微信 ClawBot 扫码登录工具（零外部依赖，不需要任何浏览器桥）。
 *
 * 用法：
 *   node tools/wechat-login.mjs                    # 扫码并输出凭据
 *   node tools/wechat-login.mjs --write            # 同时写入 $DSH_HOME/weixinbot/credentials.json
 *   node tools/wechat-login.mjs --patch            # 同时更新 profile 的 cordis.patch.yml
 *   node tools/wechat-login.mjs --profile web      # 指定 profile（默认 web）
 *   node tools/wechat-login.mjs --timeout 300      # 等待扫码秒数（默认 600）
 *
 * 流程：
 *   1. 向 iLink 申请二维码 → 终端显示 ASCII 二维码 + 链接（可选保存 PNG 并自动打开）；
 *   2. 手机微信扫码并确认；
 *   3. 轮询确认结果 → 输出 bot_token / baseurl / botId；
 *   4. --write 写入 credentials.json（插件启动时自动读取，权限 0600）；
 *      --patch 再把凭据写进 profile 的 cordis.patch.yml（enabled=true）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE_URL = process.env.WX_BASE_URL || 'https://ilinkai.weixin.qq.com'

function parseArgs(argv) {
  const args = { write: false, patch: false, profile: 'web', timeout: 600, savePng: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--write') args.write = true
    else if (a === '--patch') args.patch = true
    else if (a === '--profile') args.profile = argv[++i]
    else if (a === '--timeout') args.timeout = Number(argv[++i]) || 600
    else if (a === '--save-png') args.savePng = true
    else if (a === '--help' || a === '-h') {
      console.log(
        '用法: node tools/wechat-login.mjs [--write] [--patch] [--profile <name>] [--timeout <秒>] [--save-png]',
      )
      process.exit(0)
    }
  }
  return args
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function ilinkHeaders() {
  const n = Math.floor(Math.random() * 0xffffffff)
  return {
    'Content-Type': 'application/json',
    'X-WECHAT-UIN': Buffer.from(String(n), 'utf8').toString('base64'),
  }
}

async function main() {
  const args = parseArgs(process.argv)
  console.log('→ 向 iLink 申请二维码…')

  // 1. QR code
  const qr = await (await fetch(`${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`)).json()
  if (qr.ret !== 0) throw new Error('获取二维码失败: ' + JSON.stringify(qr))
  console.log('\n📱 扫码链接（浏览器打开或直接扫码）:')
  console.log('  ' + qr.qrcode_img_content)
  console.log()

  // 2. Render: ASCII terminal QR — 必须编码完整链接 qrcode_img_content，
  //    微信扫码后才会进入登录确认页；编码裸 qrcode id 会扫出一串乱码文本。
  try {
    const QRCode = (await import('qrcode')).default
    const ascii = await QRCode.toString(qr.qrcode_img_content, { type: 'terminal', small: true })
    console.log('┌─ 二维码（手机微信扫一扫）─' + '─'.repeat(20) + '┐')
    console.log(ascii)
    console.log('└' + '─'.repeat(48) + '┘')
    if (args.savePng) {
      const pngPath = path.join(process.cwd(), 'wechat-qrcode.png')
      await QRCode.toFile(pngPath, qr.qrcode_img_content)
      console.log('💾 二维码已保存: ' + pngPath)
    }
  } catch {
    console.log('（终端二维码渲染失败，请使用上面的链接）')
  }

  // 3. Poll for confirmation
  console.log('\n⏳ 等待手机扫码确认（' + args.timeout + ' 秒超时）…')
  const deadline = Date.now() + args.timeout * 1000
  let confirmed = null
  while (Date.now() < deadline) {
    try {
      const s = await (
        await fetch(`${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${qr.qrcode}`)
      ).json()
      if (s.status === 'confirmed') {
        confirmed = s
        break
      }
      if (s.status === 'expired') {
        console.error('✗ 二维码已过期，请重新运行本工具')
        process.exit(2)
      }
    } catch (e) {
      /* transient network error, keep polling */
    }
    await sleep(2000)
  }
  if (!confirmed) {
    console.error('✗ 等待超时，请重新运行本工具')
    process.exit(3)
  }

  // 4. Output credentials
  console.log('\n✅ 扫码成功！凭据如下：')
  const creds = {
    botToken: confirmed.bot_token,
    baseUrl: confirmed.baseurl || BASE_URL,
    botId: confirmed.ilink_bot_id,
    userId: confirmed.ilink_user_id,
  }
  console.log(JSON.stringify(creds, null, 2))

  // 5. --write: 写入 credentials.json（插件启动时自动读取）
  if (args.write) {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const dir = path.join(home, 'weixinbot')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'credentials.json')
    fs.writeFileSync(file, JSON.stringify(creds, null, 2) + '\n', 'utf8')
    fs.chmodSync(file, 0o600)
    console.log('\n✅ 已写入 ' + file + '（重启 DSH profile 后生效）')
  }

  // 6. --patch: 写入 profile 的 cordis.patch.yml（weixinbot 行，enabled=true）
  if (args.patch) {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const patchPath = path.join(home, 'profiles', args.profile, 'cordis.patch.yml')
    if (!fs.existsSync(patchPath)) {
      console.error('\n✗ 未找到 ' + patchPath + '，请先挂载插件并添加 weixinbot 行（见 README）')
      process.exit(4)
    }
    let patch = fs.readFileSync(patchPath, 'utf8')
    const rowStart = patch.indexOf('- id: weixinbot')
    if (rowStart < 0) {
      console.error('\n✗ ' + patchPath + ' 中没有 weixinbot 行，请先按 README 配置插件')
      process.exit(5)
    }
    const rowEnd = patch.indexOf('- id:', rowStart + 10)
    const block = rowEnd > 0 ? patch.slice(rowStart, rowEnd) : patch.slice(rowStart)
    const lines = block.split('\n')

    // 在 weixinbot 行内按行替换凭据键与 enabled
    const replaceKey = (key, value) => {
      const idx = lines.findIndex((l) => new RegExp(`^\\s*${key}:`).test(l))
      if (idx >= 0) {
        lines[idx] = lines[idx].replace(/^( *)(.*)$/, `$1${key}: ${JSON.stringify(value)}`)
      }
    }
    const enabledIdx = lines.findIndex((l) => /^\s*enabled:\s*false/.test(l))
    if (enabledIdx >= 0) lines[enabledIdx] = lines[enabledIdx].replace(/false/, 'true')

    replaceKey('botToken', creds.botToken)
    replaceKey('baseUrl', creds.baseUrl)
    replaceKey('botId', creds.botId ?? '')
    replaceKey('userId', creds.userId ?? '')

    const newBlock = lines.join('\n')
    patch = rowEnd > 0 ? patch.slice(0, rowStart) + newBlock + patch.slice(rowEnd) : patch.slice(0, rowStart) + newBlock
    fs.writeFileSync(patchPath, patch, 'utf8')
    console.log('\n✅ 已写入 ' + patchPath + '（enabled=true，凭据已更新）')
    console.log('   重启 DSH profile 后生效：dsh --profile ' + args.profile)
  } else {
    console.log('\n💡 提示：加 --write 写入 credentials.json；或加 --patch 直接改 profile 配置')
  }
}

main().catch((e) => {
  console.error('✗ 登录工具失败:', e.message)
  process.exit(1)
})
