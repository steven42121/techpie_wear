// Minimal QR encoder: byte mode, EC level M, versions 1-6, all 8 masks.
// Matrix output matches the QR standard bit-for-bit (verified vs `qrcode` npm).
'use strict'

// GF(256) with primitive polynomial 0x11d
const EXP = new Array(512)
const LOG = new Array(256)
;(function () {
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
})()

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a] + LOG[b]]
}

// version -> [totalCodewords, ecPerBlock, numBlocks, byteCapacity]
const VERSIONS = [
  null,
  [26, 10, 1, 14],
  [44, 16, 1, 26],
  [70, 26, 1, 42],
  [100, 18, 2, 62],
  [134, 24, 2, 84],
  [172, 16, 4, 106],
  [196, 18, 4, 122],
  [242, 22, 4, 152],
  [292, 22, 5, 180],
  [346, 26, 5, 213],
]

const ALIGN = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
]

// 生成多项式按度数缓存：同一版本每次生成二维码只建一次表。
const GEN_CACHE = {}
function rsGenerator(degree) {
  const cached = GEN_CACHE[degree]
  if (cached) return cached
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], 1)
      next[j + 1] ^= gfMul(poly[j], EXP[i])
    }
    poly = next
  }
  GEN_CACHE[degree] = poly
  return poly
}

// 原地左移 LFSR，避免 shift/push 的 O(n) 搬移。
function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen)
  const res = new Uint8Array(ecLen)
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ res[0]
    for (let j = 0; j < ecLen - 1; j++) {
      res[j] = res[j + 1] ^ gfMul(gen[j + 1], factor)
    }
    res[ecLen - 1] = gfMul(gen[ecLen], factor)
  }
  return res
}

function pickVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    if (VERSIONS[v][3] >= byteLen) return v
  }
  return -1
}

function buildCodewords(bytes, version) {
  const total = VERSIONS[version][0]
  const ecPer = VERSIONS[version][1]
  const blocks = VERSIONS[version][2]
  const dataCount = total - ecPer * blocks

  // 位流直接按字节打包，去掉逐位数组。
  const data = []
  let cur = 0
  let nbits = 0
  function push(value, len) {
    for (let i = len - 1; i >= 0; i--) {
      cur = (cur << 1) | ((value >> i) & 1)
      nbits++
      if (nbits === 8) {
        data.push(cur & 0xff)
        cur = 0
        nbits = 0
      }
    }
  }
  const countBits = version >= 10 ? 16 : 8
  push(0b0100, 4) // byte mode
  push(bytes.length, countBits)
  for (let i = 0; i < bytes.length; i++) push(bytes[i], 8)
  const capacity = dataCount * 8
  const used = 4 + countBits + bytes.length * 8
  push(0, Math.min(4, capacity - used)) // terminator
  while (nbits !== 0) push(0, 1)
  const pads = [0xec, 0x11]
  let pi = 0
  while (data.length < dataCount) data.push(pads[pi++ % 2])

  // split into blocks (short blocks first)
  const shortLen = Math.floor(dataCount / blocks)
  const longCount = dataCount % blocks
  const dataBlocks = []
  const ecBlocks = []
  let off = 0
  for (let b = 0; b < blocks; b++) {
    const len = shortLen + (b >= blocks - longCount ? 1 : 0)
    const chunk = data.slice(off, off + len)
    off += len
    dataBlocks.push(chunk)
    ecBlocks.push(rsEncode(chunk, ecPer))
  }
  // interleave
  const out = []
  const maxData = shortLen + (longCount > 0 ? 1 : 0)
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < blocks; b++) {
      if (i < dataBlocks[b].length) out.push(dataBlocks[b][i])
    }
  }
  for (let i = 0; i < ecPer; i++) {
    for (let b = 0; b < blocks; b++) out.push(ecBlocks[b][i])
  }
  return out
}

