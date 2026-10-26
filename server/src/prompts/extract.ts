import { canvasFor, ratioToWH, type ApiSize } from './canvas'
import { fillPlaceholders } from './placeholders'
import { roleSentence } from './main'
import type { Category, Library, Style } from '../library/schema'

export function extractPromptFor(lib: Library, cat: Category, style: Style): string {
  const raw = cat.extractPrompt?.trim() ? cat.extractPrompt : lib.defaults.extractPrompt
  return fillPlaceholders(raw, { category: cat.name, style: style.name, ratio: style.ratio })
}

/** ② 只发竞品图一张；画布和 size 都按款式比例 */
export function buildExtractRequest(prompt: string, ratio: string): { prefix: string; prompt: string; size: ApiSize } {
  const [w, h] = ratioToWH(ratio)
  const c = canvasFor(w, h)
  return { prefix: c.prefix + roleSentence(['竞品商品图']) + '\n', prompt, size: c.size }
}
