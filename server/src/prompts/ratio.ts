import { z } from 'zod'

export const RATIO_SYSTEM = '你是电商商品图的测量助手，只输出 JSON 对象，不输出其他文字。'

export function ratioUser(label: string, hint: string): string {
  return [
    `这是「${label}」的商品图${hint ? `（${hint}）` : ''}。`,
    '找出商品上用来印定制图案的那一块表面（例如画面、毯面、标牌正面、灯罩上透光的面板），图案设计稿就要做成它的形状。',
    '如果这块表面是斜着拍的，按它正对着看时的真实形状估计。',
    '输出 JSON：{"found": true 或 false, "box": [左, 上, 右, 下], "width_to_height": 数字, "shape": "长方形" 或 "圆形" 或 "其他", "surface": "这块表面是什么，几个字", "reason": "一句话说明"}',
    'box 是这块表面在图里的范围，用 0～1000 的相对坐标（横向按图宽、纵向按图高）；width_to_height 是正对时的宽÷高。',
  ].join('\n')
}

export const RatioAnswerSchema = z.object({
  found: z.boolean(),
  box: z.array(z.number()).length(4).nullable().optional(),
  width_to_height: z.number().positive().nullable().optional(),
  shape: z.string().optional().default(''),
  surface: z.string().optional().default(''),
  reason: z.string().optional().default(''),
})

const MAX_TERM = 12
const TOLERANCE = 0.03

/** 换成好记的整数比：先找最简单、误差 3% 以内的，找不到就取误差最小的 */
export function snapRatio(r: number): string {
  const cands: { a: number; b: number; err: number }[] = []
  for (let a = 1; a <= MAX_TERM; a++) for (let b = 1; b <= MAX_TERM; b++) cands.push({ a, b, err: Math.abs(a / b - r) / r })
  cands.sort((x, y) => x.a + x.b - (y.a + y.b) || x.err - y.err)
  const pick = cands.find((c) => c.err <= TOLERANCE) ?? cands.reduce((m, c) => (c.err < m.err ? c : m))
  return `${pick.a}:${pick.b}`
}
