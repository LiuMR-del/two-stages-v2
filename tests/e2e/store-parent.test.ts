import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { startMockRelay, type MockRelay } from '../../scripts/mock-relay'
import type { MockListing } from '../../scripts/mock-parent'
import { startInProcess } from '../inprocess'
import { makeCategory, uploadJobs, waitJob, isDone, getJob } from './harness'
import { localDay } from '../../server/src/util/ids'

/** 多店铺方案第 4 段：爱睿特（没有飞书父体表）从店铺扫描结果挑父体；子体材质编码跟着父体走 */

let mock: MockRelay
let srv: Awaited<ReturnType<typeof startInProcess>>
const color = (v: string) => ({ color: [{ value: v }] })
const ymd = () => {
  const [y, m, d] = localDay().split('-')
  return `${y!.slice(-1)}7${m}${d}`
}

/** 照着爱睿特店里的真实写法造：毛毯父体两代（主题式 / 日期码），子体编码是 cn-mtfl，变体名 Style## */
function seed(m: MockRelay) {
  const L: MockListing[] = [
    { sku: 'mtfl760820700-P', asin: 'B0OLD', variationTheme: ['color'], productType: 'BLANKET', title: 'LOPHAW Personalized Halloween Throw Blanket', createdAt: '2026-08-20T00:00:00Z' },
    { sku: 'mtfl760820701', parentSku: 'mtfl760820700-P', productType: 'BLANKET', attributes: color('Style01'), createdAt: '2026-08-20T01:00:00Z' },
    { sku: 'ART-cn-mtfl-cookie', asin: 'B0COOKIE', variationTheme: ['color'], productType: 'BLANKET', title: 'LOPHAW Gingerbread Christmas Throw Blanket', createdAt: '2026-10-27T00:00:00Z' },
    { sku: 'ART-cn-mtfl-671027701', parentSku: 'ART-cn-mtfl-cookie', productType: 'BLANKET', attributes: color('Style01'), createdAt: '2026-10-27T01:00:00Z' },
    { sku: 'ART-cn-mtfl-671027702', parentSku: 'ART-cn-mtfl-cookie', productType: 'BLANKET', attributes: color('Style02'), createdAt: '2026-10-27T02:00:00Z' },
    { sku: 'ART-cn-mtfl-Dumpling', asin: 'B0DUMP', variationTheme: ['color'], productType: 'BLANKET', title: 'LOPHAW Dumpling Blanket', createdAt: '2026-10-28T00:00:00Z' },
    { sku: 'ART-cn-mtfl671028701', parentSku: 'ART-cn-mtfl-Dumpling', productType: 'BLANKET', attributes: color('Style01'), createdAt: '2026-10-28T01:00:00Z' },
    // 别的商品类型：不进毛毯的候选
    { sku: 'ART-cn-yklgj-Farm', asin: 'B0FARM', variationTheme: ['color'], productType: 'HANGING_ORNAMENT', title: 'Farm Ornament', createdAt: '2026-11-01T00:00:00Z' },
  ]
  m.parent.spapi.listings = L
}

beforeEach(async () => {
  mock = await startMockRelay()
  seed(mock)
  srv = await startInProcess()
  const { ctx } = srv
  await ctx.settings.update({
    image: { baseUrl: mock.url, apiKey: 'sk-test-image-0001', concurrency: 2 },
    analysis: { baseUrl: mock.url, apiKey: 'sk-test-chat-0002', concurrency: 3 },
    parent: { enabled: true },
  })
  const sp = mock.parent.spapi
  await ctx.settings.updateStoreRaw('art', (st) =>
    Object.assign(st.spapi, { sellerId: sp.sellerId, clientId: sp.clientId, clientSecret: sp.clientSecret, refreshToken: sp.refreshToken, endpoint: mock.origin, tokenUrl: mock.origin + '/auth/o2/token' }),
  )
  expect((await srv.api.json('POST', '/stores/art/use')).status).toBe(200)
  ctx.onSettingsSaved()
})
afterEach(async () => {
  await srv.close()
  await mock.close()
})

