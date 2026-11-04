import { describe, expect, it } from 'vitest'
import { candidateParents, decideChildCode, namingSeed, stripStyleMark, themedRows, withOwnMark } from '../../server/src/parent/storeParents'
import type { IndexedListing, StoreSnapshot } from '../../server/src/parent/storeIndex'

const L = (sku: string, o: Partial<IndexedListing> = {}): IndexedListing => ({
  sku,
  asin: null,
  title: '',
  productType: 'BLANKET',
  createdAt: '2026-10-01T00:00:00Z',
  status: [],
  kind: 'single',
  themeAttributes: [],
  childSkus: [],
  parentSkus: [],
  values: {},
  theme: '',
  ...o,
})
const parent = (sku: string, createdAt: string, theme = '', productType = 'BLANKET') => L(sku, { kind: 'parent', createdAt, theme, productType, themeAttributes: ['color'] })
const kid = (sku: string, of: string, v: string, createdAt = '2026-10-02T00:00:00Z') => L(sku, { kind: 'child', parentSkus: [of], values: { color: v }, createdAt })
const snap = (items: IndexedListing[]): StoreSnapshot => ({ storeId: 'art', scannedAt: '2026-11-04T00:00:00Z', items, truncated: false, requests: 1 })

describe('店铺来源的候选父体', () => {
  it('只要这几个商品类型的父体，新建的排前面；建议新父体只用主题式的', () => {
    const s = snap([
      parent('mtfl760820700-P', '2026-08-20T00:00:00Z'),
      parent('ART-cn-mtfl-cookie', '2026-10-27T00:00:00Z', 'cookie'),
      parent('ART-cn-yklgj-Farm', '2026-11-01T00:00:00Z', 'Farm', 'HANGING_ORNAMENT'),
      kid('ART-cn-mtfl-671027701', 'ART-cn-mtfl-cookie', 'Style01'),
    ])
    const rows = candidateParents(s, ['blanket'])
    expect(rows.map((r) => r.sku)).toEqual(['ART-cn-mtfl-cookie', 'mtfl760820700-P'])
    expect(themedRows(rows, 'ART')).toEqual([{ sku: 'ART-cn-mtfl-cookie', asin: '', theme: 'cookie', row: 1 }])
  })
})

describe('第一个变体名的写法', () => {
  it('同品类最近有子体的父体里最多的那种；没有子体的父体、没编号的命名不算；都没有是 null', () => {
    const s = snap([
      parent('A', '2026-10-01T00:00:00Z'),
      kid('a1', 'A', 'Design 01'),
      parent('B', '2026-10-02T00:00:00Z'),
      kid('b1', 'B', 'Style01'),
      kid('b2', 'B', 'Style02'),
      parent('C', '2026-10-03T00:00:00Z'),
      kid('c1', 'C', 'Style01'),
      parent('D', '2026-10-04T00:00:00Z'),
      parent('E', '2026-10-05T00:00:00Z'),
      kid('e1', 'E', 'Red'),
    ])
    expect(namingSeed(s, ['A', 'B', 'C', 'D', 'E'])).toEqual({ prefix: 'Style', width: 2, basedOn: ['C', 'B'] })
    // 一样多取较新的
    expect(namingSeed(s, ['A', 'B'])).toMatchObject({ prefix: 'Style' })
    expect(namingSeed(s, ['A'])).toMatchObject({ prefix: 'Design ', width: 2 })
    expect(namingSeed(s, ['D', 'E'])).toBeNull()
    expect(namingSeed(null, ['A'])).toBeNull()
  })
})

describe('子体材质编码跟着父体走', () => {
  const base = { abbr: 'ART', parentSku: null, kids: [] as string[], newPrefix: null, snap: null, productTypes: [] as string[] }
  it('按顺序：父体下的子体 → 父体 SKU → 新父体前缀 → 同类最近商品 → 不改', () => {
    expect(decideChildCode({ ...base, parentSku: 'ART-mtfl-Grandma', kids: ['ART-cn-mtfl671102401', 'ART-cn-mtfl671102402'] })).toEqual({ code: 'cn-mtfl', why: '按父体 ART-mtfl-Grandma 下的子体', fromKids: true })
    expect(decideChildCode({ ...base, parentSku: 'ART-cn-yklgj-memory', kids: ['Z9-PX7O-E911'] })).toEqual({ code: 'cn-yklgj', why: '按父体 SKU ART-cn-yklgj-memory', fromKids: false })
    expect(decideChildCode({ ...base, newPrefix: 'ART-cn-dd' })?.code).toBe('cn-dd')
    // 焕捷：父体下是 HBxkfb（横版）
    expect(decideChildCode({ ...base, abbr: 'HJ', parentSku: 'HJ-xkfb5-Love', kids: ['HJ-HBxkfb671030401', 'HJ-HBxkfb671030402', 'HJ-xkfb671030403'] })?.code).toBe('HBxkfb')
    const s = snap([L('ART-cn-mtfl671101401', { createdAt: '2026-11-01T00:00:00Z' }), L('ART-mtfl660101401', { createdAt: '2026-01-01T00:00:00Z' }), L('ART-mtfl660101402', { createdAt: '2026-01-01T00:00:00Z' })])
    expect(decideChildCode({ ...base, parentSku: 'Z9-PX7O-E911', snap: s, productTypes: ['BLANKET'], libraryCode: 'mtfl', now: Date.UTC(2026, 10, 4) })).toEqual({
      code: 'cn-mtfl',
      why: '按店铺里最近 60 天同类商品（BLANKET）',
      fromKids: false,
    })
    // 同类商品多数是别的材质（亚克力挂件 / 陶瓷挂件同为 HANGING_ORNAMENT）：不改
    expect(decideChildCode({ ...base, parentSku: 'Z9-PX7O-E911', snap: s, productTypes: ['BLANKET'], libraryCode: 'cn-yklgj', now: Date.UTC(2026, 10, 4) })).toBeNull()
    expect(decideChildCode({ ...base, parentSku: 'Z9-PX7O-E911' })).toBeNull()
  })
})

describe('横竖版标记怎么取舍', () => {
  it('看子体：子体都不带 → 去掉；和自己一样 → 照用；和自己相反 → 保留自己的；看别的来源 → 保留自己的', () => {
    expect(stripStyleMark('cn-HBxkfb')).toBe('cn-xkfb')
    expect(stripStyleMark('HB-xkfb')).toBe('xkfb')
    expect(withOwnMark({ code: 'xkfb', why: '', fromKids: true }, 'HB')).toBe('xkfb')
    expect(withOwnMark({ code: 'HBxkfb', why: '', fromKids: true }, 'HB')).toBe('HBxkfb')
    expect(withOwnMark({ code: 'HB-xkfb', why: '', fromKids: true }, 'HB')).toBe('HB-xkfb')
    expect(withOwnMark({ code: 'HBxkfb', why: '', fromKids: true }, 'SB')).toBe('SBxkfb')
    expect(withOwnMark({ code: 'HBxkfb', why: '', fromKids: true }, null)).toBe('HBxkfb')
    // 新父体前缀、父体 SKU 拆出来的都没有标记：保留自己的
    expect(withOwnMark({ code: 'xkfb', why: '', fromKids: false }, 'HB')).toBe('HBxkfb')
    expect(withOwnMark({ code: 'cn-xkfb', why: '', fromKids: false }, 'SB')).toBe('cn-SBxkfb')
    expect(withOwnMark({ code: 'cn-mtfl', why: '', fromKids: false }, null)).toBe('cn-mtfl')
  })
})
