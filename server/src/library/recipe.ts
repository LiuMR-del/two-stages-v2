import type { Library } from './schema'
import type { ImageStore } from './images'
import { buildMainRequest, mainPlanFor } from '../prompts/main'
import { refWarning } from '../prompts/refcheck'
import { HttpError } from '../util/errors'

export type Recipe = {
  images: { no: number | null; role: string; hash: string | null; auto: boolean; required: boolean }[]
  prefix: string
  prompt: string
  scope: string
  size: string
  templateId: string
  templateName: string
  warnings: string[]
}

export const MISSING_WHITE_WARNING = '没有白底图时，这个款式的图会进入「需处理」，不会在缺图的情况下生成。'

export async function recipeFor(lib: Library, images: ImageStore, cid: string, sid: string, tid?: string): Promise<Recipe> {
  const cat = lib.categories.find((c) => c.id === cid)
  if (!cat) throw new HttpError(404, '品类不存在，可能已被删除')
  const style = cat.styles.find((s) => s.id === sid)
  if (!style) throw new HttpError(404, '款式不存在，可能已被删除')
  const templateId = tid ?? style.activeTemplate
  if (templateId !== 'default' && !style.templates.some((t) => t.id === templateId)) throw new HttpError(404, '模版不存在，可能已被删除')

  const { main, missingWhite, scope } = mainPlanFor(lib, cat, style, templateId)
  const req = await buildMainRequest(main, style.ratio, (h) => images.dims(h))
  const warnings: string[] = []
  if (missingWhite) warnings.push(MISSING_WHITE_WARNING)
  if (!main.prompt.trim()) warnings.push('提示词为空，这个组合生成不了主图')
  const w = refWarning(main.prompt, req.sent.length)
  if (w) warnings.push(w + '。请上传参考图，或改写提示词。')
  return {
    images: req.slots.map((s) => ({ no: s.no, role: s.role, hash: s.hash, auto: s.auto, required: s.required })),
    prefix: req.prefix,
    prompt: req.prompt,
    scope,
    size: req.size,
    templateId: main.templateId,
    templateName: main.templateName,
    warnings,
  }
}
