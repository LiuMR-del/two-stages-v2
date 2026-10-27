import sharp from 'sharp'
import { ratioValue } from './whiteShape'
import { readSize } from './process'

/**
 * 竞品图里商品印刷面的区域：第①步的模型给出四个角，这里在本地校正、按透视拉正。
 * 拉正后的印刷面再交给生图模型清理，模型就不用自己判断哪些是印的、哪些是产品实体。
 */

export type Pt = [number, number]
/** 左上、右上、右下、左下（图像坐标，顺时针） */
export type Quad = [Pt, Pt, Pt, Pt]

/** 往外找真实边缘的范围（占短边） */
const SEARCH_OUT = 0.035
/** 校正后再往外多留的余量（占短边）：宁可带一丝背景交给生图模型去掉，也不切掉图案 */
const MARGIN = 0.004
const STEP_K = 3
/** 一个采样点上颜色变化最大值低于这个就当作没有边缘 */
const MIN_EDGE = 40
/** 「强边缘」：不低于这个点最大变化的这么多 */
const STRONG = 0.6
const SAMPLES = 40
/** 半条边上至少这么多个点找到边缘，才按找到的挪 */
const MIN_HITS = 4
/** 拉正后的长边上限 */
const MAX_EDGE = 2048
/** 定位时先缩到这么大，角点是比例坐标，和缩放无关 */
const LOCATE_EDGE = 3000
/** 印刷面至少占整张图这么大 */
const MIN_AREA = 0.05
/** 量出的印刷面宽高比和款式比例差这么多倍以上（方向反了、框错了），不拉正，按整张图提取 */
export const ORIENT_TOLERANCE = 1.4

const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

function area(q: Pt[]): number {
  let s = 0
  for (let i = 0; i < q.length; i++) {
    const a = q[i]!
    const b = q[(i + 1) % q.length]!
    s += a[0] * b[1] - b[0] * a[1]
  }
  return Math.abs(s) / 2
}

/**
 * 模型给的四个角：数值合法、是凸四边形、面积够大才用。
 * 给成像素坐标时按它看到的那张图（seen）换算；不管模型按什么顺序给，都整理成左上起顺时针，
 * 否则拉正出来的图会镜像或转 90 度，而验收对照的也是这张错图，拦不住。
 */
export function validQuad(raw: unknown, seen?: { width: number; height: number }): Quad | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null
  let q = raw.map((p) => (Array.isArray(p) && p.length === 2 ? [Number(p[0]), Number(p[1])] : null)) as (Pt | null)[]
  if (q.some((p) => !p || !p.every((v) => Number.isFinite(v)))) return null
  if (seen && q.some((p) => Math.max(...p!) > 1.5)) q = q.map((p) => [p![0] / seen.width, p![1] / seen.height])
  if (q.some((p) => !p!.every((v) => v >= -0.02 && v <= 1.02))) return null
  const pts = q.map((p) => [Math.min(1, Math.max(0, p![0])), Math.min(1, Math.max(0, p![1]))] as Pt)
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4
  const cy = pts.reduce((s, p) => s + p[1], 0) / 4
  // 图像坐标里 y 朝下，按 atan2 从小到大排就是顺时针；再从 x+y 最小的那个（左上）开始
  pts.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx))
  let start = 0
  for (let i = 1; i < 4; i++) if (pts[i]![0] + pts[i]![1] < pts[start]![0] + pts[start]![1]) start = i
  const quad = [0, 1, 2, 3].map((i) => pts[(start + i) % 4]!) as Quad
  for (let i = 0; i < 4; i++) if (cross(quad[i]!, quad[(i + 1) % 4]!, quad[(i + 2) % 4]!) <= 0) return null
  if (area(quad) < MIN_AREA) return null
  return quad
}

function intersect(p1: Pt, d1: Pt, p2: Pt, d2: Pt): Pt {
  const den = d1[0] * d2[1] - d1[1] * d2[0]
  const t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / den
  return [p1[0] + t * d1[0], p1[1] + t * d1[1]]
}

type Raw = { data: Buffer; width: number; height: number }

