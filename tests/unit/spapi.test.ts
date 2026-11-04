import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startMockRelay, type MockRelay } from '../../scripts/mock-relay'
import { SettingsStore } from '../../server/src/store/settings'
import { attributeValue, SpapiAuthError, SpapiPool, type SpapiClient } from '../../server/src/parent/spapi'
import { analyzeNaming, nextName } from '../../server/src/parent/naming'
import { rmDir, tmpDir } from '../helpers'

let mock: MockRelay
let dir: string
let client: SpapiClient

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
  const s = new SettingsStore(path.join(dir, `s-${Date.now()}-${Math.random()}.json`))
  const sp = mock.parent.spapi
  await s.updateStoreRaw('hj', (st) => Object.assign(st.spapi, { sellerId: sp.sellerId, clientId: sp.clientId, clientSecret: sp.clientSecret, refreshToken: sp.refreshToken, endpoint: mock.origin, tokenUrl: mock.origin + '/auth/o2/token' }))
  client = new SpapiPool(s).for('hj')
})

const color = (v: string) => ({ color: [{ value: v, language_tag: 'en_US', marketplace_id: 'ATVPDKIKX0DER' }] })

describe('SP-API 读父体和子体', () => {
  it('父体：ASIN 和变体主题属性；店铺里没有这个 SKU 返回 null', async () => {
    mock.parent.spapi.listings = [{ sku: 'HJ-cn-yklgj-Christmas Baby', asin: 'B0HKJ8G5QP', variationTheme: ['color'] }]
    expect(await client.parent('HJ-cn-yklgj-Christmas Baby')).toEqual({ sku: 'HJ-cn-yklgj-Christmas Baby', asin: 'B0HKJ8G5QP', themeAttributes: ['color'] })
    expect(await client.parent('HJ-nope')).toBeNull()
  })

  it('子体按 pageToken 翻完所有页，不同状态（含未完成）都算；推算出下一个变体名', async () => {
    const parent = 'HJ-cn-yklgj-Christmas'
    mock.parent.spapi.listings = [
      { sku: parent, variationTheme: ['color'] },
      ...Array.from({ length: 25 }, (_, i) => ({ sku: `C-${i}`, parentSku: parent, status: i === 3 ? 'INCOMPLETE' : 'BUYABLE', attributes: color(`Design ${String(i + 1).padStart(2, '0')}`) })),
      { sku: 'other', parentSku: 'HJ-other', attributes: color('Design 99') },
    ]
    const kids = await client.children(parent, ['color'])
    expect(kids).toHaveLength(25)
    expect(kids[3]!.status).toEqual(['INCOMPLETE'])
    expect(mock.parent.calls.filter((c) => c.path.startsWith('/2021-08-01/items/') && !c.path.includes(parent))).toHaveLength(2)
    expect(nextName(analyzeNaming(['color'], kids.map((k) => k.values))).next).toBe('Design 26')
  })

  it('429 按 Retry-After 等待后继续', async () => {
    mock.parent.spapi.listings = [{ sku: 'P', variationTheme: ['color'] }, { sku: 'K1', parentSku: 'P', attributes: color('Design 01') }]
    mock.parent.spapi.throttle = 3
    expect(await client.children('P', ['color'])).toHaveLength(1)
  })

  it('凭证不对：报凭证错误（第 6 步会整体暂停）', async () => {
    mock.parent.spapi.clientSecret = 'changed-on-amazon-side'
    await expect(client.parent('P')).rejects.toBeInstanceOf(SpapiAuthError)
  })

  it('属性值：取第一个 value，没有时取 standardized_values', () => {
    expect(attributeValue(color('Design 05'), 'color')).toBe('Design 05')
    expect(attributeValue({ size: [{ standardized_values: ['12x18'] }] }, 'size')).toBe('12x18')
    expect(attributeValue({}, 'color')).toBeNull()
  })
})
