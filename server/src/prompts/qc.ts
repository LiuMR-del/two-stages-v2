import { z } from 'zod'

/** 素材图验收：一个分析请求同时看竞品图和素材图。文字只让模型抄，一致不一致由程序判 */
export const QC_SYSTEM = `你是素材图验收助手。第一张图片是竞品商品图，第二张图片是从它提取出来的平面素材图（只保留商品印刷面上的图案）。请完成两件事，只输出 JSON，不要任何其他文字：
1. 逐字抄写文字：分别把第一张图里商品印刷面上的所有文字、第二张图里的所有文字逐字抄下来。照原样抄，不翻译、不纠错、不补全、不改大小写；按从上到下、从左到右的顺序，每一行（或连在一起的一小段）作为数组里的一项。商品印刷面以外的文字（背景、水印、包装、价格标签）不要抄。没有文字给空数组。
2. 比对图案元素：比对两张图印刷面上的主要元素（人物、动物、建筑、物品、装饰，如星星、雪花球），看素材图有没有缺失、多出或明显变样的元素。给 0～1 的相似分（1 表示完全一致），并用中文短句列出发现的问题，没有问题给空数组。素材图去掉了商品外形、边框、透视、光影和背景是正常的，不要因此扣分；文字差异不用写进元素问题。
输出格式：
{"source_texts": ["第一张图的文字"], "pattern_texts": ["第二张图的文字"], "element_score": 0.95, "element_issues": []}`

export const QC_USER = '第一张是竞品商品图，第二张是提取出来的素材图。请按要求抄写文字、比对图案元素，只输出 JSON。'

const strList = z
  .array(z.unknown())
  .nullish()
  .transform((a) => (a ?? []).map((x) => String(x ?? '').trim()).filter(Boolean))

export const QcAnswerSchema = z.object({
  source_texts: strList,
  pattern_texts: strList,
  element_score: z.coerce.number().min(0).max(1),
  element_issues: strList,
})
export type QcAnswer = z.infer<typeof QcAnswerSchema>

/** 大小写、全半角、标点符号、空白都不算差异 */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 逐条比对两边的文字。分行不同（「THE BENNETT」「FAMILY」和「THE BENNETT FAMILY」）不算差异；
 * 有缺、多、改任何一处都返回差异说明。
 */
export function compareTexts(source: string[], pattern: string[]): { ok: boolean; diffs: string[] } {
  const a = source.map((t) => ({ raw: t, n: normalizeText(t) })).filter((t) => t.n)
  const b = pattern.map((t) => ({ raw: t, n: normalizeText(t) })).filter((t) => t.n)
  // 按原顺序拼成词序列再比：分行不同不算差异，顺序调换算
  const words = (xs: { n: string }[]) => xs.map((x) => x.n).join(' ')
  if (words(a) === words(b)) return { ok: true, diffs: [] }

  const rest = [...b]
  const srcOnly: typeof a = []
  for (const t of a) {
    const i = rest.findIndex((x) => x.n === t.n)
    if (i >= 0) rest.splice(i, 1)
    else srcOnly.push(t)
  }
  const diffs: string[] = []
  const n = Math.min(srcOnly.length, rest.length)
  for (let i = 0; i < n; i++) diffs.push(`文字变了：原图 ${srcOnly[i]!.raw} → 素材图 ${rest[i]!.raw}`)
  for (const t of srcOnly.slice(n)) diffs.push(`素材图缺少文字：${t.raw}`)
  for (const t of rest.slice(n)) diffs.push(`素材图多出文字：${t.raw}`)
  // 每条都对得上、只是顺序或拆分不同
  if (!diffs.length) diffs.push(`文字顺序变了：原图 ${a.map((x) => x.raw).join(' / ')} → 素材图 ${b.map((x) => x.raw).join(' / ')}`)
  return { ok: false, diffs }
}
