import { canvasFor, ratioToWH, type ApiSize } from './canvas'
import { fillPlaceholders } from './placeholders'
import { roleSentence } from './main'
import type { Category, Library, Style } from '../library/schema'

export function extractPromptFor(lib: Library, cat: Category, style: Style): string {
  const raw = cat.extractPrompt?.trim() ? cat.extractPrompt : lib.defaults.extractPrompt
  return fillPlaceholders(raw, { category: cat.name, style: style.name, ratio: style.ratio })
}

/**
 * 固定的保真约束，和画布句、图片角色句一样不可编辑。
 * 旧项目的教训是「第一阶段不能写铺满」（模型会放大人物、把文字挤出画面）；这里画布比例就是产品比例，
 * 素材图本来就要铺满，最后一句「比例差一点就补背景、不裁不挤文字」就是防这个的，不能删。
 */
export const EXTRACT_CONSTRAINT =
  "Extract only the artwork printed on the product's face and output it as a flat, front-facing print file. The artwork fills the whole canvas edge to edge: its outer edges are the canvas edges. Do not include the product's frame, rounded corners, metal edge, thickness, mounting holes, perspective, reflections, shadows or background. Keep the original layout and composition, and keep every text element, letter and number fully legible in its original position. Do not rearrange, redraw, simplify or omit any part of the artwork, and keep every small detail as it is. Preserve the exact original colors, hues and saturation. Do not recolor or restyle. Only improve sharpness, detail and resolution. If the artwork's proportions differ slightly from the canvas, extend its own background to fill; never crop, squeeze or drop any text."

/** ② 只发竞品图一张；画布和 size 都按款式比例 */
export function buildExtractRequest(prompt: string, ratio: string): { prefix: string; prompt: string; size: ApiSize } {
  const [w, h] = ratioToWH(ratio)
  const c = canvasFor(w, h)
  return { prefix: c.prefix + roleSentence(['竞品商品图']) + '\n' + EXTRACT_CONSTRAINT + '\n', prompt, size: c.size }
}
