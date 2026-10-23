// 生成应用图标 assets/icon.png（512×512）：macOS 风格圆角蓝底 + 白色电池图形
// 纯 Node 实现，无图像库依赖：SDF 绘制 + zlib PNG 编码
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 512
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---- SDF ----
const sdRoundRect = (px, py, cx, cy, hw, hh, r) => {
  const dx = Math.abs(px - cx) - (hw - r)
  const dy = Math.abs(py - cy) - (hh - r)
  const ax = Math.max(dx, 0)
  const ay = Math.max(dy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r
}

const clamp01 = (v) => Math.min(1, Math.max(0, v))
/** 抗锯齿覆盖：d<0 内部 1，d>0 外部 0，边缘 1px 过渡 */
const cov = (d) => clamp01(0.5 - d)

const mix = (a, b, t) => a + (b - a) * t

// ---- 绘制 ----
const px = new Uint8Array(SIZE * SIZE * 4)

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4
    let r = 0
    let g = 0
    let b = 0
    let a = 0

    // 背景：圆角方块 + 纵向蓝色渐变（#56ACFF → #0B69F8）
    const bg = cov(sdRoundRect(x, y, 256, 256, 244, 244, 116))
    if (bg > 0) {
      const t = y / SIZE
      r = mix(0x56, 0x0b, t)
      g = mix(0xac, 0x69, t)
      b = mix(0xff, 0xf8, t)
      a = bg * 255
    }

    // 电池主体（白色圆角矩形）
    const body = cov(sdRoundRect(x, y, 244, 256, 140, 82, 30))
    // 电池正极凸头
    const cap = cov(sdRoundRect(x, y, 408, 256, 14, 34, 8))
    const white = Math.max(body, cap)
    if (white > 0) {
      r = mix(r, 255, white)
      g = mix(g, 255, white)
      b = mix(b, 255, white)
      a = Math.max(a, white * 255)
    }

    // 内部电量填充（主题蓝，约 55%）
    const fill = cov(sdRoundRect(x, y, 226, 256, 116, 58, 20))
    if (fill > 0) {
      r = mix(r, 0x1f, fill)
      g = mix(g, 0x8b, fill)
      b = mix(b, 0xff, fill)
    }

    px[i] = Math.round(r)
    px[i + 1] = Math.round(g)
    px[i + 2] = Math.round(b)
    px[i + 3] = Math.round(a)
  }
}

// ---- PNG 编码 ----
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
// 行前加 filter 字节 0
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

mkdirSync(path.join(root, 'assets'), { recursive: true })
writeFileSync(path.join(root, 'assets', 'icon.png'), png)
console.log(`assets/icon.png 已生成 (${png.length} 字节)`)
