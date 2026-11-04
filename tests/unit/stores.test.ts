import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startMockRelay, type MockRelay } from '../../scripts/mock-relay'
import { startInProcess, type Api } from '../inprocess'
import type { AppContext } from '../../server/src/context'
import { SettingsStore } from '../../server/src/store/settings'
import { rmDir, tmpDir } from '../helpers'

/** 多店铺方案第 1 段：店铺档案、旧设置迁移、凭证和 token 按店铺隔离 */

describe('旧设置迁移成店铺档案', () => {
  let dir: string
  beforeAll(() => (dir = tmpDir()))
  afterAll(() => rmDir(dir))

  it('原来的凭证、父体表、店铺缩写、地区标识归焕捷，另加空的爱睿特；留一份原文件', () => {
    const file = path.join(dir, 'settings.json')
    const old = {
      parent: {
        enabled: true,
        sheetUrl: 'https://x.feishu.cn/wiki/abc',
        recentUrls: [{ url: 'https://x.feishu.cn/wiki/abc', title: '父体分类汇总', usedAt: '2026-10-27T00:00:00.000Z' }],
        tabs: ['毛毯', '地垫'],
        threshold: 0.6,
        creatorMark: '1',
        feishu: { appId: 'cli_1', appSecret: 'sec-1' },
        spapi: { sellerId: 'A28LU3EFGREW2P', clientId: 'cid-1', clientSecret: 'cs-1', refreshToken: 'Atzr|rt-1', marketplaceId: 'ATVPDKIKX0DER' },
      },
      sku: { store: 'HJ', region: '7' },
    }
    fs.writeFileSync(file, JSON.stringify(old))
    const s = new SettingsStore(file).get()
    expect(s.stores).toHaveLength(2)
    expect(s.stores[0]).toMatchObject({
      id: 'hj',
      name: '焕捷',
      abbr: 'HJ',
      parentSource: 'feishu',
      spapi: old.parent.spapi,
      feishu: { sheetUrl: old.parent.sheetUrl, recentUrls: old.parent.recentUrls, tabs: old.parent.tabs },
    })
    expect(s.stores[1]).toMatchObject({ id: 'art', name: '爱睿特', abbr: 'ART', parentSource: 'store', spapi: { sellerId: '', refreshToken: '' } })
    expect(s.currentStoreId).toBe('hj')
    expect(s.sku).toEqual({ group: '7' })
    expect(s.parent).toMatchObject({ enabled: true, threshold: 0.6, creatorMark: '1', feishu: { appId: 'cli_1', appSecret: 'sec-1' } })
    expect((s.parent as any).spapi).toBeUndefined()
    // 写回的是新结构，再读一次不会再迁移；原文件留了备份
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(saved.stores).toHaveLength(2)
    const backups = fs.readdirSync(dir).filter((f) => /^settings\.v1-\d+\.json$/.test(f))
    expect(backups).toHaveLength(1)
    expect(JSON.parse(fs.readFileSync(path.join(dir, backups[0]!), 'utf8'))).toEqual(old)
    expect(new SettingsStore(file).get().stores[0]!.spapi.sellerId).toBe('A28LU3EFGREW2P')
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('settings.v1-'))).toHaveLength(1)
  })

  it('原文件读不懂（字段超范围）：先留一份 bad 备份，不会被第一次保存冲掉', async () => {
    const file = path.join(dir, 'bad.json')
    const old = { image: { concurrency: 99 }, parent: { spapi: { sellerId: 'AKEEPME000001' } } }
    fs.writeFileSync(file, JSON.stringify(old))
    const st = new SettingsStore(file)
    const bad = fs.readdirSync(dir).filter((f) => /^bad\.bad-\d+\.json$/.test(f))
    expect(bad).toHaveLength(1)
    expect(JSON.parse(fs.readFileSync(path.join(dir, bad[0]!), 'utf8'))).toEqual(old)
    await st.update({ routeThreshold: 0.6 })
    expect(JSON.parse(fs.readFileSync(path.join(dir, bad[0]!), 'utf8'))).toEqual(old)
  })

  it('备份不成功就不许保存', async () => {
    const sub = path.join(dir, 'ro')
    fs.mkdirSync(sub)
    const file = path.join(sub, 'settings.json')
    fs.writeFileSync(file, JSON.stringify({ parent: { spapi: { sellerId: 'AKEEPME000002' } }, sku: { store: 'HJ' } }))
    fs.chmodSync(sub, 0o500)
    try {
      const st = new SettingsStore(file)
      expect(st.get().stores[0]!.spapi.sellerId).toBe('AKEEPME000002')
      await expect(st.update({ routeThreshold: 0.6 })).rejects.toThrow('还没备份成功')
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).parent.spapi.sellerId).toBe('AKEEPME000002')
    } finally {
      fs.chmodSync(sub, 0o700)
    }
  })

  it('新装：默认焕捷 + 爱睿特，当前是焕捷', () => {
    const s = new SettingsStore(path.join(dir, 'fresh.json')).get()
    expect(s.stores.map((x) => x.abbr)).toEqual(['HJ', 'ART'])
    expect(s.currentStoreId).toBe('hj')
  })
})

