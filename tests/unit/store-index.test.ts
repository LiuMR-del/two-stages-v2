import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { startMockRelay, type MockRelay } from '../../scripts/mock-relay'
import type { MockListing } from '../../scripts/mock-parent'
import { SettingsStore, storeById } from '../../server/src/store/settings'
import { SpapiPool } from '../../server/src/parent/spapi'
import { scanStore, StoreIndex, toListing } from '../../server/src/parent/storeIndex'
import type { SpapiClient } from '../../server/src/parent/spapi'
import { rmDir, tmpDir } from '../helpers'

/** 多店铺方案第四节：店铺商品快照 */

let mock: MockRelay
let dir: string
let settings: SettingsStore
let index: StoreIndex
let clock = 0

beforeAll(async () => {
  mock = await startMockRelay()
  dir = tmpDir()
})
afterAll(async () => {
  await mock.close()
  rmDir(dir)
})
beforeEach(async () => {
  mock.reset()
  settings = new SettingsStore(path.join(dir, `s-${Date.now()}-${Math.random()}.json`))
  const sp = mock.parent.spapi
  await settings.updateStoreRaw('art', (st) =>
    Object.assign(st.spapi, { sellerId: sp.sellerId, clientId: sp.clientId, clientSecret: sp.clientSecret, refreshToken: sp.refreshToken, endpoint: mock.origin, tokenUrl: mock.origin + '/auth/o2/token' }),
  )
  clock = Date.UTC(2026, 10, 4)
  index = new StoreIndex(
    new SpapiPool(settings),
    (id) => {
      const st = storeById(settings.get(), id)!
      return { abbr: st.abbr, sellerId: st.spapi.sellerId, marketplaceId: st.spapi.marketplaceId }
    },
    10 * 60_000,
    () => clock,
  )
})

const color = (v: string) => ({ color: [{ value: v, language_tag: 'en_US', marketplace_id: 'ATVPDKIKX0DER' }] })
const searches = () => mock.parent.calls.filter((c) => c.service === 'spapi' && c.method === 'GET' && /^\/2021-08-01\/items\/[^/]+$/.test(c.path)).length

