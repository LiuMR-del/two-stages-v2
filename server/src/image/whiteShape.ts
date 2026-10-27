import sharp from 'sharp'
import { pickApiSize, ratioToWH } from '../prompts/canvas'

/**
 * 白底图的本地图形检测和本地合成（贴图方式 B）。
 * 产品轮廓 = 从图片四边往里连着的近白背景之外的部分；轮廓里被包住的近白小块当作安装孔。
 */

/** 背景：最暗的通道也不低于这个值，且接近灰色 */
const BG_MIN = 246
/** 安装孔里的像素比背景稍宽松（孔里常有一点阴影） */
const HOLE_MIN = 236
const GRAY_SPREAD = 14
/** 检测在长边不超过这么多像素的缩小图上做 */
const WORK_EDGE = 2000
/** 轮廓面积 / 外接矩形面积，达到就算正对镜头的矩形（允许圆角） */
export const RECT_FILL_MIN = 0.97
/** 轮廓和外接矩形内切椭圆的重合度，达到就算圆形 */
export const ELLIPSE_IOU_MIN = 0.97
/** 素材图和产品外形比例差这么多以内时等比铺满（居中，裁掉一点） */
export const COVER_TOLERANCE = 0.03
/** 差这么多以内仍可本地合成，素材图非等比拉伸到产品外形（2026-10-27 用户确认：铝板画白底图实测 1.407，款式 3:2） */
export const STRETCH_TOLERANCE = 0.07
/** 安装孔面积占轮廓面积的范围 */
const HOLE_MIN_FRAC = 0.0001
const HOLE_MAX_FRAC = 0.01
/** 除了最大的那块，其余产品像素超过这个比例就说明图里不止一个东西 */
const STRAY_MAX_FRAC = 0.01

export type WhiteShape = {
  /** 能不能本地合成（只看图形，不看比例） */
  ok: boolean
  shape: 'rect' | 'ellipse' | null
  /** 原图像素坐标 */
  bbox: { x: number; y: number; w: number; h: number } | null
  fill: number | null
  holes: number
  reason: string
}

type Mask = { w: number; h: number; scale: number; product: Uint8Array; holes: Uint8Array }

async function loadWork(buf: Buffer): Promise<{ data: Buffer; w: number; h: number; scale: number; fullW: number; fullH: number }> {
  const meta = await sharp(buf).rotate().metadata()
  const oriented = meta.orientation && meta.orientation >= 5
  const fullW = (oriented ? meta.height : meta.width)!
  const fullH = (oriented ? meta.width : meta.height)!
  const scale = Math.min(1, WORK_EDGE / Math.max(fullW, fullH))
  const w = Math.max(1, Math.round(fullW * scale))
  const h = Math.max(1, Math.round(fullH * scale))
  const data = await sharp(buf).rotate().flatten({ background: '#ffffff' }).resize(w, h, { fit: 'fill' }).removeAlpha().raw().toBuffer()
  return { data, w, h, scale: w / fullW, fullW, fullH }
}

const isLight = (d: Buffer, i: number, min: number) => {
  const r = d[i]!
  const g = d[i + 1]!
  const b = d[i + 2]!
  const lo = Math.min(r, g, b)
  return lo >= min && Math.max(r, g, b) - lo <= GRAY_SPREAD
}

/** 4 邻接连通块标记；返回每个块的大小和外接矩形 */
function components(mask: Uint8Array, w: number, h: number) {
  const label = new Int32Array(w * h).fill(-1)
  const queue = new Int32Array(w * h)
  const comps: { size: number; x0: number; y0: number; x1: number; y1: number; touchesEdge: boolean }[] = []
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || label[s] !== -1) continue
    const id = comps.length
    const c = { size: 0, x0: w, y0: h, x1: -1, y1: -1, touchesEdge: false }
    let head = 0
    let tail = 0
    queue[tail++] = s
    label[s] = id
    while (head < tail) {
      const p = queue[head++]!
      const x = p % w
      const y = (p - x) / w
      c.size++
      if (x < c.x0) c.x0 = x
      if (x > c.x1) c.x1 = x
      if (y < c.y0) c.y0 = y
      if (y > c.y1) c.y1 = y
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) c.touchesEdge = true
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]
      for (const q of nb) {
        if (q >= 0 && mask[q] && label[q] === -1) {
          label[q] = id
          queue[tail++] = q
        }
      }
    }
    comps.push(c)
  }
  return { label, comps }
}

