import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { startWorld, makeCategory, uploadJobs, waitJob, isDone, hasAttention, imageRequests, getJob, onlyBatch, type World } from './harness'
import { PASTE_CONSTRAINT } from '../../server/src/prompts/main'
import { FACE_CONSTRAINT, SCENE_CONSTRAINT } from '../../server/src/prompts/extract'
import { waitFor } from '../helpers'

let w: World | null = null
afterEach(async () => {
  await w?.close()
  w = null
})

const qcRequests = (w: World) => w.mock.log().filter((e) => e.kind === 'qc')
const extracts = (w: World) => imageRequests(w.mock).filter((r) => r.prompt!.includes('竞品商品图'))
const mains = (w: World) => imageRequests(w.mock).filter((r) => r.images.length === 2)

describe('e2e 13：素材图验收', () => {
  it('横幅文字变了 → 进需处理，原因里有两段文字，不生成主图；仍然使用后接着跑完', async () => {
    w = await startWorld()
    const api = w.api
    await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    w.mock.script({ qc: [{ qc: { source_texts: ['THE BENNETT FAMILY', 'Merry Christmas'], pattern_texts: ['AND A HAPPY NEW YEAR', 'Merry Christmas'] } }] })
    const [a] = await uploadJobs(api, ['bennett.png'])
    const bad = await waitJob(api, a.id, hasAttention('qc'), '进需处理')
    expect(bad.attention.step).toBe(1)
    expect(bad.attention.message).toContain('THE BENNETT FAMILY')
    expect(bad.attention.message).toContain('AND A HAPPY NEW YEAR')
    expect(bad.steps[1].state).toBe('failed')
    expect(bad.steps[2].state).toBe('pending')
    expect(bad.qc).toMatchObject({ state: 'fail', textOk: false, sourceTexts: ['THE BENNETT FAMILY', 'Merry Christmas'] })
    expect(bad.qc.snapshot.images.map((i: any) => i.role)).toEqual(['竞品图', '素材图'])
    expect(bad.qc.raw).toContain('AND A HAPPY NEW YEAR')

    // 一次验收只发一个分析请求，两张缩小后的 JPEG
    const q = qcRequests(w)
    expect(q).toHaveLength(1)
    expect(q[0]!.images.map((i) => i.field)).toEqual(['data:image/jpeg;base64', 'data:image/jpeg;base64'])
    expect(mains(w)).toHaveLength(0)
    // 没过验收的素材图不写进输出文件夹
    expect(fs.existsSync(path.join(w.outDir, bad.outputFolder, '铝板画', '素材图', 'bennett.png'))).toBe(false)

    const r = await api.json('POST', `/jobs/${a.id}/qc-accept`)
    expect(r.status).toBe(200)
    const done = await waitJob(api, a.id, isDone, '仍然使用后完成')
    expect(done.qc.state).toBe('bypassed')
    expect(fs.existsSync(path.join(onlyBatch(w), '铝板画', '素材图', 'bennett.png'))).toBe(true)
    expect(qcRequests(w)).toHaveLength(1)
    expect(w.srv.logs()).toContain('按你的选择仍然使用')
  })

  it('素材图验收只发一次分析请求（边框外延检查已去掉）', async () => {
    w = await startWorld()
    const api = w.api
    await makeCategory(api, '毛毯', [{ name: '', ratio: '4:5', white: [1200, 1500] }])
    const [a] = await uploadJobs(api, ['amelia.png'])
    const done = await waitJob(api, a.id, isDone)
    expect(done.qc.state).toBe('pass')
    expect(done.qc.border).toBeNull()
    expect(w.mock.log().filter((e) => e.kind === 'other')).toHaveLength(0)
    expect(qcRequests(w)).toHaveLength(1)
  })

  it('图案相似分低于阈值 → 进需处理；重新提取（改提示词）后再验收，合格就继续', async () => {
    w = await startWorld()
    const api = w.api
    await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    w.mock.script({ qc: [{ qc: { element_score: 0.5, element_issues: ['星星不见了', '雪花球变成了圆球'] } }] })
    const [a] = await uploadJobs(api, ['g.png'])
    const bad = await waitJob(api, a.id, hasAttention('qc'))
    expect(bad.attention.message).toContain('图案元素相似分 0.50，低于 0.90：星星不见了；雪花球变成了圆球')

    const r = await api.json('POST', `/jobs/${a.id}/redo`, { step: 1, prompt: '只要印刷面，星星和雪花球一个都不能少' })
    expect(r.status).toBe(200)
    const done = await waitJob(api, a.id, isDone)
    expect(done.qc.state).toBe('pass')
    expect(done.qc.color).toMatchObject({ checked: true, threshold: 5 })
    expect(done.qc.color.deltaE).toBeLessThan(2)
    expect(extracts(w)).toHaveLength(2)
    expect(extracts(w)[1]!.prompt).toContain('星星和雪花球一个都不能少')
    expect(qcRequests(w)).toHaveLength(2)
  })

  it('默认阈值 0.9：0.88（Bennett 实测分数）不合格', async () => {
    w = await startWorld()
    const api = w.api
    await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    w.mock.script({ qc: [{ qc: { element_score: 0.88, element_issues: ['房屋的造型明显变样'] } }] })
    const [a] = await uploadJobs(api, ['bennett.png'])
    const bad = await waitJob(api, a.id, hasAttention('qc'))
    expect(bad.attention.message).toContain('图案元素相似分 0.88，低于 0.90：房屋的造型明显变样')
  })

  it('四边的印刷边框（红色做旧边）丢了 → 进需处理', async () => {
    w = await startWorld()
    const api = w.api
    await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    w.mock.script({ qc: [{ qc: { edge_missing: ['四周的红色做旧边没了'], edge_extra: ['带着安装孔'] } }] })
    const [a] = await uploadJobs(api, ['henry.png'])
    const bad = await waitJob(api, a.id, hasAttention('qc'))
    expect(bad.attention.message).toBe('素材图没过验收：四边少了：四周的红色做旧边没了；四边多了：带着安装孔')
    expect(bad.qc).toMatchObject({ edgeMissing: ['四周的红色做旧边没了'], edgeExtra: ['带着安装孔'] })
  })

  it('阈值可改；关掉验收时一个验收请求都不发', async () => {
    w = await startWorld()
    const api = w.api
    await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    await api.json('PUT', '/settings', { patternQcThreshold: 0.4 })
    w.mock.script({ qc: [{ qc: { element_score: 0.5 } }] })
    const [a] = await uploadJobs(api, ['a.png'])
    expect((await waitJob(api, a.id, isDone)).qc).toMatchObject({ state: 'pass', score: 0.5, threshold: 0.4 })

    await api.json('PUT', '/settings', { patternQc: false })
    const before = qcRequests(w).length
    const [b] = await uploadJobs(api, ['b.png'])
    const bDone = await waitJob(api, b.id, isDone)
    expect(bDone.qc).toBeNull()
    expect(qcRequests(w).length).toBe(before)
    expect(fs.existsSync(path.join(onlyBatch(w), '铝板画', '素材图', 'b.png'))).toBe(true)
  })

  it('验收进行到一半服务被杀：重启后接着验收，不重新提取；验收时占分析并发、不占生图并发', async () => {
    w = await startWorld()
    const api = w.api
    await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    w.mock.script({ qc: [{ qc: {}, delay: 4000 }] })
    const [a] = await uploadJobs(api, ['a.png'])
    await waitFor(() => qcRequests(w!).length === 1, { label: '验收请求已发出' })
    const mid = await waitJob(api, a.id, (j) => j.view.label === '验收素材中')
    expect(mid.view.runningStep).toBe(1)
    const q = (await api.json('GET', '/queue')).body
    expect(q.slots.analysis.busy).toBe(1)
    expect(q.slots.image.busy).toBe(0)
    await w.restart({ kill: true })
    const done = await waitJob(w.api, a.id, isDone)
    expect(done.qc.state).toBe('pass')
    expect(extracts(w)).toHaveLength(1)
    expect(qcRequests(w)).toHaveLength(2)
  })

  it('验收请求本身一直出错 → 按重试规则，最终进需处理（失败），不当作合格；重试只重做验收', async () => {
    w = await startWorld()
    const api = w.api
    await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    w.mock.script({ qc: Array.from({ length: 5 }, () => ({ status: 500 })) })
    const [a] = await uploadJobs(api, ['a.png'])
    const failed = await waitJob(api, a.id, hasAttention('failed'))
    expect(failed.attention.step).toBe(1)
    expect(failed.attention.message).toMatch(/^素材图验收失败/)
    expect(failed.qc.state).toBe('pending')
    expect(qcRequests(w)).toHaveLength(5)
    expect(mains(w)).toHaveLength(0)
    await api.json('POST', `/jobs/${a.id}/retry`)
    expect((await waitJob(api, a.id, isDone)).qc.state).toBe('pass')
    expect(extracts(w)).toHaveLength(1)
  })
})