/** 解码成 RGB；maxEdge 给了就先等比缩小，避免大图全尺寸解码占几百 MB 内存 */
async function raw(buf: Buffer, maxEdge?: number): Promise<Raw> {
  let s = sharp(buf).rotate().flatten({ background: '#ffffff' })
  if (maxEdge) s = s.resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
  const { data, info } = await s.removeAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

/** off = a + b·t 的最小二乘拟合；先按中位数剔除离群点（边上的装饰、阴影），点太少返回 null */
function fitLine(hits: { t: number; off: number }[]): { a: number; b: number } | null {
  if (hits.length < MIN_HITS * 2) return null
  const lsq = (pts: { t: number; off: number }[]) => {
    const n = pts.length
    const mt = pts.reduce((s, p) => s + p.t, 0) / n
    const mo = pts.reduce((s, p) => s + p.off, 0) / n
    const vt = pts.reduce((s, p) => s + (p.t - mt) ** 2, 0)
    const b = vt > 0 ? pts.reduce((s, p) => s + (p.t - mt) * (p.off - mo), 0) / vt : 0
    return { a: mo - b * mt, b }
  }
  let f = lsq(hits)
  const res = hits.map((h) => Math.abs(h.off - (f.a + f.b * h.t)))
  const cut = Math.max(2, median(res) * 3)
  const kept = hits.filter((_, i) => res[i]! <= cut)
  if (kept.length >= MIN_HITS * 2) f = lsq(kept)
  return f
}

/**
 * 每条边往外找最外面的强边缘（印刷面和背景的分界），再多留一点余量。只往外挪、不往里缩：
 * 两个方向都找时会吸到边框内侧的线上（实测 Gingerbread 底边的锈边被切掉一窄条）。
 * 每条边用采样点拟合真实边缘的直线，两头各按拟合结果往外补，模型给的边是斜的（一头准、一头往里缩）也能补回来。
 * 返回像素坐标；moved 是每条边找到的外移（不含余量），取两头较大的那个。
 */
export function refineQuad(img: Raw, norm: Quad): { quad: Quad; moved: number[] } {
  const { data, width: W, height: H } = img
  const at = (x: number, y: number, c: number) => data[(Math.min(H - 1, Math.max(0, Math.round(y))) * W + Math.min(W - 1, Math.max(0, Math.round(x)))) * 3 + c]!
  const q = norm.map(([x, y]) => [x * W, y * H] as Pt) as Quad
  const m = Math.min(W, H)
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4
  const cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4
  const hi = Math.round(m * SEARCH_OUT)
  const margin = Math.round(m * MARGIN)
  const lines: { p: Pt; d: Pt }[] = []
  const moved: number[] = []
  for (let s = 0; s < 4; s++) {
    const a = q[s]!
    const b = q[(s + 1) % 4]!
    const d: Pt = [b[0] - a[0], b[1] - a[1]]
    const len = Math.hypot(d[0], d[1])
    let n: Pt = [-d[1] / len, d[0] / len]
    if (((a[0] + b[0]) / 2 - cx) * n[0] + ((a[1] + b[1]) / 2 - cy) * n[1] < 0) n = [-n[0], -n[1]]
    const hits: { t: number; off: number }[] = []
    for (let i = 1; i < SAMPLES; i++) {
      // 避开两头的圆角
      const t = 0.1 + 0.8 * (i / SAMPLES)
      const px = a[0] + d[0] * t
      const py = a[1] + d[1] * t
      const prof: [number, number, number][] = []
      for (let o = -STEP_K; o <= hi + STEP_K; o++) {
        const x = px + n[0] * o
        const y = py + n[1] * o
        prof.push([at(x, y, 0), at(x, y, 1), at(x, y, 2)])
      }
      const str: number[] = []
      for (let j = STEP_K; j < prof.length - STEP_K; j++) {
        let dr = 0
        let dg = 0
        let db = 0
        for (let k = 1; k <= STEP_K; k++) {
          dr += prof[j - k]![0] - prof[j + k]![0]
          dg += prof[j - k]![1] - prof[j + k]![1]
          db += prof[j - k]![2] - prof[j + k]![2]
        }
        str.push(Math.hypot(dr, dg, db) / STEP_K)
      }
      const max = Math.max(...str)
      if (max < MIN_EDGE) continue
      for (let j = str.length - 1; j >= 0; j--) {
        if (str[j]! >= STRONG * max) {
          hits.push({ t, off: j })
          break
        }
      }
    }
    const fit = fitLine(hits)
    const offA = fit ? Math.max(0, fit.a) : 0
    const offB = fit ? Math.max(0, fit.a + fit.b) : 0
    moved.push(Math.round(Math.max(offA, offB)))
    // 两头各自外移，过两点的直线就是这条边
    const pa: Pt = [a[0] + n[0] * (offA + margin), a[1] + n[1] * (offA + margin)]
    const pb: Pt = [b[0] + n[0] * (offB + margin), b[1] + n[1] * (offB + margin)]
    lines.push({ p: pa, d: [pb[0] - pa[0], pb[1] - pa[1]] })
  }
  const quad = [0, 1, 2, 3].map((s) => intersect(lines[(s + 3) % 4]!.p, lines[(s + 3) % 4]!.d, lines[s]!.p, lines[s]!.d)) as Quad
  return { quad, moved }
}

/** 单位正方形 → 四边形的透视映射 */
function squareToQuad(q: Quad): (u: number, v: number) => Pt {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q
  const dx1 = x1 - x2
  const dx2 = x3 - x2
  const dy1 = y1 - y2
  const dy2 = y3 - y2
  const sx = x0 - x1 + x2 - x3
  const sy = y0 - y1 + y2 - y3
  const den = dx1 * dy2 - dx2 * dy1
  const g = (sx * dy2 - dx2 * sy) / den
  const h = (dx1 * sy - sx * dy1) / den
  return (u, v) => {
    const w = g * u + h * v + 1
    return [((x1 - x0 + g * x1) * u + (x3 - x0 + h * x3) * v + x0) / w, ((y1 - y0 + g * y1) * u + (y3 - y0 + h * y3) * v + y0) / w]
  }
}

function rectify(img: Raw, quad: Quad, W: number, H: number): Buffer {
  const { data, width, height } = img
  const f = squareToQuad(quad)
  const out = Buffer.alloc(W * H * 3)
  const px = (x: number, y: number, c: number) => data[(Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))) * 3 + c]!
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [sx, sy] = f((x + 0.5) / W, (y + 0.5) / H)
      const x0 = Math.floor(sx - 0.5)
      const y0 = Math.floor(sy - 0.5)
      const fx = sx - 0.5 - x0
      const fy = sy - 0.5 - y0
      for (let c = 0; c < 3; c++) {
        out[(y * W + x) * 3 + c] = Math.round(
          px(x0, y0, c) * (1 - fx) * (1 - fy) + px(x0 + 1, y0, c) * fx * (1 - fy) + px(x0, y0 + 1, c) * (1 - fx) * fy + px(x0 + 1, y0 + 1, c) * fx * fy,
        )
      }
    }
  }
  return out
}