function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask
  const out = new Uint8Array(mask)
  const r2 = r * r
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w || dx * dx + dy * dy > r2) continue
          out[yy * w + xx] = 1
        }
      }
    }
  }
  return out
}

async function analyze(buf: Buffer): Promise<{ shape: WhiteShape; mask: Mask | null; fullW: number; fullH: number }> {
  const { data, w, h, scale, fullW, fullH } = await loadWork(buf)
  const n = w * h
  const fail = (reason: string) => ({ shape: { ok: false, shape: null, bbox: null, fill: null, holes: 0, reason }, mask: null, fullW, fullH })

  const light = new Uint8Array(n)
  for (let p = 0; p < n; p++) light[p] = isLight(data, p * 3, BG_MIN) ? 1 : 0
  const { label: lightLabel, comps: lightComps } = components(light, w, h)
  const bg = new Uint8Array(n)
  for (let p = 0; p < n; p++) {
    const l = lightLabel[p]!
    if (l >= 0 && lightComps[l]!.touchesEdge) bg[p] = 1
  }
  const product = new Uint8Array(n)
  for (let p = 0; p < n; p++) product[p] = bg[p] ? 0 : 1

  const { label, comps } = components(product, w, h)
  if (!comps.length) return fail('图里没有找到产品（整张都是白底）')
  let main = 0
  for (let i = 1; i < comps.length; i++) if (comps[i]!.size > comps[main]!.size) main = i
  const m = comps[main]!
  const stray = comps.reduce((s, c, i) => (i === main ? s : s + c.size), 0)
  if (stray > m.size * STRAY_MAX_FRAC) return fail('白底图里不止一个物体（或有文字、阴影）')
  if (m.touchesEdge) return fail('产品贴到了图片边缘，四周没有白底')
  for (let p = 0; p < n; p++) if (label[p] !== main) product[p] = 0

  // 轮廓里的近白小块 = 安装孔
  const inner = new Uint8Array(n)
  for (let p = 0; p < n; p++) inner[p] = product[p] && isLight(data, p * 3, HOLE_MIN) ? 1 : 0
  const { label: hl, comps: hc } = components(inner, w, h)
  const holes = new Uint8Array(n)
  let holeCount = 0
  const keep = hc.map((c) => {
    const bw = c.x1 - c.x0 + 1
    const bh = c.y1 - c.y0 + 1
    const frac = c.size / m.size
    const ok = frac >= HOLE_MIN_FRAC && frac <= HOLE_MAX_FRAC && bw / bh >= 0.5 && bw / bh <= 2 && c.size / (bw * bh) >= 0.5
    if (ok) holeCount++
    return ok
  })
  for (let p = 0; p < n; p++) if (hl[p]! >= 0 && keep[hl[p]!]) holes[p] = 1
  // 孔边上那一圈深色也是孔的一部分
  const holeRadius = Math.sqrt((m.size * HOLE_MAX_FRAC) / Math.PI)
  const ring = Math.max(2, Math.round(Math.min(holeRadius, Math.sqrt(hc.filter((_, i) => keep[i]).reduce((a, c) => Math.max(a, c.size), 0) / Math.PI)) * 0.4))
  const holesWide = holeCount ? dilate(holes, w, h, ring) : holes
  for (let p = 0; p < n; p++) if (!product[p]) holesWide[p] = 0

  const bw = m.x1 - m.x0 + 1
  const bh = m.y1 - m.y0 + 1
  const fill = m.size / (bw * bh)
  const cx = m.x0 + bw / 2
  const cy = m.y0 + bh / 2
  let inter = 0
  let ell = 0
  for (let y = m.y0; y <= m.y1; y++) {
    for (let x = m.x0; x <= m.x1; x++) {
      const dx = (x + 0.5 - cx) / (bw / 2)
      const dy = (y + 0.5 - cy) / (bh / 2)
      const inE = dx * dx + dy * dy <= 1
      if (inE) ell++
      if (inE && product[y * w + x]) inter++
    }
  }
  const iou = inter / (ell + m.size - inter)
  const bbox = { x: Math.round(m.x0 / scale), y: Math.round(m.y0 / scale), w: Math.round(bw / scale), h: Math.round(bh / scale) }
  const mask: Mask = { w, h, scale, product, holes: holesWide }
  const round2 = (v: number) => Math.round(v * 1000) / 1000
  if (fill >= RECT_FILL_MIN) {
    return { shape: { ok: true, shape: 'rect', bbox, fill: round2(fill), holes: holeCount, reason: `正对镜头的矩形，轮廓占外接矩形 ${(fill * 100).toFixed(1)}%` }, mask, fullW, fullH }
  }
  if (iou >= ELLIPSE_IOU_MIN) {
    return { shape: { ok: true, shape: 'ellipse', bbox, fill: round2(fill), holes: holeCount, reason: `圆形，和外接椭圆重合 ${(iou * 100).toFixed(1)}%` }, mask, fullW, fullH }
  }
  return {
    shape: { ok: false, shape: null, bbox, fill: round2(fill), holes: holeCount, reason: `不是正对镜头的矩形或圆形（轮廓占外接矩形 ${(fill * 100).toFixed(1)}%）` },
    mask,
    fullW,
    fullH,
  }
}

