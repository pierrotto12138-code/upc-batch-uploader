/* 生成扩展图标：红底圆角 + 白色垃圾桶。
 * 纯 Node 写 PNG，不依赖 ImageMagick / canvas。用法：node row-delete/tools/make-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'icons')
mkdirSync(outDir, { recursive: true })

const SIZE = 128
const px = new Uint8Array(SIZE * SIZE * 4)

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
  const i = (y * SIZE + x) * 4
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a
}
function rect(x0, y0, x1, y1, r, g, b) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, r, g, b)
}
function roundRect(x0, y0, x1, y1, radius, r, g, b) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = Math.max(x0 + radius - x, 0, x - (x1 - radius - 1))
      const dy = Math.max(y0 + radius - y, 0, y - (y1 - radius - 1))
      if (dx * dx + dy * dy <= radius * radius) set(x, y, r, g, b)
    }
  }
}

// 背景：#e5484d 圆角方块
roundRect(4, 4, 124, 124, 26, 229, 72, 77)
// 桶盖与提手
rect(38, 32, 90, 42, 255, 255, 255)
rect(54, 22, 74, 32, 255, 255, 255)
// 桶身
roundRect(44, 48, 84, 102, 8, 255, 255, 255)
// 桶身上的三条红色竖槽
rect(54, 58, 59, 92, 229, 72, 77)
rect(62, 58, 67, 92, 229, 72, 77)
rect(70, 58, 75, 92, 229, 72, 77)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encode(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // 每行前一个字节是 filter 类型
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function sample(size) {
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = Math.min(SIZE - 1, Math.floor((x + 0.5) * SIZE / size))
      const sy = Math.min(SIZE - 1, Math.floor((y + 0.5) * SIZE / size))
      const si = (sy * SIZE + sx) * 4
      const di = (y * size + x) * 4
      out[di] = px[si]; out[di + 1] = px[si + 1]; out[di + 2] = px[si + 2]; out[di + 3] = px[si + 3]
    }
  }
  return out
}

const base = Buffer.from(px)
for (const size of [16, 48, 128]) {
  const file = join(outDir, `icon${size}.png`)
  writeFileSync(file, encode(size, size === 128 ? base : sample(size)))
  console.log('wrote', file)
}
