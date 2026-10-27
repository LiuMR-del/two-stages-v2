import sharp from 'sharp'
import { pickApiSize } from '../prompts/canvas'
import { ratioDiff, ratioValue } from './whiteShape'

/**
 * 素材图版面验收（本地判定，不花额度）：四边留白、圆角、边框、宽高比。
 */

const WORK_EDGE = 1000
const WHITE_MIN = 236
const WHITE_SPREAD = 18
/** 一行（列）里近白像素占这么多就算空白行 */
const BLANK_LINE = 0.98
/** 四边都有这么宽的白边就不合格 */
export const MARGIN_ALL = 0.02
/** 相对的两边都有这么宽的白边也不合格 */
export const MARGIN_PAIR = 0.05
/** 角上这么大的方块里看圆角 */
const CORNER = 0.04
/** 宽高比允许差 */
export const RATIO_TOLERANCE = 0.01
const API_RATIO: Record<string, number> = { '1536x1024': 1.5, '1024x1536': 1024 / 1536, '1024x1024': 1 }

export type LayoutResult = { ok: boolean; issues: string[]; ratioChecked: boolean; note: string | null }

type Img = { d: Buffer; w: number; h: number }

const white = (im: Img, x: number, y: number) => {
  const i = (y * im.w + x) * 3
  const r = im.d[i]!
  const g = im.d[i + 1]!
  const b = im.d[i + 2]!
  const lo = Math.min(r, g, b)
  return lo >= WHITE_MIN && Math.max(r, g, b) - lo <= WHITE_SPREAD
}

function blankRow(im: Img, y: number) {
  let n = 0
  for (let x = 0; x < im.w; x++) if (white(im, x, y)) n++
  return n / im.w >= BLANK_LINE
}

function blankCol(im: Img, x: number) {
  let n = 0
  for (let y = 0; y < im.h; y++) if (white(im, x, y)) n++
  return n / im.h >= BLANK_LINE
}

function margins(im: Img) {
  let top = 0
  while (top < im.h && blankRow(im, top)) top++
  let bottom = 0
  while (bottom < im.h - top && blankRow(im, im.h - 1 - bottom)) bottom++
  let left = 0
  while (left < im.w && blankCol(im, left)) left++
  let right = 0
  while (right < im.w - left && blankCol(im, im.w - 1 - right)) right++
  return { top: top / im.h, bottom: bottom / im.h, left: left / im.w, right: right / im.w, empty: top >= im.h }
}

/** 角上紧贴顶点的小三角是白的，而紧挨着它的两条边上是图案 → 这个角是圆的（或缺角） */
function roundCorners(im: Img): number {
  const k = Math.max(4, Math.round(Math.min(im.w, im.h) * CORNER))
  const corners: [number, number, number, number][] = [
    [0, 0, 1, 1],
    [im.w - 1, 0, -1, 1],
    [0, im.h - 1, 1, -1],
    [im.w - 1, im.h - 1, -1, -1],
  ]
  let n = 0
  for (const [cx, cy, sx, sy] of corners) {
    let tri = 0
    let triWhite = 0
    for (let a = 0; a < k; a++) {
      for (let b = 0; a + b < k * 0.3; b++) {
        tri++
        if (white(im, cx + sx * a, cy + sy * b)) triWhite++
      }
    }
    let edge = 0
    let edgeWhite = 0
    for (let t = k; t < k * 2.5; t++) {
      for (const [x, y] of [
        [cx + sx * t, cy],
        [cx, cy + sy * t],
      ] as const) {
        if (x < 0 || y < 0 || x >= im.w || y >= im.h) continue
        edge++
        if (white(im, x, y)) edgeWhite++
      }
    }
    if (tri && edge && triWhite / tri >= 0.9 && edgeWhite / edge <= 0.4) n++
  }
  return n
}

type Stat = { mean: [number, number, number]; std: number }