async function blanket() {
  const api = srv.api
  const c = await makeCategory(api, '毛毯', [{ name: '', ratio: '4:5', white: [1200, 1500] }])
  // 模版库里毛毯的编码是 mtfl，店里这类父体下的子体都是 cn-mtfl
  expect((await api.json('PATCH', `/library/categories/${c.cid}`, { skuCode: 'mtfl' })).status).toBe(200)
  return c
}

describe('e2e：爱睿特从店铺挑父体', () => {
  it('品类没选店铺商品类型：提示去模版库选，不问 AI', async () => {
    const api = srv.api
    await blanket()
    const [a] = await uploadJobs(api, ['a.png'])
    const d = await waitJob(api, a.id, isDone)
    expect(d.parent).toMatchObject({ status: 'none' })
    expect(d.parent.message).toContain('店铺商品类型')
    expect(mock.log().filter((e) => e.kind === 'parent')).toHaveLength(0)
  })

  it('挑中已有父体：候选只有毛毯类、带商品标题；变体名往下排；子体 SKU 跟着父体下的子体改成 cn-mtfl，三个文件改名', async () => {
    const api = srv.api
    const c = await blanket()
    expect((await api.json('PATCH', `/library/categories/${c.cid}`, { productTypes: ['blanket'] })).status).toBe(200)
    expect((await api.json('PATCH', `/library/categories/${c.cid}`, { productTypes: ['bad type'] })).status).toBe(400)
    // 候选按新到旧：1 Dumpling、2 cookie、3 日期码父体
    mock.script({ parent: [{ parent: { pick: 2, confidence: 0.9, alternatives: [3], reason: '姜饼' } }] })
    const [a] = await uploadJobs(api, ['a.png'])
    const d = await waitJob(api, a.id, isDone)
    expect(d.parent).toMatchObject({ status: 'matched', sku: 'ART-cn-mtfl-cookie', asin: 'B0COOKIE', theme: 'cookie', tab: 'BLANKET' })
    expect(d.parent.naming).toMatchObject({ next: 'Style03', key: 'Style##' })
    const user = d.steps[5].snapshot.params.user as string
    expect(user).toContain('1｜Dumpling｜ART-cn-mtfl-Dumpling｜LOPHAW Dumpling Blanket')
    expect(user).toContain('3｜（没写主题）｜mtfl760820700-P｜LOPHAW Personalized Halloween Throw Blanket')
    expect(user).not.toContain('Farm')
    expect(d.steps[5].snapshot.prompt).toContain('店铺里「BLANKET」的父体清单')
    expect(d.steps[5].snapshot.prompt).toContain('父体的材质要和这张图的品类一致')
    // 子体 SKU：ART-mtfl… → ART-cn-mtfl…（新前缀下重新取号），文件跟着改
    expect(d.sku).toBe(`ART-cn-mtfl${ymd()}001`)
    expect(d.skuNote).toContain('按父体 ART-cn-mtfl-cookie 下的子体改成 cn-mtfl（原 mtfl）')
    expect(d.skuMeta).toMatchObject({ code: 'cn-mtfl', was: [`ART-mtfl${ymd()}001`] })
    const dir = path.join(srv.ctx.settings.get().outputDir, d.outputFolder, '毛毯')
    expect(fs.existsSync(path.join(dir, '主图', `${d.sku}.png`))).toBe(true)
    expect(fs.existsSync(path.join(dir, '素材图', `${d.sku}.png`))).toBe(true)
    expect(fs.existsSync(path.join(dir, '主图', `ART-mtfl${ymd()}001.png`))).toBe(false)
    // CSV 在第 6 步完成后才重写，等它写好
    const csvFile = path.join(srv.ctx.settings.get().outputDir, d.outputFolder, '识别信息.csv')
    await vi.waitFor(() => expect(fs.readFileSync(csvFile, 'utf8')).toContain(`a.png,${d.sku},毛毯`))
    // 只读
    expect(mock.parent.calls.filter((x) => x.method !== 'GET' && x.path !== '/token')).toEqual([])
  })

  it('都不合适：按主题式父体的前缀建议新父体（不加专属号），第一个变体名照同品类最近父体的 Style## 写法', async () => {
    const api = srv.api
    const c = await blanket()
    await api.json('PATCH', `/library/categories/${c.cid}`, { productTypes: ['BLANKET'] })
    mock.script({ parent: [{ parent: { pick: null, confidence: 0.2, new_themes: ['cookie', 'Snowman'] } }] })
    const [a] = await uploadJobs(api, ['a.png'])
    const d = await waitJob(api, a.id, isDone)
    // cookie 和店里的 ART-cn-mtfl-cookie 重名（快照里查到，不用再查店铺），用第二个
    expect(d.parent).toMatchObject({ status: 'new', sku: 'ART-cn-mtfl-Snowman', proposal: { prefix: 'ART-cn-mtfl' } })
    expect(d.parent.naming.next).toBe('Style01')
    expect(d.parent.naming.note).toContain('参照同品类最近的父体')
    // 子体编码跟新父体前缀一致
    expect(d.sku).toBe(`ART-cn-mtfl${ymd()}001`)
    expect((await getJob(api, a.id)).skuNote).toContain('按建议新建的父体 ART-cn-mtfl')
  })

  it('店里这类父体都是日期码的（爱睿特帆布画）：新父体前缀用「店铺缩写-材质缩写」', async () => {
    const api = srv.api
    mock.parent.spapi.listings = [
      { sku: 'xkfb760901700-P', variationTheme: ['color'], productType: 'WALL_ART', title: 'LOPHAW Cat Memorial Canvas', createdAt: '2026-09-01T00:00:00Z' },
      { sku: 'xkfb760901701', parentSku: 'xkfb760901700-P', productType: 'WALL_ART', attributes: color('Style01'), createdAt: '2026-09-01T01:00:00Z' },
    ]
    srv.ctx.parent.index.clear()
    const c = await makeCategory(api, '帆布画', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    await api.json('PATCH', `/library/categories/${c.cid}`, { skuCode: 'xkfb', productTypes: ['WALL_ART'] })
    mock.script({ parent: [{ parent: { pick: null, confidence: 0.1, new_themes: ['Dog Memorial'] } }] })
    const [a] = await uploadJobs(api, ['a.png'])
    const d = await waitJob(api, a.id, isDone)
    expect(d.parent).toMatchObject({ status: 'new', sku: 'ART-xkfb-Dog Memorial', proposal: { prefix: 'ART-xkfb' } })
    // 给 AI 的主题样例里没有凑数用的占位主题
    expect(d.steps[5].snapshot.prompt).not.toContain('Theme')
  })

  it('横版标记：建议新建父体时保留自己的 HB；挑中的父体下子体都不带标记时去掉', async () => {
    const api = srv.api
    mock.parent.spapi.listings = [
      { sku: 'xkfb760901700-P', asin: 'B0CAT', variationTheme: ['color'], productType: 'WALL_ART', title: 'LOPHAW Cat Memorial Canvas', createdAt: '2026-09-01T00:00:00Z' },
      { sku: 'xkfb760901701', parentSku: 'xkfb760901700-P', productType: 'WALL_ART', attributes: color('Style01'), createdAt: '2026-09-01T01:00:00Z' },
    ]
    srv.ctx.parent.index.clear()
    const c = await makeCategory(api, '帆布画', [{ name: '横版', ratio: '3:2', white: [1500, 1000] }])
    await api.json('PATCH', `/library/categories/${c.cid}`, { skuCode: 'xkfb', productTypes: ['WALL_ART'] })
    await api.json('PATCH', `/library/categories/${c.cid}/styles/${c.styles['横版']}`, { skuMark: 'HB' })
    mock.script({ parent: [{ parent: { pick: null, confidence: 0.1, new_themes: ['Dog Memorial'] } }, { parent: { pick: 1, confidence: 0.9 } }] })
    const [a] = await uploadJobs(api, ['a.png'])
    const da = await waitJob(api, a.id, isDone)
    expect(da.parent).toMatchObject({ status: 'new', sku: 'ART-xkfb-Dog Memorial', proposal: { basedOn: [] } })
    expect(da.sku).toBe(`ART-HBxkfb${ymd()}001`)
    const [b] = await uploadJobs(api, ['b.png'])
    const db = await waitJob(api, b.id, isDone)
    expect(db.parent).toMatchObject({ status: 'matched', sku: 'xkfb760901700-P' })
    expect(db.sku).toBe(`ART-xkfb${ymd()}001`)
    expect(db.skuNote).toContain('按父体 xkfb760901700-P 下的子体改成 xkfb（原 HBxkfb）')
  })

  it('待确认不改 SKU，只提示；确认（手动指定）后才改', async () => {
    const api = srv.api
    const c = await blanket()
    await api.json('PATCH', `/library/categories/${c.cid}`, { productTypes: ['BLANKET'] })
    mock.script({ parent: [{ parent: { pick: 2, confidence: 0.3 } }] })
    const [a] = await uploadJobs(api, ['a.png'])
    const d = await waitJob(api, a.id, isDone)
    expect(d.parent).toMatchObject({ status: 'unsure', sku: 'ART-cn-mtfl-cookie' })
    expect(d.sku).toBe(`ART-mtfl${ymd()}001`)
    expect(d.skuNote).toContain('确认父体后，子体编码会按父体 ART-cn-mtfl-cookie 下的子体改成 cn-mtfl')
    const r = await api.json('POST', `/jobs/${a.id}/parent`, { sku: 'ART-cn-mtfl-cookie' })
    expect(r.body.job).toMatchObject({ sku: `ART-cn-mtfl${ymd()}001` })
    // 换成子体是 mtfl 的父体：改回 mtfl
    const back = await api.json('POST', `/jobs/${a.id}/parent`, { sku: 'mtfl760820700-P' })
    expect(back.body.job.sku).toBe(`ART-mtfl${ymd()}002`)
  })

  it('改专属号：只在输出文件夹里改，不去店铺查（2026-11-04 用户要求）', async () => {
    const api = srv.api
    await blanket()
    const jobs = await uploadJobs(api, ['a.png', 'b.png'])
    await Promise.all(jobs.map((j) => waitJob(api, j.id, isDone)))
    const before = mock.parent.calls.length
    const r = await api.json('POST', '/batch/mark', { mark: '1', apply: true })
    expect(r.body.applied).toBe(true)
    expect(r.body.items.map((x: any) => x.next)).toEqual([`ART-mtfl${ymd()}101`, `ART-mtfl${ymd()}102`])
    expect(mock.parent.calls.slice(before).filter((c) => c.service === 'spapi')).toEqual([])
  })

  it('手动指定父体：从店铺扫描结果里找，命名按它的子体重算', async () => {
    const api = srv.api
    const c = await blanket()
    await api.json('PATCH', `/library/categories/${c.cid}`, { productTypes: ['BLANKET'] })
    mock.script({ parent: [{ parent: { pick: 2, confidence: 0.9 } }] })
    const [a] = await uploadJobs(api, ['a.png'])
    await waitJob(api, a.id, isDone)
    const rows = await api.json('GET', '/parent/rows?tab=BLANKET')
    expect(rows.body.rows.map((r: any) => r.sku)).toEqual(['ART-cn-mtfl-Dumpling', 'ART-cn-mtfl-cookie', 'mtfl760820700-P'])
    expect(rows.body.tabs).toEqual(expect.arrayContaining(['BLANKET', 'HANGING_ORNAMENT']))
    const r = await api.json('POST', `/jobs/${a.id}/parent`, { sku: 'mtfl760820700-P' })
    expect(r.status).toBe(200)
    expect(r.body.job.parent).toMatchObject({ status: 'matched', manual: true, sku: 'mtfl760820700-P', theme: 'LOPHAW Personalized Halloween Throw Blanket', naming: { next: 'Style02' } })
  })
})
