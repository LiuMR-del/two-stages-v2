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
    // 只留当天的记录
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')))).toEqual(['2026-10-30'])
  })
})
