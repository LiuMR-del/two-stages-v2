import type { WhiteShapeRecord } from '../library/schema'
import { canvasMismatch, decidePaste } from '../image/whiteShape'

export type PasteSetting = 'auto' | 'local' | 'ai'
export type PasteDecision = {
  setting: PasteSetting
  /** 自动判断的结果；没有白底图时为 null */
  auto: { mode: 'local' | 'ai'; reason: string } | null
  /** 实际用的方式 */
  mode: 'local' | 'ai'
  note: string | null
}

/** 默认模版用哪种贴图方式：按白底图判断，同一个款式的图都一样 */
export function decidePasteMode(setting: PasteSetting, shape: WhiteShapeRecord | null, styleRatio: string): PasteDecision {
  const auto = shape ? decidePaste(shape, styleRatio) : null
  if (setting === 'ai') return { setting, auto, mode: 'ai', note: null }
  if (setting === 'local') {
    if (shape?.ok) {
      const mismatch = canvasMismatch(shape, styleRatio)
      if (mismatch) return { setting, auto, mode: 'ai', note: `没法本地合成：${mismatch}，仍用 AI 贴图` }
      return { setting, auto, mode: 'local', note: null }
    }
    return { setting, auto, mode: 'ai', note: `白底图没法本地合成（${shape?.reason ?? '没有白底图'}），仍用 AI 贴图` }
  }
  return { setting, auto, mode: auto?.mode ?? 'ai', note: null }
}
