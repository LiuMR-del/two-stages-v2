import sharp from 'sharp'
import { ratioDiff, ratioValue } from './whiteShape'

/**
 * 素材图版面验收（本地判定，不花额度）：四边留白、圆角、宽高比。
 * 边框不在这里判：印在面上的边框、做旧边属于图案，和产品的金属边从像素上分不出来，交给验收模型对照竞品图判断。
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
const MAX_CHECKED_RATIO = 2.5

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
  }

  const target = ratioValue(productRatio)
  let ratioChecked = false
  let note: string | null = null
  // 2026-10-29 起提取按款式精确比例传尺寸，比例都能查；太细长的（超过 1:2.5）模型未必画得出，不查
  if (Math.max(target, 1 / target) <= MAX_CHECKED_RATIO) {
    ratioChecked = true
    const r = W / H
    if (ratioDiff(r, target) > RATIO_TOLERANCE) issues.push(`宽高比 ${r.toFixed(3)} 和产品比例 ${productRatio} 不一致`)
  } else {
    note = `${productRatio} 太细长，未检查比例`
  }
  return { ok: issues.length === 0, issues, ratioChecked, note }
}
