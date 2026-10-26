import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { capBytes, capEdge, flattenWhite, forceSize, padSquare, shrinkForAnalysis, thumb, toPng, sniffImageType } from '../../server/src/image/process'
import { jpeg, noisyPng, png, size } from '../helpers'

describe('image/process', () => {
  it('toPng 按 EXIF 方向旋转', async () => {
    const src = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#f00' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer()
    const out = await toPng(src)
    expect(sniffImageType(out)).toBe('png')
    expect(await size(out)).toEqual([20, 40])
  })

  it('flattenWhite 把透明区域压成纯白、去掉透明通道', async () => {
    const transparent = await sharp({ create: { width: 20, height: 10, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer()
    const out = await flattenWhite(transparent)
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true })
    expect(info.channels).toBe(3)
    expect(Array.from(data.subarray(0, 3))).toEqual([255, 255, 255])
  })

  it('capEdge 只缩不放', async () => {
    expect(await size(await capEdge(await png(3000, 1500)))).toEqual([2000, 1000])
    expect(await size(await capEdge(await png(800, 600)))).toEqual([800, 600])
  })

  it('padSquare 只补白边，不缩放原图', async () => {
    const out = await padSquare(await png(300, 101, { r: 0, g: 0, b: 0 }))
    expect(await size(out)).toEqual([300, 300])
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true })
    const px = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3))
    expect(px(150, 0)).toEqual([255, 255, 255])
    expect(px(150, 299)).toEqual([255, 255, 255])
    expect(px(150, 150)).toEqual([0, 0, 0])
    // 原图 101 行全部保留：上补 99、下补 100
    expect(px(150, 99)).toEqual([0, 0, 0])
    expect(px(150, 199)).toEqual([0, 0, 0])
    expect(px(150, 98)).toEqual([255, 255, 255])
    expect(px(150, 200)).toEqual([255, 255, 255])
    const tall = await padSquare(await png(100, 400))
    expect(await size(tall)).toEqual([400, 400])
  })

  it('capBytes 超限时按 0.85 缩小直到不超限', async () => {
    const big = await noisyPng(1600, 1600)
    expect(big.length).toBeGreaterThan(5 * 1024 * 1024)
    const r = await capBytes(big, 3 * 1024 * 1024)
    expect(r.shrunk).toBe(true)
    expect(r.buffer.length).toBeLessThanOrEqual(3 * 1024 * 1024)
    const [w] = await size(r.buffer)
    expect(w).toBeLessThan(1600)
    expect(w).toBeGreaterThanOrEqual(1000)
    const small = await png(100, 100)
    expect((await capBytes(small)).shrunk).toBe(false)
  })

  it('shrinkForAnalysis 长边 1536、JPEG、不超过 1.5MB', async () => {
    const out = await shrinkForAnalysis(await noisyPng(2000, 1800))
    expect(sniffImageType(out)).toBe('jpeg')
    expect(out.length).toBeLessThanOrEqual(1.5 * 1024 * 1024)
    const [w, h] = await size(out)
    expect(Math.max(w, h)).toBeLessThanOrEqual(1536)
    const small = await shrinkForAnalysis(await png(300, 200))
    expect(await size(small)).toEqual([300, 200])
  })

  it('forceSize 拉到指定宽高', async () => {
    expect(await size(await forceSize(await png(1024, 1024), 1000, 1500))).toEqual([1000, 1500])
  })

  it('thumb 长边 320 的 WebP', async () => {
    const t = await thumb(await jpeg(1000, 500))
    expect(sniffImageType(t)).toBe('webp')
    expect(await size(t)).toEqual([320, 160])
  })
})
