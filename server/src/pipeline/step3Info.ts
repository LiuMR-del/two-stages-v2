import fsp from 'node:fs/promises'
import path from 'node:path'
import type { StepHandler } from './types'
import { chatJson } from '../ai/chatClient'
import { shrinkForAnalysis } from '../image/process'
import { INFO_SYSTEM, INFO_USER, InfoAnswerSchema } from '../prompts/info'
import { decideBlankItems } from './blankItems'
import { sha256 } from '../library/images'
import { JOB_FILES } from './files'

export const step3Info: StepHandler = async (ctx) => {
  const mainBuf = await fsp.readFile(path.join(ctx.dir, JOB_FILES.main)).catch(() => null)
  if (!mainBuf) {
    return { kind: 'attention', state: 'failed', attention: { kind: 'failed', step: 3, message: '主图文件不存在，请从「生成主图」重做' } }
  }
  const jpeg = await shrinkForAnalysis(mainBuf)
  const settings = ctx.env.settings()
  const useOverride = ctx.job.override?.step === 3
  const system = useOverride ? ctx.job.override!.prompt : INFO_SYSTEM
  ctx.setSnapshot({
    images: [{ no: 1, role: '主图', sha256: sha256(mainBuf) }],
    prefix: '',
    prompt: system,
    model: settings.analysis.model,
    params: { user: INFO_USER },
  })
  const { data } = await ctx.retry(() => chatJson(settings.analysis, { system, user: INFO_USER, imageJpeg: jpeg, signal: ctx.signal }, InfoAnswerSchema))
  const blank = decideBlankItems(data.customizable, data.blank_items)
  const skipNext = !ctx.env.settings().blankImage || blank.en.length === 0
  return {
    kind: 'done',
    skipNext,
    patch: (job) => {
      job.info = { scene: data.scene, keywords: data.keywords, customizable: data.customizable, blankItems: blank.zh, blankItemsEn: blank.en }
      if (useOverride) job.override = null
    },
  }
}
