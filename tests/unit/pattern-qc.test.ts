import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { compareTexts, normalizeText, QcAnswerSchema } from '../../server/src/prompts/qc'
import { checkPatternLayout } from '../../server/src/image/patternLayout'
import { compareColors, normalizeBox, rgbToLab } from '../../server/src/image/colorCheck'
import { normalizeLibraryImage } from '../../server/src/library/images'

const svg = (w: number, h: number, body: string, bg = '#ffffff') =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${bg}"/>${body}</svg>`)).png().toBuffer()
/** 铺满画布的图案：几块颜色 */
const art = (w: number, h: number) =>
  svg(w, h, `<rect x="0" y="0" width="${w}" height="${h / 3}" fill="#c0392b"/><circle cx="${w / 2}" cy="${h / 2}" r="${h / 4}" fill="#2e86de"/><rect x="0" y="${(h * 2) / 3}" width="${w}" height="${h / 3}" fill="#27ae60"/>`, '#f5d76e')

describe('素材图文字比对（程序判定）', () => {
  it('横幅文字被换掉 → 不合格，原因里有两段文字', () => {
    const r = compareTexts(['THE BENNETT FAMILY', 'Merry Christmas'], ['AND A HAPPY NEW YEAR', 'Merry Christmas'])
    expect(r.ok).toBe(false)
    expect(r.diffs).toEqual(['文字变了：原图 THE BENNETT FAMILY → 素材图 AND A HAPPY NEW YEAR'])
  })

  it('大小写、空白、标点、分行不同都不算差异', () => {
    expect(normalizeText('  The  Bennett—Family! ')).toBe('the bennett family')
    expect(compareTexts(['THE BENNETT', 'FAMILY', 'Est. 2020'], ['The Bennett Family', 'EST 2020']).ok).toBe(true)
    expect(compareTexts([], []).ok).toBe(true)
  })

  it('缺字、多字、改一个字母都不合格', () => {
    expect(compareTexts(['Bennett', 'Family'], ['Bennett']).diffs).toEqual(['素材图缺少文字：Family'])
    expect(compareTexts(['Bennett'], ['Bennett', 'Joy']).diffs).toEqual(['素材图多出文字：Joy'])
    expect(compareTexts(['Bennett'], ['Benett']).diffs).toEqual(['文字变了：原图 Bennett → 素材图 Benett'])
  })

  it('顺序调换也不合格', () => {
    const r = compareTexts(['THE BENNETT FAMILY'], ['FAMILY THE BENNETT'])
    expect(r.ok).toBe(false)
    expect(compareTexts(['Merry', 'Christmas'], ['Christmas', 'Merry']).diffs).toEqual(['文字顺序变了：原图 Merry / Christmas → 素材图 Christmas / Merry'])
  })

  it('模型回复的字段校验：分数是数字、数组里的空项去掉', () => {
    const v = QcAnswerSchema.parse({ source_texts: ['A', ''], pattern_texts: null, element_score: '0.9', element_issues: [] })
    expect(v).toEqual({ source_texts: ['A'], pattern_texts: [], print_box: null, element_score: 0.9, element_issues: [], edge_missing: [], edge_extra: [] })
    expect(QcAnswerSchema.parse({ print_box: 'x', element_score: 1 }).print_box).toBeNull()
    expect(QcAnswerSchema.safeParse({ element_score: 3 }).success).toBe(false)
  })
})

describe('素材图版面（本地判定）', () => {
  it('四边铺满、比例对 → 合格', async () => {
    const r = await checkPatternLayout(await art(1536, 1024), '3:2')
    expect(r).toEqual({ ok: true, issues: [], ratioChecked: true, note: null })
  })

  it('四边有白边 → 不合格', async () => {
    const buf = await svg(1536, 1024, '<rect x="90" y="70" width="1356" height="884" fill="#c0392b"/>')
    const r = await checkPatternLayout(buf, '3:2')
    expect(r.ok).toBe(false)
    expect(r.issues[0]).toMatch(/^四边有白边/)
  })

  it('左右两边留白（图案没铺满宽度）→ 不合格', async () => {
    const r = await checkPatternLayout(await svg(1536, 1024, '<rect x="256" y="0" width="1024" height="1024" fill="#c0392b"/>'), '3:2')
    expect(r.issues[0]).toMatch(/^左右两边有白边/)
  })

  it('带着产品的圆角 → 不合格', async () => {
    const r = await checkPatternLayout(await svg(1536, 1024, '<rect x="0" y="0" width="1536" height="1024" rx="70" fill="#c0392b"/>'), '3:2')
    expect(r.ok).toBe(false)
    expect(r.issues).toContain('带着产品的圆角（4 个角）')
  })

  it('四周印着一圈边框（如红色做旧边）本地不判不合格：属于图案，交给验收模型对照竞品图', async () => {
    const buf = await svg(1536, 1024, '<rect x="18" y="18" width="1500" height="988" fill="#2e86de"/><circle cx="768" cy="512" r="200" fill="#f1c40f"/>', '#c0392b')
    expect(await checkPatternLayout(buf, '3:2')).toMatchObject({ ok: true, issues: [] })
  })

  it('比例：画布能表示时检查（差 1% 以内）；4:5 这类接口画布不支持就跳过并注明', async () => {
    const sq = await art(1024, 1024)
    expect((await checkPatternLayout(sq, '3:2')).issues).toEqual(['宽高比 1.000 和产品比例 3:2 不一致'])
    expect(await checkPatternLayout(sq, '1:1')).toMatchObject({ ok: true, ratioChecked: true })
    expect(await checkPatternLayout(sq, '4:5')).toEqual({ ok: true, issues: [], ratioChecked: false, note: '接口画布不支持 4:5，未检查比例' })
    expect((await checkPatternLayout(await art(1254, 1254), '1:1')).ok).toBe(true)
  })
})

