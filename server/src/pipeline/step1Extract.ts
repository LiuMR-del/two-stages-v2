import path from 'node:path'
import type { StepHandler } from './types'
import { resolvePlan } from './plan'
import { buildExtractRequest } from '../prompts/extract'
import { editImage } from '../ai/imageClient'
import { flattenWhite } from '../image/process'
import { JOB_FILES, readInput, writeJobImage } from './files'
import { writeOutput } from './output'
import { fidelityParams } from './params'

export const step1Extract: StepHandler = async (ctx) => {
  if (!ctx.job.route) {
    return { kind: 'attention', state: 'pending', attention: { kind: 'nomatch', step: 1, message: '还没有确定品类' } }
  }
  let plan = ctx.job.plan
  let ratio = ctx.job.route.ratio
  if (!plan) {
    const r = await resolvePlan(ctx.job, ctx.env.library.get(), ctx.env.library.images, ctx.dir)
    if (!r.ok) return { kind: 'attention', state: 'pending', attention: r.attention }
    plan = r.plan
    ratio = r.names.ratio
    const resolved = r
    ctx.commit((job) => {
      job.plan = resolved.plan
      Object.assign(job.route!, resolved.names)
    })
  }

  const settings = ctx.env.settings()
  const useOverride = ctx.job.override?.step === 1
  const req = buildExtractRequest(useOverride ? ctx.job.override!.prompt : plan.extractPrompt, ratio)
  const src = await readInput(path.join(ctx.dir, ctx.job.source.file), 'source')
  ctx.setSnapshot({
    images: [{ no: 1, role: '竞品图', sha256: ctx.job.source.sha256 }],
    prefix: req.prefix,
    prompt: req.prompt,
    model: settings.image.model,
    size: req.size,
    params: fidelityParams(settings, req.size),
  })

  const res = await ctx.retry(() =>
    editImage(ctx.env.settings().image, { images: [src], prefix: req.prefix, prompt: req.prompt, size: req.size, signal: ctx.signal }, ctx.env.onFidelityDowngrade),
  )
  const png = await flattenWhite(res.buffer)
  await writeJobImage(ctx.dir, 'pattern', JOB_FILES.pattern, png)
  await writeOutput(ctx.env.outputDir(), ctx.job, 'pattern', png)
  return {
    kind: 'done',
    output: JOB_FILES.pattern,
    patch: (job) => {
      const s = job.steps[1]!.snapshot
      if (s) s.params = res.params
      if (useOverride) job.override = null
    },
  }
}
