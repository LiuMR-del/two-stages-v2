import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { compositeLocal, decidePaste, detectWhiteShape, LocalPasteError } from '../../server/src/image/whiteShape'
import { decidePasteMode } from '../../server/src/pipeline/paste'
import { DEFAULT_EXTRACT_PROMPT, DEFAULT_PASTE_PROMPT, LibrarySchema, OLD_DEFAULT_EXTRACT_PROMPTS, OLD_DEFAULT_PASTE_PROMPTS } from '../../server/src/library/schema'
import { LibraryStore } from '../../server/src/library/store'
import { rmDir, tmpDir } from '../helpers'

const svg = (w: number, h: number, body: string) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#ffffff"/>${body}</svg>`)).png().toBuffer()

const HOLES = [
  [200, 150],
  [1300, 150],
  [200, 850],
  [1300, 850],
] as const
/** 灰色圆角矩形铝板 + 四个安装孔，外形 1200x800（3:2） */
const plate = () =>
  svg(1500, 1000, `<rect x="150" y="100" width="1200" height="800" rx="40" fill="#9c9c9c" stroke="#555" stroke-width="3"/>${HOLES.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="16" fill="#ffffff" stroke="#444" stroke-width="3"/>`).join('')}`)
/** 左半红、右半白（中间一个蓝块），用来看白色区域合成后还是白的 */
const pattern = () => svg(1536, 1024, `<rect x="0" y="0" width="768" height="1024" fill="#d03030"/><rect x="1000" y="400" width="200" height="200" fill="#2060d0"/>`)

async function pixel(buf: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const i = (y * info.width + x) * info.channels
  return [data[i]!, data[i + 1]!, data[i + 2]!]
}
const near = (a: number[], b: number[], tol = 4) => a.every((v, i) => Math.abs(v - b[i]!) <= tol)

describe('白底图图形检测', () => {
  it('灰色圆角矩形 + 四个孔 → 矩形、4 个孔、比例对得上就判本地合成', async () => {
    const s = await detectWhiteShape(await plate())
    expect(s).toMatchObject({ ok: true, shape: 'rect', holes: 4 })
    expect(s.bbox).toEqual({ x: 148, y: 98, w: 1204, h: 804 })
    expect(decidePaste(s, '3:2').mode).toBe('local')
  })

  it('斜拍（梯形）、不规则形状 → AI 贴图', async () => {
    const skew = await detectWhiteShape(await svg(1500, 1000, '<polygon points="200,150 1300,260 1300,740 200,850" fill="#9c9c9c"/>'))
    expect(skew.ok).toBe(false)
    expect(decidePaste(skew, '3:2').mode).toBe('ai')
    const star = await detectWhiteShape(await svg(1000, 1000, '<polygon points="500,80 610,380 920,380 670,570 760,880 500,700 240,880 330,570 80,380 390,380" fill="#9c9c9c"/>'))
    expect(star.ok).toBe(false)
    expect(decidePaste(star, '1:1').mode).toBe('ai')
  })

  it('比例差太多 → AI 贴图；7% 以内仍本地合成（素材图轻微拉伸）', async () => {
    const wide = await detectWhiteShape(await svg(1500, 1000, '<rect x="150" y="200" width="1200" height="600" fill="#9c9c9c"/>'))
    expect(wide.ok).toBe(true)
    const d = decidePaste(wide, '3:2')
    expect(d.mode).toBe('ai')
    expect(d.reason).toContain('超过 7%')
    // 1.407 对 3:2：差 6.2%，和实测铝板画白底图一样
    const a4 = await detectWhiteShape(await svg(1500, 1100, '<rect x="100" y="120" width="1200" height="853" fill="#9c9c9c"/>'))
    expect(decidePaste(a4, '3:2')).toMatchObject({ mode: 'local' })
    expect(decidePaste(a4, '3:2').reason).toContain('轻微拉伸')
  })

  it('款式比例接口画布画不出来（4:5 出来是 1:1）时不判本地合成，手动选也一样', async () => {
    const r45 = await detectWhiteShape(await svg(1000, 1200, '<rect x="100" y="100" width="800" height="1000" fill="#9c9c9c"/>'))
    expect(r45.ok).toBe(true)
    const d = decidePaste(r45, '4:5')
    expect(d.mode).toBe('ai')
    expect(d.reason).toContain('接口画布不支持 4:5')
    expect(decidePasteMode('local', r45, '4:5')).toMatchObject({ mode: 'ai' })
  })

  it('圆形 → 本地合成；整张都是产品（没有白底）、整张近白 → AI 贴图', async () => {
    const c = await detectWhiteShape(await svg(1000, 1000, '<circle cx="500" cy="500" r="400" fill="#9c9c9c"/>'))
    expect(c).toMatchObject({ ok: true, shape: 'ellipse' })
    expect(decidePaste(c, '1:1').mode).toBe('local')
    expect((await detectWhiteShape(await svg(800, 600, '<rect width="800" height="600" fill="#9c9c9c"/>'))).ok).toBe(false)
    expect((await detectWhiteShape(await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 250, g: 250, b: 250 } } }).png().toBuffer())).ok).toBe(false)
  })

  it('手动改贴图方式：AI 贴图优先；本地合成但白底图不合格时仍用 AI 并说明', async () => {
    const ok = await detectWhiteShape(await plate())
    const bad = await detectWhiteShape(await svg(1500, 1000, '<polygon points="200,150 1300,260 1300,740 200,850" fill="#9c9c9c"/>'))
    expect(decidePasteMode('auto', ok, '3:2').mode).toBe('local')
    expect(decidePasteMode('ai', ok, '3:2')).toMatchObject({ mode: 'ai', auto: { mode: 'local' } })
    expect(decidePasteMode('local', ok, '2:1').mode).toBe('local')
    const forced = decidePasteMode('local', bad, '3:2')
    expect(forced.mode).toBe('ai')
    expect(forced.note).toContain('没法本地合成')
    expect(decidePasteMode('auto', null, '3:2').mode).toBe('ai')
  })
})

describe('本地合成', () => {
  it('孔还在、轮廓外是白的、轮廓内全是素材图像素、素材图白色区域仍是白色', async () => {
    const white = await plate()
    const pat = await pattern()
    const { buffer, shape, fit } = await compositeLocal(white, pat)
    expect(fit).toBe('cover')
    const [w, h] = [(await sharp(buffer).metadata()).width, (await sharp(buffer).metadata()).height]
    expect([w, h]).toEqual([1500, 1000])

    for (const [x, y] of HOLES) expect(Math.min(...(await pixel(buffer, x, y)))).toBeGreaterThanOrEqual(245)
    for (const [x, y] of [
      [20, 20],
      [1480, 980],
      [152, 102],
      [750, 60],
    ] as const) {
      expect(await pixel(buffer, x, y)).toEqual([255, 255, 255])
    }

    const b = shape.bbox!
    const expected = await sharp(pat).resize(b.w, b.h, { fit: 'cover' }).removeAlpha().png().toBuffer()
    const samples = [
      [300, 300],
      [600, 500],
      [700, 880],
      [1100, 500],
      [1200, 300],
      [900, 700],
      [400, 700],
      [1250, 850],
    ] as const
    for (const [x, y] of samples) {
      const got = await pixel(buffer, x, y)
      const want = await pixel(expected, x - b.x, y - b.y)
      expect(near(got, want), `(${x},${y}) ${got} ≠ ${want}`).toBe(true)
      expect(near(got, [156, 156, 156], 20)).toBe(false)
    }
    // 右半边素材图是白的：合成后还是白，不露铝板的灰
    expect(await pixel(buffer, 950, 300)).toEqual([255, 255, 255])
  })

  it('素材图比例和产品外形差超过 7% 就不合成', async () => {
    const sq = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#d03030' } }).png().toBuffer()
    await expect(compositeLocal(await plate(), sq)).rejects.toBeInstanceOf(LocalPasteError)
  })
})

describe('旧模版库', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmDir(dir)
    dir = ''
  })

  it('没有贴图方式、白底图检测结果的旧库照常读，版本不变', () => {
    const old = {
      version: 2,
      defaults: { extractPrompt: 'a', pastePrompt: 'b' },
      categories: [{ id: 'c1', name: '铝板画', hint: '', extractPrompt: null, styles: [{ id: 's1', name: '', ratio: '3:2', whiteImage: null, activeTemplate: 'default', templates: [] }] }],
    }
    const lib = LibrarySchema.parse(old)
    expect(lib.version).toBe(2)
    expect(lib.whiteChecks).toEqual({})
    expect(lib.categories[0]!.styles[0]!.pasteMode).toBe('auto')
  })

  it('全局默认提示词和旧默认一字不差才换成新的，改过的不动', () => {
    dir = tmpDir()
    const mk = (extractPrompt: string, pastePrompt: string) => {
      const d = fs.mkdtempSync(path.join(dir, 'l'))
      fs.writeFileSync(path.join(d, 'library.json'), JSON.stringify({ version: 2, defaults: { extractPrompt, pastePrompt }, categories: [] }))
      return new LibraryStore({ file: path.join(d, 'library.json'), imagesDir: path.join(d, 'images'), thumbsDir: path.join(d, 'thumbs'), backupsDir: path.join(d, 'backups') })
    }
    const a = mk(OLD_DEFAULT_EXTRACT_PROMPTS[0]!, OLD_DEFAULT_PASTE_PROMPTS[0]!)
    expect(a.get().defaults).toEqual({ extractPrompt: DEFAULT_EXTRACT_PROMPT, pastePrompt: DEFAULT_PASTE_PROMPT })
    const b = mk(OLD_DEFAULT_EXTRACT_PROMPTS[0]! + ' ', '我自己改过的贴图提示词')
    expect(b.get().defaults).toEqual({ extractPrompt: OLD_DEFAULT_EXTRACT_PROMPTS[0]! + ' ', pastePrompt: '我自己改过的贴图提示词' })
    expect(DEFAULT_EXTRACT_PROMPT).toBe('这是一张{品类}商品图。只要商品印刷面上的图案部分，转成正面的平面设计稿并高清处理，图案四边铺满画布，比例 {比例}。')
  })
})