export type Face = {
  /** 模型给的四个角，0～1 比例 */
  ai: Quad
  /** 本地校正后的四个角，0～1 比例 */
  corners: Quad
  /** 四条边各找到往外多少像素（原图像素，不含固定余量；上右下左） */
  moved: number[]
  /** 印刷面在原图里大约多大（像素） */
  size: { width: number; height: number }
}

const len = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1])

/** 校正四个角，算出印刷面在原图里的大小 */
export async function locateFace(source: Buffer, ai: Quad): Promise<Face> {
  const { width: fullW } = await readSize(source)
  const img = await raw(source, LOCATE_EDGE)
  const scale = fullW / img.width
  const { quad, moved } = refineQuad(img, ai)
  const corners = quad.map(([x, y]) => [Math.min(1, Math.max(0, x / img.width)), Math.min(1, Math.max(0, y / img.height))] as Pt) as Quad
  const px = corners.map(([x, y]) => [x * img.width * scale, y * img.height * scale] as Pt)
  return {
    ai,
    corners,
    moved: moved.map((v) => Math.round(v * scale)),
    size: { width: Math.round((len(px[0]!, px[1]!) + len(px[3]!, px[2]!)) / 2), height: Math.round((len(px[0]!, px[3]!) + len(px[1]!, px[2]!)) / 2) },
  }
}

/**
 * 按款式比例拉正成 PNG；长边取印刷面在原图里的长边（不超过 2048），不凭空放大。
 * 量出来的宽高比和款式比例差太多（方向反了、框错了）就返回 null，由调用方按整张图提取。
 */
export async function flattenFace(source: Buffer, face: Pick<Face, 'size'> & { corners: Pt[] }, ratio: string): Promise<{ buffer: Buffer } | { buffer: null; reason: string }> {
  const r = ratioValue(ratio)
  const measured = face.size.width / Math.max(1, face.size.height)
  const k = measured / r
  if (k > ORIENT_TOLERANCE || k < 1 / ORIENT_TOLERANCE) {
    return { buffer: null, reason: `印刷面量出来宽高比 ${measured.toFixed(2)}，和款式比例 ${ratio} 差太多` }
  }
  const long = Math.min(MAX_EDGE, Math.max(face.size.width, face.size.height, 64))
  const W = r >= 1 ? long : Math.round(long * r)
  const H = r >= 1 ? Math.round(long / r) : long
  // 先缩到印刷面长边不超过 2048 再解码
  const full = await readSize(source)
  const fullLong = Math.max(full.width, full.height)
  const faceLong = Math.max(face.size.width, face.size.height, 1)
  const img = await raw(source, Math.round(fullLong * Math.min(1, MAX_EDGE / faceLong)))
  const quad = face.corners.map(([x, y]) => [x * img.width, y * img.height]) as Quad
  return { buffer: await sharp(rectify(img, quad, W, H), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer() }
}
