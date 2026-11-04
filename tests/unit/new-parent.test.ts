import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanTheme, derivePrefix, proposeParent, splitSku, themeSamples, withCreator } from '../../server/src/parent/newParent'
import type { ParentRow } from '../../server/src/parent/feishu'
import { JobStore } from '../../server/src/store/jobs'
import { fakeJob } from '../jobfixture'
import { rmDir, tmpDir } from '../helpers'

const row = (sku: string, theme = '', i = 0): ParentRow => ({ sku, theme, asin: '', row: i + 2 })
/** 实测表里的写法：主题列是中文，SKU 末尾是英文 */
const REAL = [row('HJ-cn-yklgj-Christmas Baby', '圣诞节婴儿', 0), row('HJ-cn-yklgj-Christmas', '圣诞节挂件', 1), row('HJ-cn-yklgj5-Christmas Dumpling', '圣诞节小笼包挂件', 2)]

describe('建议新建父体：前缀', () => {
  it('父体不加专属号（2026-11-04）：HJ-cn-yklgj / HJ-cn-yklgj5 / HJ-cn-yklgj3 都得到 HJ-cn-yklgj；HJ-mtfl5 得到 HJ-mtfl', () => {
    expect(withCreator('HJ-cn-yklgj', '')).toBe('HJ-cn-yklgj')
    expect(withCreator('HJ-cn-yklgj5', '')).toBe('HJ-cn-yklgj')
    expect(withCreator('HJ-cn-yklgj3', '')).toBe('HJ-cn-yklgj')
    expect(withCreator('HJ-mtfl5', '')).toBe('HJ-mtfl')
  })

  it('主题带空格（Christmas Baby）能正确拆前缀；主题列是 SKU 里的写法时按它拆，是中文时按最后一个「-」拆', () => {
    expect(splitSku(row('HJ-cn-yklgj-Christmas Baby', 'Christmas Baby'))).toEqual({ prefix: 'HJ-cn-yklgj', theme: 'Christmas Baby' })
    expect(splitSku(row('HJ-mtfl5-Mother-Daughter', 'Mother-Daughter'))).toEqual({ prefix: 'HJ-mtfl5', theme: 'Mother-Daughter' })
    expect(splitSku(row('HJ-cn-yklgj-Christmas Baby', '圣诞节婴儿'))).toEqual({ prefix: 'HJ-cn-yklgj', theme: 'Christmas Baby' })
    expect(derivePrefix(REAL)).toEqual({ prefix: 'HJ-cn-yklgj', basedOn: ['HJ-cn-yklgj-Christmas', 'HJ-cn-yklgj-Christmas Baby'] })
    expect(themeSamples(REAL)).toEqual(['Christmas Dumpling', 'Christmas', 'Christmas Baby'])
  })

  it('前缀票数相同取表里靠后的；拆不出前缀返回 null', () => {
    expect(derivePrefix([row('HJ-a-Love'), row('HJ-b-Home')])!.prefix).toBe('HJ-b')
    expect(derivePrefix([row('NOHYPHEN'), row('ALSO')])).toBeNull()
  })

  it('主题清理：去掉 SKU 里不能用的字符，空格保留，每个词首字母大写', () => {
    expect(cleanTheme('snow man & friends!')).toBe('Snow Man Friends')
    expect(cleanTheme('  ')).toBe('')
  })
})

describe('建议新建父体：查重', () => {
  it('第一个主题和表里 SKU 重名、第二个在店铺里已存在 → 用第三个', async () => {
    const checked: string[] = []
    const r = await proposeParent({
      rows: [...REAL, row('HJ-cn-yklgj-Snowman', '', 3)],
      themes: ['Snowman', 'Gingerbread', 'Santa Claus'],
      queued: [],
      existsInStore: async (sku) => (checked.push(sku), sku.endsWith('Gingerbread')),
    })
    expect(r).toMatchObject({ ok: true, proposal: { sku: 'HJ-cn-yklgj-Santa Claus', prefix: 'HJ-cn-yklgj', theme: 'Santa Claus' } })
    expect(checked).toEqual(['HJ-cn-yklgj-Gingerbread', 'HJ-cn-yklgj-Santa Claus'])
  })

  it('都重名 → 返回试过的 SKU；拆不出前缀 → noPrefix', async () => {
    const r = await proposeParent({ rows: REAL, themes: ['Snowman'], queued: [], existsInStore: async () => true })
    expect(r).toEqual({ ok: false, reason: 'taken', tried: ['HJ-cn-yklgj-Snowman'] })
    expect(await proposeParent({ rows: [row('X')], themes: ['A'], queued: [], existsInStore: async () => false })).toEqual({ ok: false, reason: 'noPrefix' })
  })

  it('同一批里别的图已经建议了同一个新 SKU：直接共用，不再查店铺', async () => {
    let calls = 0
    const r = await proposeParent({ rows: REAL, themes: ['Snowman'], queued: ['hj-cn-yklgj-snowman'], existsInStore: async () => (calls++, false) })
    expect(r).toMatchObject({ ok: true, proposal: { sku: 'hj-cn-yklgj-snowman' } })
    expect(calls).toBe(0)
  })
})

describe('旧任务迁移', () => {
  let dir = ''
  afterEach(() => dir && rmDir(dir))

  it('5 步的旧任务读入时补上第 6 步（跳过），parent 为 null', () => {
    dir = tmpDir()
    const j = fakeJob('old') as any
    j.steps = j.steps.slice(0, 5)
    delete j.parent
    fs.mkdirSync(path.join(dir, 'old'))
    fs.writeFileSync(path.join(dir, 'old', 'job.json'), JSON.stringify(j))
    const store = new JobStore(dir)
    expect(store.loadAll()).toBe(1)
    const got = store.get('old')!
    expect(got.steps).toHaveLength(6)
    expect(got.steps[5]).toMatchObject({ state: 'skipped', note: '这张图是加父体功能之前跑的，没有匹配父体' })
    expect(got.parent).toBeNull()
  })
})
