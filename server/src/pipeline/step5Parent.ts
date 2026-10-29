import fsp from 'node:fs/promises'
import path from 'node:path'
import type { StepHandler, StepResult } from './types'
import { chatJson } from '../ai/chatClient'
import { shrinkForAnalysis } from '../image/process'
import { PARENT_STEP, type Job, type ParentResult } from '../store/jobs'
import { MAX_CANDIDATES, ParentAnswerSchema, parentSystem, parentUser } from '../prompts/parent'
import { themeSamples } from '../parent/newParent'
import { bindExisting, bindNew, emptyResult, guard, parentSkipReason } from '../parent/match'

/**
 * 第 6 步「匹配父体」（实施方案第五节）：读对应标签页 → 让分析模型挑父体（只给编号）→ 查店铺、推算下一个变体名；
 * 都不合适时建议新建父体。开关关着、缺设置时调度器在派发前就跳过，这里只是兜底。
 */
export const step5Parent: StepHandler = async (ctx) => {
  const settings = ctx.env.settings()
  const skip = parentSkipReason(settings)
  if (skip) return { kind: 'skipped', patch: (j) => (j.steps[PARENT_STEP]!.note = skip) }
  const route = ctx.job.route
  if (!route) return { kind: 'skipped', patch: (j) => (j.steps[PARENT_STEP]!.note = '还没有确定品类，不匹配父体') }
  const deps = ctx.env.parent
  const p = settings.parent
  const cat = ctx.env.library.get().categories.find((c) => c.id === route.categoryId)
  // 品类改过名（如相框 → 帆布画）时，旧任务里存的还是旧名，按模版库里现在的名字找标签页
  const tab = cat?.parentTab?.trim() || cat?.name || route.categoryName

  const read = await ctx.retry(() => guard(() => deps.sheets.rows(p.sheetUrl, tab)))
  const base = { tab, readAt: read?.readAt ?? new Date().toISOString() }
  const finish = (r: ParentResult): StepResult => ({ kind: 'done', patch: (j) => (j.parent = r) })
  if (!read) return finish(emptyResult(base, 'none', `飞书表里没有「${tab}」标签页，去模版库给「${cat?.name ?? route.categoryName}」选对应的标签页`))
  if (!read.rows) return finish(emptyResult(base, 'none', `「${tab}」标签页里找不到「父体SKU」表头`))
  if (!read.rows.length) return finish(emptyResult(base, 'none', `「${tab}」标签页里还没有父体`))
  const rows = read.rows.slice(0, MAX_CANDIDATES)

  const system = parentSystem(tab, themeSamples(rows))
  const user = parentUser({ category: route.categoryName, scene: ctx.job.info?.scene ?? null, keywords: ctx.job.info?.keywords ?? [], rows })
  const src = await fsp.readFile(path.join(ctx.dir, ctx.job.source.file))
  const jpeg = await shrinkForAnalysis(src)
  ctx.setSnapshot({
    images: [{ no: 1, role: '竞品图', sha256: ctx.job.source.sha256 }],
    prefix: '',
    prompt: system,
    model: settings.analysis.model,
    params: { user, tab, candidates: rows.length },
  })
  const { data } = await ctx.retry(() => chatJson(settings.analysis, { system, user, imageJpeg: jpeg, signal: ctx.signal }, ParentAnswerSchema))

  const rowAt = (n: number | null) => (n !== null && n >= 1 && n <= rows.length ? rows[n - 1]! : null)
  const pick = rowAt(data.pick)
  const seen = new Set<string>()
  const candidates = [data.pick, ...data.alternatives]
    .map((n, i) => ({ row: rowAt(n), confidence: i === 0 ? data.confidence : null }))
    .filter((c): c is { row: NonNullable<typeof c.row>; confidence: number | null } => !!c.row && !seen.has(c.row.sku) && !!seen.add(c.row.sku))
    .slice(0, 3)
    .map((c) => ({ sku: c.row.sku, asin: c.row.asin, theme: c.row.theme, confidence: c.confidence }))
  const info = { ...base, candidates, confidence: data.confidence, reason: data.reason || null }
  const call = <T,>(fn: () => Promise<T>) => ctx.retry(fn)
  const save = (r: ParentResult) => ctx.commit((j) => (j.parent = r))
  const job = ctx.job as Job

  if (pick) {
    await bindExisting({ deps, job, row: pick, base: { ...info, manual: false }, threshold: p.threshold, commit: save, call, signal: ctx.signal })
  } else {
    // 新建建议的前缀统计和查重要看表里所有父体，不只是给 AI 的前 300 个
    await bindNew({ deps, job, rows: read.rows, themes: data.new_themes, creatorMark: p.creatorMark, base: info, commit: save, call, signal: ctx.signal })
  }
  return { kind: 'done' }
}
