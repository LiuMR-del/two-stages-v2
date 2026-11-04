import { z } from 'zod'
import { isValidRatio } from '../prompts/canvas'

export const HASH_RE = /^[a-f0-9]{64}$/

const Hash = z.string().regex(HASH_RE, '图片指纹格式不对')
const Ratio = z.string().refine(isValidRatio, '比例要写成「3:2」这样的两个正整数')

/** 自定义模版属于某一个款式，款式之间互不影响 */
export const TemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(30),
  prompt: z.string(),
  /** 参考图，可不配 */
  image: Hash.nullable(),
  /** 没有参考图时主图画布用的比例；null 表示跟款式比例 */
  canvasRatio: Ratio.nullable().default(null),
})

export const StyleSchema = z.object({
  id: z.string().min(1),
  name: z.string().max(20),
  ratio: Ratio,
  whiteImage: Hash.nullable(),
  /** 'default' 或本款式某个模版的 id */
  activeTemplate: z.string().min(1),
  templates: z.array(TemplateSchema),
  /** 默认模版的贴图方式：auto 按白底图自动判断，local 本地合成，ai AI 贴图 */
  pasteMode: z.enum(['auto', 'local', 'ai']).default('auto'),
  /**
   * 子体 SKU 里材质编码前的款式标记，如帆布画横版 HB、竖版 SB（2026-11-04 用户确认）：HJ-HBxkfb671104001。
   * null = 不加（旧库没有这个字段，读入时补 null，不升版本）
   */
  skuMark: z.string().nullable().default(null),
})

/** 白底图的本地图形检测结果，按图片指纹存；旧库没有这个字段，用到时再算 */
export const WhiteShapeSchema = z.object({
  ok: z.boolean(),
  shape: z.enum(['rect', 'ellipse']).nullable(),
  bbox: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
  fill: z.number().nullable(),
  holes: z.number(),
  reason: z.string(),
})

export const CategorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(20),
  hint: z.string(),
  extractPrompt: z.string().nullable(),
  styles: z.array(StyleSchema).min(1),
  /** 飞书父体表里对应的标签页；null = 和品类同名（旧库没有这个字段，读入时补 null，不升版本） */
  parentTab: z.string().nullable().default(null),
  /**
   * 店铺里对应的亚马逊商品类型（如毛毯 BLANKET），从店铺扫描父体的店铺（爱睿特）按它挑候选父体（多店铺方案 2.3）。
   * 旧库没有这个字段，读入时补 []，不升版本
   */
  productTypes: z.array(z.string()).default([]),
  /** 子体 SKU 里的材质缩写，如毛毯 mtfl；null = 不生成 SKU，文件名用原图名（旧库没有这个字段，读入时补 null） */
  skuCode: z.string().nullable().default(null),
})

export const LIBRARY_VERSION = 2

export const LibrarySchema = z.object({
  version: z.literal(LIBRARY_VERSION),
  defaults: z.object({
    extractPrompt: z.string(),
    pastePrompt: z.string(),
  }),
  categories: z.array(CategorySchema),
  whiteChecks: z.record(z.string(), WhiteShapeSchema).default({}),
})

export type Style = z.infer<typeof StyleSchema>
export type Template = z.infer<typeof TemplateSchema>
export type Category = z.infer<typeof CategorySchema>
export type Library = z.infer<typeof LibrarySchema>

export type WhiteShapeRecord = z.infer<typeof WhiteShapeSchema>

export const DEFAULT_EXTRACT_PROMPT = '这是一张{品类}商品图。只要商品印刷面上的图案部分，转成正面的平面设计稿并高清处理，图案四边铺满画布，比例 {比例}。'

