// Ring face renderer for the circle watch: RGB edge-glow timeline ring -> RGB PNG.
// 色相沿环角度渐变（流光），状态用亮度区分：走过暗、未走亮、有课最亮；环外沿屏幕边缘有辉光。
'use strict'

const pngmod = require('./png.js')

// 整体透明度：环所有颜色亮度 ×0.8（透明度 +20%）
const OP = 0.8

// h,s,v: 0..1 -> 直接写入 pixels[px..px+2]（热循环零分配，QuickJS 堆小）
function hsvPut(pixels, px, h, s, v) {
  v = v * OP
  h = h - Math.floor(h)
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)
  let r, g, b
  if (i === 0) { r = v; g = t; b = p } else if (i === 1) { r = q; g = v; b = p }
  else if (i === 2) { r = p; g = v; b = t } else if (i === 3) { r = p; g = q; b = v }
  else if (i === 4) { r = t; g = p; b = v } else { r = v; g = p; b = q }
  pixels[px] = (r * 255) | 0
  pixels[px + 1] = (g * 255) | 0
  pixels[px + 2] = (b * 255) | 0
}

// size: 方形边长（渲染尺寸，显示时铺满 466 屏）
// opts.now: 0..1 当前时刻（0=顶部，顺时针）
// opts.arcs: [{ from, to, level: 0|1|2, hue: 0..1 }] 课程时段
//   level 0=已过(暗) 1=未到(亮) 2=进行中(满亮+辉光)
//   hue 按课名哈希，同一门课永远同色
// opts.ticks: [{ frac, strong }] 整点刻度
function ringPng(size, opts) {
  const r = Math.floor(size * 0.45)
  const t = Math.max(6, Math.round(size * 0.024)) // 底环
  const tCls = Math.round(t * 1.6) // 课程弧
  const glow = Math.round(size * 0.05) // 辉光厚度
  const cx = size / 2
  const cy = size / 2
  const rOuter = r + t / 2
  const rInner = r - t / 2
  const clsOuter = r + tCls / 2
  const clsInner = r - tCls / 2
  const glowOuter = clsOuter + glow
  const tickLen = Math.max(6, Math.round(size * 0.028))
  const tickW = Math.max(3, Math.round(size * 0.011))
  const arcs = (opts && opts.arcs) || []
  const ticks = (opts && opts.ticks) || []
  const hasNow = opts && typeof opts.now === 'number' && opts.now >= 0 && opts.now <= 1
  const nowF = hasNow ? opts.now : -1
  const nowW = Math.max(4, Math.round(size * 0.013))
  const handTip = glowOuter + 2
  const pixels = new Uint8Array(size * size * 3) // 黑底
  const twoPi = Math.PI * 2
  const tickR0 = rInner - tickLen
  const x0 = Math.max(0, Math.floor(cx - handTip))
  const x1 = Math.min(size, Math.ceil(cx + handTip))
  const y0 = Math.max(0, Math.floor(cy - handTip))
  const y1 = Math.min(size, Math.ceil(cy + handTip))
  for (let y = y0; y < y1; y++) {
    const dy = y - cy
    for (let x = x0; x < x1; x++) {
      const dx = x - cx
      const d2 = dx * dx + dy * dy
      if (d2 > handTip * handTip || d2 < tickR0 * tickR0) continue
      let ang = Math.atan2(dx, -dy)
      if (ang < 0) ang += twoPi
      const f = ang / twoPi
      const px = (y * size + x) * 3
      const d = Math.sqrt(d2)
      // 白指针最上层
      if (hasNow) {
        let df = Math.abs(f - nowF)
        if (df > 0.5) df = 1 - df
        const half = nowW / 2 / rOuter / twoPi
        if (df <= half) {
          const g = (255 * OP) | 0
          pixels[px] = g
          pixels[px + 1] = g
          pixels[px + 2] = g
          continue
        }
      }
      // 课程归属
      let arc = null
      for (let i = 0; i < arcs.length; i++) {
        if (f >= arcs[i].from && f <= arcs[i].to) {
          arc = arcs[i]
          break
        }
      }
      const hue = arc ? arc.hue : 0
      // 课程弧
      if (arc && d >= clsInner && d <= clsOuter) {
        if (arc.level === 2) {
          hsvPut(pixels, px, hue, 0.75, 1) // 进行中：满亮
        } else if (arc.level === 1) {
          hsvPut(pixels, px, hue, 0.85, 0.92) // 未到：亮
        } else {
          hsvPut(pixels, px, hue, 0.55, 0.35) // 已过：暗
        }
        continue
      }
      // 底环：中性时间轴（走过暗灰/未走中灰），不抢课程色
      if (!arc && d >= rInner && d <= rOuter) {
        const past = nowF >= 0 && f <= nowF
        const g = ((past ? 40 : 72) * OP) | 0
        pixels[px] = g
        pixels[px + 1] = g
        pixels[px + 2] = g
        continue
      }
      // 辉光：课程色向外沿衰减（进行中最亮）
      if (d > clsOuter && d <= glowOuter) {
        const k = 1 - (d - clsOuter) / glow
        const v = (arc ? (arc.level === 2 ? 0.95 : 0.28) : 0) * k * k
        if (v > 0.01) {
          hsvPut(pixels, px, hue, 0.85, v)
        }
        continue
      }
      // 整点刻度
      if (!arc && d < rInner) {
        for (let i = 0; i < ticks.length; i++) {
          const tk = ticks[i]
          let df = Math.abs(f - tk.frac)
          if (df > 0.5) df = 1 - df
          const half = tickW / 2 / ((rInner + tickR0) / 2) / twoPi
          if (df <= half) {
            const g = ((tk.strong ? 200 : 110) * OP) | 0
            pixels[px] = g
            pixels[px + 1] = g
            pixels[px + 2] = g
            break
          }
        }
      }
    }
  }
  return pngmod.encodeRgbPng(size, size, pixels)
}

module.exports = { ringPng }
