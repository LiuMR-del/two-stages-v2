import fsp from 'node:fs/promises'
import path from 'node:path'
import type { StepHandler, StepResult } from './types'
import { chatJson } from '../ai/chatClient'
import { readSize, shrinkForAnalysis } from '../image/process'
import { RouteAnswerSchema, ROUTE_USER, routeSystem } from '../prompts/route'
import { labelOf } from '../prompts/placeholders'
import { locateFace, validQuad, type Face } from '../image/face'
import { log } from '../util/log'

export const step0Route: StepHandler = async (ctx) => {
  const lib = ctx.env.library.get()
  if (lib.categories.length === 0) {
    return { kind: 'attention', state: 'failed', attention: { kind: 'nomatch', step: 0, message: '模版库还没有品类，请先到模版库添加' } }
  }
  const settings = ctx.env.settings()
  const system = routeSystem(lib)
  const src = await fsp.readFile(path.join(ctx.dir, ctx.job.source.file))
  const jpeg = await shrinkForAnalysis(src)
  ctx.setSnapshot({
    images: [{ no: 1, role: '竞品图', sha256: ctx.job.source.sha256 }],
    prefix: '',
    prompt: system,
    model: settings.analysis.model,
    params: { user: ROUTE_USER },
  })
  const { data } = await ctx.retry(() =>
    chatJson(settings.analysis, { system, user: ROUTE_USER, imageJpeg: jpeg, signal: ctx.signal }, RouteAnswerSchema),
  )

  const ai = validQuad(data.print_corners, await readSize(jpeg))
  if (!ai && data.print_corners != null) log.warn(`「${ctx.job.source.originalName}」AI 给的印刷面四个角不合格，按整张图提取：${JSON.stringify(data.print_corners).slice(0, 200)}`)
  let face: Face | null = null
  if (ai) {
    try {
      face = await locateFace(src, ai)
    } catch (e) {
      log.warn(`「${ctx.job.source.originalName}」印刷面区域校正失败，按整张图提取：${(e as Error).message}`)
    }
  }
  const setFace = (job: Parameters<NonNullable<StepResult['patch']>>[0]) => {
    job.face = face
  }

  const guess = data.guess.trim() || undefined
  const cat = data.category_id ? lib.categories.find((c) => c.id === data.category_id) : undefined
  if (!cat) {
    return {
      kind: 'attention',
      state: 'failed',
      attention: { kind: 'nomatch', step: 0, message: `AI 判断是「${guess ?? '未知商品'}」，模版库里没有这个品类`, guess },
      patch: setFace,
    }
  }
  let style = cat.styles.length === 1 ? cat.styles[0] : cat.styles.find((s) => s.id === data.style_id)
  if (!style) {
    return { kind: 'attention', state: 'failed', attention: { kind: 'nomatch', step: 0, message: `认出是${cat.name}，但判断不了款式`, guess }, patch: setFace }
  }
  if (data.confidence < settings.routeThreshold) {
    return {
      kind: 'attention',
      state: 'failed',
      attention: { kind: 'nomatch', step: 0, message: `AI 认为是「${labelOf(cat.name, style.name)}」，但把握只有 ${data.confidence.toFixed(2)}`, guess },
      patch: setFace,
    }
  }
  const chosen = style
  return {
    kind: 'done',
    patch: (job) => {
      setFace(job)
      job.route = {
        categoryId: cat.id,
        styleId: chosen.id,
        categoryName: cat.name,
        styleName: chosen.name,
        ratio: chosen.ratio,
        confidence: data.confidence,
        reason: data.reason || null,
        manual: false,
      }
    },
  }
}
