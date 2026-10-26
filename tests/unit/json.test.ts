import { describe, expect, it } from 'vitest'
import { extractFirstJsonObject } from '../../server/src/ai/json'

describe('extractFirstJsonObject', () => {
  it('带代码围栏', () => {
    expect(extractFirstJsonObject('```json\n{"a": 1}\n```')).toEqual({ a: 1 })
    expect(extractFirstJsonObject('```\n{"a": 2}\n```')).toEqual({ a: 2 })
  })
  it('前后有说明文字', () => {
    expect(extractFirstJsonObject('好的，结果如下：{"a": 1, "b": "x"} 希望有帮助 {"c": 3}')).toEqual({ a: 1, b: 'x' })
  })
  it('嵌套括号和字符串里的括号', () => {
    const t = '结果 {"a": {"b": [1, {"c": 2}]}, "s": "含有 } 和 { 的文字", "q": "\\"}"} 结束'
    expect(extractFirstJsonObject(t)).toEqual({ a: { b: [1, { c: 2 }] }, s: '含有 } 和 { 的文字', q: '"}' })
  })
  it('前面有不合法的花括号时跳过', () => {
    expect(extractFirstJsonObject('{这不是json} 然后 {"ok": true}')).toEqual({ ok: true })
  })
  it('没有 JSON 时抛错', () => {
    expect(() => extractFirstJsonObject('没有任何对象')).toThrow()
    expect(() => extractFirstJsonObject('{"a": 1')).toThrow()
  })
})