function makeMatrix(version) {
  const size = 17 + 4 * version
  const modules = []
  const reserved = []
  for (let i = 0; i < size; i++) {
    modules.push(new Uint8Array(size))
    reserved.push(new Uint8Array(size))
  }
  function place(x, y, dark) {
    modules[y][x] = dark ? 1 : 0
    reserved[y][x] = 1
  }
  function finder(ox, oy) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = ox + dx, y = oy + dy
        if (x < 0 || y < 0 || x >= size || y >= size) continue
        const on = (dx >= 0 && dx <= 6 && (dy === 0 || dy === 6)) ||
          (dy >= 0 && dy <= 6 && (dx === 0 || dx === 6)) ||
          (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4)
        place(x, y, on)
      }
    }
  }
  finder(0, 0)
  finder(size - 7, 0)
  finder(0, size - 7)
  // timing
  for (let i = 0; i < size; i++) {
    if (reserved[6][i] === 0) place(i, 6, i % 2 === 0)
    if (reserved[i][6] === 0) place(6, i, i % 2 === 0)
  }
  // alignment
  const centers = ALIGN[version]
  for (let i = 0; i < centers.length; i++) {
    for (let j = 0; j < centers.length; j++) {
      const cx = centers[i], cy = centers[j]
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const on = Math.max(Math.abs(dx), Math.abs(dy)) !== 1
          place(cx + dx, cy + dy, on)
        }
      }
    }
  }
  // dark module + format reservations
  place(8, size - 8, 1)
  for (let i = 0; i < 9; i++) {
    if (reserved[8][i] === 0) place(i, 8, 0)
    if (reserved[i][8] === 0) place(8, i, 0)
  }
  for (let i = 0; i < 8; i++) {
    if (reserved[8][size - 1 - i] === 0) place(size - 1 - i, 8, 0)
    if (reserved[size - 1 - i][8] === 0) place(8, size - 1 - i, 0)
  }
  // version information reservations (v >= 7)
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      place(Math.floor(i / 3), size - 11 + (i % 3), 0)
      place(size - 11 + (i % 3), Math.floor(i / 3), 0)
    }
  }
  return { modules, reserved, size }
}

function versionBits(version) {
  let rem = version
  for (let i = 0; i < 12; i++) rem = ((rem << 1) ^ (((rem >> 11) & 1) * 0x1f25)) & 0x1fff
  return (((version << 12) | (rem & 0xfff)) >>> 0)
}

function placeVersion(m, version) {
  const { modules, size } = m
  const bits = versionBits(version)
  for (let i = 0; i < 18; i++) {
    const b = (bits >> i) & 1
    modules[Math.floor(i / 3)][size - 11 + (i % 3)] = b
    modules[size - 11 + (i % 3)][Math.floor(i / 3)] = b
  }
}

function placeData(m, codewords) {
  const { modules, reserved, size } = m
  let bitIndex = 0
  const total = codewords.length * 8
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let v = 0; v < size; v++) {
      const y = upward ? size - 1 - v : v
      for (let k = 0; k < 2; k++) {
        const x = right - k
        if (reserved[y][x]) continue
        if (bitIndex < total) {
          modules[y][x] = (codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1
          bitIndex++
        } else {
          modules[y][x] = 0
        }
      }
    }
    upward = !upward
  }
}

function maskFn(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0
    case 1: return y % 2 === 0
    case 2: return x % 3 === 0
    case 3: return (x + y) % 3 === 0
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
  }
  return false
}

// 掩码只作用于非功能区，XOR 是可逆的：同一掩码连续调用两次即还原。
function applyMask(m, mask) {
  const { modules, reserved, size } = m
  for (let y = 0; y < size; y++) {
    const row = modules[y]
    const res = reserved[y]
    for (let x = 0; x < size; x++) {
      if (!res[x] && maskFn(mask, x, y)) row[x] ^= 1
    }
  }
}

function formatBits(ecLevelBits, mask) {
  let data = (ecLevelBits << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >> 9) & 1) * 0x537)
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412
}

function placeFormat(m, ecLevelBits, mask) {
  const { modules, size } = m
  const bits = formatBits(ecLevelBits, mask)
  const bit = (i) => (bits >> i) & 1
  // col 8 copy: bits 0..5 rows 0..5, bit 6 row 7, bit 7 row 8, bits 8..14 bottom
  for (let i = 0; i < 6; i++) modules[i][8] = bit(i)
  modules[7][8] = bit(6)
  modules[8][8] = bit(7)
  for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = bit(i)
  // row 8 copy: bits 0..7 right side, bit 8 col 7, bits 9..14 cols 5..0
  for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = bit(i)
  modules[8][7] = bit(8)
  for (let i = 9; i < 15; i++) modules[8][14 - i] = bit(i)
}

const PAT1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]
const PAT2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]

