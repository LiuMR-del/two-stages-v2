import sharp from 'sharp'

export const MAIN_MAX_EDGE = 2000
export const MAIN_MAX_BYTES = Math.floor(9.5 * 1024 * 1024)
const MIN_EDGE_FOR_BYTES = 1000
const ANALYSIS_MAX_EDGE = 1536
const ANALYSIS_MAX_BYTES = Math.floor(1.5 * 1024 * 1024)
const THUMB_EDGE = 320
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 }

export async function readSize(buf: Buffer): Promise<{ width: number; height: number; format: string }> {
  const meta = await sharp(buf).metadata()
  if (!meta.width || !meta.height) throw new Error('无法读取图片尺寸')
  const oriented = meta.orientation && meta.orientation >= 5
  return {
    width: oriented ? meta.height : meta.width,
    height: oriented ? meta.width : meta.height,
    format: meta.format ?? 'unknown',
  }
}

export async function toPng(buf: Buffer): Promise<Buffer> {
  return sharp(buf).rotate().png().toBuffer()
}

export async function capEdge(buf: Buffer, maxEdge = MAIN_MAX_EDGE): Promise<Buffer> {
  const { width, height } = await readSize(buf)
  if (Math.max(width, height) <= maxEdge) return sharp(buf).rotate().png().toBuffer()
  return sharp(buf)
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer()
}

export async function padSquare(buf: Buffer): Promise<Buffer> {
  const { width, height } = await readSize(buf)
  if (width === height) return sharp(buf).rotate().png().toBuffer()
  const d = Math.abs(width - height)
  const a = Math.floor(d / 2)
  const b = d - a
  const ext = width > height ? { top: a, bottom: b, left: 0, right: 0 } : { top: 0, bottom: 0, left: a, right: b }
  return sharp(buf).rotate().extend({ ...ext, background: WHITE }).png().toBuffer()
}

export async function capBytes(buf: Buffer, maxBytes = MAIN_MAX_BYTES): Promise<{ buffer: Buffer; shrunk: boolean }> {
  if (buf.length <= maxBytes) return { buffer: buf, shrunk: false }
  const { width, height } = await readSize(buf)
  let edge = Math.max(width, height)
  let out = buf
  while (out.length > maxBytes && edge > MIN_EDGE_FOR_BYTES) {
    edge = Math.max(MIN_EDGE_FOR_BYTES, Math.round(edge * 0.85))
    out = await sharp(buf).rotate().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true }).png().toBuffer()
  }
  return { buffer: out, shrunk: true }
}

export async function shrinkForAnalysis(buf: Buffer): Promise<Buffer> {
  const base = () => sharp(buf).rotate().flatten({ background: WHITE })
  const { width, height } = await readSize(buf)
  let edge = Math.min(ANALYSIS_MAX_EDGE, Math.max(width, height))
  const encode = (e: number, q: number) =>
    base().resize({ width: e, height: e, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: q }).toBuffer()
  for (const q of [85, 75, 65]) {
    const out = await encode(edge, q)
    if (out.length <= ANALYSIS_MAX_BYTES) return out
  }
  let out: Buffer
  do {
    edge = Math.max(64, Math.round(edge * 0.85))
    out = await encode(edge, 65)
  } while (out.length > ANALYSIS_MAX_BYTES && edge > 64)
  return out
}

export async function forceSize(buf: Buffer, w: number, h: number): Promise<Buffer> {
  return sharp(buf).rotate().resize(w, h, { fit: 'fill' }).png().toBuffer()
}

export async function thumb(buf: Buffer): Promise<Buffer> {
  return sharp(buf)
    .rotate()
    .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer()
}

export async function solidPng(w: number, h: number, rgb: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: rgb } }).png().toBuffer()
}

export function sniffImageType(buf: Buffer): 'png' | 'jpeg' | 'webp' | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  return null
}

export const MIME_OF = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const
export const EXT_OF = { png: 'png', jpeg: 'jpg', webp: 'webp' } as const
