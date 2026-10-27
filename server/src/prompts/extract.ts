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
 * 素材图本来就要铺满，最后一句「比例差一点就整体缩放、不裁不丢文字和边框」就是防这个的，不能删。
 * 2026-10-27 实测：写「不要产品的边框、金属边」时，模型把印在铝板上的红色做旧边、锈边、印刷线框都当成产品边框去掉了，
 * 图案还被放大去填画布。印刷面上看得到的都算图案，只去掉实体部分。
 */
export const EXTRACT_CONSTRAINT =
  "Extract the whole printed face of the product exactly as it is printed and output it as a flat, front-facing print file. Everything printed on the face is part of the artwork and must be kept, including printed borders and frame lines, distressed or weathered edges, rust, scratches and worn effects near the edges. The printed face fills the whole canvas edge to edge: its outer edges are the canvas edges. Leave out only the physical product: its thickness and side edges, the cut-away rounded corners, mounting holes and screws, perspective, reflections, shadows and the background; where a hole or screw covers the artwork, continue the surrounding artwork. Keep the original layout and composition, and keep every text element, letter and number fully legible in its original position. Do not rearrange, redraw, simplify, enlarge or omit any part of the artwork, and keep every small detail as it is. Preserve the exact original colors, hues and saturation. Do not recolor or restyle. Only improve sharpness, detail and resolution. If the printed face's proportions differ slightly from the canvas, fit the whole printed face to the canvas; never crop, squeeze or drop any text, element or border."

/**
 * 发的是第①步定位、本地拉正后的印刷面时用这段（2026-10-27）。区域已经裁好，模型只需要清理：
 * 去掉边上残留的一丝背景、手指，螺丝孔、反光，其余印着的全部保留。
 */
export const FACE_CONSTRAINT =
  "The first image is the product's printed face, already cropped out of the competitor photo and flattened. Reproduce it as a clean, flat, front-facing print file that fills the whole canvas edge to edge. Everything printed on the face is part of the artwork and must be kept, including printed borders and frame lines, distressed or weathered edges, rust, scratches and worn effects near the edges. Remove only what is not printed: thin slivers of background, hands or fingers along the edges, the background showing outside rounded corners, the product's thickness or side edges, mounting holes and screws (continue the surrounding artwork there), reflections, glare and shadows. Keep the original layout and composition, and keep every text element, letter and number fully legible in its original position. Do not rearrange, redraw, simplify, enlarge, crop or omit any part of the artwork, and keep every small detail as it is. Preserve the exact original colors, hues and saturation. Do not recolor or restyle. Only improve sharpness, detail and resolution."

/**
 * ② 只发一张图：有印刷面区域时发拉正后的印刷面，没有时发整张竞品图；画布和 size 都按款式比例
 */
export function buildExtractRequest(prompt: string, ratio: string, face = false): { prefix: string; prompt: string; size: ApiSize } {
  const [w, h] = ratioToWH(ratio)
  const c = canvasFor(w, h)
  const role = face ? roleSentence(['从竞品图裁出并拉正的商品印刷面']) : roleSentence(['竞品商品图'])
  return { prefix: c.prefix + role + '\n' + (face ? FACE_CONSTRAINT : EXTRACT_CONSTRAINT) + '\n', prompt, size: c.size }
}