describe('素材图色差（竞品图印刷面 vs 素材图）', () => {
  /** 竞品图：浅灰墙面上一块 3:2 的铝板，印着 art */
  const photo = async (w: number, h: number) =>
    sharp({ create: { width: 1200, height: 1000, channels: 3, background: '#d8d4cc' } })
      .composite([{ input: await sharp(await art(w, h)).resize(900, 600).png().toBuffer(), left: 150, top: 200 }])
      .png()
      .toBuffer()
  const box: [number, number, number, number] = [150 / 1200, 200 / 1000, 1050 / 1200, 800 / 1000]

  it('颜色一样 → 合格，色差接近 0', async () => {
    const r = await compareColors(await photo(1536, 1024), await art(1536, 1024), box, 8)
    expect(r.checked).toBe(true)
    expect(r.deltaE!).toBeLessThan(2)
    expect(r.gridDeltaE!).toBeLessThan(3)
    expect(r.issues).toEqual([])
  })

  it('整体偏黄偏暖 → 不合格，写明方向和数值', async () => {
    const warm = await sharp(await art(1536, 1024)).modulate({ brightness: 1.0 }).tint({ r: 255, g: 210, b: 120 }).png().toBuffer()
    const r = await compareColors(await photo(1536, 1024), warm, box, 8)
    expect(r.deltaE!).toBeGreaterThan(8)
    expect(r.issues[0]).toMatch(/^颜色偏了：整体.*偏黄.*（ΔE [\d.]+，超过 8）$/)
    expect(r.shift!.b).toBeGreaterThan(3)
  })

  it('局部颜色换了（红色横幅变成蓝色）→ 不合格', async () => {
    const swapped = await svg(1536, 1024, `<rect x="0" y="0" width="1536" height="341" fill="#2e86de"/><circle cx="768" cy="512" r="256" fill="#2e86de"/><rect x="0" y="683" width="1536" height="341" fill="#c0392b"/>`, '#f5d76e')
    const r = await compareColors(await photo(1536, 1024), swapped, box, 8)
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0]).toMatch(/^颜色偏了/)
  })

  it('模型没给印刷面位置 → 不检查并注明；框给成像素也能换算', async () => {
    const r = await compareColors(await photo(1536, 1024), await art(1536, 1024), null, 8)
    expect(r).toMatchObject({ checked: false, issues: [], note: '模型没给出竞品图印刷面的位置，这次没检查颜色' })
    expect(normalizeBox([150, 200, 1050, 800], { width: 1200, height: 1000 })).toEqual(box)
    expect(normalizeBox([0.5, 0.5, 0.55, 0.9], { width: 1, height: 1 })).toBeNull()
    expect(rgbToLab(255, 255, 255).map((v) => Math.round(v) + 0)).toEqual([100, 0, 0])
  })

  it('截屏这类带非 sRGB 色彩配置的图，入库时转成 sRGB（模型不认配置）', async () => {
    const base = await art(300, 200)
    const p3 = await sharp(base).withIccProfile('p3').png().toBuffer()
    expect((await sharp(p3).metadata()).icc).toBeTruthy()
    const n = await normalizeLibraryImage(p3)
    expect((await sharp(n.buffer).metadata()).icc).toBeUndefined()
    const a = await sharp(base).removeAlpha().raw().toBuffer()
    const b = await sharp(n.buffer, { ignoreIcc: true }).removeAlpha().raw().toBuffer()
    let max = 0
    for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i]! - b[i]!))
    expect(max).toBeLessThanOrEqual(3)
    // sRGB 的图原样保留
    expect((await normalizeLibraryImage(base)).buffer).toBe(base)
  })
})

