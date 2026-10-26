import path from 'node:path'
import type { StepHandler } from './types'
import { editImage } from '../ai/imageClient'
import { capBytes, flattenWhite, forceSize, readSize } from '../image/process'
import { canvasFor } from '../prompts/canvas'
import { blankPrompt } from '../prompts/blank'
import { sha256 } from '../library/images'
import { JOB_FILES, readInput, writeJobImage } from './files'
import { writeOutput } from './output'
import { fidelityParams } from './params'

export const step4Blank: StepHandler = async (ctx) => {
  const useOverride = ctx.job.override?.step === 4
  const items = ctx.job.info?.blankItemsEn ?? []
  if (!useOverride && items.length === 0) return { kind: 'skipped' }

  const main = await readInput(path.join(ctx.dir, JOB_FILES.main), 'main').catch(() => null)
  if (!main) {
    return { kind: 'attention', state: 'failed', attention: { kind: 'failed', step: 4, message: '主图文件不存在，请从「生成主图」重做' } }
  }
  const { width, height } = await readSize(main.buffer)
  const canvas = canvasFor(width, height)
  const prompt = useOverride ? ctx.job.override!.prompt : blankPrompt(items)
  const settings = ctx.env.settings()
  ctx.setSnapshot({
    images: [{ no: 1, role: '主图', sha256: sha256(main.buffer) }],
    prefix: canvas.prefix,
    prompt,
    model: settings.image.model,
    size: canvas.size,
    params: fidelityParams(settings, canvas.size),
  })
  const res = await ctx.retry(() =>
    editImage(ctx.env.settings().image, { images: [main], prefix: canvas.prefix, prompt, size: canvas.size, signal: ctx.signal }, ctx.env.onFidelityDowngrade),
  )
  const sized = await forceSize(await flattenWhite(res.buffer), width, height)
  const { buffer } = await capBytes(sized)
  await writeJobImage(ctx.dir, 'blank', JOB_FILES.blank, buffer)
  await writeOutput(ctx.env.outputDir(), ctx.job, 'blank', buffer)
  return {
    kind: 'done',
    output: JOB_FILES.blank,
    patch: (job) => {
      const s = job.steps[4]!.snapshot
      if (s) s.params = res.params
      if (useOverride) job.override = null
    },
  }
}
