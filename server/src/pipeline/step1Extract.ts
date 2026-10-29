import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { StepCtx, StepHandler, StepResult } from './types'
import { resolvePlan } from './plan'
import { buildExtractRequest } from '../prompts/extract'
import { editImage } from '../ai/imageClient'
import { chatJson } from '../ai/chatClient'
import { flattenWhite, readSize, shrinkForAnalysis } from '../image/process'
import { flattenFace } from '../image/face'
import { compareColors, normalizeBox } from '../image/colorCheck'
import { checkPatternLayout } from '../image/patternLayout'
import { BORDER_SYSTEM, BORDER_USER, BorderAnswerSchema, compareTexts, qcSystem, QC_USER, QcAnswerSchema } from '../prompts/qc'
import { sha256 } from '../library/images'
import { MAX_ATTEMPTS, withRetry } from '../ai/retry'
import type { Qc } from '../store/jobs'
import { JOB_FILES, readInput, removeJobImage, writeJobImage } from './files'
import { writeOutput } from './output'
import { fidelityParams } from './params'
import { log } from '../util/log'

const BORDER_TIMEOUT_SEC = 180

export function newQc(): Qc {
  return {
    state: 'pending',
    score: null,
    sourceTexts: [],
    patternTexts: [],
    textOk: null,
    textDiffs: [],
    elementIssues: [],
    edgeMissing: [],
    edgeExtra: [],
    fillIssues: [],
    layout: null,
    color: null,
    border: null,
    reasons: [],
  }
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
  const face = ctx.job.face
  let src = await readInput(path.join(ctx.dir, ctx.job.source.file), 'source')
  let shown = { no: 1, role: '竞品图', sha256: ctx.job.source.sha256 }
  let flat: Buffer | null = null
  if (face) {
    // 第①步定位的印刷面按款式比例拉正，只把这块发给生图模型
    const r = await flattenFace(src.buffer, face, ratio)
    if (r.buffer) flat = r.buffer
    else log.warn(`「${ctx.job.source.originalName}」${r.reason}，这次按整张竞品图提取`)
  }
  await removeJobImage(ctx.dir, 'face')
  if (flat) {
    await writeJobImage(ctx.dir, 'face', JOB_FILES.face, flat)
    src = { buffer: flat, mime: 'image/png', filename: 'face.png' }
    shown = { no: 1, role: '印刷面', sha256: sha256(flat) }
  }
  const req = buildExtractRequest(useOverride ? ctx.job.override!.prompt : plan.extractPrompt, ratio, !!flat)
  ctx.setSnapshot({
    images: [shown],
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
  // 有拉正后的印刷面就拿它对照：和素材图是对齐的，文字、颜色都比对得更准
  const faceFile = path.join(ctx.dir, JOB_FILES.face)
  // 只有这次提取发的就是印刷面时才拿它对照
  const useFace = !!ctx.job.face && ctx.job.steps[1]!.snapshot?.images[0]?.role === '印刷面' && fs.existsSync(faceFile)
  const srcBuf = await fsp.readFile(useFace ? faceFile : path.join(ctx.dir, ctx.job.source.file))
  const patBuf = await fsp.readFile(patternFile)
  const layout = await checkPatternLayout(patBuf, ctx.job.route!.ratio)
  const images = [await shrinkForAnalysis(srcBuf), await shrinkForAnalysis(patBuf)]
  const system = qcSystem(useFace)
  const snapshot = {
    images: [
      useFace ? { no: 1, role: '印刷面', sha256: sha256(srcBuf) } : { no: 1, role: '竞品图', sha256: ctx.job.source.sha256 },
      { no: 2, role: '素材图', sha256: sha256(patBuf) },
    ],
    prefix: '',
    prompt: system,
    model: settings.analysis.model,
    params: { user: QC_USER },
  }
  ctx.commit((job) => {
    if (job.qc) job.qc.snapshot = snapshot
  })
  // 边框外延检查和验收同时发；有一圈格子的图模型要想 1～3 分钟，超时放宽到 180 秒。
  // 重试单独计数（最多再试一次），不占这一步的尝试次数；请求没成功不拦，写明没检查
  const borderApi = { ...settings.analysis, timeoutSec: Math.max(settings.analysis.timeoutSec, BORDER_TIMEOUT_SEC) }
  const borderP = withRetry(() => chatJson(borderApi, { system: BORDER_SYSTEM, user: BORDER_USER, images, signal: ctx.signal }, BorderAnswerSchema), {
    attemptsSoFar: MAX_ATTEMPTS - 2,
    signal: ctx.signal,
  }).then(
      ({ data, raw }) => ({ hasBorder: data.has_border, overflow: data.has_border ? data.pattern_partial : '', source: data.source, pattern: data.pattern, error: null, raw }),
      (e: Error) => {
        if (ctx.signal.aborted) throw e
        log.warn(`「${ctx.job.source.originalName}」边框外延检查没做成：${e.message}`)
        return { hasBorder: false, overflow: '', source: null, pattern: null, error: e.message }
      },
    )
  const [{ data, raw }, border] = await Promise.all([
    ctx.retry(() => chatJson(settings.analysis, { system, user: QC_USER, images, signal: ctx.signal }, QcAnswerSchema)),
    borderP,
  ])

  const text = compareTexts(data.source_texts, data.pattern_texts)
  const reasons = [...text.diffs]
  if (data.element_score < threshold) {
    const issues = data.element_issues.length ? `：${data.element_issues.join('；')}` : ''
    reasons.push(`图案元素相似分 ${data.element_score.toFixed(2)}，低于 ${threshold.toFixed(2)}${issues}`)
  }
  for (const m of data.edge_missing) reasons.push(`四边少了：${m}`)
  for (const m of data.edge_extra) reasons.push(`四边多了：${m}`)
  if (border.overflow) reasons.push(`图案往外延伸了：${border.overflow}`)
  const box: [number, number, number, number] | null = useFace ? [0, 0, 1, 1] : normalizeBox(data.print_box, await readSize(images[0]!))
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
    edgeMissing: data.edge_missing,
    edgeExtra: data.edge_extra,
    fillIssues: [],
    layout,
    color,
    border,
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