describe('店铺商品快照', () => {
  it('父体 / 子体 / 单品、商品类型、标题、变体值、主题式父体的主题都记下来，按创建时间排', async () => {
    mock.parent.spapi.listings = [
      { sku: 'ART-cn-yklgj-cookie', variationTheme: ['color'], productType: 'HANGING_ORNAMENT', title: 'LOPHAW Gingerbread Ornament', createdAt: '2026-10-27T08:00:00Z', attributes: { parentage_level: [{ value: 'parent' }] } },
      { sku: 'ART-cn-yklgj67102701', parentSku: 'ART-cn-yklgj-cookie', productType: 'HANGING_ORNAMENT', attributes: color('Style01'), createdAt: '2026-10-27T09:00:00Z' },
      { sku: 'mtfl760820700-P', variationTheme: ['color'], productType: 'BLANKET', title: 'Halloween Blanket', createdAt: '2026-08-20T00:00:00Z' },
      { sku: 'ART-mtfl67102970001', productType: 'BLANKET', createdAt: '2026-10-29T00:00:00Z' },
    ]
    const snap = await index.get('art')
    expect(snap.items.map((x) => x.sku)).toEqual(['mtfl760820700-P', 'ART-cn-yklgj-cookie', 'ART-cn-yklgj67102701', 'ART-mtfl67102970001'])
    const [old, cookie, kid, single] = snap.items
    expect(cookie).toMatchObject({ kind: 'parent', productType: 'HANGING_ORNAMENT', title: 'LOPHAW Gingerbread Ornament', themeAttributes: ['color'], childSkus: ['ART-cn-yklgj67102701'], theme: 'cookie' })
    expect(kid).toMatchObject({ kind: 'child', parentSkus: ['ART-cn-yklgj-cookie'], values: { color: 'Style01' }, theme: '' })
    // 日期码父体：没有主题，靠标题
    expect(old).toMatchObject({ kind: 'parent', theme: '', title: 'Halloween Blanket' })
    expect(single!.kind).toBe('single')
    expect(snap.truncated).toBe(false)
  })

  it('超过 1000 条：按创建日期分段，全部扫到、不重复', async () => {
    const start = Date.UTC(2026, 0, 1)
    mock.parent.spapi.listings = Array.from({ length: 1365 }, (_, i): MockListing => ({ sku: `HJ-mtfl${i}`, createdAt: new Date(start + i * 3 * 3600_000).toISOString() }))
    mock.parent.spapi.cap = 1000
    const snap = await index.get('art')
    expect(snap.items).toHaveLength(1365)
    expect(new Set(snap.items.map((x) => x.sku)).size).toBe(1365)
    expect(snap.truncated).toBe(false)
  })

  it('不到 1000 条：不分段，一次翻完', async () => {
    mock.parent.spapi.listings = Array.from({ length: 45 }, (_, i): MockListing => ({ sku: `A-${i}` }))
    const snap = await index.get('art')
    expect(snap.items).toHaveLength(45)
    // 1 次看总数 + 3 页
    expect(snap.requests).toBe(4)
  })

  it('10 分钟内共用缓存；并发只扫一次；过期后先用旧的、后台重扫；超过 2 小时等重扫；force 重扫；换了店铺 ID 作废', async () => {
    mock.parent.spapi.listings = [{ sku: 'A-1' }]
    const [a, b] = await Promise.all([index.get('art'), index.get('art')])
    expect(a).toBe(b)
    const n = searches()
    clock += 9 * 60_000
    expect(await index.get('art')).toBe(a)
    expect(searches()).toBe(n)
    expect(index.peek('art')).toBe(a)
    // 过了 10 分钟：马上拿到旧的，后台在重扫
    clock += 2 * 60_000
    mock.parent.spapi.listings.push({ sku: 'A-2' })
    expect((await index.get('art')).items).toHaveLength(1)
    expect(index.scanning('art')).toBe(true)
    await vi.waitFor(() => expect(index.scanning('art')).toBe(false))
    expect((await index.get('art')).items).toHaveLength(2)
    // 超过 2 小时：等扫完
    clock += 3 * 3600_000
    mock.parent.spapi.listings.push({ sku: 'A-3' })
    expect((await index.get('art')).items).toHaveLength(3)
    mock.parent.spapi.listings.push({ sku: 'A-4' })
    expect((await index.get('art', { force: true })).items).toHaveLength(4)
    await settings.updateStore('art', { spapi: { sellerId: 'AOTHER0000001' } })
    expect(index.peek('art')).toBeNull()
    expect(index.peek('hj')).toBeNull()
  })

  it('分得够细时几段同时翻：结果和一段一段翻一样', async () => {
    const start = Date.UTC(2026, 0, 1)
    mock.parent.spapi.listings = Array.from({ length: 700 }, (_, i): MockListing => ({ sku: `ART-mtfl${i}`, createdAt: new Date(start + i * 3600_000).toISOString() }))
    const snap = await index.get('art')
    expect(snap.items.map((x) => x.sku)).toEqual(mock.parent.spapi.listings.map((x) => x.sku))
  })

  it('只发 GET', async () => {
    mock.parent.spapi.listings = [{ sku: 'A-1' }]
    await index.get('art')
    expect(mock.parent.calls.filter((c) => c.service === 'spapi' && c.path !== '/token' && c.method !== 'GET')).toEqual([])
  })
})

describe('真实返回的样子', () => {
  it('爱睿特 ART-cn-mtfl-Dumpling 父体（多个变体属性）', () => {
    const it = {
      sku: 'ART-cn-mtfl-Dumpling',
      summaries: [{ asin: 'B0HPG1ZFWR', productType: 'BLANKET', itemName: 'LOPHAW Dumpling Blanket', createdDate: '2026-10-27T03:00:00.000Z', status: ['BUYABLE'] }],
      attributes: { parentage_level: [{ value: 'parent', marketplace_id: 'ATVPDKIKX0DER' }] },
      relationships: [{ marketplaceId: 'ATVPDKIKX0DER', relationships: [{ type: 'VARIATION', childSkus: ['ART-cn-mtfl-Dumpling-671026701'], variationTheme: { attributes: ['color', 'size', 'style'], theme: 'COLOR/SIZE/STYLE' } }] }],
    }
    expect(toListing(it, 'ART')).toMatchObject({ kind: 'parent', asin: 'B0HPG1ZFWR', themeAttributes: ['color', 'size', 'style'], theme: 'Dumpling', childSkus: ['ART-cn-mtfl-Dumpling-671026701'] })
  })
})