describe('店铺接口', () => {
  let mock: MockRelay
  let srv: Awaited<ReturnType<typeof startInProcess>>
  let api: Api
  let ctx: AppContext

  beforeAll(async () => {
    mock = await startMockRelay()
    srv = await startInProcess()
    api = srv.api
    ctx = srv.ctx
  })
  afterAll(async () => {
    await srv.close()
    await mock.close()
  })
  beforeEach(() => mock.reset())

  const store = (id: string) => ctx.settings.get().stores.find((s) => s.id === id)

  it('新增、改名、改缩写、删除；缩写不能重；当前店铺不能删', async () => {
    const add = await api.json('POST', '/stores', { name: '熵玖铄', abbr: 'SJS' })
    expect(add.status).toBe(200)
    const sjs = add.body.id as string
    expect(sjs).toMatch(/^sjs-/)
    expect(store(sjs)).toMatchObject({ name: '熵玖铄', abbr: 'SJS', parentSource: 'store' })
    expect((await api.json('POST', '/stores', { name: '重名', abbr: 'hj' })).body.error ?? '').toContain('焕捷')
    expect((await api.json('POST', '/stores', { name: '重名', abbr: 'hj' })).status).toBe(400)
    expect((await api.json('PATCH', `/stores/${sjs}`, { abbr: 'ART' })).status).toBe(400)
    expect((await api.json('PATCH', `/stores/${sjs}`, { name: '熵玖铄店', abbr: 'SJ' })).status).toBe(200)
    expect(store(sjs)).toMatchObject({ name: '熵玖铄店', abbr: 'SJ' })
    expect((await api.json('PATCH', `/stores/${sjs}`, { name: '  ' })).status).toBe(400)
    expect((await api.json('DELETE', '/stores/hj')).status).toBe(400)
    expect(store('hj')).toBeTruthy()
    expect((await api.json('DELETE', `/stores/${sjs}`)).status).toBe(200)
    expect(store(sjs)).toBeUndefined()
    expect((await api.json('PATCH', `/stores/${sjs}`, { name: 'x' })).status).toBe(404)
    // 删掉再加同一个缩写，ID 不复用（旧批次按店铺 ID 记）
    const again = await api.json('POST', '/stores', { name: '熵玖铄', abbr: 'SJS' })
    expect(again.body.id).not.toBe(sjs)
  })

  it('两个店铺的凭证、测试连接、access token 互不影响', async () => {
    const sp = mock.parent.spapi
    const good = { sellerId: sp.sellerId, clientId: sp.clientId, clientSecret: sp.clientSecret, refreshToken: sp.refreshToken }
    for (const id of ['hj', 'art']) {
      await ctx.settings.updateStoreRaw(id, (st) => Object.assign(st.spapi, { endpoint: mock.origin, tokenUrl: mock.origin + '/auth/o2/token' }))
    }
    await api.json('PATCH', '/stores/hj', { spapi: good })
    await api.json('PATCH', '/stores/art', { spapi: { ...good, clientSecret: 'amzn1.oa2-cs.v1.wrong' } })
    mock.parent.spapi.listings = [{ sku: 'X-1' }]
    expect((await api.json('POST', '/stores/hj/spapi/test')).body.ok).toBe(true)
    const bad = await api.json('POST', '/stores/art/spapi/test')
    expect(bad.body.ok).toBe(false)
    expect(bad.body.message).toContain('SP-API 凭证不对')
    // 爱睿特换 token 失败不影响焕捷已经换到的 token：焕捷再测不会重新换
    const tokenCalls = () => mock.parent.calls.filter((c) => c.service === 'spapi' && c.path === '/token').length
    const before = tokenCalls()
    expect((await api.json('POST', '/stores/hj/spapi/test')).body.ok).toBe(true)
    expect(tokenCalls()).toBe(before)
    // 改对爱睿特的凭证后能连上，焕捷照旧
    await api.json('PATCH', '/stores/art', { spapi: { clientSecret: sp.clientSecret } })
    expect((await api.json('POST', '/stores/art/spapi/test')).body.ok).toBe(true)
    expect(store('hj')!.spapi.clientSecret).toBe(sp.clientSecret)
    expect((await api.json('POST', '/stores/nope/spapi/test')).status).toBe(404)
  })

  it('扫描店铺商品：没扫过时只看缓存不发请求；重新扫描给出概况；凭证错给原因', async () => {
    const sp = mock.parent.spapi
    await ctx.settings.updateStoreRaw('art', (st) =>
      Object.assign(st.spapi, { sellerId: sp.sellerId, clientId: sp.clientId, clientSecret: sp.clientSecret, refreshToken: sp.refreshToken, endpoint: mock.origin, tokenUrl: mock.origin + '/auth/o2/token' }),
    )
    ctx.parent.index.clear()
    mock.parent.spapi.listings = [
      { sku: 'ART-cn-yklgj-cookie', variationTheme: ['color'], productType: 'HANGING_ORNAMENT' },
      { sku: 'ART-cn-yklgj67102701', parentSku: 'ART-cn-yklgj-cookie', productType: 'HANGING_ORNAMENT' },
      { sku: 'mtfl760820700-P', variationTheme: ['color'], productType: 'BLANKET' },
      { sku: 'ART-mtfl67102970001', productType: 'BLANKET' },
    ]
    const before = mock.parent.calls.length
    expect((await api.json('GET', '/stores/art/scan')).body).toEqual({ scanning: false, snapshot: null })
    expect(mock.parent.calls.length).toBe(before)
    const r = await api.json('POST', '/stores/art/scan')
    expect(r.body).toMatchObject({ ok: true, snapshot: { items: 4, parents: 2, themed: 1, truncated: false, productTypes: [{ type: 'HANGING_ORNAMENT', count: 1 }, { type: 'BLANKET', count: 1 }] } })
    expect((await api.json('GET', '/stores/art/scan')).body.snapshot.items).toBe(4)
    // 焕捷没扫过，各是各的
    expect((await api.json('GET', '/stores/hj/scan')).body.snapshot).toBeNull()
    await api.json('PATCH', '/stores/art', { spapi: { clientSecret: 'amzn1.oa2-cs.v1.wrong' } })
    const bad = await api.json('POST', '/stores/art/scan')
    expect(bad.body.ok).toBe(false)
    expect(bad.body.message).toContain('SP-API 凭证不对')
  })
})
