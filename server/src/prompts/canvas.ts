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

/**
 * 画布描述与 size 必须来自同一组宽高，所以两者只能从这里一起取。
 */
export function canvasFor(w: number, h: number): { prefix: string; size: ApiSize; ratio: string; orientation: Orientation } {
  const { ratio, orientation } = describeCanvas(w, h)
  return { prefix: `[Canvas: ${ratio} ${orientation} format] `, size: pickApiSize(w, h), ratio, orientation }
}
