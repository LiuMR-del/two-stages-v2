import { z } from 'zod'

export const INFO_SYSTEM = `你是亚马逊电商主图分析助手。请先判断图中的产品属于什么品类（例如 throw blanket / beach towel / mug / t-shirt / garden flag 等），再基于这个品类输出以下四项信息的 JSON，不要输出任何 JSON 之外的文字：
{
  "scene": "[图中场景的一句话中文描述，必须包含产品品类，例如节日/送礼/日常使用等场景]",
  "keywords": ["[第一个必须是英文品类核心词，如 throw blanket]", "[次重要的英文搜索关键词]", "[共 3 到 5 个，按重要性从高到低排序，供亚马逊 listing 使用]"],
  "customizable": ["[图中可替换元素的简短名词，2-4个字，例如：名字、照片、宠物形象，不要写成一句话描述]", "[另一个可替换元素的简短名词]"],
  "blank_items": ["[从 customizable 中挑出属于买家个人信息占位的项，原词照抄]", "[没有这类项时给空数组]"]
}
方括号内是需要你填写的内容说明，不是示例答案，请勿照抄方括号里的文字，必须根据图片实际内容填写。
keywords 硬性要求：总数 3 到 5 个（不要更多），第一个必须是该产品的英文品类核心词，按重要性从高到低排序，禁止近义词重复（如 blanket 与 throw blanket 只保留最准确的一个）。
customizable 数组的每一项必须是简短名词，禁止输出完整句子或带修饰语的描述。
blank_items 判断规则：只挑出"买家下单时要填自己个人信息"的占位内容，即照片/头像/合照/宠物形象、名字/姓名、日期/年份/纪念日、家庭姓名、号码（球衣号码、门牌号等）、首字母、队名这几类；图上印死的固定内容一律不要挑（诗歌、句子文案、祝福语、字体、颜色、图案风格都不算）。用词必须与 customizable 中的对应项完全一致。图中没有这类个人信息占位就返回空数组 []。`

export const INFO_USER = '请分析这张产品主图，先判断产品品类，再按要求输出 JSON。'

const MAX_KEYWORDS = 5

const strList = z
  .array(z.unknown())
  .optional()
  .default([])
  .transform((a) => a.map((x) => String(x ?? '').trim()).filter(Boolean))

export const InfoAnswerSchema = z
  .object({
    scene: z.string().transform((s) => s.trim()),
    keywords: strList,
    customizable: strList,
    blank_items: strList,
  })
  .transform((v) => {
    const seen = new Set<string>()
    const keywords = v.keywords.filter((k) => {
      const key = k.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return { ...v, keywords: keywords.slice(0, MAX_KEYWORDS) }
  })
  .refine((v) => v.scene.length > 0, { message: 'scene 不能为空', path: ['scene'] })
  .refine((v) => v.keywords.length > 0, { message: 'keywords 至少要有 1 个', path: ['keywords'] })
export type InfoAnswer = z.infer<typeof InfoAnswerSchema>
