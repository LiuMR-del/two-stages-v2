import { z } from 'zod'
import { isValidRatio } from '../prompts/canvas'

export const HASH_RE = /^[a-f0-9]{64}$/

const Hash = z.string().regex(HASH_RE, '图片指纹格式不对')
const Ratio = z.string().refine(isValidRatio, '比例要写成「3:2」这样的两个正整数')

export const StyleSchema = z.object({
  id: z.string().min(1),
  name: z.string().max(20),
  ratio: Ratio,
  whiteImage: Hash.nullable(),
})

export const TemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(30),
  prompt: z.string(),
  images: z.record(z.string(), Hash),
})

export const CategorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(20),
  hint: z.string(),
  extractPrompt: z.string().nullable(),
  activeTemplate: z.string().min(1),
  styles: z.array(StyleSchema).min(1),
  templates: z.array(TemplateSchema),
})

export const LibrarySchema = z.object({
  version: z.literal(1),
  defaults: z.object({
    extractPrompt: z.string(),
    pastePrompt: z.string(),
  }),
  categories: z.array(CategorySchema),
})

export type Style = z.infer<typeof StyleSchema>
export type Template = z.infer<typeof TemplateSchema>
export type Category = z.infer<typeof CategorySchema>
export type Library = z.infer<typeof LibrarySchema>

export const DEFAULT_EXTRACT_PROMPT =
  '这是一张{品类}商品图。识别商品表面印刷的图案，把它完整提取出来还原成平面设计稿：去掉商品外形、透视、褶皱、光影和背景；图案的构图、文字、颜色保持不变，不重绘、不增删；高清输出，比例 {比例}。'

export const DEFAULT_PASTE_PROMPT =
  '请自动识别商品底图中用于承载图案的表面及其边界，将素材图直接贴满该区域，贴合原有透视，不额外留白边，不超出边界。直接使用原素材，不重绘，不修改文字、图案和排版。底图的商品外形、比例、角度、材质、光影、背景、构图及图片尺寸保持不变，只完成贴图，不做其他改动。'

export function initialLibrary(): Library {
  return {
    version: 1,
    defaults: { extractPrompt: DEFAULT_EXTRACT_PROMPT, pastePrompt: DEFAULT_PASTE_PROMPT },
    categories: [],
  }
}

/** 库里所有被引用的图片 */
export function referencedHashes(lib: Library): Set<string> {
  const s = new Set<string>()
  for (const c of lib.categories) {
    for (const st of c.styles) if (st.whiteImage) s.add(st.whiteImage)
    for (const t of c.templates) for (const h of Object.values(t.images)) s.add(h)
  }
  return s
}

/** 结构之外的一致性：id 唯一、名称不重复、模版图只挂在存在的款式上 */
export function validateIntegrity(lib: Library): string | null {
  const names = new Set<string>()
  const ids = new Set<string>()
  for (const c of lib.categories) {
    if (names.has(c.name)) return `品类名称重复：「${c.name}」`
    names.add(c.name)
    if (ids.has(c.id)) return `品类 id 重复：${c.id}`
    ids.add(c.id)
    const sids = new Set(c.styles.map((s) => s.id))
    if (sids.size !== c.styles.length) return `「${c.name}」里有重复的款式 id`
    const tids = new Set(c.templates.map((t) => t.id))
    if (tids.size !== c.templates.length || tids.has('default')) return `「${c.name}」里有重复的模版 id`
    for (const t of c.templates) {
      for (const sid of Object.keys(t.images)) if (!sids.has(sid)) return `模版「${t.name}」的参考图挂在不存在的款式上`
    }
  }
  return null
}
