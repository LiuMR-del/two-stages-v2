import { describe, expect, it } from 'vitest'
import { canvasFor, describeCanvas, pickApiSize, ratioToWH } from '../../server/src/prompts/canvas'

describe('describeCanvas', () => {
  it('常见比例在 3% 以内取整', () => {
    expect(describeCanvas(1536, 1024)).toEqual({ ratio: '3:2', orientation: 'landscape' })
    expect(describeCanvas(1024, 1536)).toEqual({ ratio: '2:3', orientation: 'portrait' })
    expect(describeCanvas(1000, 1000)).toEqual({ ratio: '1:1', orientation: 'square' })
    expect(describeCanvas(1920, 1080)).toEqual({ ratio: '16:9', orientation: 'landscape' })
    expect(describeCanvas(3066, 4000).ratio).toBe('3:4') // 0.7665 vs 0.75，差 2.2%
    expect(describeCanvas(1210, 1000).ratio).toBe('121:100') // 和 5:4 差 3.2%，不取整
  })

  it('超过 3% 用最大公约数约简的精确比例', () => {
    expect(describeCanvas(1300, 1000).ratio).toBe('4:3') // 差 2.5%
    expect(describeCanvas(1400, 1000).ratio).toBe('7:5')
    expect(describeCanvas(1537, 1024).ratio).toBe('3:2')
    expect(describeCanvas(700, 1000).ratio).toBe('7:10')
  })

  it('方向：0.97～1.03 为 square', () => {
    expect(describeCanvas(1030, 1000).orientation).toBe('square')
    expect(describeCanvas(970, 1000).orientation).toBe('square')
    expect(describeCanvas(1031, 1000).orientation).toBe('landscape')
    expect(describeCanvas(969, 1000).orientation).toBe('portrait')
  })

  it('宽高不合法时报错', () => {
    expect(() => describeCanvas(0, 100)).toThrow()
  })
})

describe('pickApiSize', () => {
  it('按 1.2 / 0.8 分三档', () => {
    expect(pickApiSize(3, 2)).toBe('1536x1024')
    expect(pickApiSize(2, 3)).toBe('1024x1536')
    expect(pickApiSize(1, 1)).toBe('1024x1024')
    expect(pickApiSize(1.2, 1)).toBe('1024x1024')
    expect(pickApiSize(1.21, 1)).toBe('1536x1024')
    expect(pickApiSize(0.8, 1)).toBe('1024x1024')
    expect(pickApiSize(0.79, 1)).toBe('1024x1536')
    expect(pickApiSize(5, 4)).toBe('1536x1024')
    expect(pickApiSize(4, 5)).toBe('1024x1024')
  })
})

describe('ratioToWH', () => {
  it('解析合法比例', () => {
    expect(ratioToWH('3:2')).toEqual([3, 2])
    expect(ratioToWH(' 16 : 9 ')).toEqual([16, 9])
  })
  it('非法格式报错', () => {
    for (const bad of ['3/2', '0:1', '1:0', 'a:b', '1.5:1', '', '3:2:1', '-1:2']) {
      expect(() => ratioToWH(bad), bad).toThrow()
    }
  })
})

describe('canvasFor', () => {
  it('前置句和 size 来自同一组宽高', () => {
    const c = canvasFor(2, 3)
    expect(c.prefix).toBe('[Canvas: 2:3 portrait format] ')
    expect(c.size).toBe('1024x1536')
  })
  it('前置句不含铺满画布之类的措辞', () => {
    const c = canvasFor(3, 2)
    expect(c.prefix).not.toMatch(/fill|edge to edge|铺满/i)
  })
})
