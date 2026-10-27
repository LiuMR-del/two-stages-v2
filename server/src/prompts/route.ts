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
{"category_id": "清单中的品类 id；清单里没有对应品类时为 null", "style_id": "该品类下的款式 id；无法判断时为 null", "confidence": 0 到 1 之间的小数, "reason": "一句话中文判断理由", "guess": "图中商品的中文品类名，无论是否匹配都必须填写", "print_corners": [[左上x, 左上y], [右上x, 右上y], [右下x, 右下y], [左下x, 左下y]]}
规则：
1. 只能从清单中选择，不得编造 id。看不清或清单中没有对应品类时 category_id 填 null。
2. 款式按商品印刷面的形状和方向判断（例如横版/竖版看印刷面的宽高），不要按整张照片的宽高判断。
3. confidence 表示你对品类判断的把握，不要习惯性给高分。
4. print_corners 是商品「印刷面」四个角在图里的位置，坐标用 0～1 的比例（相对整张图的宽和高），顺序左上、右上、右下、左下。印刷面 = 商品上印着图案的整块面，一直到商品的实体外缘：印在面上的边框、线框、做旧边、锈迹都算在里面，不能往里缩；背景、墙面、拿着它的手和人、相框或画框的木框、商品的厚度和侧边、阴影都不算。商品有圆角时把圆角补成直角给出角点；斜着拍时按透视给出四个实际的角点（不是外接矩形）。印刷面不是一块平整的四边形（如揉皱的布、弯曲的灯罩）时，给出能框住它的四个角。看不到商品时为 null。
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
  /** 交给 image/face.ts 校验，不合格当作没给 */
  print_corners: z.unknown().optional(),
})
export type RouteAnswer = z.infer<typeof RouteAnswerSchema>
