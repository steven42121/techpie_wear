// Minimal PNG encoder for the band display: 8-bit grayscale, stored deflate.
// Hot paths write into preallocated Uint8Arrays (QuickJS: no per-byte pushes).
'use strict'

const CRC_TABLE = (function () {
  const table = new Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes, start, end) {
  let c = 0xffffffff
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function adler32(bytes) {
  let a = 1, b = 0
  const n = bytes.length
  let i = 0
  // 每 5552 字节才取模一次（中间和 < 2^53，精确），省掉逐字节的 % 开销。
  while (i < n) {
    const end = i + 5552 < n ? i + 5552 : n
    for (; i < end; i++) {
      a += bytes[i]
      b += a
    }
    a %= 65521
    b %= 65521
  }
  return ((b << 16) | a) >>> 0
}

function chunk(type, data) {
  const len = data.length
  const out = new Uint8Array(12 + len)
  out[0] = (len >>> 24) & 0xff
  out[1] = (len >>> 16) & 0xff
  out[2] = (len >>> 8) & 0xff
  out[3] = len & 0xff
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  const crc = crc32(out, 4, 8 + len)
  out[8 + len] = (crc >>> 24) & 0xff
  out[9 + len] = (crc >>> 16) & 0xff
  out[10 + len] = (crc >>> 8) & 0xff
  out[11 + len] = crc & 0xff
  return out
}

// zlib stream with stored (uncompressed) deflate blocks
function zlibStored(raw) {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535))
  const out = new Uint8Array(2 + blocks * 5 + raw.length + 4)
  let p = 0
  out[p++] = 0x78
  out[p++] = 0x01
  let offset = 0
  do {
    const len = Math.min(65535, raw.length - offset)
    const final = offset + len >= raw.length ? 1 : 0
    out[p++] = final
    out[p++] = len & 0xff
    out[p++] = (len >>> 8) & 0xff
    out[p++] = ~len & 0xff
    out[p++] = (~len >>> 8) & 0xff
    out.set(raw.subarray(offset, offset + len), p)
    p += len
    offset += len
  } while (offset < raw.length)
  const ad = adler32(raw)
  out[p++] = (ad >>> 24) & 0xff
  out[p++] = (ad >>> 16) & 0xff
  out[p++] = (ad >>> 8) & 0xff
  out[p++] = ad & 0xff
  return out
}

// pixels: Uint8Array, row-major, 0=black 255=white.
function encodeGrayPng(width, height, pixels) {
  const stride = width + 1
  const raw = new Uint8Array(height * stride) // filter byte 0 already
  for (let y = 0; y < height; y++) {
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * stride + 1)
  }
  const ihdr = new Uint8Array([
    (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff,
    (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff,
    8, 0, 0, 0, 0, // bit depth 8, grayscale, deflate 0, no filter, no interlace
  ])
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', zlibStored(raw)), chunk('IEND', new Uint8Array(0))]
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let off = 0
  for (const part of parts) {
    out.set(part, off)
    off += part.length
  }
  return out
}

// qr: { size, modules } -> 180x180 (or scaled) grayscale PNG bytes
function qrToPng(qr) {
  const quiet = 4
  const total = qr.size + quiet * 2
  const scale = Math.max(1, Math.floor(180 / total))
  const dim = total * scale
  const pixels = new Uint8Array(dim * dim).fill(255)
  for (let y = 0; y < qr.size; y++) {
    const row = qr.modules[y]
    const py = (y + quiet) * scale
    // 相邻暗模块合并成一次 fill：fill 调用数从 模块数×scale 降到 行程数×scale。
    let x = 0
    while (x < qr.size) {
      if (!row[x]) {
        x++
        continue
      }
      let x2 = x + 1
      while (x2 < qr.size && row[x2]) x2++
      const px = (x + quiet) * scale
      const len = (x2 - x) * scale
      for (let dy = 0; dy < scale; dy++) {
        pixels.fill(0, (py + dy) * dim + px, (py + dy) * dim + px + len)
      }
      x = x2
    }
  }
  return encodeGrayPng(dim, dim, pixels)
}

module.exports = { encodeGrayPng, qrToPng }