export async function detectWhiteShape(buf: Buffer): Promise<WhiteShape> {
  return (await analyze(buf)).shape
}

export function ratioDiff(a: number, b: number): number {
  return Math.abs(a - b) / b
}

export function ratioValue(ratio: string): number {
  const [w, h] = ratioToWH(ratio)
  return w / h
}

const API_RATIO: Record<string, number> = { '1536x1024': 1.5, '1024x1536': 1024 / 1536, '1024x1024': 1 }

/** 素材图实际出来的宽高比：生图接口只有三种画布 */
export function patternCanvasRatio(styleRatio: string): number {
  return API_RATIO[pickApiSize(ratioValue(styleRatio), 1)]!
}

/** 素材图画布和产品外形比例差超过 7% 时，本地合成会失败；返回原因 */
export function canvasMismatch(shape: WhiteShape, styleRatio: string): string | null {
  if (!shape.bbox) return null
  const r = shape.bbox.w / shape.bbox.h
  const c = patternCanvasRatio(styleRatio)
  const d = ratioDiff(c, r)
  return d > STRETCH_TOLERANCE ? `素材图画布比例 ${c.toFixed(2)}（接口画布不支持 ${styleRatio}）和产品外形 ${r.toFixed(2)} 差 ${(d * 100).toFixed(1)}%，超过 7%` : null
}

/** 自动判断：图形合格、外接矩形比例和款式比例差 7% 以内、素材图画布也对得上 → 本地合成 */
export function decidePaste(shape: WhiteShape, styleRatio: string): { mode: 'local' | 'ai'; reason: string } {
  if (!shape.ok || !shape.bbox) return { mode: 'ai', reason: shape.reason }
  const r = shape.bbox.w / shape.bbox.h
  const mismatch = canvasMismatch(shape, styleRatio)
  if (mismatch) return { mode: 'ai', reason: mismatch }
  const d = ratioDiff(r, ratioValue(styleRatio))
  if (d > STRETCH_TOLERANCE) {
    return { mode: 'ai', reason: `产品外形比例 ${r.toFixed(2)} 和款式比例 ${styleRatio} 差 ${(d * 100).toFixed(1)}%，超过 7%` }
  }
  return { mode: 'local', reason: d > COVER_TOLERANCE ? `${shape.reason}；外形比例 ${r.toFixed(2)} 和款式 ${styleRatio} 差 ${(d * 100).toFixed(1)}%，素材图会轻微拉伸` : shape.reason }
}

