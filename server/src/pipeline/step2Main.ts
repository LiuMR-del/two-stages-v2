import fsp from 'node:fs/promises'
import path from 'node:path'
import type { StepHandler } from './types'
import { buildMainRequest } from '../prompts/main'
import { editImage, type ImageInput } from '../ai/imageClient'
import { capBytes, capEdge, flattenWhite, padSquare, readSize } from '../image/process'
import { sha256 } from '../library/images'
import { planImageFile } from './plan'
import { JOB_FILES, readInput, writeJobImage } from './files'
import { writeOutput } from './output'
import { fidelityParams } from './params'
import { log } from '../util/log'

export const step2Main: StepHandler = async (ctx) => {
  const plan = ctx.job.plan
  const route = ctx.job.route
  if (!plan || !route) {
    return { kind: 'attention', state: 'pending', attention: { kind: 'nomatch', step: 2, message: '还没有确定要用的模版，请重新识别' } }
  }
  const main = plan.main
  let planFile: string | null = null
  if (main.image) {
    planFile = planImageFile(ctx.dir, main.image.hash)
    if (!planFile) {
      return { kind: 'attention', state: 'failed', attention: { kind: 'failed', step: 2, message: `${main.image.role}文件丢失了，请从这一步重做` } }
    }
  }
  const req = await buildMainRequest(main, route.ratio, async () => readSize(await fsp.readFile(planFile!)))
  const useOverride = ctx.job.override?.step === 2
  const prompt = useOverride ? ctx.job.override!.prompt : req.prompt

  const patternInput = await readInput(path.join(ctx.dir, JOB_FILES.pattern), 'pattern')
  const inputs: ImageInput[] = []
  const shown: { no: number; role: string; sha256: string }[] = []
  for (const slot of req.sent) {
    if (slot.role === '素材图') {
      inputs.push(patternInput)
      shown.push({ no: slot.no!, role: slot.role, sha256: sha256(patternInput.buffer) })
    } else {
      const inp = await readInput(planFile!, slot.role === '白底图' ? 'white' : 'reference')
      inputs.push(inp)
      shown.push({ no: slot.no!, role: slot.role, sha256: slot.hash! })
    }
  }
  const settings = ctx.env.settings()
  ctx.setSnapshot({ images: shown, prefix: req.prefix, prompt, model: settings.image.model, size: req.size, params: fidelityParams(settings, req.size) })

  const res = await ctx.retry(() =>
    editImage(ctx.env.settings().image, { images: inputs, prefix: req.prefix, prompt, size: req.size, signal: ctx.signal }, ctx.env.onFidelityDowngrade),
  )
  let out = await capEdge(await flattenWhite(res.buffer), 2000)
  if (ctx.env.settings().padSquare) out = await padSquare(out)
  const capped = await capBytes(out)
  if (capped.shrunk) log.warn(`主图超过 9.5MB，已等比缩小：${ctx.job.source.originalName}`)
  await writeJobImage(ctx.dir, 'main', JOB_FILES.main, capped.buffer)
  await writeOutput(ctx.env.outputDir(), ctx.job, 'main', capped.buffer)
  return {
    kind: 'done',
    output: JOB_FILES.main,
    patch: (job) => {
      const s = job.steps[2]!.snapshot
      if (s) s.params = res.params
      if (useOverride) job.override = null
    },
  }
}
