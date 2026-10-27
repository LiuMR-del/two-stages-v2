import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { EXT_OF, MIME_OF, readSize, sniffImageType, thumb } from '../image/process'
import { writeFileAtomic } from '../store/atomic'
import { HASH_RE } from './schema'
import { log } from '../util/log'

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

const EXTS = ['png', 'jpg', 'webp'] as const
const MIME_BY_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }

export class UnsupportedImageError extends Error {}

/** ICC 配置文件的描述里带 sRGB（ASCII 或 UTF-16）就当作 sRGB */
export function isSrgbProfile(icc: Buffer): boolean {
  return icc.toString('latin1').includes('sRGB') || icc.includes(Buffer.from('\0s\0R\0G\0B', 'latin1'))
}

/**
 * 只接收 PNG / JPG / WebP。带 EXIF 旋转的 JPG 先转正再存，
 * 否则按像素算出的画布比例和模型实际看到的方向可能不一致。
 * 带非 sRGB 色彩配置的图（如截屏带的显示器配置）转成 sRGB 再存：模型不认配置，
 * 不转的话模型看到的颜色和电脑上看到的不一样，生成的图就有色差。
 */
export async function normalizeLibraryImage(buf: Buffer): Promise<{ buffer: Buffer; ext: string; mime: string }> {
  const type = sniffImageType(buf)
  if (!type) throw new UnsupportedImageError('只支持 PNG、JPG、WebP 格式的图片')
  let meta
  try {
    meta = await sharp(buf).metadata()
  } catch {
    throw new UnsupportedImageError('图片无法解码，可能已损坏')
  }
  if (!meta.width || !meta.height) throw new UnsupportedImageError('图片无法解码，可能已损坏')
  let out = buf
  const foreignProfile = !!meta.icc && !isSrgbProfile(meta.icc)
  if ((meta.orientation && meta.orientation !== 1) || foreignProfile) {
    // sharp 默认按图里的配置文件把像素转成 sRGB 并去掉配置文件
    const s = sharp(buf).rotate().toColourspace('srgb')
    out = await (type === 'png' ? s.png() : type === 'webp' ? s.webp({ quality: 95 }) : s.jpeg({ quality: 95 })).toBuffer()
  }
  return { buffer: out, ext: EXT_OF[type], mime: MIME_OF[type] }
}

export class ImageStore {
  private dimsCache = new Map<string, { width: number; height: number }>()

  constructor(
    private dir: string,
    private thumbsDir: string,
  ) {}

  async add(buf: Buffer): Promise<string> {
    const { buffer, ext } = await normalizeLibraryImage(buf)
    const hash = sha256(buffer)
    const file = path.join(this.dir, `${hash}.${ext}`)
    if (!fs.existsSync(file)) await writeFileAtomic(file, buffer)
    await this.ensureThumb(hash, buffer)
    return hash
  }

  /** 导入时用：内容指纹必须和文件名一致 */
  async addExact(hash: string, ext: string, buf: Buffer): Promise<void> {
    const file = path.join(this.dir, `${hash}.${ext}`)
    if (!fs.existsSync(file)) await writeFileAtomic(file, buf)
    await this.ensureThumb(hash, buf)
  }

  find(hash: string): { file: string; ext: string; mime: string } | null {
    if (!HASH_RE.test(hash)) return null
    for (const ext of EXTS) {
      const file = path.join(this.dir, `${hash}.${ext}`)
      if (fs.existsSync(file)) return { file, ext, mime: MIME_BY_EXT[ext]! }
    }
    return null
  }

  has(hash: string): boolean {
    return this.find(hash) !== null
  }

  async read(hash: string): Promise<{ buffer: Buffer; ext: string; mime: string }> {
    const f = this.find(hash)
    if (!f) throw new Error(`模版库里找不到图片 ${hash.slice(0, 8)}`)
    return { buffer: await fsp.readFile(f.file), ext: f.ext, mime: f.mime }
  }

  async thumbFile(hash: string): Promise<string | null> {
    const t = path.join(this.thumbsDir, `${hash}.webp`)
    if (fs.existsSync(t)) return t
    const f = this.find(hash)
    if (!f) return null
    await this.ensureThumb(hash, await fsp.readFile(f.file))
    return t
  }

  async dims(hash: string): Promise<{ width: number; height: number }> {
    const c = this.dimsCache.get(hash)
    if (c) return c
    const { buffer } = await this.read(hash)
    const { width, height } = await readSize(buffer)
    const d = { width, height }
    this.dimsCache.set(hash, d)
    return d
  }

  private async ensureThumb(hash: string, buf: Buffer): Promise<void> {
    const t = path.join(this.thumbsDir, `${hash}.webp`)
    if (fs.existsSync(t)) return
    await writeFileAtomic(t, await thumb(buf))
  }

  cleanOrphans(referenced: Set<string>): number {
    let n = 0
    const sweep = (dir: string) => {
      if (!fs.existsSync(dir)) return
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!ent.isFile()) continue
        const hash = ent.name.split('.')[0]!
        if (!referenced.has(hash)) {
          fs.rmSync(path.join(dir, ent.name), { force: true })
          n++
        }
      }
    }
    sweep(this.dir)
    sweep(this.thumbsDir)
    if (n) log.info(`清理了 ${n} 个模版库里没有引用的图片文件`)
    return n
  }
}
