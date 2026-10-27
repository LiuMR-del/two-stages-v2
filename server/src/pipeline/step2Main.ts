import fsp from 'node:fs/promises'
import path from 'node:path'
import type { StepCtx, StepHandler, StepResult } from './types'
import { buildMainRequest } from '../prompts/main'
import { editImage, type ImageInput } from '../ai/imageClient'
import { capBytes, capEdge, flattenWhite, padSquare, readSize } from '../image/process'
import { compositeLocal, LocalPasteError } from '../image/whiteShape'
import { sha256 } from '../library/images'
import { planImageFile } from './plan'
import { decidePasteMode } from './paste'
import { JOB_FILES, readInput, writeJobImage } from './files'
import { writeOutput } from './output'
import { fidelityParams } from './params'
import { log } from '../util/log'

export const LOCAL_PROMPT = '本地合成，未调用 AI'

/** 生成结果的统一收尾：白底、长边 2000、方图开关、9.5MB 兜底 */
async function finish(ctx: StepCtx, buf: Buffer): Promise<void> {
  let out = await capEdge(await flattenWhite(buf), 2000)
  if (ctx.env.settings().padSquare) out = await padSquare(out)
  const capped = await capBytes(out)
  if (capped.shrunk) log.warn(`主图超过 9.5MB，已等比缩小：${ctx.job.source.originalName}`)
  await writeJobImage(ctx.dir, 'main', JOB_FILES.main, capped.buffer)
  await writeOutput(ctx.env.outputDir(), ctx.job, 'main', capped.buffer)
}

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
  await finish(ctx, res.buffer)
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
  await finish(ctx, r.buffer)
  return {
    kind: 'done',
    output: JOB_FILES.main,
    patch: (job) => {
      if (job.override?.step === 2) job.override = null
    },
  }
}
