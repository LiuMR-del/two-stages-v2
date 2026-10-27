import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { StepCtx, StepHandler, StepResult } from './types'
import { resolvePlan } from './plan'
import { buildExtractRequest } from '../prompts/extract'
import { editImage } from '../ai/imageClient'
import { chatJson } from '../ai/chatClient'
import { flattenWhite, readSize, shrinkForAnalysis } from '../image/process'
import { compareColors, normalizeBox } from '../image/colorCheck'
import { checkPatternLayout } from '../image/patternLayout'
import { compareTexts, QC_SYSTEM, QC_USER, QcAnswerSchema } from '../prompts/qc'
import { sha256 } from '../library/images'
import type { Qc } from '../store/jobs'
import { JOB_FILES, readInput, writeJobImage } from './files'
import { writeOutput } from './output'
import { fidelityParams } from './params'
import { log } from '../util/log'

export function newQc(): Qc {
  return { state: 'pending', score: null, sourceTexts: [], patternTexts: [], textOk: null, textDiffs: [], elementIssues: [], layout: null, color: null, reasons: [] }
}

/**
 * 第②步 = 提取 + 验收。提取（占生图并发）完成后，验收打开时这一步回到排队，
 * 再以分析类请求做验收；验收没过，第③步不开始。
 */
export const step1Extract: StepHandler = async (ctx) => {
  if (!ctx.job.route) {
    return { kind: 'attention', state: 'pending', attention: { kind: 'nomatch', step: 1, message: '还没有确定品类' } }
  }
  const patternFile = path.join(ctx.dir, JOB_FILES.pattern)
  if (ctx.job.qc?.state === 'pending' && !fs.existsSync(patternFile)) {
    // 等验收时这一步占的是分析并发；素材图不在了要重新提取，回到排队按生图类重新派发
    return { kind: 'requeue', patch: (job) => (job.qc = null) }
  }
  if (ctx.job.qc?.state === 'pending') {
    if (!ctx.env.settings().patternQc) {
      await writeOutput(ctx.env.outputDir(), ctx.job, 'pattern', await fsp.readFile(patternFile))
      return { kind: 'done', output: JOB_FILES.pattern, patch: (job) => (job.qc = null) }
    }
    return runQc(ctx, patternFile)
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
  const qcOn = ctx.env.settings().patternQc
  if (!qcOn) await writeOutput(ctx.env.outputDir(), ctx.job, 'pattern', png)
  const patch = (job: Parameters<NonNullable<StepResult['patch']>>[0]) => {
    const s = job.steps[1]!.snapshot
    if (s) s.params = res.params
    if (useOverride) job.override = null
  }
  if (qcOn) {
    return {
      kind: 'requeue',
      patch: (job) => {
        patch(job)
        job.qc = newQc()
        job.steps[1]!.attempts = 0
      },
    }
  }
  return { kind: 'done', output: JOB_FILES.pattern, patch: (job) => ((job.qc = null), patch(job)) }
}

async function runQc(ctx: StepCtx, patternFile: string): Promise<StepResult> {
  const settings = ctx.env.settings()
  const threshold = settings.patternQcThreshold
  const srcBuf = await fsp.readFile(path.join(ctx.dir, ctx.job.source.file))
  const patBuf = await fsp.readFile(patternFile)
  const layout = await checkPatternLayout(patBuf, ctx.job.route!.ratio)
  const images = [await shrinkForAnalysis(srcBuf), await shrinkForAnalysis(patBuf)]
  const snapshot = {
    images: [
      { no: 1, role: '竞品图', sha256: ctx.job.source.sha256 },
      { no: 2, role: '素材图', sha256: sha256(patBuf) },
    ],
    prefix: '',
    prompt: QC_SYSTEM,
    model: settings.analysis.model,
    params: { user: QC_USER },
  }
  ctx.commit((job) => {
    if (job.qc) job.qc.snapshot = snapshot
  })
  const { data, raw } = await ctx.retry(() => chatJson(settings.analysis, { system: QC_SYSTEM, user: QC_USER, images, signal: ctx.signal }, QcAnswerSchema))

  const text = compareTexts(data.source_texts, data.pattern_texts)
  const reasons = [...text.diffs]
  if (data.element_score < threshold) {
    const issues = data.element_issues.length ? `：${data.element_issues.join('；')}` : ''
    reasons.push(`图案元素相似分 ${data.element_score.toFixed(2)}，低于 ${threshold.toFixed(2)}${issues}`)
  }
  const box = normalizeBox(data.print_box, await readSize(images[0]!))
  const color = { ...(await compareColors(srcBuf, patBuf, box, settings.patternQcDeltaE)), threshold: settings.patternQcDeltaE }
  reasons.push(...color.issues)
  reasons.push(...layout.issues)
  const qc: Qc = {
    state: reasons.length ? 'fail' : 'pass',
    at: new Date().toISOString(),
    threshold,
    score: data.element_score,
    sourceTexts: data.source_texts,
    patternTexts: data.pattern_texts,
    textOk: text.ok,
    textDiffs: text.diffs,
    elementIssues: data.element_issues,
    layout,
    color,
    reasons,
    snapshot,
    raw,
  }
  if (reasons.length) {
    log.warn(`「${ctx.job.source.originalName}」素材图没过验收：${reasons.join('；')}`)
    return {
      kind: 'attention',
      state: 'failed',
      attention: { kind: 'qc', step: 1, message: `素材图没过验收：${reasons.join('；')}` },
      patch: (job) => (job.qc = qc),
    }
  }
  await writeOutput(ctx.env.outputDir(), ctx.job, 'pattern', patBuf)
  return { kind: 'done', output: JOB_FILES.pattern, patch: (job) => (job.qc = qc) }
}
