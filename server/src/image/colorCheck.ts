import sharp from 'sharp'
import { readSize } from './process'

/**
 * 素材图和竞品图印刷面的色差（本地计算，不花额度）。
 * 印刷面的位置由验收请求里的模型顺便给出；两边各往里收一点，避开边框和背景，
 * 缩成同样大小后在 Lab 空间比：整体平均色（色偏）和 3×3 分块的平均色（局部颜色）。只拦不改。
 */

/** 两边都往里收这么多，避开产品边缘、背景和素材图四边 */
const INSET = 0.06
const GRID = 3
const SAMPLE_W = 96
/** 方向描述：差多少才算「偏」 */
const LEAN = 3
/** 分块比较受印刷面位置误差影响大（实测框偏 2% 分块色差就到 5），阈值放宽到整体的这么多倍 */
export const GRID_FACTOR = 2

export type ColorResult = {
  checked: boolean
  /** 整体平均色的色差 ΔE（CIE76） */
  deltaE: number | null
  /** 3×3 分块色差的中位数 */
  gridDeltaE: number | null
  /** 素材图 - 竞品图：亮度、红绿、黄蓝、鲜艳度 */
  shift: { L: number; a: number; b: number; C: number } | null
  box: [number, number, number, number] | null
  issues: string[]
  note: string | null
}

type Lab = [number, number, number]

function srgbToLinear(v: number): number {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)

export function rgbToLab(r: number, g: number, b: number): Lab {
  const R = srgbToLinear(r)
  const G = srgbToLinear(g)
  const B = srgbToLinear(b)
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047
  const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883
  const fy = f(Y)
  return [116 * fy - 16, 500 * (f(X) - fy), 200 * (fy - f(Z))]
}

const dE = (p: Lab, q: Lab) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
const round1 = (v: number) => Math.round(v * 10) / 10

async function sample(buf: Buffer, rect: { left: number; top: number; width: number; height: number }, w: number, h: number): Promise<Lab[]> {
  const d = await sharp(buf).rotate().flatten({ background: '#ffffff' }).extract(rect).resize(w, h, { fit: 'fill' }).removeAlpha().raw().toBuffer()
  const out: Lab[] = []
  for (let i = 0; i < w * h; i++) out.push(rgbToLab(d[i * 3]!, d[i * 3 + 1]!, d[i * 3 + 2]!))
  return out
}

function mean(px: Lab[], w: number, x0 = 0, y0 = 0, x1 = w, y1 = px.length / w): Lab {
  const m: Lab = [0, 0, 0]
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = px[y * w + x]!
      m[0] += p[0]
      m[1] += p[1]
      m[2] += p[2]
      n++
    }
  }
  return [m[0] / n, m[1] / n, m[2] / n]
}

function inset(x: number, y: number, w: number, h: number) {
  const dx = w * INSET
  const dy = h * INSET
  return { left: Math.round(x + dx), top: Math.round(y + dy), width: Math.max(1, Math.round(w - 2 * dx)), height: Math.max(1, Math.round(h - 2 * dy)) }
}

/** 模型给的框是 0～1 的比例；给成了像素就按它看到的那张缩小图的尺寸换算 */
export function normalizeBox(box: number[] | null | undefined, seen: { width: number; height: number }): [number, number, number, number] | null {
  if (!box || box.length !== 4 || box.some((v) => !Number.isFinite(v))) return null
  let [x0, y0, x1, y1] = box as [number, number, number, number]
  if (Math.max(x0, y0, x1, y1) > 1.5) {
    x0 /= seen.width
    x1 /= seen.width
    y0 /= seen.height
    y1 /= seen.height
  }
  const c = (v: number) => Math.min(1, Math.max(0, v))
  ;[x0, y0, x1, y1] = [c(x0), c(y0), c(x1), c(y1)]
  if (x1 - x0 < 0.15 || y1 - y0 < 0.15) return null
  return [x0, y0, x1, y1]
}

function describe(s: { L: number; a: number; b: number; C: number }): string {
  const parts: string[] = []
  if (s.b >= LEAN) parts.push('偏黄')
  else if (s.b <= -LEAN) parts.push('偏蓝')
  if (s.a >= LEAN) parts.push('偏红')
  else if (s.a <= -LEAN) parts.push('偏绿')
  if (s.L >= LEAN) parts.push('偏亮')
  else if (s.L <= -LEAN) parts.push('偏暗')
  if (s.C >= LEAN) parts.push('偏艳')
  else if (s.C <= -LEAN) parts.push('偏灰')
  return parts.join('、')
}

export async function compareColors(source: Buffer, pattern: Buffer, box: [number, number, number, number] | null, threshold: number): Promise<ColorResult> {
  if (!box) return { checked: false, deltaE: null, gridDeltaE: null, shift: null, box: null, issues: [], note: '模型没给出竞品图印刷面的位置，这次没检查颜色' }
  const { width: SW, height: SH } = await readSize(source)
  const { width: PW, height: PH } = await readSize(pattern)
  const [x0, y0, x1, y1] = box
  const srcRect = inset(x0 * SW, y0 * SH, (x1 - x0) * SW, (y1 - y0) * SH)
  const patRect = inset(0, 0, PW, PH)
  const w = SAMPLE_W
  const h = Math.max(GRID, Math.round((SAMPLE_W * PH) / PW))
  const a = await sample(source, srcRect, w, h)
  const b = await sample(pattern, patRect, w, h)

  const ma = mean(a, w)
  const mb = mean(b, w)
  const chroma = (p: Lab) => Math.hypot(p[1], p[2])
  const shift = { L: round1(mb[0] - ma[0]), a: round1(mb[1] - ma[1]), b: round1(mb[2] - ma[2]), C: round1(chroma(mb) - chroma(ma)) }
  const deltaE = round1(dE(ma, mb))
  const cells: number[] = []
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const cx0 = Math.floor((gx * w) / GRID)
      const cx1 = Math.floor(((gx + 1) * w) / GRID)
      const cy0 = Math.floor((gy * h) / GRID)
      const cy1 = Math.floor(((gy + 1) * h) / GRID)
      cells.push(dE(mean(a, w, cx0, cy0, cx1, cy1), mean(b, w, cx0, cy0, cx1, cy1)))
    }
  }
  cells.sort((p, q) => p - q)
  const gridDeltaE = round1(cells[Math.floor(cells.length / 2)]!)

  const issues: string[] = []
  const lean = describe(shift)
  if (deltaE > threshold) issues.push(`颜色偏了：整体${lean || '有色差'}（ΔE ${deltaE}，超过 ${threshold}）`)
  else if (gridDeltaE > threshold * GRID_FACTOR)
    issues.push(`颜色偏了：局部颜色和竞品图对不上（分块色差中位数 ΔE ${gridDeltaE}，超过 ${threshold * GRID_FACTOR}${lean ? `；整体${lean}` : ''}）`)
  return { checked: true, deltaE, gridDeltaE, shift, box, issues, note: null }
}