export class LocalPasteError extends Error {}

/**
 * 素材图铺满产品外接矩形（比例差 3% 以内等比居中裁切，3%～7% 拉伸），只在轮廓内显示；安装孔保留白底图原样。
 * 画布就是白底图原尺寸。
 */
export async function compositeLocal(white: Buffer, pattern: Buffer): Promise<{ buffer: Buffer; shape: WhiteShape; fit: 'cover' | 'stretch'; placed: Buffer }> {
  const { shape, mask, fullW, fullH } = await analyze(white)
  if (!shape.ok || !shape.bbox || !mask) throw new LocalPasteError(`白底图不适合本地合成：${shape.reason}`)
  const pm = await sharp(pattern).metadata()
  const pr = pm.width! / pm.height!
  const br = shape.bbox.w / shape.bbox.h
  const diff = ratioDiff(pr, br)
  if (diff > STRETCH_TOLERANCE) {
    throw new LocalPasteError(`素材图比例 ${pr.toFixed(2)} 和产品外形比例 ${br.toFixed(2)} 差超过 7%`)
  }

  const alphaWork = Buffer.alloc(mask.w * mask.h)
  for (let p = 0; p < alphaWork.length; p++) alphaWork[p] = mask.product[p] && !mask.holes[p] ? 255 : 0
  // 边缘抗锯齿：轻微模糊后再放大到原尺寸
  const alpha = await sharp(alphaWork, { raw: { width: mask.w, height: mask.h, channels: 1 } })
    .blur(0.6)
    .resize(fullW, fullH, { fit: 'fill', kernel: 'cubic' })
    .extractChannel(0)
    .raw()
    .toBuffer()
  // 被模糊抹低的内部像素恢复成完全不透明，保证轮廓内只看得到素材图
  const full = await sharp(alphaWork, { raw: { width: mask.w, height: mask.h, channels: 1 } })
    .erode(1)
    .resize(fullW, fullH, { fit: 'fill', kernel: 'nearest' })
    .extractChannel(0)
    .raw()
    .toBuffer()
  for (let p = 0; p < alpha.length; p++) if (full[p] === 255) alpha[p] = 255

  const { x, y, w, h } = shape.bbox
  const placed = await sharp(pattern).rotate().flatten({ background: '#ffffff' }).resize(w, h, { fit: diff > COVER_TOLERANCE ? 'fill' : 'cover', position: 'centre' }).removeAlpha().raw().toBuffer()
  const layer = await sharp({ create: { width: fullW, height: fullH, channels: 3, background: '#ffffff' } })
    .composite([{ input: placed, raw: { width: w, height: h, channels: 3 }, left: x, top: y }])
    .removeAlpha()
    .raw()
    .toBuffer()
  const rgba = await sharp(layer, { raw: { width: fullW, height: fullH, channels: 3 } })
    .joinChannel(alpha, { raw: { width: fullW, height: fullH, channels: 1 } })
    .png()
    .toBuffer()
  const out = await sharp(white).rotate().flatten({ background: '#ffffff' }).composite([{ input: rgba }]).png().toBuffer()
  // 铺进外接矩形的素材图，给主图验收在本地核对用
  const placedPng = await sharp(placed, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer()
  return { buffer: out, shape, fit: diff > COVER_TOLERANCE ? 'stretch' : 'cover', placed: placedPng }
}
