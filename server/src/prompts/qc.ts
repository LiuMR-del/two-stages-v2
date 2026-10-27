import { z } from 'zod'

const FIRST_PHOTO = '第一张图片是竞品商品图'
const FIRST_FACE = '第一张图片是从竞品商品图里裁出、按透视拉正的商品印刷面（边上可能残留一丝背景或手指，那不算印刷面）'

/**
 * 素材图验收：一个分析请求同时看竞品图（或拉正后的印刷面）和素材图。文字只让模型抄，一致不一致由程序判。
 * 第一张是拉正后的印刷面时，颜色比较直接用整张图，不用模型给的框。
 */
export function qcSystem(face: boolean): string {
  return QC_SYSTEM.replace(FIRST_PHOTO, face ? FIRST_FACE : FIRST_PHOTO)
}

export const QC_SYSTEM = `你是素材图验收助手。第一张图片是竞品商品图，第二张图片是从它提取出来的平面素材图（只保留商品印刷面上的图案）。请完成下面几件事，只输出 JSON，不要任何其他文字：
1. 逐字抄写文字：分别把第一张图里商品印刷面上的所有文字、第二张图里的所有文字逐字抄下来。照原样抄，不翻译、不纠错、不补全、不改大小写；按从上到下、从左到右的顺序，每一行（或连在一起的一小段）作为数组里的一项。商品印刷面以外的文字（背景、水印、包装、价格标签）不要抄。没有文字给空数组。
2. 标出印刷面位置：给出第一张图里商品印刷面（印着图案的整块面，一直到商品的实体外缘，印在面上的边框也算；不含背景）的外接矩形 print_box，格式 [左, 上, 右, 下]，用 0～1 的比例表示（相对第一张图的宽和高）。
3. 比对图案元素：比对两张图印刷面上的主要元素（人物、动物、建筑、物品、装饰，如星星、雪花球），看素材图有没有缺失、多出或明显变样的元素。给 0～1 的相似分（1 表示完全一致），并用中文短句列出发现的问题，没有问题给空数组。文字差异不用写进元素问题。
4. 比对四边：印刷面上看得到的都属于图案，包括四周印刷的边框和线框、做旧边、锈迹、划痕。逐条列出第一张图印刷面四边有、素材图里却没有的内容（edge_missing，如「四周的红色做旧边没了」），以及素材图四边多出来、第一张图印刷面上没有的东西（edge_extra，如「多了一圈金属边」「带着圆角」「带着安装孔或螺丝」「带着背景」）。没有就给空数组。
素材图去掉了商品的厚度和侧边、圆角外的空白、安装孔和螺丝、透视、反光、阴影和背景是正常的，不要因此扣分。
输出格式：
{"source_texts": ["第一张图的文字"], "pattern_texts": ["第二张图的文字"], "print_box": [0.1, 0.2, 0.9, 0.8], "element_score": 0.95, "element_issues": [], "edge_missing": [], "edge_extra": []}`

export const QC_USER = '第一张是竞品商品图，第二张是提取出来的素材图。请按要求抄写文字、比对图案元素，只输出 JSON。'

const strList = z
  .array(z.unknown())
  .nullish()
  .transform((a) => (a ?? []).map((x) => String(x ?? '').trim()).filter(Boolean))

export const QcAnswerSchema = z.object({
  source_texts: strList,
  pattern_texts: strList,
  print_box: z
    .array(z.coerce.number())
    .nullish()
    .catch(null)
    .transform((v) => v ?? null),
  element_score: z.coerce.number().min(0).max(1),
  element_issues: strList,
  edge_missing: strList,
  edge_extra: strList,
})
export type QcAnswer = z.infer<typeof QcAnswerSchema>

/** 主图验收（AI 贴图时）：素材图和主图一起看。文字照样只让模型抄，由程序比 */
export const MAIN_QC_SYSTEM = `你是主图验收助手。第一张图片是素材图（平面图案），第二张图片是把素材图贴到商品上生成的主图。请完成下面几件事，只输出 JSON，不要任何其他文字：
1. 逐字抄写文字：分别把第一张图里的所有文字、第二张图里商品印刷面上的所有文字逐字抄下来。照原样抄，不翻译、不纠错、不补全、不改大小写；按从上到下、从左到右的顺序，每一行（或连在一起的一小段）作为数组里的一项。没有文字给空数组。
2. 标出印刷面位置：给出第二张图里商品印刷面的外接矩形 print_box，格式 [左, 上, 右, 下]，用 0～1 的比例表示。
3. 比对图案元素：第二张图印刷面上的图案和第一张图比，主要元素（人物、动物、建筑、物品、装饰、四周的边框和做旧边）有没有缺失、多出或明显变样。给 0～1 的相似分（1 表示完全一致），并用中文短句列出问题，没有问题给空数组。
4. 检查贴图：印刷面有没有被素材图完整铺满（露出空白、金属边、底材算没铺满）；印刷面以内有没有透出商品原来的金属、木纹等材质颜色（包括素材图里白色、浅色的地方）。有问题就用中文短句写进 fill_issues，没有给空数组。
透视、光影、反光、安装孔和螺丝是正常的，不要因此扣分。
输出格式：
{"pattern_texts": ["第一张图的文字"], "main_texts": ["第二张图的文字"], "print_box": [0.1, 0.2, 0.9, 0.8], "element_score": 0.95, "element_issues": [], "fill_issues": []}`

export const MAIN_QC_USER = '第一张是素材图，第二张是贴好的主图。请按要求抄写文字、比对图案、检查贴图，只输出 JSON。'

export const MainQcAnswerSchema = z.object({
  pattern_texts: strList,
  main_texts: strList,
  print_box: z
    .array(z.coerce.number())
    .nullish()
    .catch(null)
    .transform((v) => v ?? null),
  element_score: z.coerce.number().min(0).max(1),
  element_issues: strList,
  fill_issues: strList,
})

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
export function compareTexts(source: string[], pattern: string[], names: { from: string; to: string } = { from: '原图', to: '素材图' }): { ok: boolean; diffs: string[] } {
  const { from, to } = names
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
  for (let i = 0; i < n; i++) diffs.push(`文字变了：${from} ${srcOnly[i]!.raw} → ${to} ${rest[i]!.raw}`)
  for (const t of srcOnly.slice(n)) diffs.push(`${to}缺少文字：${t.raw}`)
  for (const t of rest.slice(n)) diffs.push(`${to}多出文字：${t.raw}`)
  // 每条都对得上、只是顺序或拆分不同
  if (!diffs.length) diffs.push(`文字顺序变了：${from} ${a.map((x) => x.raw).join(' / ')} → ${to} ${b.map((x) => x.raw).join(' / ')}`)
  return { ok: false, diffs }
}
