import { z } from 'zod'
import type { ParentRow } from '../parent/feishu'

/** 店铺来源的行多一个商品标题（日期码父体 SKU 里没有主题，只能看标题） */
type Row = ParentRow & { title?: string }

/** 候选太多时只给前这么多个（表里一页一般几十个） */
export const MAX_CANDIDATES = 300

/** 第 6 步：让分析模型从标签页的父体里挑一个。用编号而不是让模型抄 SKU，避免编出不存在的 SKU */
export function parentSystem(tab: string, samples: string[], source: 'feishu' | 'store' = 'feishu'): string {
  const intro =
    source === 'store'
      ? `店铺里「${tab}」的父体清单（编号｜主题｜父体SKU｜商品标题；有的父体 SKU 里没写主题，看商品标题判断它是什么主题）`
      : `飞书父体表「${tab}」标签页里的父体清单（编号｜主题｜父体SKU）`
  return `你是亚马逊父体匹配助手。给你一张竞品商品图、它的品类、场景和关键词，以及${intro}。判断这张图应该挂到哪个父体下：父体的主题要和图案内容（节日、人物、动物、风格、用途）对得上。只输出 JSON，不要任何其他文字：
{"pick": 清单里的编号或 null, "confidence": 0 到 1 之间的小数, "reason": "一句话中文理由", "alternatives": [其他可能的编号，最多 2 个], "new_themes": ["pick 为 null 时给 2～3 个英文主题，否则空数组"]}
规则：
1. 只能从清单里选编号，不要编造。清单里没有合适的父体时 pick 填 null。
2. confidence 表示你对 pick 的把握，不要习惯性给高分。
${source === 'store' ? '3. 清单里同一商品类型可能有不同材质（比如亚克力挂件和陶瓷挂件 Ceramic、木质挂件 Wooden），父体的材质要和这张图的品类一致，看父体 SKU 和商品标题区分，对不上的不要选。\n' : ''}${source === 'store' ? 4 : 3}. pick 为 null 时，new_themes 给 2～3 个英文主题，按合适程度排序：每个 1～3 个词，每个词首字母大写，风格照着这个标签页已有的主题${samples.length ? `（样例：${samples.join('、')}）` : ''}。pick 不为 null 时 new_themes 给空数组。`
}

export function parentUser(p: { category: string; scene: string | null; keywords: string[]; rows: Row[] }): string {
  const list = p.rows
    .slice(0, MAX_CANDIDATES)
    .map((r, i) => `${i + 1}｜${r.theme || '（没写主题）'}｜${r.sku}${r.title !== undefined ? `｜${r.title || '（没有标题）'}` : ''}`)
    .join('\n')
  return [
    `品类：${p.category}`,
    `场景：${p.scene || '（没有）'}`,
    `关键词：${p.keywords.join('、') || '（没有）'}`,
    `父体清单：`,
    list,
    '请判断这张竞品图应该挂到哪个父体下，只输出 JSON。',
  ].join('\n')
}

const num = z.preprocess((v) => (v === '' || v === 'null' || v === undefined ? null : v), z.coerce.number().int().nullable())

export const ParentAnswerSchema = z.object({
  pick: num,
  confidence: z.coerce.number().min(0).max(1),
  reason: z.string().optional().default(''),
  alternatives: z
    .array(z.unknown())
    .nullish()
    .transform((a) => (a ?? []).map((x) => Number(x)).filter((x) => Number.isInteger(x))),
  new_themes: z
    .array(z.unknown())
    .nullish()
    .transform((a) => (a ?? []).map((x) => String(x ?? '').trim()).filter(Boolean)),
})
export type ParentAnswer = z.infer<typeof ParentAnswerSchema>
