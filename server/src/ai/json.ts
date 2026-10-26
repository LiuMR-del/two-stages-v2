/**
 * 去掉代码围栏后，从第一个 `{` 开始做括号配对（跳过字符串里的括号），取出第一个完整的 JSON 对象。
 */
export function extractFirstJsonObject(text: string): unknown {
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text)
  const candidates = fenced ? [fenced[1]!, text] : [text]
  let lastErr: unknown = new Error('回复里没有 JSON 对象')
  for (const src of candidates) {
    let from = src.indexOf('{')
    while (from !== -1) {
      const end = matchBrace(src, from)
      if (end === -1) break
      try {
        return JSON.parse(src.slice(from, end + 1))
      } catch (e) {
        lastErr = e
      }
      from = src.indexOf('{', from + 1)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

function matchBrace(s: string, start: number): number {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}