function stripStat(im: Img, side: 'top' | 'bottom' | 'left' | 'right', from: number, width: number): Stat {
  const sum = [0, 0, 0]
  const sq = [0, 0, 0]
  let n = 0
  const add = (x: number, y: number) => {
    const i = (y * im.w + x) * 3
    for (let c = 0; c < 3; c++) {
      const v = im.d[i + c]!
      sum[c]! += v
      sq[c]! += v * v
    }
    n++
  }
  for (let t = from; t < from + width; t++) {
    if (side === 'top' || side === 'bottom') {
      const y = side === 'top' ? t : im.h - 1 - t
      for (let x = 0; x < im.w; x++) add(x, y)
    } else {
      const x = side === 'left' ? t : im.w - 1 - t
      for (let y = 0; y < im.h; y++) add(x, y)
    }
  }
  const mean = sum.map((s) => s / n) as [number, number, number]
  const std = Math.max(...sq.map((s, c) => Math.sqrt(Math.max(0, s / n - mean[c]! * mean[c]!))))
  return { mean, std }
}

const dist = (a: [number, number, number], b: [number, number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/** 四边最外一圈颜色均匀、四边一致、和里面一圈明显不同 → 一圈边框（铝板金属边、相框） */
function hasBorder(im: Img): boolean {
  const sides = ['top', 'bottom', 'left', 'right'] as const
  for (const frac of [0.01, 0.025]) {
    const t = Math.max(2, Math.round(Math.min(im.w, im.h) * frac))
    const outer = sides.map((s) => stripStat(im, s, 0, t))
    const inner = sides.map((s) => stripStat(im, s, t, t))
    if (outer.some((o) => o.std > 14)) continue
    if (outer.every((o) => Math.min(...o.mean) >= WHITE_MIN)) continue
    let spread = 0
    for (const a of outer) for (const b of outer) spread = Math.max(spread, dist(a.mean, b.mean))
    if (spread > 24) continue
    const differs = outer.filter((o, i) => dist(o.mean, inner[i]!.mean) > 40).length
    if (differs >= 3) return true
  }
  return false
}

const pct = (v: number) => `${Math.round(v * 100)}%`

export async function checkPatternLayout(buf: Buffer, productRatio: string): Promise<LayoutResult> {
  const meta = await sharp(buf).metadata()
  const W = meta.width!
  const H = meta.height!
  const s = Math.min(1, WORK_EDGE / Math.max(W, H))
  const w = Math.max(8, Math.round(W * s))
  const h = Math.max(8, Math.round(H * s))
  const d = await sharp(buf).rotate().flatten({ background: '#ffffff' }).resize(w, h, { fit: 'fill' }).removeAlpha().raw().toBuffer()
  const im: Img = { d, w, h }
  const issues: string[] = []

  const m = margins(im)
  if (m.empty) {
    issues.push('素材图是一张白图')
  } else {
    const all = [m.top, m.bottom, m.left, m.right]
    if (all.every((v) => v >= MARGIN_ALL)) {
      issues.push(`四边有白边（上 ${pct(m.top)}、下 ${pct(m.bottom)}、左 ${pct(m.left)}、右 ${pct(m.right)}）`)
    } else if (m.left >= MARGIN_PAIR && m.right >= MARGIN_PAIR) {
      issues.push(`左右两边有白边（左 ${pct(m.left)}、右 ${pct(m.right)}）`)
    } else if (m.top >= MARGIN_PAIR && m.bottom >= MARGIN_PAIR) {
      issues.push(`上下两边有白边（上 ${pct(m.top)}、下 ${pct(m.bottom)}）`)
    }
    const rc = roundCorners(im)
    if (rc >= 3) issues.push(`带着产品的圆角（${rc} 个角）`)
    if (hasBorder(im)) issues.push('四周有一圈边框')
  }

  const target = ratioValue(productRatio)
  const canvas = API_RATIO[pickApiSize(target, 1)]!
  let ratioChecked = false
  let note: string | null = null
  if (ratioDiff(canvas, target) <= RATIO_TOLERANCE) {
    ratioChecked = true
    const r = W / H
    if (ratioDiff(r, target) > RATIO_TOLERANCE) issues.push(`宽高比 ${r.toFixed(3)} 和产品比例 ${productRatio} 不一致`)
  } else {
    note = `接口画布不支持 ${productRatio}，未检查比例`
  }
  return { ok: issues.length === 0, issues, ratioChecked, note }
}
