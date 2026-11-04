import { describe, expect, it } from 'vitest'
import { analyzeNaming, chooseAttribute, nextName, patternOf, splitValue } from '../../server/src/parent/naming'

const kids = (attr: string, values: string[]) => values.map((v) => ({ [attr]: v }))
const next = (values: string[], taken: number[] = [], theme = ['color']) => nextName(analyzeNaming(theme, kids('color', values)), taken)

describe('命名推算：实施方案里的三个真实父体', () => {
  it('HJ-cn-yklgj-Christmas Baby：Design 01～04 → Design 05', () => {
    const r = next(['Design 01', 'Design 02', 'Design 03', 'Design 04'])
    expect(r).toMatchObject({ attribute: 'color', next: 'Design 05', groups: [{ pattern: 'Design ##', count: 4 }], note: null, key: 'Design ##', number: 5 })
  })

  it('HJ-cn-yklgj-Christmas：Design 01～05 → Design 06', () => {
    expect(next(['Design 03', 'Design 01', 'Design 05', 'Design 02', 'Design 04']).next).toBe('Design 06')
  })

  it('HJ-cn-yklgj5-Christmas Dumpling：Design 02、03 + Ceramic → 「Design ##」2 个最多 → Design 04', () => {
    const r = next(['Design 02', 'Ceramic', 'Design 03'])
    expect(r.groups).toEqual([
      { pattern: 'Design ##', count: 2 },
      { pattern: 'Ceramic', count: 1 },
    ])
    expect(r.next).toBe('Design 04')
  })
})

describe('命名推算：其他情况', () => {
  it('父体还没有子体：没有可参照的同品类父体时 Style01 起（2026-11-04 用户确认），并说明', () => {
    const r = next([])
    expect(r).toMatchObject({ next: 'Style01', note: '这个父体还没有子体，按 Style01 起（同品类没有可参照的父体）', key: 'Style##' })
    // 同一批里别的图已经分到 Style01
    expect(next([], [1]).next).toBe('Style02')
  })

  it('父体还没有子体：按参照的写法起（如同品类多用 Design ##）', () => {
    const r = nextName(analyzeNaming(['color'], []), [], { prefix: 'Design ', width: 2 }, '同品类最近的父体 A')
    expect(r).toMatchObject({ next: 'Design 01', key: 'Design ##', note: '这个父体还没有子体，按 Design 01 起（参照同品类最近的父体 A）' })
  })

  it('最多的那种命名没有编号：不推荐，提示手动起名并列出现有名字', () => {
    const r = next(['Red', 'Red', 'Blue'])
    expect(r).toMatchObject({ next: null, key: null, note: '这个父体的命名没有编号，请手动起名（现有：Red、Red、Blue）' })
  })

  it('数量一样时取最大编号更大的那一类；位数不变', () => {
    expect(next(['Style 1', 'Style 2', 'Design 008', 'Design 009']).next).toBe('Design 010')
    expect(next(['A1', 'A2', 'B07', 'B03']).next).toBe('B08')
  })

  it('队列里已经分到的号也算占用，依次往后排', () => {
    expect(next(['Design 01', 'Design 02'], [3, 4]).next).toBe('Design 05')
    expect(next(['Design 01', 'Design 02'], [3, 4]).number).toBe(5)
  })

  it('同一前缀位数不同（Design 1～9 和 Design 10）不撞号', () => {
    const r = next(['Design 1', 'Design 2', 'Design 3', 'Design 9', 'Design 10'])
    expect(r.next).toBe('Design 11')
    expect(next(['Design 01', 'Design 02', 'design 03']).next).toBe('Design 04')
  })

  it('多个变体属性（尺寸 + 颜色）：选带编号的值占比最高的那个', () => {
    const children = [
      { size_name: '8x12 Inch', color: 'Design 01' },
      { size_name: '12x18 Inch', color: 'Design 02' },
      { size_name: '8x12 Inch', color: 'Design 03' },
    ]
    const a = analyzeNaming(['size_name', 'color'], children)
    expect(a.attribute).toBe('color')
    expect(nextName(a).next).toBe('Design 04')
    expect(chooseAttribute(['size', 'color'], { size: ['Small', 'Large'], color: ['Red', 'Blue'] })).toBe('size')
  })

  it('拆分和归类', () => {
    expect(splitValue('Design 05 ')).toEqual({ prefix: 'Design ', num: 5, width: 2 })
    expect(splitValue('Ceramic')).toBeNull()
    expect(patternOf('Design 05')).toBe('Design ##')
    expect(patternOf('No.7')).toBe('No.#')
  })
})
