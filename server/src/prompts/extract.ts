import { exactCanvas, ratioToWH } from './canvas'
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
 * 2026-10-29 实测：搭在扶手椅上的拼格毛毯，折过扶手、垂下去的边框格子被当成新的一排，素材图左、右、下各多出半圈格子。
 * 所以加 NO_EXTEND：不许把图案往外延伸，每边重复元素的个数要和原图一样。材质特有的情况（软布折叠、包边）放品类提示词。
 */
export const NO_EXTEND =
  'Never extend, repeat or continue the artwork beyond its original outer edge: do not add an extra row or column of tiles or blocks, an extra ring of border, or partial elements cut off by the canvas edge. Each side must show exactly the same number of border tiles or repeated elements as the original.'

export const EXTRACT_CONSTRAINT =
  "Extract the whole printed face of the product exactly as it is printed and output it as a flat, front-facing print file. Everything printed on the face is part of the artwork and must be kept, including printed borders and frame lines, distressed or weathered edges, rust, scratches and worn effects near the edges. The printed face fills the whole canvas edge to edge: its outer edges are the canvas edges. Leave out only the physical product: its thickness and side edges, a sewn hem, binding or stitching, the cut-away rounded corners, mounting holes and screws, perspective, reflections, shadows and the background; where a hole or screw covers the artwork, continue the surrounding artwork. Keep the original layout and composition, and keep every text element, letter and number fully legible in its original position. Do not rearrange, redraw, simplify, enlarge or omit any part of the artwork, and keep every small detail as it is. Preserve the exact original colors, hues and saturation. Do not recolor or restyle. Only improve sharpness, detail and resolution. If the printed face's proportions differ slightly from the canvas, fit the whole printed face to the canvas; never crop, squeeze or drop any text, element or border. " + NO_EXTEND

/**
 * 发的是第①步定位、本地拉正后的印刷面时用这段（2026-10-27）。区域已经裁好，模型只需要清理：
 * 去掉边上残留的一丝背景、手指，螺丝孔、反光，其余印着的全部保留。
 */
export const FACE_CONSTRAINT =
  "The first image is the product's printed face, already cropped out of the competitor photo and flattened. Reproduce it as a clean, flat, front-facing print file that fills the whole canvas edge to edge. Everything printed on the face is part of the artwork and must be kept, including printed borders and frame lines, distressed or weathered edges, rust, scratches and worn effects near the edges. Remove only what is not printed: thin slivers of background, hands or fingers along the edges, the background showing outside rounded corners, the product's thickness or side edges, a sewn hem, binding or stitching, mounting holes and screws (continue the surrounding artwork there), reflections, glare and shadows. Keep the original layout and composition, and keep every text element, letter and number fully legible in its original position. Do not rearrange, redraw, simplify, enlarge, crop or omit any part of the artwork, and keep every small detail as it is. Preserve the exact original colors, hues and saturation. Do not recolor or restyle. Only improve sharpness, detail and resolution. " + NO_EXTEND

/**
 * 第①步判断商品放在场景里有变形时用这段（2026-10-29，用户要求分情况）：不框选，整张竞品图交给生图模型自己提取、矫正。
 * 实测搭在扶手椅上的拼格毛毯，按四个角拉正后背景混进来、毯子还是斜的；整张图 + 这段提示词好很多，但仍不是每次都对。
 * 2026-11-09 用户要求毛毯不保留包边：原来写「包边就是画布边缘」，改成以印刷图案外缘为画布边缘，缝上去的包边、锁边、缝线不算图案；
 * 印出来的边框、做旧边、锈迹（铝板画）照样保留；品类提示词另有说法时以品类为准。拉正印刷面和整图两段的去除清单也加上包边。
 */
export const SCENE_CONSTRAINT =
  "The first image is a photo of the product in use: it may be draped over furniture, folded, wrinkled, curved, hanging, held in hands, partly hidden or seen at an angle. Identify the product and reconstruct its complete printed design as a flat, front-facing print file, as if the product were laid perfectly flat and photographed straight on, filling the whole canvas edge to edge; the outer edge of the printed design is the canvas edge. A sewn hem, binding, overlocked edge or stitching is not printed and is not part of the design, so leave it out; printed borders, frame lines, distressed or weathered edges and rust are printed and must be kept. If the category instructions below say otherwise, follow them. Undo every distortion: straighten folds, wrinkles, curves and perspective so that straight lines in the design are straight, rows and columns of the layout are aligned and evenly spaced, and every element keeps its natural proportions. Remove everything that is not the printed design: the background, furniture, hands, shadows, lighting, glare and fabric highlights. Rebuild parts that are folded out of view or hidden only by continuing the visible design's own logic (repeat the same border tiles in the same order, continue the same background); never invent new motifs. A border made of tiles or blocks stays exactly one ring: tiles that wrap around an armrest or hang down belong to that same ring, so every side has the same number of tiles as the product really has, all complete, none cut off by the canvas edge, and nothing outside the ring. Keep every text element, letter and number exactly as written and fully legible, keep the main subject in its original position and size within the design, and keep the exact original colors. Do not restyle, simplify, enlarge or add anything."

/** face = 拉正后的印刷面；scene = 有变形的整张图；photo = 没框出印刷面的整张图 */
export type ExtractMode = 'face' | 'scene' | 'photo'

/**
 * ② 只发一张图；画布前置句和 size 都按款式的精确比例（素材图比例要对）
 */
export function buildExtractRequest(prompt: string, ratio: string, mode: ExtractMode = 'photo'): { prefix: string; prompt: string; size: string } {
  const [w, h] = ratioToWH(ratio)
  const c = exactCanvas(w, h)
  const role = mode === 'face' ? roleSentence(['从竞品图裁出并拉正的商品印刷面']) : roleSentence(['竞品商品图'])
  const constraint = mode === 'face' ? FACE_CONSTRAINT : mode === 'scene' ? SCENE_CONSTRAINT : EXTRACT_CONSTRAINT
  return { prefix: c.prefix + role + '\n' + constraint + '\n', prompt, size: c.size }
}
