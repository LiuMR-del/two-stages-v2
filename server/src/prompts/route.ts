import { z } from 'zod'
import type { Library } from '../library/schema'

export const ROUTE_USER = '请判断这张商品图属于清单中的哪个品类和款式。'

export function routeCatalog(lib: Library): string {
  return lib.categories
    .map((c) => {
      const styles =
        c.styles.length === 1 && !c.styles[0]!.name
          ? `${c.styles[0]!.id} （单款式，比例 ${c.styles[0]!.ratio}）`
          : c.styles.map((s) => `${s.id} ${s.name}（比例 ${s.ratio}）`).join('；')
      return `- 品类 id: ${c.id}｜名称: ${c.name}｜识别说明: ${c.hint.replace(/\s+/g, ' ').trim()}｜款式: ${styles}`
    })
    .join('\n')
}

export function routeSystem(lib: Library): string {
  return `你是电商商品图分类助手。给你一张竞品商品图和一份品类清单，判断图中商品属于清单中的哪个品类、哪个款式。只输出一个 JSON 对象，不要输出任何其他文字：
{"category_id": "清单中的品类 id；清单里没有对应品类时为 null", "style_id": "该品类下的款式 id；无法判断时为 null", "confidence": 0 到 1 之间的小数, "reason": "一句话中文判断理由", "guess": "图中商品的中文品类名，无论是否匹配都必须填写"}
规则：
1. 只能从清单中选择，不得编造 id。看不清或清单中没有对应品类时 category_id 填 null。
2. 款式按商品印刷面的形状和方向判断（例如横版/竖版看印刷面的宽高），不要按整张照片的宽高判断。
3. confidence 表示你对品类判断的把握，不要习惯性给高分。
品类清单：
${routeCatalog(lib)}`
}

const nullableId = z.preprocess((v) => (v === '' || v === 'null' ? null : v), z.string().nullable())

export const RouteAnswerSchema = z.object({
  category_id: nullableId,
  style_id: nullableId.optional().default(null),
  confidence: z.coerce.number().min(0).max(1),
  reason: z.string().optional().default(''),
  guess: z.string().optional().default(''),
})
export type RouteAnswer = z.infer<typeof RouteAnswerSchema>
