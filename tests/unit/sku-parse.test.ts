import { describe, expect, it } from 'vitest'
import { majorityCode, materialCode, themeParent } from '../../server/src/parent/skuParse'

/** 例子都是两个店铺里真实存在的 SKU（2026-11-04 只读扫描） */

describe('从 SKU 拆材质编码', () => {
  it.each([
    ['ART-mtfl671103401', 'ART', 'mtfl'],
    ['ART-cn-mtfl671102401', 'ART', 'cn-mtfl'],
    ['ART-cn-yklgj-Farm-671031701', 'ART', 'cn-yklgj'],
    ['ART-cn-yklgj-Dog Memorial-671103701', 'ART', 'cn-yklgj'],
    ['ART-mtfl-671016702', 'ART', 'mtfl'],
    ['ART-cn-dd671102503', 'ART', 'cn-dd'],
    ['ART-cn-yklgj6709107000-P', 'ART', 'cn-yklgj'],
    ['mtfl760820700-P', 'ART', 'mtfl'],
    ['cn-dd760914701', 'ART', 'cn-dd'],
    ['tyntyt760824703', 'ART', 'tyntyt'],
    ['xkfb - 561211000-F', 'ART', 'xkfb'],
    ['HJ-cn-tyntyt670720204', 'HJ', 'cn-tyntyt'],
    ['HJ-cn-tyntyd-2607-Pet Solar Light', 'HJ', 'cn-tyntyd'],
    ['HJ-cn-yklgj5-Christmas Dumpling', 'HJ', 'cn-yklgj'],
    ['HJ-dd5-Christmas', 'HJ', 'dd'],
    ['hj-mtfl671029101', 'HJ', 'mtfl'],
    ['HJ-HBxkfb671030404', 'HJ', 'HBxkfb'],
    ['HJ-SBlbh671028401', 'HJ', 'SBlbh'],
    ['ART-HB-xkfb671014701', 'ART', 'HB-xkfb'],
    ['HB-xkfb-couple-671029701', 'ART', 'HB-xkfb'],
    ['HJ- HBfbxk671023301', 'HJ', 'HBfbxk'],
  ])('%s → %s', (sku, abbr, code) => {
    expect(materialCode(sku, abbr)).toBe(code)
  })

  it.each([
    ['Z9-PX7O-E911', 'ART'],
    ['NC-6034-TL4E', 'ART'],
    ['YMY-BeachTowel', 'ART'],
    ['51061202-black-xl-new', 'ART'],
    ['cn-ART-mtfl-6715701', 'ART'],
    // 在爱睿特里看到别的店铺的 SKU：HJ- 不当成 HB / SB 那种标记
    ['HJ-mtfl671029101', 'ART'],
    ['HB-cn-xkfb671014701', 'ART'],
    ['', 'ART'],
  ])('%s 拆不出来', (sku, abbr) => {
    expect(materialCode(sku, abbr)).toBeNull()
  })
})

describe('主题式父体', () => {
  it.each([
    ['ART-cn-yklgj-cookie', 'ART', { prefix: 'ART-cn-yklgj', code: 'cn-yklgj', theme: 'cookie' }],
    ['ART-cn-mtfl-old love', 'ART', { prefix: 'ART-cn-mtfl', code: 'cn-mtfl', theme: 'old love' }],
    ['ART-cn-yklgj-Dog Memorial', 'ART', { prefix: 'ART-cn-yklgj', code: 'cn-yklgj', theme: 'Dog Memorial' }],
    ['ART-tcgj-Music Teacher', 'ART', { prefix: 'ART-tcgj', code: 'tcgj', theme: 'Music Teacher' }],
    ['ART-cn-yklgj-Crafting11', 'ART', { prefix: 'ART-cn-yklgj', code: 'cn-yklgj', theme: 'Crafting11' }],
    ['HJ-cn-yklgj5-Christmas Dumpling', 'HJ', { prefix: 'HJ-cn-yklgj', code: 'cn-yklgj', theme: 'Christmas Dumpling' }],
    ['HJ-lbh5-Christmas Rectangle', 'HJ', { prefix: 'HJ-lbh', code: 'lbh', theme: 'Christmas Rectangle' }],
    ['HJ-cn-dd1-FamilyName', 'HJ', { prefix: 'HJ-cn-dd', code: 'cn-dd', theme: 'FamilyName' }],
    ['HJ-xkfb-2607-Wrestling', 'HJ', { prefix: 'HJ-xkfb', code: 'xkfb', theme: 'Wrestling' }],
    ['HJ-cn-dd-2-Halloween Doormat', 'HJ', { prefix: 'HJ-cn-dd', code: 'cn-dd', theme: 'Halloween Doormat' }],
    ['HJ-stj670605-women', 'HJ', { prefix: 'HJ-stj', code: 'stj', theme: 'women' }],
  ])('%s', (sku, abbr, want) => {
    expect(themeParent(sku, abbr)).toEqual(want)
  })

  it.each([
    'ART-cn-yklgj6709107000-P',
    'ART-mtfl-670625-P',
    'ART-mzxk670611-P',
    'ART-cn-yklgj67101300-F',
    'mtfl760820700-P',
    'xkfb-ymy-couple',
    'HB-xkfb-couple',
    'Z9-PX7O-E911',
    'ART-fz-6708137000-H',
    'ART-mtfl-P2',
    'ART-mtfl760820700-PH',
  ])('%s 不是主题式（日期码 / 没有店铺缩写）', (sku) => {
    expect(themeParent(sku, 'ART')).toBeNull()
  })
})

describe('出现最多的编码', () => {
  it('票多的赢；一样多取较新的；都拆不出来是 null', () => {
    // 父体 ART-mtfl-Grandma 下子体其实都是 cn-mtfl
    expect(majorityCode(['ART-cn-mtfl671102401', 'ART-cn-mtfl671102402', 'ART-mtfl671103401'], 'ART')).toBe('cn-mtfl')
    expect(majorityCode(['ART-mtfl6710297002', 'ART-cn-mtfl671029701'], 'ART')).toBe('cn-mtfl')
    expect(majorityCode(['ART-cn-mtfl671029701', 'ART-mtfl6710297002'], 'ART')).toBe('mtfl')
    expect(majorityCode(['Z9-PX7O-E911', 'NC-6034-TL4E'], 'ART')).toBeNull()
    expect(majorityCode([], 'ART')).toBeNull()
  })
})