/** 不走网络的假客户端：每次搜索返回 items 的当前内容，可以卡住不返回 */
function fakeClient(items: () => { sku: string }[]) {
  let gate: Promise<void> = Promise.resolve()
  let open: () => void = () => {}
  const client = {
    calls: 0,
    hold() {
      gate = new Promise<void>((r) => (open = r))
    },
    release() {
      open()
    },
    async search(query: Record<string, string>) {
      client.calls++
      await gate
      const all = items()
      if (query.pageSize === '1') return { numberOfResults: all.length, items: all.slice(0, 1) }
      return { numberOfResults: all.length, items: all.map((x) => ({ sku: x.sku, summaries: [{}] })) }
    },
  }
  return client
}

describe('扫描并发和作废', () => {
  const key = { abbr: 'ART', sellerId: 'A1', marketplaceId: 'M' }
  const make = (c: ReturnType<typeof fakeClient>, k = () => key) => new StoreIndex({ for: () => c as unknown as SpapiClient } as unknown as InstanceType<typeof SpapiPool>, k)

  it('正在扫的时候点「重新扫描」：排在它后面再扫一次，拿到的是新的', async () => {
    let list = [{ sku: 'A-1' }]
    const c = fakeClient(() => list)
    const idx = make(c)
    c.hold()
    const first = idx.get('art')
    await vi.waitFor(() => expect(c.calls).toBeGreaterThan(0))
    list = [{ sku: 'A-1' }, { sku: 'A-2' }]
    const forced = idx.get('art', { force: true })
    const forced2 = idx.get('art', { force: true })
    c.release()
    const [a, b, b2] = await Promise.all([first, forced, forced2])
    // 两次强制重扫共用排在后面的那一次：一共扫两轮（每轮看总数 1 次 + 翻 1 页）
    expect(b2).toBe(b)
    expect(b).not.toBe(a)
    expect(c.calls).toBe(4)
    expect(b.items).toHaveLength(2)
    expect(idx.peek('art')).toBe(b)
  })

  it('扫的途中换了凭证：不拿旧凭证那次的结果', async () => {
    let k = key
    const c = fakeClient(() => [{ sku: k.sellerId }])
    const idx = make(c, () => k)
    c.hold()
    const old = idx.get('art')
    await vi.waitFor(() => expect(c.calls).toBeGreaterThan(0))
    k = { ...key, sellerId: 'A2' }
    const now = idx.get('art')
    c.release()
    await old
    expect((await now).items.map((x) => x.sku)).toEqual(['A2'])
    expect(idx.peek('art')!.items.map((x) => x.sku)).toEqual(['A2'])
  })

  it('扫的途中删了店铺（清缓存）：扫完不写回', async () => {
    const c = fakeClient(() => [{ sku: 'A-1' }])
    const idx = make(c)
    c.hold()
    const p = idx.get('art')
    await vi.waitFor(() => expect(c.calls).toBeGreaterThan(0))
    idx.clear('art')
    c.release()
    await p
    expect(idx.peek('art')).toBeNull()
  })

  it('分段只覆盖到一部分（有商品早于 2015 年）：标记快照不全', async () => {
    mock.parent.spapi.listings = [
      ...Array.from({ length: 5 }, (_, i): MockListing => ({ sku: `N-${i}`, createdAt: `2026-0${i + 1}-01T00:00:00Z` })),
      { sku: 'OLD-1', createdAt: '2010-01-01T00:00:00Z' },
    ]
    const client = new SpapiPool(settings).for('art')
    const r = await scanStore(client, 'ART', undefined, Date.now(), { leafTarget: 2 })
    expect(r.truncated).toBe(true)
    expect(r.items.map((x) => x.sku)).not.toContain('OLD-1')
  })

  it('parentage_level 是 child 的，带了变体主题也算子体', () => {
    const it = { sku: 'ART-cn-yklgj-Farm-671031701', attributes: { parentage_level: [{ value: 'child' }] }, relationships: [{ relationships: [{ type: 'VARIATION', variationTheme: { attributes: ['color'] } }] }] }
    expect(toListing(it, 'ART')).toMatchObject({ kind: 'child', theme: '' })
  })
})
