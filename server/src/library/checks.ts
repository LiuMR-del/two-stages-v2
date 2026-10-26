import type { Library } from './schema'
import { mainPlanFor } from '../prompts/main'
import { refWarning } from '../prompts/refcheck'

export type CheckLevel = 'ok' | 'warn' | 'error'
export type StyleCheck = { level: CheckLevel; messages: string[] }
export type CategoryCheck = { level: CheckLevel; styles: Record<string, StyleCheck> }
export type Checks = Record<string, CategoryCheck>

const RANK: Record<CheckLevel, number> = { ok: 0, warn: 1, error: 2 }
const worst = (a: CheckLevel, b: CheckLevel): CheckLevel => (RANK[b] > RANK[a] ? b : a)

/** 按品类当前使用的模版判断 */
export function computeChecks(lib: Library): Checks {
  const out: Checks = {}
  for (const cat of lib.categories) {
    const styles: Record<string, StyleCheck> = {}
    let catLevel: CheckLevel = 'ok'
    for (const style of cat.styles) {
      const { main, missingWhite } = mainPlanFor(lib, cat, style)
      const messages: string[] = []
      let level: CheckLevel = 'ok'
      if (missingWhite) {
        messages.push('缺白底图')
        level = 'error'
      }
      if (!main.prompt.trim()) {
        messages.push('模版提示词为空')
        level = 'error'
      }
      const w = refWarning(main.prompt, 1 + (main.image ? 1 : 0))
      if (w) {
        messages.push(w)
        level = worst(level, 'warn')
      }
      styles[style.id] = { level, messages }
      catLevel = worst(catLevel, level)
    }
    out[cat.id] = { level: catLevel, styles }
  }
  return out
}
