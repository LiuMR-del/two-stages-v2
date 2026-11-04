import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatSku, SkuCounter } from '../../server/src/pipeline/sku'
import { rmDir, tmpDir } from '../helpers'

const P = { store: 'HJ', code: 'mtfl', region: '7', mark: '1' }
let dir: string | null = null
afterEach(() => {
  if (dir) rmDir(dir)
  dir = null
})

describe('子体 SKU', () => {
  it('按用户给的例子拼：HJ-mtfl671028101', () => {
    expect(formatSku(P, '2026-10-28', 1)).toBe('HJ-mtfl671028101')
    expect(formatSku(P, '2026-10-28', 2)).toBe('HJ-mtfl671028102')
    expect(formatSku({ ...P, code: 'cn-tyntyd' }, '2026-01-05', 12)).toBe('HJ-cn-tyntyd670105112')
    expect(formatSku(P, '2026-10-28', 100)).toBe('HJ-mtfl6710281100')
  })

  it('每个品类每天各自从 01 起；换一天重新从 01 起；跳过已占用的；记在文件里重启后接着排', () => {
    dir = tmpDir()
    const file = path.join(dir, 'sku.json')
    const day1 = new Date(2026, 9, 29, 10)
    const c = new SkuCounter(file)
    const none = () => false
    expect(c.allocate(P, none, day1)).toBe('HJ-mtfl671029101')
    expect(c.allocate(P, none, day1)).toBe('HJ-mtfl671029102')
    expect(c.allocate({ ...P, code: 'xkfb' }, none, day1)).toBe('HJ-xkfb671029101')
    expect(c.allocate(P, (s) => s === 'HJ-mtfl671029103', day1)).toBe('HJ-mtfl671029104')
    expect(new SkuCounter(file).allocate(P, none, day1)).toBe('HJ-mtfl671029105')
    expect(c.allocate(P, none, new Date(2026, 9, 30, 9))).toBe('HJ-mtfl671030101')
    // 留最近 7 天的记录（跨天没清空的批次也能改专属号）
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).counts)).toEqual(['2026-10-29', '2026-10-30'])
    for (let d = 1; d <= 8; d++) c.allocate(P, none, new Date(2026, 10, d, 9))
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).counts)).toHaveLength(7)
  })

  it('发过的号不管在哪一批都不再发：改专属号改出来的号记下来，之后按新专属号发时跳过（两批都改成 5 的情况）', () => {
    dir = tmpDir()
    const c = new SkuCounter(path.join(dir, 'sku.json'))
    const day = new Date(2026, 10, 4, 10)
    const none = () => false
    const p0 = { ...P, mark: '0' }
    const p5 = { ...P, mark: '5' }
    // 第一批 2 张，改成 5
    expect([c.allocate(p0, none, day), c.allocate(p0, none, day)]).toEqual(['HJ-mtfl671104001', 'HJ-mtfl671104002'])
    c.record(['HJ-mtfl671104501', 'HJ-mtfl671104502'], day)
    // 第二批先 1 张（0 号的第 3 个），改成 5
    expect(c.allocate(p0, none, day)).toBe('HJ-mtfl671104003')
    c.record(['HJ-mtfl671104503'], day)
    // 第二批再加图：5 号的 01～03 已经发过，从 04 起
    expect(c.allocate(p5, none, day)).toBe('HJ-mtfl671104504')
    expect(c.issued('hj-mtfl671104502')).toBe(true)
    expect(c.issued('HJ-mtfl671104004')).toBe(false)
  })

  it('旧格式的 sku.json（只有计数）也能读', () => {
    dir = tmpDir()
    const file = path.join(dir, 'sku.json')
    fs.writeFileSync(file, JSON.stringify({ '2026-11-04': { 'HJ-mtfl6711041': 3 } }))
    expect(new SkuCounter(file).allocate(P, () => false, new Date(2026, 10, 4, 10))).toBe('HJ-mtfl671104104')
  })
})
