import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { startMockRelay, type MockRelay } from '../../scripts/mock-relay'
import { startInProcess } from '../inprocess'
import { makeCategory, uploadJobs, waitJob, isDone, getJob } from './harness'
import { resetAppToken } from '../../server/src/parent/feishu'

let mock: MockRelay
let srv: Awaited<ReturnType<typeof startInProcess>>

const URL_ = 'https://x.feishu.cn/wiki/wikiP'
const color = (v: string) => ({ color: [{ value: v }] })

/** 实施方案里的三个真实父体和它们的子体 */
function seed(m: MockRelay) {
  m.parent.feishu.wiki.wikiP = 'shtP'
  m.parent.feishu.sheets.shtP = {
    title: '父体分类汇总',
    tabs: [
      {
        sheet_id: 's1',
        title: '铝板画',
        values: [
          ['主题', '父体SKU', '父体ASIN'],
          ['圣诞节婴儿', 'HJ-cn-yklgj-Christmas Baby', 'B0HKJ8G5QP'],
          ['圣诞节挂件', 'HJ-cn-yklgj-Christmas', 'B0HKN6DD1K'],
          ['圣诞节小笼包挂件', 'HJ-cn-yklgj5-Christmas Dumpling', 'B0HKVTLKHX'],
        ],
      },
    ],
  }
  const kids = (parent: string, names: string[]) => names.map((n, i) => ({ sku: `${parent}-k${i}`, parentSku: parent, attributes: color(n) }))
  m.parent.spapi.listings = [
    { sku: 'HJ-cn-yklgj-Christmas Baby', asin: 'B0HKJ8G5QP', variationTheme: ['color'] },
    { sku: 'HJ-cn-yklgj-Christmas', asin: 'B0HKN6DD1K', variationTheme: ['color'] },
    { sku: 'HJ-cn-yklgj5-Christmas Dumpling', asin: 'B0HKVTLKHX', variationTheme: ['color'] },
    ...kids('HJ-cn-yklgj-Christmas Baby', ['Design 01', 'Design 02', 'Design 03', 'Design 04']),
    ...kids('HJ-cn-yklgj-Christmas', ['Design 01', 'Design 02', 'Design 03', 'Design 04', 'Design 05']),
    ...kids('HJ-cn-yklgj5-Christmas Dumpling', ['Design 02', 'Design 03', 'Ceramic']),
  ]
}

beforeEach(async () => {
  mock = await startMockRelay()
  resetAppToken()
  seed(mock)
  srv = await startInProcess()
  const { ctx } = srv
  await ctx.settings.update({
    image: { baseUrl: mock.url, apiKey: 'sk-test-image-0001', concurrency: 2 },
    analysis: { baseUrl: mock.url, apiKey: 'sk-test-chat-0002', concurrency: 3 },
    parent: {
      enabled: true,
      sheetUrl: URL_,
      feishu: { appId: mock.parent.feishu.appId, appSecret: mock.parent.feishu.appSecret },
      spapi: { sellerId: mock.parent.spapi.sellerId, clientId: mock.parent.spapi.clientId, clientSecret: mock.parent.spapi.clientSecret, refreshToken: mock.parent.spapi.refreshToken },
    },
  })
  await ctx.settings.updateParent((p) => {
    p.feishu.baseUrl = mock.origin
    Object.assign(p.spapi, { endpoint: mock.origin, tokenUrl: mock.origin + '/auth/o2/token' })
  })
  ctx.onSettingsSaved()
})
afterEach(async () => {
  await srv.close()
  await mock.close()
})

const parentReqs = () => mock.log().filter((e) => e.kind === 'parent')

