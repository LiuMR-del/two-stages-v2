import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInProcess, type Api } from '../inprocess'
import { png, jpeg } from '../helpers'
import type { AppContext } from '../../server/src/context'
import { MISSING_WHITE_WARNING } from '../../server/src/library/recipe'

let api: Api
let ctx: AppContext
let close: () => Promise<void>
let dir: string

beforeAll(async () => {
  const s = await startInProcess()
  api = s.api
  ctx = s.ctx
  close = s.close
  dir = s.dir
})
afterAll(() => close())

describe('模版库接口', () => {
  let cid = ''
  let sH = ''
  let sV = ''
  let tid = ''

  it('初始内容只有两段默认提示词', async () => {
    const r = await api.json('GET', '/library')
    expect(r.body.library.categories).toEqual([])
    expect(r.body.library.defaults.extractPrompt).toContain('{品类}')
    expect(r.body.library.defaults.pastePrompt).toContain('贴图')
    expect(fs.existsSync(path.join(dir, 'library', 'library.json'))).toBe(true)
  })

  it('建品类时自动带一个空名款式（1:1）；不能重名', async () => {
    const r = await api.json('POST', '/library/categories', { name: '相框' })
    expect(r.status).toBe(200)
    cid = r.body.category.id
    expect(cid).toMatch(/^c_[a-z0-9]{8}$/)
    expect(r.body.category.styles).toHaveLength(1)
    expect(r.body.category.styles[0]).toMatchObject({ name: '', ratio: '1:1', whiteImage: null })
    expect(r.body.checks[cid].level).toBe('error')
    const dup = await api.json('POST', '/library/categories', { name: '相框' })
    expect(dup.status).toBe(400)
    expect(dup.body.error).toContain('已经有叫「相框」的品类了')
    const long = await api.json('POST', '/library/categories', { name: 'x'.repeat(21) })
    expect(long.status).toBe(400)
  })

  it('建款式：比例校验；加第二个款式时给空名款式补名字', async () => {
    const bad = await api.json('POST', `/library/categories/${cid}/styles`, { name: '横版', ratio: '3/2' })
    expect(bad.status).toBe(400)
    const s1 = await api.json('PATCH', `/library/categories/${cid}/styles/${(await api.json('GET', '/library')).body.library.categories[0].styles[0].id}`, { name: '横版', ratio: '3:2' })
    expect(s1.status).toBe(200)
    sH = s1.body.library.categories[0].styles[0].id
    const s2 = await api.json('POST', `/library/categories/${cid}/styles`, { name: '竖版', ratio: '2:3' })
    sV = s2.body.style.id
    expect(s2.body.library.categories[0].styles.map((s: any) => s.name)).toEqual(['横版', '竖版'])
  })

  it('上传白底图：拒收非图片；同图只存一份并生成缩略图', async () => {
    const bad = await api.upload('PUT', `/library/categories/${cid}/styles/${sH}/white`, 'file', [{ name: 'a.gif', buffer: Buffer.from('GIF89a....') }])
    expect(bad.status).toBe(400)
    expect(bad.body.error).toContain('只支持 PNG、JPG、WebP')
    const white = await png(1500, 1000, { r: 255, g: 255, b: 255 })
    const r = await api.upload('PUT', `/library/categories/${cid}/styles/${sH}/white`, 'file', [{ name: 'w.png', buffer: white, type: 'image/png' }])
    expect(r.status).toBe(200)
    const hash = r.body.library.categories[0].styles[0].whiteImage
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    expect(fs.existsSync(path.join(dir, 'library', 'images', `${hash}.png`))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'library', 'images', 'thumbs', `${hash}.webp`))).toBe(true)
    await api.upload('PUT', `/library/categories/${cid}/styles/${sV}/white`, 'file', [{ name: 'w.png', buffer: white, type: 'image/png' }])
    expect(fs.readdirSync(path.join(dir, 'library', 'images')).filter((f) => f.endsWith('.png'))).toHaveLength(1)
    const img = await api.raw(`/library/images/${hash}?size=thumb`)
    expect(img.status).toBe(200)
    expect(img.headers.get('cache-control')).toContain('immutable')
    expect(img.headers.get('content-type')).toContain('webp')
  })

  it('配方预览：默认模版 = 白底图 + 素材图，前置句按白底图实际尺寸', async () => {
    const r = await api.json('GET', `/library/recipe?cid=${cid}&sid=${sH}`)
    expect(r.body.images).toEqual([
      { no: 1, role: '白底图', hash: expect.any(String), auto: false, required: true },
      { no: 2, role: '素材图', hash: null, auto: true, required: true },
    ])
    expect(r.body.prefix).toBe('[Canvas: 3:2 landscape format] 第一张图片是白底图，第二张图片是素材图。\n')
    expect(r.body.scope).toBe('全局共用 · 所有品类')
    expect(r.body.warnings).toEqual([])
  })

  it('移除白底图后，配方卡提示缺图，检查结果为 error', async () => {
    const r = await api.json('DELETE', `/library/categories/${cid}/styles/${sV}/white`)
    expect(r.body.checks[cid].styles[sV]).toEqual({ level: 'error', messages: ['缺白底图'] })
    const rc = await api.json('GET', `/library/recipe?cid=${cid}&sid=${sV}`)
    expect(rc.body.images[0]).toMatchObject({ no: null, role: '白底图', hash: null, required: true })
    expect(rc.body.prefix).toBe('[Canvas: 2:3 portrait format] 第一张图片是素材图。\n')
    expect(rc.body.warnings).toContain(MISSING_WHITE_WARNING)
  })

  it('自定义模版：按款式上传参考图，切换使用中，引用检查', async () => {
    const t = await api.json('POST', `/library/categories/${cid}/templates`, { name: '客厅场景', prompt: '把第二张图片贴到第一张图片里{款式}挂画上' })
    tid = t.body.template.id
    const ref = await jpeg(800, 1000)
    await api.upload('PUT', `/library/categories/${cid}/templates/${tid}/images/${sH}`, 'file', [{ name: 'r.jpg', buffer: ref, type: 'image/jpeg' }])
    const act = await api.json('PATCH', `/library/categories/${cid}`, { activeTemplate: tid })
    expect(act.body.library.categories[0].activeTemplate).toBe(tid)
    expect(act.body.checks[cid].styles[sH].level).toBe('ok')
    expect(act.body.checks[cid].styles[sV]).toEqual({ level: 'warn', messages: ['提示词里提到「第 2 张」图片，但这里只会发送 1 张'] })

    const rh = await api.json('GET', `/library/recipe?cid=${cid}&sid=${sH}&tid=${tid}`)
    expect(rh.body.images.map((i: any) => [i.no, i.role])).toEqual([
      [1, '参考图'],
      [2, '素材图'],
    ])
    expect(rh.body.prefix).toBe('[Canvas: 4:5 portrait format] 第一张图片是参考图，第二张图片是素材图。\n')
    expect(rh.body.prompt).toBe('把第二张图片贴到第一张图片里横版挂画上')
    expect(rh.body.scope).toBe('「相框」所有款式共用')
    expect(rh.body.size).toBe('1024x1024')

    const rv = await api.json('GET', `/library/recipe?cid=${cid}&sid=${sV}&tid=${tid}`)
    expect(rv.body.images.map((i: any) => [i.no, i.role, i.hash])).toEqual([
      [null, '参考图', null],
      [1, '素材图', null],
    ])
    expect(rv.body.warnings[0]).toContain('提示词里提到「第 2 张」图片，但这里只会发送 1 张')
  })

  it('删除使用中的模版，回到默认模版；删除款式会去掉它的参考图', async () => {
    const t2 = await api.json('POST', `/library/categories/${cid}/templates`, { name: '临时', prompt: 'x' })
    const id2 = t2.body.template.id
    await api.json('PATCH', `/library/categories/${cid}`, { activeTemplate: id2 })
    const d = await api.json('DELETE', `/library/categories/${cid}/templates/${id2}`)
    expect(d.body.library.categories[0].activeTemplate).toBe('default')
    await api.json('PATCH', `/library/categories/${cid}`, { activeTemplate: tid })
  })

  it('不能删除最后一个款式', async () => {
    const c = await api.json('POST', '/library/categories', { name: '毛毯' })
    const sid = c.body.category.styles[0].id
    const r = await api.json('DELETE', `/library/categories/${c.body.category.id}/styles/${sid}`)
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('每个品类至少要保留一个款式')
  })

  it('排序', async () => {
    const lib = (await api.json('GET', '/library')).body.library
    const ids = lib.categories.map((c: any) => c.id).reverse()
    const r = await api.json('PUT', '/library/categories/order', { ids })
    expect(r.body.library.categories.map((c: any) => c.id)).toEqual(ids)
    const bad = await api.json('PUT', '/library/categories/order', { ids: ids.slice(1) })
    expect(bad.status).toBe(400)
  })

  it('每次修改都发 library 事件', async () => {
    const got: unknown[] = []
    const off = ctx.bus.on('library', (p) => got.push(p))
    await api.json('PUT', '/library/defaults', { pastePrompt: '贴图提示词 v2' })
    off()
    expect(got).toHaveLength(1)
    expect((got[0] as any).library.defaults.pastePrompt).toBe('贴图提示词 v2')
    expect((got[0] as any).checks).toBeTruthy()
  })

  it('导出后在空库导入，数据一致；合并模式同名品类整个覆盖但保留本地 id', async () => {
    const before = (await api.json('GET', '/library')).body.library
    const zipResp = await api.raw('/library/export')
    expect(zipResp.headers.get('content-type')).toContain('zip')
    const zip = Buffer.from(await zipResp.arrayBuffer())

    const other = await startInProcess()
    try {
      const imp = await other.api.upload('POST', '/library/import?mode=replace', 'file', [{ name: 'lib.zip', buffer: zip }])
      expect(imp.status).toBe(200)
      expect(imp.body.library.categories).toEqual(before.categories)
      const r = await other.api.json('GET', `/library/recipe?cid=${cid}&sid=${sH}&tid=${tid}`)
      expect(r.body.images[0].hash).toBe(before.categories.find((c: any) => c.id === cid).templates[0].images[sH])

      // 本地先有一个同名但内容不同的「相框」
      await other.api.json('DELETE', `/library/categories/${cid}`)
      const local = await other.api.json('POST', '/library/categories', { name: '相框' })
      const localId = local.body.category.id
      await other.api.json('PATCH', `/library/categories/${localId}`, { hint: '本地说明' })
      const merged = await other.api.upload('POST', '/library/import?mode=merge', 'file', [{ name: 'lib.zip', buffer: zip }])
      const frame = merged.body.library.categories.find((c: any) => c.name === '相框')
      expect(frame.id).toBe(localId)
      expect(frame.hint).toBe(before.categories.find((c: any) => c.id === cid).hint)
      expect(frame.styles.map((s: any) => s.name)).toEqual(['横版', '竖版'])
      expect(frame.activeTemplate).toBe(frame.templates[0].id)
      expect(merged.body.library.categories.filter((c: any) => c.name === '相框')).toHaveLength(1)
      expect(merged.body.library.categories.some((c: any) => c.name === '毛毯')).toBe(true)

      const backups = fs.readdirSync(path.join(other.dir, 'library', 'backups'))
      expect(backups.length).toBe(1)
    } finally {
      await other.close()
    }
  })

  it('导入前校验：缺图整包拒绝，不是 zip 也拒绝', async () => {
    const { zipSync, strToU8 } = await import('fflate')
    const lib = (await api.json('GET', '/library')).body.library
    const broken = Buffer.from(zipSync({ 'library.json': strToU8(JSON.stringify(lib)) }))
    const r = await api.upload('POST', '/library/import?mode=merge', 'file', [{ name: 'x.zip', buffer: broken }])
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('在 zip 里找不到')
    const r2 = await api.upload('POST', '/library/import?mode=merge', 'file', [{ name: 'x.zip', buffer: Buffer.from('nope') }])
    expect(r2.status).toBe(400)
    const r3 = await api.upload('POST', '/library/import?mode=merge', 'file', [{ name: 'x.zip', buffer: Buffer.from(zipSync({ 'library.json': strToU8('{"version":2}') })) }])
    expect(r3.status).toBe(400)
    expect(r3.body.error).toContain('格式不对')
  })

  it('清理孤儿图片只删没被引用的文件', async () => {
    const orphan = path.join(dir, 'library', 'images', `${'f'.repeat(64)}.png`)
    fs.writeFileSync(orphan, await png(10, 10))
    const kept = fs.readdirSync(path.join(dir, 'library', 'images')).filter((f) => f.endsWith('.png') || f.endsWith('.jpg'))
    const n = await ctx.library.cleanOrphans()
    expect(n).toBe(1)
    expect(fs.existsSync(orphan)).toBe(false)
    expect(fs.readdirSync(path.join(dir, 'library', 'images')).filter((f) => f.endsWith('.png') || f.endsWith('.jpg')).length).toBe(kept.length - 1)
  })
})