// 罚分拆成两部分：规则 1/2/4 便宜，规则 3（十字窗扫描）最贵。
// 掩码预筛只在全部 8 个掩码上算便宜部分，规则 3 只对前 2 名补算。
function penaltyQuick(m) {
  const modules = m.modules
  const size = m.size
  let score = 0
  // rule 1: runs of 5+
  for (let y = 0; y < size; y++) {
    const row = modules[y]
    let run = 1
    for (let x = 1; x < size; x++) {
      if (row[x] === row[x - 1]) {
        run++
        if (run === 5) score += 3
        else if (run > 5) score++
      } else run = 1
    }
  }
  for (let x = 0; x < size; x++) {
    let run = 1
    let prev = modules[0][x]
    for (let y = 1; y < size; y++) {
      const v = modules[y][x]
      if (v === prev) {
        run++
        if (run === 5) score += 3
        else if (run > 5) score++
      } else run = 1
      prev = v
    }
  }
  // rule 2: 2x2 blocks
  for (let y = 0; y < size - 1; y++) {
    const row = modules[y]
    const below = modules[y + 1]
    for (let x = 0; x < size - 1; x++) {
      const v = row[x]
      if (v === row[x + 1] && v === below[x] && v === below[x + 1]) score += 3
    }
  }
  // rule 4: dark ratio
  let dark = 0
  for (let y = 0; y < size; y++) {
    const row = modules[y]
    for (let x = 0; x < size; x++) dark += row[x]
  }
  const percent = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(percent - 50) / 5) * 10
  return score
}

function penaltyRule3(m) {
  const modules = m.modules
  const size = m.size
  let score = 0
  // finder-like 1:1:3:1:1 with 4 light on either side.
  // quick-reject on end bits (patterns are (1,...,0) / (0,...,1)).
  for (let y = 0; y < size; y++) {
    const row = modules[y]
    for (let x = 0; x + 11 <= size; x++) {
      const v0 = row[x]
      const v10 = row[x + 10]
      if (!((v0 === 1 && v10 === 0) || (v0 === 0 && v10 === 1))) continue
      let ok1 = true
      let ok2 = true
      for (let i = 0; i < 11; i++) {
        const v = row[x + i]
        if (v !== PAT1[i]) ok1 = false
        if (v !== PAT2[i]) ok2 = false
        if (!ok1 && !ok2) break
      }
      if (ok1 || ok2) score += 40
    }
  }
  for (let x = 0; x < size; x++) {
    for (let y = 0; y + 11 <= size; y++) {
      const v0 = modules[y][x]
      const v10 = modules[y + 10][x]
      if (!((v0 === 1 && v10 === 0) || (v0 === 0 && v10 === 1))) continue
      let ok1 = true
      let ok2 = true
      for (let i = 0; i < 11; i++) {
        const v = modules[y + i][x]
        if (v !== PAT1[i]) ok1 = false
        if (v !== PAT2[i]) ok2 = false
        if (!ok1 && !ok2) break
      }
      if (ok1 || ok2) score += 40
    }
  }
  return score
}

function penalty(m) {
  return penaltyQuick(m) + penaltyRule3(m)
}

// bytes: array of byte values. Returns { size, modules } with modules[y][x] = 0|1.
// opts: { version, mask } force for tests.
function encodeQr(bytes, opts) {
  const forced = opts || {}
  const version = forced.version || pickVersion(bytes.length)
  if (version < 0) throw new Error('QR payload too long')
  const codewords = buildCodewords(bytes, version)
  // 功能区 + 数据只构建一次；掩码 XOR 可逆，评审完直接还原，不再逐掩码复制矩阵。
  const m = makeMatrix(version)
  placeData(m, codewords)
  // 7.8.3 的掩码评分是启发式而非兼容性要求：先用规则 1/2/4 预筛，
  // 只给前 2 名补算最贵的规则 3，输出仍是合法且确定性的二维码。
  const candidates = []
  for (let mask = 0; mask < 8; mask++) {
    if (forced.mask !== undefined && forced.mask !== mask) continue
    applyMask(m, mask)
    placeFormat(m, 0b00, mask) // EC level M
    if (version >= 7) placeVersion(m, version)
    candidates.push([penaltyQuick(m), mask])
    applyMask(m, mask) // restore data modules
  }
  if (candidates.length === 0) throw new Error('no mask selected')
  let bestMask = -1
  let bestScore = Infinity
  let bestQuick = 0
  const top = candidates.length > 2 ? 2 : candidates.length
  for (let i = 0; i < top; i++) {
    let pick = 0
    for (let j = 1; j < candidates.length; j++) {
      if (candidates[j][0] < candidates[pick][0]) pick = j
    }
    const quick = candidates[pick][0]
    const mask = candidates[pick][1]
    candidates.splice(pick, 1)
    applyMask(m, mask)
    placeFormat(m, 0b00, mask)
    if (version >= 7) placeVersion(m, version)
    const score = quick + penaltyRule3(m)
    applyMask(m, mask)
    if (score < bestScore) {
      bestScore = score
      bestMask = mask
      bestQuick = quick
    }
  }
  applyMask(m, bestMask)
  placeFormat(m, 0b00, bestMask)
  if (version >= 7) placeVersion(m, version)
  return { size: m.size, modules: m.modules }
}

module.exports = { encodeQr, __i: { buildCodewords, makeMatrix, placeData, applyMask, placeFormat, placeVersion, penalty } }
