/**
 * F8 媒体下载：微信 CDN（novac2c.cdn.weixin.qq.com/c2c）下载 + AES-128-ECB 解密。
 *
 * 参考 @tencent-weixin/openclaw-weixin 官方实现：
 * - 下载 URL：`full_url` 优先，否则 `${cdnBaseUrl}/download?encrypted_query_param=<param>`；
 * - AES key 两种编码：base64(16 原始字节) 或 base64(16 字节的 hex 字符串，32 字符)；
 * - 图片可用 item.aeskey（hex 字符串）→ base64 → 再解析。
 */
import { createDecipheriv } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Logger } from '../util.js'
import { fileLog } from '../util.js'

export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

export interface MediaRef {
  /** 协议字段为 snake_case：full_url / encrypt_query_param / aes_key。 */
  full_url?: string
  encrypt_query_param?: string
  aes_key?: string
}

export interface MediaAttachment {
  kind: 'image' | 'voice' | 'file' | 'video'
  path: string
  name: string
  size: number
}

/** 媒体消息 item 的原始形状（官方协议字段）。 */
export interface MediaItemRaw {
  type: number
  text_item?: { text?: string }
  image_item?: { aeskey?: string; media?: MediaRef }
  voice_item?: { text?: string; media?: MediaRef }
  file_item?: { file_name?: string; media?: MediaRef }
  video_item?: { media?: MediaRef }
}

/** 解析 AES key：base64(16 原始字节) 或 base64(hex 字符串)。 */
function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new Error(`aes_key 无法解析（${decoded.length} bytes）`)
}

/** AES-128-ECB 解密（PKCS7 padding 默认）。 */
export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

async function fetchBytes(url: string, logger: Logger): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`CDN 下载 ${res.status} ${res.statusText}`)
  return Buffer.from(await res.arrayBuffer())
}

function buildDownloadUrl(ref: MediaRef): string {
  if (ref.full_url) return ref.full_url
  if (ref.encrypt_query_param) {
    return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(ref.encrypt_query_param)}`
  }
  throw new Error('媒体项缺少 full_url / encrypt_query_param')
}

function aesKeyFor(ref: MediaRef, imageHexAeskey?: string): Buffer | null {
  let base64: string | undefined
  if (imageHexAeskey) base64 = Buffer.from(imageHexAeskey, 'hex').toString('base64')
  else base64 = ref.aes_key
  return base64 ? parseAesKey(base64) : null
}

function safeName(name: string): string {
  return name.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(0, 80) || 'file'
}

/** 下载 + 解密一条媒体 item，保存到 mediaDir，返回附件信息；不支持/失败返回 null。 */
export async function downloadMediaItem(
  item: MediaItemRaw,
  mediaDir: string,
  maxBytes: number,
  logger: Logger,
  seq: number,
): Promise<MediaAttachment | null> {
  const stamp = `${Date.now()}-${seq}`
  try {
    if (item.type === 2 && item.image_item?.media) {
      const { media } = item.image_item
      if (!media.full_url && !media.encrypt_query_param) return null
      const key = aesKeyFor(media, item.image_item.aeskey)
      const buf = key ? decryptAesEcb(await fetchBytes(buildDownloadUrl(media), logger), key) : await fetchBytes(buildDownloadUrl(media), logger)
      const name = `img-${stamp}.jpg`
      const saved = await saveMedia(buf, mediaDir, name, maxBytes)
      return { kind: 'image', ...saved }
    }
    if (item.type === 3 && item.voice_item?.media) {
      const { media } = item.voice_item
      if (!media.full_url && !media.encrypt_query_param) return null
      const key = aesKeyFor(media)
      if (!key) return null
      const buf = decryptAesEcb(await fetchBytes(buildDownloadUrl(media), logger), key)
      const name = `voice-${stamp}.silk`
      const saved = await saveMedia(buf, mediaDir, name, maxBytes)
      return { kind: 'voice', ...saved }
    }
    if (item.type === 4 && item.file_item?.media) {
      const { media, file_name } = item.file_item
      if (!media.full_url && !media.encrypt_query_param) return null
      const key = aesKeyFor(media)
      if (!key) return null
      const buf = decryptAesEcb(await fetchBytes(buildDownloadUrl(media), logger), key)
      const name = `${Date.now()}-${safeName(file_name ?? 'file.bin')}`
      const saved = await saveMedia(buf, mediaDir, name, maxBytes)
      return { kind: 'file', ...saved }
    }
    if (item.type === 5 && item.video_item?.media) {
      const { media } = item.video_item
      if (!media.full_url && !media.encrypt_query_param) return null
      const key = aesKeyFor(media)
      if (!key) return null
      const buf = decryptAesEcb(await fetchBytes(buildDownloadUrl(media), logger), key)
      const name = `video-${stamp}.mp4`
      const saved = await saveMedia(buf, mediaDir, name, maxBytes)
      return { kind: 'video', ...saved }
    }
    return null
  } catch (e) {
    logger.warn('[cdn] 媒体下载失败: %s', e instanceof Error ? e.message : String(e))
    fileLog('media-fail', 'type=' + item.type + ' err=' + (e instanceof Error ? e.message : String(e)))
    return null
  }
}

async function saveMedia(
  buf: Buffer,
  mediaDir: string,
  name: string,
  maxBytes: number,
): Promise<{ path: string; name: string; size: number }> {
  if (buf.length > maxBytes) throw new Error(`媒体超限（${buf.length} > ${maxBytes} bytes）`)
  fs.mkdirSync(mediaDir, { recursive: true })
  const full = path.join(mediaDir, name)
  fs.writeFileSync(full, buf)
  fileLog('media-save', 'path=' + full + ' bytes=' + buf.length)
  return { path: full, name, size: buf.length }
}
