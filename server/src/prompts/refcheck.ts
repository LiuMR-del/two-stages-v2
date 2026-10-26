const REF_RE = /第\s*([一二三四五12345])\s*张/g
const REF_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5 }

/** 提示词里提到的最大图片编号 */
export function maxImageRef(prompt: string): number {
  let max = 0
  for (const m of prompt.matchAll(REF_RE)) max = Math.max(max, REF_NUM[m[1]!] ?? 0)
  return max
}

export function refWarning(prompt: string, sentCount: number): string | null {
  const n = maxImageRef(prompt)
  return n > sentCount ? `提示词里提到「第 ${n} 张」图片，但这里只会发送 ${sentCount} 张` : null
}