/** 灰色圆角矩形 + 四个孔，3:2 */
async function plate(): Promise<Buffer> {
  const holes = [
    [200, 150],
    [1300, 150],
    [200, 850],
    [1300, 850],
  ]
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="16" fill="#ffffff" stroke="#444" stroke-width="3"/>`)
    .join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="1000"><rect width="1500" height="1000" fill="#ffffff"/><rect x="150" y="100" width="1200" height="800" rx="40" fill="#9c9c9c" stroke="#555" stroke-width="3"/>${holes}</svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

describe('e2e 14：主图贴图方式', () => {
  it('正对镜头的矩形白底图自动判本地合成：不调生图接口；改成 AI 贴图后重做第③步就走 AI', async () => {
    w = await startWorld()
    const api = w.api
    const c = await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2' }])
    const sid = c.styles['']!
    const up = await api.upload('PUT', `/library/categories/${c.cid}/styles/${sid}/white`, 'file', [{ name: 'w.png', buffer: await plate(), type: 'image/png' }])
    expect(up.status).toBe(200)
    const hash = up.body.library.categories[0].styles[0].whiteImage
    expect(up.body.library.whiteChecks[hash]).toMatchObject({ ok: true, shape: 'rect', holes: 4 })
    const rc = await api.json('GET', `/library/recipe?cid=${c.cid}&sid=${sid}`)
    expect(rc.body.paste).toMatchObject({ setting: 'auto', mode: 'local', auto: { mode: 'local' } })

    const [a] = await uploadJobs(api, ['a.png'])
    const done = await waitJob(api, a.id, isDone)
    expect(done.steps[2].snapshot).toMatchObject({ mode: 'local', prompt: '本地合成，未调用 AI', prefix: '' })
    expect(done.steps[2].snapshot.images.map((i: any) => i.role)).toEqual(['白底图', '素材图'])
    expect(mains(w)).toHaveLength(0)
    const out = path.join(onlyBatch(w), '铝板画', '主图', 'a.png')
    const meta = await sharp(out).metadata()
    expect([meta.width, meta.height]).toEqual([1500, 1500])

    await api.json('PATCH', `/library/categories/${c.cid}/styles/${sid}`, { pasteMode: 'ai' })
    expect((await api.json('GET', `/library/recipe?cid=${c.cid}&sid=${sid}`)).body.paste).toMatchObject({ setting: 'ai', mode: 'ai', auto: { mode: 'local' } })
    await api.json('POST', `/jobs/${a.id}/redo`, { step: 2 })
    const again = await waitJob(api, a.id, (j) => isDone(j) && j.steps[2].snapshot?.mode === 'ai')
    expect(again.steps[2].snapshot.prefix).toContain(PASTE_CONSTRAINT)
    expect(mains(w)).toHaveLength(1)
    expect((await getJob(api, a.id)).plan.main.pasteMode).toBe('ai')
  })
})

const mainQcRequests = (w: World) => w.mock.log().filter((e) => e.kind === 'mainqc')

describe('e2e 15：主图验收（素材图 → 主图）', () => {
  it('AI 贴图：主图文字变了、没铺满 → 进需处理，不写进输出文件夹；仍然使用后接着跑完', async () => {
    w = await startWorld()
    const api = w.api
    await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    w.mock.script({ mainqc: [{ mainqc: { pattern_texts: ['THE BENNETT FAMILY'], main_texts: ['THE BENNET FAMILY'], fill_issues: ['印刷面右边露出了金属边'] } }] })
    const [a] = await uploadJobs(api, ['a.png'])
    const bad = await waitJob(api, a.id, hasAttention('qc'))
    expect(bad.attention.step).toBe(2)
    expect(bad.attention.message).toBe('主图没过验收：文字变了：素材图 THE BENNETT FAMILY → 主图 THE BENNET FAMILY；贴图：印刷面右边露出了金属边')
    expect(bad.steps[2].state).toBe('failed')
    expect(bad.steps[3].state).toBe('pending')
    expect(bad.mainQc).toMatchObject({ state: 'fail', mode: 'ai', fillIssues: ['印刷面右边露出了金属边'] })
    expect(bad.mainQc.snapshot.images.map((i: any) => i.role)).toEqual(['素材图', '主图'])
    const q = mainQcRequests(w)
    expect(q).toHaveLength(1)
    expect(q[0]!.images).toHaveLength(2)
    expect(fs.existsSync(path.join(w.outDir, bad.outputFolder, '铝板画', '主图', 'a.png'))).toBe(false)

    await api.json('POST', `/jobs/${a.id}/qc-accept`)
    const done = await waitJob(api, a.id, isDone)
    expect(done.mainQc.state).toBe('bypassed')
    expect(fs.existsSync(path.join(onlyBatch(w), '铝板画', '主图', 'a.png'))).toBe(true)
    expect(w.srv.logs()).toContain('主图没过验收')
  })

  it('AI 贴图：重做第③步后重新验收，合格就继续；颜色一致', async () => {
    w = await startWorld()
    const api = w.api
    await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    w.mock.script({ mainqc: [{ mainqc: { element_score: 0.6, element_issues: ['圣诞老人不见了'] } }] })
    const [a] = await uploadJobs(api, ['a.png'])
    const bad = await waitJob(api, a.id, hasAttention('qc'))
    expect(bad.attention.message).toContain('图案元素相似分 0.60，低于 0.90：圣诞老人不见了')
    await api.json('POST', `/jobs/${a.id}/redo`, { step: 2 })
    const done = await waitJob(api, a.id, isDone)
    expect(done.mainQc).toMatchObject({ state: 'pass', mode: 'ai' })
    expect(done.mainQc.color.checked).toBe(true)
    expect(done.mainQc.color.deltaE).toBeLessThan(2)
    expect(mains(w)).toHaveLength(2)
    expect(mainQcRequests(w)).toHaveLength(2)
  })

  it('主图验收进行到一半服务被杀：重启后接着验收，不重新生成', async () => {
    w = await startWorld()
    const api = w.api
    await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    w.mock.script({ mainqc: [{ mainqc: {}, delay: 4000 }] })
    const [a] = await uploadJobs(api, ['a.png'])
    await waitFor(() => mainQcRequests(w!).length === 1, { label: '主图验收请求已发出' })
    const mid = await waitJob(api, a.id, (j) => j.view.label === '验收主图中')
    expect(mid.view.runningStep).toBe(2)
    expect((await api.json('GET', '/queue')).body.slots).toMatchObject({ analysis: { busy: 1 }, image: { busy: 0 } })
    await w.restart({ kill: true })
    expect((await waitJob(w.api, a.id, isDone)).mainQc.state).toBe('pass')
    expect(mains(w)).toHaveLength(1)
    expect(mainQcRequests(w)).toHaveLength(2)
  })

  it('本地合成：本地核对，不发主图验收请求；关掉主图验收也不发', async () => {
    w = await startWorld()
    const api = w.api
    const c = await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2' }])
    await api.upload('PUT', `/library/categories/${c.cid}/styles/${c.styles['']!}/white`, 'file', [{ name: 'w.png', buffer: await plate(), type: 'image/png' }])
    const [a] = await uploadJobs(api, ['a.png'])
    const done = await waitJob(api, a.id, isDone)
    expect(done.mainQc).toMatchObject({ state: 'pass', mode: 'local', reasons: [] })
    expect(done.mainQc.color.deltaE).toBeLessThan(1)
    expect(mainQcRequests(w)).toHaveLength(0)

    await api.json('PUT', '/settings', { mainQc: false })
    await api.json('PATCH', `/library/categories/${c.cid}/styles/${c.styles['']!}`, { pasteMode: 'ai' })
    const [b] = await uploadJobs(api, ['b.png'])
    expect((await waitJob(api, b.id, isDone)).mainQc).toBeNull()
    expect(mainQcRequests(w)).toHaveLength(0)
    expect(fs.existsSync(path.join(onlyBatch(w), '铝板画', '主图', 'b.png'))).toBe(true)
  })
})

describe('e2e 16：先定印刷面区域，再按区域提取', () => {
  it('识别品类时给出四个角 → 只把拉正后的印刷面发给生图模型；验收拿印刷面对照', async () => {
    w = await startWorld()
    const api = w.api
    const c = await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    w.mock.script({
      route: [{ route: { category_id: c.cid, style_id: null, confidence: 0.95, print_corners: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]] } }],
    })
    const [a] = await uploadJobs(api, ['a.png'])
    const done = await waitJob(api, a.id, isDone)
    expect(done.face.ai).toEqual([[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]])
    expect(done.face.corners[0][0]).toBeLessThan(0.1)
    expect(done.steps[1].snapshot.images.map((i: any) => i.role)).toEqual(['印刷面'])
    expect(done.steps[1].snapshot.prefix).toContain(FACE_CONSTRAINT)

    const ex = imageRequests(w.mock).filter((r) => r.prompt!.includes('商品印刷面'))
    expect(ex).toHaveLength(1)
    expect(ex[0]!.prompt!.startsWith('[Canvas: 3:2 landscape format] 第一张图片是从竞品图裁出并拉正的商品印刷面。\n')).toBe(true)
    const [img] = ex[0]!.images
    expect(Math.abs(img!.width / img!.height - 1.5)).toBeLessThan(0.01)
    expect(img!.width).toBeLessThan(800)

    expect(done.qc.snapshot.images.map((i: any) => i.role)).toEqual(['印刷面', '素材图'])
    expect(qcRequests(w)[0]!.system).toContain('按透视拉正的商品印刷面')
    expect(done.qc.color.box).toEqual([0, 0, 1, 1])
    expect((await api.raw(`/jobs/${a.id}/files/face`)).status).toBe(200)
  })

  it('竞品图里商品有变形（print_flat=false）→ 不框选，整张竞品图 + 场景矫正约束；尺寸按款式精确比例', async () => {
    w = await startWorld()
    const api = w.api
    const c = await makeCategory(api, '毛毯', [{ name: '', ratio: '4:5', white: [1200, 1500] }])
    w.mock.script({
      route: [{ route: { category_id: c.cid, style_id: null, confidence: 0.95, print_flat: false, print_corners: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]] } }],
    })
    const [a] = await uploadJobs(api, ['draped.png'])
    const done = await waitJob(api, a.id, isDone)
    expect(done.deformed).toBe(true)
    expect(done.face).toBeNull()
    expect(done.steps[1].snapshot.images.map((i: any) => i.role)).toEqual(['竞品图'])
    expect(done.steps[1].snapshot.prefix).toBe('[Canvas: 4:5 portrait format] 第一张图片是竞品商品图。\n' + SCENE_CONSTRAINT + '\n')
    const ex = imageRequests(w.mock).filter((r) => r.prompt!.includes(SCENE_CONSTRAINT))
    expect(ex).toHaveLength(1)
    expect(ex[0]!.fields.size).toBe('1232x1536')
    expect(ex[0]!.images.map((i) => [i.width, i.height])).toEqual([[800, 600]])
    expect(done.qc.snapshot.images.map((i: any) => i.role)).toEqual(['竞品图', '素材图'])
  })

  it('区域框错了：第②步重做时选「按整张竞品图提取」', async () => {
    w = await startWorld()
    const api = w.api
    const c = await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    w.mock.script({ route: [{ route: { category_id: c.cid, style_id: null, confidence: 0.95, print_corners: [[0.2, 0.2], [0.8, 0.2], [0.8, 0.6], [0.2, 0.6]] } }] })
    const [a] = await uploadJobs(api, ['a.png'])
    expect((await waitJob(api, a.id, isDone)).steps[1].snapshot.images[0].role).toBe('印刷面')
    await api.json('POST', `/jobs/${a.id}/redo`, { step: 1, wholePhoto: true })
    const again = await waitJob(api, a.id, (j) => isDone(j) && j.steps[1].snapshot?.images[0].role === '竞品图')
    expect(again.face).toBeNull()
    expect(again.qc.snapshot.images[0].role).toBe('竞品图')
    expect((await api.raw(`/jobs/${a.id}/files/face`)).status).toBe(404)
  })

  it('款式方向和印刷面方向对不上 → 不硬拉，照旧按整张竞品图提取', async () => {
    w = await startWorld()
    const api = w.api
    const c = await makeCategory(api, '铝板画', [{ name: '', ratio: '2:3', white: [1000, 1500] }])
    w.mock.script({ route: [{ route: { category_id: c.cid, style_id: null, confidence: 0.95, print_corners: [[0.05, 0.2], [0.95, 0.2], [0.95, 0.7], [0.05, 0.7]] } }] })
    const [a] = await uploadJobs(api, ['a.png'])
    const done = await waitJob(api, a.id, isDone)
    expect(done.face).not.toBeNull()
    expect(done.steps[1].snapshot.images[0].role).toBe('竞品图')
    expect(w.srv.logs()).toContain('和款式比例 2:3 差太多，这次按整张竞品图提取')
  })

  it('没给四个角（或给得不对）→ 照旧按整张竞品图提取', async () => {
    w = await startWorld()
    const api = w.api
    const c = await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    w.mock.script({ route: [{ route: { category_id: c.cid, style_id: null, confidence: 0.95, print_corners: [[0.1, 0.1], [0.9, 0.1], [0.5, 0.3], [0.1, 0.9]] } }] })
    const [a] = await uploadJobs(api, ['a.png'])
    const done = await waitJob(api, a.id, isDone)
    expect(done.face).toBeNull()
    expect(w.srv.logs()).toContain('AI 给的印刷面四个角不合格，按整张图提取')
    expect(done.steps[1].snapshot.images.map((i: any) => i.role)).toEqual(['竞品图'])
    expect(extracts(w)).toHaveLength(1)
  })
})