describe('e2e 17：第 6 步匹配父体', () => {
  it('挑中已有父体：查店铺推算下一个变体名；同一批同父体依次往后排，不撞号', async () => {
    const api = srv.api
    await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    mock.script({ parent: [1, 2, 3].map(() => ({ parent: { pick: 1, confidence: 0.92, alternatives: [2], reason: '圣诞婴儿' } })) })
    const jobs = await uploadJobs(api, ['a.png', 'b.png', 'c.png'])
    const done = await Promise.all(jobs.map((j) => waitJob(api, j.id, isDone, j.source.originalName)))
    const names = done.map((j) => j.parent.naming.next).sort()
    expect(names).toEqual(['Design 05', 'Design 06', 'Design 07'])
    const a = done[0]
    expect(a.parent).toMatchObject({ status: 'matched', tab: '铝板画', sku: 'HJ-cn-yklgj-Christmas Baby', asin: 'B0HKJ8G5QP', theme: '圣诞节婴儿', confidence: 0.92, manual: false })
    expect(a.parent.candidates.map((c: any) => c.sku)).toEqual(['HJ-cn-yklgj-Christmas Baby', 'HJ-cn-yklgj-Christmas'])
    expect(a.parent.naming).toMatchObject({ attribute: 'color', groups: [{ pattern: 'Design ##', count: 4 }], key: 'Design ##' })
    // 快照：发了竞品图、候选清单、提示词
    expect(a.steps[5].snapshot.images.map((i: any) => i.role)).toEqual(['竞品图'])
    expect(a.steps[5].snapshot.params.user).toContain('1｜圣诞节婴儿｜HJ-cn-yklgj-Christmas Baby')
    expect(parentReqs()).toHaveLength(3)
    const csvFile = path.join(srv.ctx.settings.get().outputDir, done[0].outputFolder, '识别信息.csv')
    const csv = fs.readFileSync(csvFile, 'utf8')
    expect(csv).toContain('父体主题,父体SKU,父体ASIN,建议变体名,父体把握,父体状态')
    expect(csv).toContain('HJ-cn-yklgj-Christmas Baby')
    // 只读：对店铺除了换 token 全是 GET，对飞书除了换 token 全是 GET
    expect(mock.parent.calls.filter((c) => c.method !== 'GET' && c.path !== '/token' && c.path !== '/auth/v3/tenant_access_token/internal')).toEqual([])
  })

  it('命名有多种时按数量最多的那种排：Dumpling → Design 04；把握低于阈值标待确认', async () => {
    const api = srv.api
    await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    mock.script({ parent: [{ parent: { pick: 3, confidence: 0.5 } }] })
    const [a] = await uploadJobs(api, ['a.png'])
    const done = await waitJob(api, a.id, isDone)
    expect(done.parent).toMatchObject({ status: 'unsure', sku: 'HJ-cn-yklgj5-Christmas Dumpling', message: '把握只有 0.50，低于 0.70，请确认' })
    expect(done.parent.naming.next).toBe('Design 04')
    expect(done.attention).toBeNull()
  })

  it('都不合适：建议新建父体；同一批两张图共用同一个新 SKU，子体 Design 01、Design 02', async () => {
    const api = srv.api
    await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    mock.script({ parent: [1, 2].map(() => ({ parent: { pick: null, confidence: 0.2, new_themes: ['Snowman', 'Winter'] } })) })
    const jobs = await uploadJobs(api, ['a.png', 'b.png'])
    const done = await Promise.all(jobs.map((j) => waitJob(api, j.id, isDone)))
    for (const d of done) {
      expect(d.parent).toMatchObject({ status: 'new', sku: 'HJ-cn-yklgj5-Snowman', asin: null, theme: 'Snowman' })
      expect(d.parent.proposal).toMatchObject({ prefix: 'HJ-cn-yklgj5', theme: 'Snowman', themeCandidates: ['Snowman', 'Winter'] })
      expect(d.parent.naming.note).toBe('这是建议新建的父体，飞书表和店铺里都还没有，需要你手动创建')
    }
    expect(done.map((d) => d.parent.naming.next).sort()).toEqual(['Design 01', 'Design 02'])
  })

  it('品类没有对应标签页：完成，状态「没有合适的父体」，不问 AI', async () => {
    const api = srv.api
    await makeCategory(api, '相框', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    const [a] = await uploadJobs(api, ['a.png'])
    const done = await waitJob(api, a.id, isDone)
    expect(done.parent).toMatchObject({ status: 'none', message: '飞书表里没有「相框」标签页，去模版库给「相框」选对应的标签页' })
    expect(parentReqs()).toHaveLength(0)
  })

  it('店铺里查不到挑中的父体 SKU：待确认', async () => {
    const api = srv.api
    await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    mock.parent.spapi.listings = mock.parent.spapi.listings.filter((l) => l.sku !== 'HJ-cn-yklgj-Christmas')
    mock.script({ parent: [{ parent: { pick: 2, confidence: 0.95 } }] })
    const [a] = await uploadJobs(api, ['a.png'])
    expect((await waitJob(api, a.id, isDone)).parent).toMatchObject({ status: 'unsure', message: '店铺里查不到这个父体 SKU，检查飞书表里的 SKU 是否写对', naming: null })
  })

  it('飞书凭证不对：只暂停第 6 步，前 5 步照常；改好设置后自动继续', async () => {
    const api = srv.api
    await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    await api.json('PUT', '/settings', { parent: { feishu: { appSecret: 'wrong-secret-9999' } } })
    const [a] = await uploadJobs(api, ['a.png'])
    const paused = await waitJob(api, a.id, (j) => j.steps[4].state !== 'pending' && j.steps[5].error)
    expect(paused.steps.slice(0, 5).map((s: any) => s.state)).toEqual(['done', 'done', 'done', 'done', 'done'])
    expect(paused.steps[5].state).toBe('pending')
    expect(paused.attention).toBeNull()
    const q = (await api.json('GET', '/queue')).body
    expect(q.parentPaused).toContain('App ID 或 App Secret 不对')
    expect(q.paused).toBeNull()
    // 第 6 步暂停期间，新图的前 5 步照样跑
    const [b] = await uploadJobs(api, ['b.png'])
    await waitJob(api, b.id, (j) => j.steps[4].state !== 'pending')
    await api.json('PUT', '/settings', { parent: { feishu: { appSecret: mock.parent.feishu.appSecret } } })
    resetAppToken()
    expect((await waitJob(api, a.id, isDone)).parent.status).toBe('matched')
    expect((await waitJob(api, b.id, isDone)).parent.status).toBe('matched')
    expect((await api.json('GET', '/queue')).body.parentPaused).toBeNull()
  })

  it('手动换父体：只重算命名，标 manual；换走后原来的号释放；删任务不释放（同一批里还占着）', async () => {
    const api = srv.api
    await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    mock.script({ parent: [1, 2].map(() => ({ parent: { pick: 1, confidence: 0.9 } })) })
    const [a, b] = await uploadJobs(api, ['a.png', 'b.png'])
    const [da, db] = await Promise.all([waitJob(api, a.id, isDone), waitJob(api, b.id, isDone)])
    const first = [da, db].find((d) => d.parent.naming.next === 'Design 05')!
    const second = [da, db].find((d) => d.parent.naming.next === 'Design 06')!
    const before = parentReqs().length
    const r = await api.json('POST', `/jobs/${first.id}/parent`, { sku: 'HJ-cn-yklgj-Christmas' })
    expect(r.status).toBe(200)
    expect(r.body.job.parent).toMatchObject({ status: 'matched', manual: true, sku: 'HJ-cn-yklgj-Christmas', theme: '圣诞节挂件', naming: { next: 'Design 06' } })
    expect(parentReqs()).toHaveLength(before)
    // second 重新匹配：Design 05 已经释放
    mock.script({ parent: [{ parent: { pick: 1, confidence: 0.9 } }] })
    await api.json('POST', `/jobs/${second.id}/redo`, { step: 5 })
    expect((await waitJob(api, second.id, (j) => isDone(j) && j.parent)).parent.naming.next).toBe('Design 05')
    // 删掉 second：它的 05 在同一批里还占着，first 换回 Christmas Baby 拿到 06
    await api.json('DELETE', `/jobs/${second.id}`)
    const back = await api.json('POST', `/jobs/${first.id}/parent`, { sku: 'HJ-cn-yklgj-Christmas Baby' })
    expect(back.body.job.parent.naming.next).toBe('Design 06')
  })

  it('手动换父体失败（店铺一直限流）：什么都不改，原来的号还占着，别的图不会拿到同一个号', async () => {
    const api = srv.api
    await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    const [x] = await uploadJobs(api, ['x.png'])
    const dx = await waitJob(api, x.id, isDone)
    expect(dx.parent.naming.next).toBe('Design 05')
    mock.parent.spapi.throttle = 100
    const r = await api.json('POST', `/jobs/${x.id}/parent`, { sku: 'HJ-cn-yklgj-Christmas' })
    expect(r.status).toBe(502)
    expect((await getJob(api, x.id)).parent).toMatchObject({ sku: 'HJ-cn-yklgj-Christmas Baby', naming: { next: 'Design 05' } })
    mock.parent.spapi.throttle = 0
    const [y] = await uploadJobs(api, ['y.png'])
    expect((await waitJob(api, y.id, isDone)).parent.naming.next).toBe('Design 06')
  })

  it('AI 说没有合适的父体却没给新主题：说明原因，不说「都已存在」', async () => {
    const api = srv.api
    await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    mock.script({ parent: [{ parent: { pick: null, confidence: 0.1, new_themes: [] } }] })
    const [a] = await uploadJobs(api, ['a.png'])
    expect((await waitJob(api, a.id, isDone)).parent).toMatchObject({ status: 'none', message: 'AI 认为表里没有合适的父体，但没给出新主题；可以手动选父体，或点「重新匹配」' })
  })

  it('同一批里「清除已完成」后号还占着，新图接着往后排；清空队列开新文件夹后重新算', async () => {
    const api = srv.api
    await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    const first = await uploadJobs(api, ['a.png', 'b.png', 'c.png'])
    await Promise.all(first.map((j) => waitJob(api, j.id, isDone)))
    expect((await api.json('POST', '/jobs/clear-done')).body.removed).toBe(3)
    const more = await uploadJobs(api, ['d.png', 'e.png'])
    const md = await Promise.all(more.map((j) => waitJob(api, j.id, isDone)))
    expect(md.map((d) => d.parent.naming.next).sort()).toEqual(['Design 08', 'Design 09'])
    // 单张删除也不释放（CSV 里还有这一行）
    await api.json('DELETE', `/jobs/${md[0].id}`)
    const [f] = await uploadJobs(api, ['f.png'])
    expect((await waitJob(api, f.id, isDone)).parent.naming.next).toBe('Design 10')
    // 清空队列开新文件夹：只看店铺和新队列
    await api.json('POST', '/jobs/clear-all')
    const [g] = await uploadJobs(api, ['g.png'])
    const gd = await waitJob(api, g.id, isDone)
    expect(gd.outputFolder).not.toBe(md[1].outputFolder)
    expect(gd.parent.naming.next).toBe('Design 05')
  })

  it('变体名上下调：跳过店铺里已有的和别的图占着的号；往下没有空号时报错', async () => {
    const api = srv.api
    await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    const js = await uploadJobs(api, ['a.png', 'b.png', 'c.png'])
    const ds = await Promise.all(js.map((j) => waitJob(api, j.id, isDone)))
    const five = ds.find((d) => d.parent.naming.next === 'Design 05')!
    const up = await api.json('POST', `/jobs/${five.id}/parent/shift`, { delta: 1 })
    expect(up.body.job.parent.naming).toMatchObject({ next: 'Design 08', number: 8 })
    const down = await api.json('POST', `/jobs/${five.id}/parent/shift`, { delta: -1 })
    expect(down.body.job.parent.naming.next).toBe('Design 05')
    const none = await api.json('POST', `/jobs/${five.id}/parent/shift`, { delta: -1 })
    expect(none.status).toBe(400)
    expect(none.body.error).toBe('再往下都被占了，没有更小的可用编号')
  })

  it('关掉开关：还没跑到第 6 步的图直接跳过，已经匹配好的保留', async () => {
    const api = srv.api
    await makeCategory(api, '铝板画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    const [a] = await uploadJobs(api, ['a.png'])
    const done = await waitJob(api, a.id, isDone)
    expect(done.parent.status).toBe('matched')
    await api.json('PUT', '/settings', { parent: { enabled: false } })
    const before = mock.parent.calls.length
    const [b] = await uploadJobs(api, ['b.png'])
    const bd = await waitJob(api, b.id, isDone)
    expect(bd.steps[5]).toMatchObject({ state: 'skipped', note: '识别父体没有打开，可以在设置里打开' })
    expect(mock.parent.calls.length).toBe(before)
    expect((await getJob(api, a.id)).parent.status).toBe('matched')
  })
})
