import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { flattenFace, locateFace, validQuad, type Quad } from '../../server/src/image/face'

const W = 1600
const H = 1200
/** 墙面（带几条横线，模拟木板缝）上挂一块铝板：外缘一圈 30px 红色做旧边，里面米色，中间一块绿色 */
async function photo(poly: [number, number][]): Promise<Buffer> {
  const pts = poly.map((p) => p.join(',')).join(' ')
  const lines = [150, 420, 980, 1100].map((y) => `<rect x="0" y="${y}" width="${W}" height="6" fill="#bdb6aa"/>`).join('')
  // 内圈：每个角往中心收 30px（近似）
  const cx = poly.reduce((s, p) => s + p[0], 0) / 4
  const cy = poly.reduce((s, p) => s + p[1], 0) / 4
  const inner = poly.map(([x, y]) => [x + Math.sign(cx - x) * 30, y + Math.sign(cy - y) * 30].join(',')).join(' ')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#e6e1d8"/>${lines}<polygon points="${pts}" fill="#c0302a"/><polygon points="${inner}" fill="#f3ead6"/><circle cx="${cx}" cy="${cy}" r="150" fill="#2e7d32"/></svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}
const norm = (poly: [number, number][], dx = 0, dy = 0): Quad => poly.map(([x, y], i) => [(x + (i === 0 || i === 3 ? dx : -dx)) / W, (y + (i < 2 ? dy : -dy)) / H]) as Quad

describe('印刷面区域：四个角校验', () => {
  it('合法的凸四边形才用；凹的、太小、越界、缺值都不用', () => {
    expect(validQuad([[0.1, 0.1], [0.9, 0.1], [0.9, 0.8], [0.1, 0.8]])).not.toBeNull()
    expect(validQuad([[0.1, 0.1], [0.9, 0.1], [0.5, 0.3], [0.1, 0.9]])).toBeNull()
    expect(validQuad([[0.1, 0.1], [0.2, 0.1], [0.2, 0.15], [0.1, 0.15]])).toBeNull()
    expect(validQuad([[0.1, 0.1], [1.5, 0.1], [0.9, 0.8], [0.1, 0.8]])).toBeNull()
    expect(validQuad([[0.1, 0.1], [0.9, 0.1], [0.9]])).toBeNull()
    expect(validQuad(null)).toBeNull()
  })

  it('不管模型按什么顺序给（逆时针、从右上开始），都整理成左上起顺时针', () => {
    const want = [[0.1, 0.2], [0.9, 0.2], [0.9, 0.8], [0.1, 0.8]]
    expect(validQuad([[0.1, 0.2], [0.1, 0.8], [0.9, 0.8], [0.9, 0.2]])).toEqual(want)
    expect(validQuad([[0.9, 0.2], [0.9, 0.8], [0.1, 0.8], [0.1, 0.2]])).toEqual(want)
    expect(validQuad([[0.9, 0.8], [0.1, 0.8], [0.1, 0.2], [0.9, 0.2]])).toEqual(want)
  })

  it('给成像素坐标时按模型看到的那张图换算', () => {
    expect(validQuad([[100, 200], [900, 200], [900, 800], [100, 800]], { width: 1000, height: 1000 })).toEqual([[0.1, 0.2], [0.9, 0.2], [0.9, 0.8], [0.1, 0.8]])
    expect(validQuad([[100, 200], [900, 200], [900, 800], [100, 800]])).toBeNull()
  })
})

describe('印刷面区域：本地校正', () => {
  const plate: [number, number][] = [
    [200, 250],
    [1400, 250],
    [1400, 1050],
    [200, 1050],
  ]

  it('模型给的角往里缩了 2%：往外补到真实外缘，红色做旧边完整保留', async () => {
    const img = await photo(plate)
    const f = await locateFace(img, norm(plate, 24, 24))
    const px = f.corners.map(([x, y]) => [x * W, y * H])
    // 校正后在真实外缘外面一点点（不超过 12px），不会往里切
    expect(px[0]![0]).toBeLessThanOrEqual(200)
    expect(px[0]![0]).toBeGreaterThan(200 - 12)
    expect(px[2]![1]).toBeGreaterThanOrEqual(1050)
    expect(px[2]![1]).toBeLessThan(1050 + 12)
    const flat = (await flattenFace(img, f, '3:2')).buffer!
    const { data, info } = await sharp(flat).raw().toBuffer({ resolveWithObject: true })
    expect(info.width / info.height).toBeCloseTo(1.5, 2)
    // 四条边往里 15px 处都是红边
    const at = (x: number, y: number) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)]
    const isRed = (p: number[]) => p[0]! > 150 && p[1]! < 90 && p[2]! < 90
    expect(isRed(at(Math.round(info.width / 2), 15))).toBe(true)
    expect(isRed(at(Math.round(info.width / 2), info.height - 16))).toBe(true)
    expect(isRed(at(15, Math.round(info.height / 2)))).toBe(true)
    expect(isRed(at(info.width - 16, Math.round(info.height / 2)))).toBe(true)
  })

  it('模型给的角已经在外缘外面：不往里缩到红边内侧那条线上', async () => {
    const img = await photo(plate)
    const f = await locateFace(img, norm(plate, -8, -8))
    for (const m of f.moved) expect(m).toBeGreaterThanOrEqual(0)
    const px = f.corners.map(([x, y]) => [x * W, y * H])
    expect(px[0]![0]).toBeLessThanOrEqual(200)
    expect(px[0]![1]).toBeLessThanOrEqual(250)
  })

  it('模型给的一条边是斜的（右上角往里缩了 30px）：两头分别往外补，红边不被切', async () => {
    const img = await photo(plate)
    const ai = norm(plate)
    ai[1] = [1400 / W, 280 / H]
    const f = await locateFace(img, ai)
    const px = f.corners.map(([x, y]) => [x * W, y * H])
    expect(px[1]![1]).toBeLessThanOrEqual(250)
    expect(px[0]![1]).toBeLessThanOrEqual(250)
    expect(px[0]![1]).toBeGreaterThan(250 - 14)
  })

  it('款式方向和量出的印刷面方向对不上（横版的板配竖版款式）：不硬拉，返回原因', async () => {
    const img = await photo(plate)
    const f = await locateFace(img, norm(plate))
    const r = await flattenFace(img, f, '2:3')
    expect(r.buffer).toBeNull()
    expect((r as { reason: string }).reason).toContain('和款式比例 2:3 差太多')
  })

  it('斜拍（透视）的铝板按四个角拉正，宽高比按款式', async () => {
    const skew: [number, number][] = [
      [260, 300],
      [1380, 230],
      [1420, 1080],
      [230, 1000],
    ]
    const img = await photo(skew)
    const f = await locateFace(img, norm(skew, 15, 15))
    const flat = (await flattenFace(img, f, '3:2')).buffer!
    const { data, info } = await sharp(flat).raw().toBuffer({ resolveWithObject: true })
    expect(Math.abs(info.width / info.height - 1.5)).toBeLessThan(0.01)
    const mid = ((Math.round(info.height / 2) * info.width + Math.round(info.width / 2)) * 3)
    expect(data[mid + 1]).toBeGreaterThan(data[mid]!) // 中间是绿色
  })
})
