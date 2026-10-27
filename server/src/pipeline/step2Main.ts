import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { StepCtx, StepHandler, StepResult } from './types'
import { buildMainRequest } from '../prompts/main'
import { editImage, type ImageInput } from '../ai/imageClient'
import { chatJson } from '../ai/chatClient'
import { capBytes, capEdge, flattenWhite, padSquare, readSize, shrinkForAnalysis } from '../image/process'
import { compositeLocal, LocalPasteError } from '../image/whiteShape'
import { compareColors, normalizeBox } from '../image/colorCheck'
import { compareTexts, MAIN_QC_SYSTEM, MAIN_QC_USER, MainQcAnswerSchema } from '../prompts/qc'
import { sha256 } from '../library/images'
import type { Qc } from '../store/jobs'
import { planImageFile } from './plan'
import { decidePasteMode } from './paste'
import { newQc } from './step1Extract'
import { JOB_FILES, readInput, writeJobImage } from './files'
import { writeOutput } from './output'
import { fidelityParams } from './params'
import { log } from '../util/log'

export const LOCAL_PROMPT = '本地合成，未调用 AI'
/** 本地合成是确定的：铺进去的素材图和合成结果应当一模一样，差这么多就是出错了 */
const LOCAL_MAX_DELTA_E = 2

/** 生成结果的统一收尾：白底、长边 2000、方图开关、9.5MB 兜底；先只写进任务目录，验收过了才写输出文件夹 */
async function finish(ctx: StepCtx, buf: Buffer): Promise<Buffer> {
  let out = await capEdge(await flattenWhite(buf), 2000)
  if (ctx.env.settings().padSquare) out = await padSquare(out)
  const capped = await capBytes(out)
  if (capped.shrunk) log.warn(`主图超过 9.5MB，已等比缩小：${ctx.job.source.originalName}`)
  await writeJobImage(ctx.dir, 'main', JOB_FILES.main, capped.buffer)
  return capped.buffer
}

function qcFailed(ctx: StepCtx, qc: Qc): StepResult {
  log.warn(`「${ctx.job.source.originalName}」主图没过验收：${qc.reasons.join('；')}`)
  return {
    kind: 'attention',
    state: 'failed',
    attention: { kind: 'qc', step: 2, message: `主图没过验收：${qc.reasons.join('；')}` },
    patch: (job) => (job.mainQc = qc),
  }
}

/**
 * 第③步 = 生成主图 + 主图验收（设置「主图验收」打开时）。
 * 本地合成在同一步里本地核对；AI 贴图生成完回到排队，再占分析并发发一次验收请求。
 */
export const step2Main: StepHandler = async (ctx) => {
  const plan = ctx.job.plan
  const route = ctx.job.route
  if (!plan || !route) {
    return { kind: 'attention', state: 'pending', attention: { kind: 'nomatch', step: 2, message: '还没有确定要用的模版，请重新识别' } }
  }
  const mainFile = path.join(ctx.dir, JOB_FILES.main)
  if (ctx.job.mainQc?.state === 'pending' && !fs.existsSync(mainFile)) {
    // 等验收时占的是分析并发；主图不在了要重新生成，回到排队按生图类重新派发
    return { kind: 'requeue', patch: (job) => (job.mainQc = null) }
  }
  if (ctx.job.mainQc?.state === 'pending') {
    if (!ctx.env.settings().mainQc) {
      await writeOutput(ctx.env.outputDir(), ctx.job, 'main', await fsp.readFile(mainFile))
      return { kind: 'done', output: JOB_FILES.main, patch: (job) => (job.mainQc = null) }
    }
    return runMainQc(ctx, mainFile)
  }

  const main = plan.main
  let planFile: string | null = null
  if (main.image) {
    planFile = planImageFile(ctx.dir, main.image.hash)
    if (!planFile) {
      return { kind: 'attention', state: 'failed', attention: { kind: 'failed', step: 2, message: `${main.image.role}文件丢失了，请从这一步重做` } }
    }
  }
  const patternInput = await readInput(path.join(ctx.dir, JOB_FILES.pattern), 'pattern')

  if (main.templateId === 'default' && main.image && planFile) {
    const whiteBuf = await fsp.readFile(planFile)
    const shape = await ctx.env.library.whiteShape(main.image.hash, whiteBuf)
    const d = decidePasteMode(main.pasteMode ?? 'ai', shape, route.ratio)
    if (d.mode === 'local') {
      const local = await pasteLocal(ctx, whiteBuf, main.image.hash, patternInput.buffer, d.setting === 'auto' ? `自动判断：${d.auto?.reason ?? ''}` : '款式设置为本地合成')
      if (local) return local
    }
  }

  const req = await buildMainRequest(main, route.ratio, async () => readSize(await fsp.readFile(planFile!)))
  const useOverride = ctx.job.override?.step === 2
  const prompt = useOverride ? ctx.job.override!.prompt : req.prompt

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
  ctx.setSnapshot({ images: shown, prefix: req.prefix, prompt, model: settings.image.model, size: req.size, params: fidelityParams(settings, req.size), mode: 'ai' })

  const res = await ctx.retry(() =>
    editImage(ctx.env.settings().image, { images: inputs, prefix: req.prefix, prompt, size: req.size, signal: ctx.signal }, ctx.env.onFidelityDowngrade),
  )
  const out = await finish(ctx, res.buffer)
  const qcOn = ctx.env.settings().mainQc
  if (!qcOn) await writeOutput(ctx.env.outputDir(), ctx.job, 'main', out)
  const patch = (job: Parameters<NonNullable<StepResult['patch']>>[0]) => {
    const s = job.steps[2]!.snapshot
    if (s) s.params = res.params
    if (useOverride) job.override = null
  }
  if (qcOn) {
    return {
      kind: 'requeue',
      patch: (job) => {
        patch(job)
        job.mainQc = { ...newQc(), mode: 'ai' }
        job.steps[2]!.attempts = 0
      },
    }
  }
  return { kind: 'done', output: JOB_FILES.main, patch: (job) => ((job.mainQc = null), patch(job)) }
}

