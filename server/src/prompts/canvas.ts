export type Orientation = 'square' | 'landscape' | 'portrait'
export type ApiSize = '1536x1024' | '1024x1536' | '1024x1024'

const COMMON_RATIOS: [number, number][] = [
  [1, 1], [4, 3], [3, 4], [3, 2], [2, 3], [5, 4], [4, 5], [16, 9], [9, 16], [2, 1], [1, 2],
]
const TOLERANCE = 0.03

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

export function describeCanvas(w: number, h: number): { ratio: string; orientation: Orientation } {
  if (!(w > 0) || !(h > 0)) throw new Error(`宽高不合法：${w}x${h}`)
  const r = w / h
  let best: { rw: number; rh: number; diff: number } | null = null
  for (const [rw, rh] of COMMON_RATIOS) {
    const c = rw / rh
    const diff = Math.abs(r - c) / c
    if (diff <= TOLERANCE && (!best || diff < best.diff)) best = { rw, rh, diff }
  }
  let ratio: string
  if (best) {
    ratio = `${best.rw}:${best.rh}`
  } else {
    const W = Math.round(w)
    const H = Math.round(h)
    const g = gcd(W, H) || 1
    ratio = `${W / g}:${H / g}`
  }
  const orientation: Orientation = r >= 0.97 && r <= 1.03 ? 'square' : r > 1.03 ? 'landscape' : 'portrait'
  return { ratio, orientation }
}

export function pickApiSize(w: number, h: number): ApiSize {
  const r = w / h
  if (r > 1.2) return '1536x1024'
  if (r < 0.8) return '1024x1536'
  return '1024x1024'
}

export function ratioToWH(ratio: string): [number, number] {
  const m = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(ratio)
  if (!m) throw new Error(`比例格式不对：「${ratio}」，应写成「3:2」这样的两个正整数`)
  const w = Number(m[1])
  const h = Number(m[2])
  if (w <= 0 || h <= 0) throw new Error(`比例格式不对：「${ratio}」，应写成「3:2」这样的两个正整数`)
  return [w, h]
}

export function isValidRatio(ratio: string): boolean {
  try {
    ratioToWH(ratio)
    return true
  } catch {
    return false
  }
}

/** 生图接口一次能出的最长边 */
const EXACT_LONG_EDGE = 1536

/**
 * 按比例给出精确尺寸：长边 1536，两边都取 16 的倍数。中转站接受任意尺寸（2026-10-29 实测 1024x1280、1456x1088 都行）；
 * 原来只按 3 种固定尺寸取，4:5 被套成 1024x1024，和前置句「4:5 竖版」打架。
 */
export function exactSize(w: number, h: number): string {
  const s = EXACT_LONG_EDGE / Math.max(w, h)
  const r16 = (v: number) => Math.max(16, Math.round((v * s) / 16) * 16)
  return `${r16(w)}x${r16(h)}`
}

/** 素材图提取用：前置句和尺寸都按款式的精确比例 */
export function exactCanvas(w: number, h: number): { prefix: string; size: string } {
  const { ratio, orientation } = describeCanvas(w, h)
  return { prefix: `[Canvas: ${ratio} ${orientation} format] `, size: exactSize(w, h) }
}

/**
 * 画布描述与 size 必须来自同一组宽高，所以两者只能从这里一起取。
 */
export function canvasFor(w: number, h: number): { prefix: string; size: ApiSize; ratio: string; orientation: Orientation } {
  const { ratio, orientation } = describeCanvas(w, h)
  return { prefix: `[Canvas: ${ratio} ${orientation} format] `, size: pickApiSize(w, h), ratio, orientation }
}
