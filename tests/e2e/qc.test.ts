import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { startWorld, makeCategory, uploadJobs, waitJob, isDone, hasAttention, imageRequests, getJob, onlyBatch, type World } from './harness'
import { PASTE_CONSTRAINT } from '../../server/src/prompts/main'
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

  it('图案相似分低于阈值 → 进需处理；重新提取（改提示词）后再验收，合格就继续', async () => {
    w = await startWorld()
    const api = w.api
    await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    w.mock.script({ qc: [{ qc: { element_score: 0.5, element_issues: ['星星不见了', '雪花球变成了圆球'] } }] })
    const [a] = await uploadJobs(api, ['g.png'])
    const bad = await waitJob(api, a.id, hasAttention('qc'))
    expect(bad.attention.message).toContain('图案元素相似分 0.50，低于 0.80：星星不见了；雪花球变成了圆球')

    const r = await api.json('POST', `/jobs/${a.id}/redo`, { step: 1, prompt: '只要印刷面，星星和雪花球一个都不能少' })
    expect(r.status).toBe(200)
    const done = await waitJob(api, a.id, isDone)
    expect(done.qc.state).toBe('pass')
    expect(extracts(w)).toHaveLength(2)
    expect(extracts(w)[1]!.prompt).toContain('星星和雪花球一个都不能少')
    expect(qcRequests(w)).toHaveLength(2)
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