/** 本地合成；素材图和产品外形比例差太多时返回 null，改走 AI 贴图 */
async function pasteLocal(ctx: StepCtx, whiteBuf: Buffer, whiteHash: string, patternBuf: Buffer, why: string): Promise<StepResult | null> {
  let r
  try {
    r = await compositeLocal(whiteBuf, patternBuf)
  } catch (e) {
    if (!(e instanceof LocalPasteError)) throw e
    log.warn(`「${ctx.job.source.originalName}」没法本地合成（${e.message}），改用 AI 贴图`)
    return null
  }
  ctx.setSnapshot({
    images: [
      { no: 1, role: '白底图', sha256: whiteHash },
      { no: 2, role: '素材图', sha256: sha256(patternBuf) },
    ],
    prefix: '',
    prompt: LOCAL_PROMPT,
    model: '本地合成',
    mode: 'local',
    params: { why, shape: r.shape.reason, fit: r.fit === 'stretch' ? '素材图轻微拉伸到产品外形' : '素材图等比铺满产品外形', bbox: r.shape.bbox },
  })
  const clearOverride = (job: Parameters<NonNullable<StepResult['patch']>>[0]) => {
    if (job.override?.step === 2) job.override = null
  }
  const out = await finish(ctx, r.buffer)
  if (!ctx.env.settings().mainQc) {
    await writeOutput(ctx.env.outputDir(), ctx.job, 'main', out)
    return { kind: 'done', output: JOB_FILES.main, patch: (job) => ((job.mainQc = null), clearOverride(job)) }
  }

  // 本地核对：产品外接矩形里（往里收一点，避开圆角和安装孔）应当就是铺进去的素材图
  const { width, height } = await readSize(r.buffer)
  const b = r.shape.bbox!
  const color = await compareColors(r.buffer, r.placed, [b.x / width, b.y / height, (b.x + b.w) / width, (b.y + b.h) / height], LOCAL_MAX_DELTA_E)
  const reasons = color.issues.length ? [`本地合成的主图和素材图对不上（ΔE ${color.deltaE}，分块 ${color.gridDeltaE}），请重新合成或改用 AI 贴图`] : []
  const qc: Qc = { ...newQc(), state: reasons.length ? 'fail' : 'pass', at: new Date().toISOString(), mode: 'local', color: { ...color, issues: [], threshold: LOCAL_MAX_DELTA_E }, reasons }
  if (reasons.length) return { ...qcFailed(ctx, qc), patch: (job) => ((job.mainQc = qc), clearOverride(job)) }
  await writeOutput(ctx.env.outputDir(), ctx.job, 'main', out)
  return { kind: 'done', output: JOB_FILES.main, patch: (job) => ((job.mainQc = qc), clearOverride(job)) }
}

async function runMainQc(ctx: StepCtx, mainFile: string): Promise<StepResult> {
  const settings = ctx.env.settings()
  const threshold = settings.patternQcThreshold
  const patBuf = await fsp.readFile(path.join(ctx.dir, JOB_FILES.pattern))
  const mainBuf = await fsp.readFile(mainFile)
  const images = [await shrinkForAnalysis(patBuf), await shrinkForAnalysis(mainBuf)]
  const snapshot = {
    images: [
      { no: 1, role: '素材图', sha256: sha256(patBuf) },
      { no: 2, role: '主图', sha256: sha256(mainBuf) },
    ],
    prefix: '',
    prompt: MAIN_QC_SYSTEM,
    model: settings.analysis.model,
    params: { user: MAIN_QC_USER },
  }
  ctx.commit((job) => {
    if (job.mainQc) job.mainQc.snapshot = snapshot
  })
  const { data, raw } = await ctx.retry(() =>
    chatJson(settings.analysis, { system: MAIN_QC_SYSTEM, user: MAIN_QC_USER, images, signal: ctx.signal }, MainQcAnswerSchema),
  )

  const text = compareTexts(data.pattern_texts, data.main_texts, { from: '素材图', to: '主图' })
  const reasons = [...text.diffs]
  if (data.element_score < threshold) {
    const issues = data.element_issues.length ? `：${data.element_issues.join('；')}` : ''
    reasons.push(`图案元素相似分 ${data.element_score.toFixed(2)}，低于 ${threshold.toFixed(2)}${issues}`)
  }
  for (const f of data.fill_issues) reasons.push(`贴图：${f}`)
  const box = normalizeBox(data.print_box, await readSize(images[1]!))
  const color = { ...(await compareColors(mainBuf, patBuf, box, settings.patternQcDeltaE, true)), threshold: settings.patternQcDeltaE }
  reasons.push(...color.issues.map((i) => i.replace('颜色偏了：', '主图颜色偏了：')))
  const qc: Qc = {
    ...newQc(),
    state: reasons.length ? 'fail' : 'pass',
    at: new Date().toISOString(),
    mode: 'ai',
    threshold,
    score: data.element_score,
    sourceTexts: data.pattern_texts,
    patternTexts: data.main_texts,
    textOk: text.ok,
    textDiffs: text.diffs,
    elementIssues: data.element_issues,
    fillIssues: data.fill_issues,
    color,
    reasons,
    snapshot,
    raw,
  }
  if (reasons.length) return qcFailed(ctx, qc)
  await writeOutput(ctx.env.outputDir(), ctx.job, 'main', mainBuf)
  return { kind: 'done', output: JOB_FILES.main, patch: (job) => (job.mainQc = qc) }
}