export const DEFAULT_PASTE_PROMPT =
  '把素材图像一张不透明的贴纸一样覆盖在白底图商品的整个印刷面上，贴合原有透视：印刷面以内只看得到素材图，一直铺到商品轮廓，不留白边、不超出轮廓。商品原来的材质、颜色、纹理在任何地方都不能透出来，素材图里白色或浅色的部分也一样。保留安装孔等实体结构。直接使用原素材，不重绘，不修改文字、图案和排版。商品的形状、位置、取景、背景和阴影与白底图完全一致，只完成贴图，不做其他改动。'

/** 2026-10-27 之前的默认提示词；库里存的和它们一字不差时自动换成新的，改过的不动 */
export const OLD_DEFAULT_EXTRACT_PROMPTS = [
  '这是一张{品类}商品图。识别商品表面印刷的图案，把它完整提取出来还原成平面设计稿：去掉商品外形、透视、褶皱、光影和背景；图案的构图、文字、颜色保持不变，不重绘、不增删；高清输出，比例 {比例}。',
]
export const OLD_DEFAULT_PASTE_PROMPTS = [
  '请自动识别商品底图中用于承载图案的表面及其边界，将素材图直接贴满该区域，贴合原有透视，不额外留白边，不超出边界。直接使用原素材，不重绘，不修改文字、图案和排版。底图的商品外形、比例、角度、材质、光影、背景、构图及图片尺寸保持不变，只完成贴图，不做其他改动。',
]

/** 只换全局默认里一字不差的旧默认；返回换了几处 */
export function upgradeDefaults(lib: Library): number {
  let n = 0
  if (OLD_DEFAULT_EXTRACT_PROMPTS.includes(lib.defaults.extractPrompt)) {
    lib.defaults.extractPrompt = DEFAULT_EXTRACT_PROMPT
    n++
  }
  if (OLD_DEFAULT_PASTE_PROMPTS.includes(lib.defaults.pastePrompt)) {
    lib.defaults.pastePrompt = DEFAULT_PASTE_PROMPT
    n++
  }
  return n
}

export function initialLibrary(): Library {
  return {
    version: LIBRARY_VERSION,
    defaults: { extractPrompt: DEFAULT_EXTRACT_PROMPT, pastePrompt: DEFAULT_PASTE_PROMPT },
    categories: [],
    whiteChecks: {},
  }
}

/** 库里所有被引用的图片 */
export function referencedHashes(lib: Library): Set<string> {
  const s = new Set<string>()
  for (const c of lib.categories) {
    for (const st of c.styles) {
      if (st.whiteImage) s.add(st.whiteImage)
      for (const t of st.templates) if (t.image) s.add(t.image)
    }
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
    for (const s of c.styles) {
      const tids = new Set(s.templates.map((t) => t.id))
      if (tids.size !== s.templates.length || tids.has('default')) return `「${c.name}」的款式「${s.name}」里有重复的模版 id`
      if (s.activeTemplate !== 'default' && !tids.has(s.activeTemplate)) return `「${c.name}」的款式「${s.name}」正在使用的模版不存在`
    }
  }
  return null
}

/**
 * 第 1 版的自定义模版挂在品类上、各款式共用；第 2 版每个款式有自己的一套。
 * 升级时把旧模版复制给每个款式（带上该款式的参考图），正在使用的模版也一样。
 */
export function migrateLibrary(raw: unknown): unknown {
  const lib = raw as any
  if (!lib || typeof lib !== 'object' || lib.version !== 1 || !Array.isArray(lib.categories)) return raw
  return {
    ...lib,
    version: LIBRARY_VERSION,
    categories: lib.categories.map((c: any) => {
      const { templates = [], activeTemplate = 'default', ...rest } = c
      return {
        ...rest,
        styles: (c.styles ?? []).map((s: any) => ({
          ...s,
          activeTemplate,
          templates: templates.map((t: any) => ({
            id: t.id,
            name: t.name,
            prompt: t.stylePrompts?.[s.id] ?? t.prompt,
            image: t.images?.[s.id] ?? null,
            canvasRatio: t.canvasRatio ?? null,
          })),
        })),
      }
    }),
  }
}
