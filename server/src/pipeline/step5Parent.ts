import fsp from 'node:fs/promises'
import path from 'node:path'
import type { StepHandler, StepResult } from './types'
import { chatJson } from '../ai/chatClient'
import { shrinkForAnalysis } from '../image/process'
import { PARENT_STEP, type Job, type ParentResult } from '../store/jobs'
import { MAX_CANDIDATES, ParentAnswerSchema, parentSystem, parentUser } from '../prompts/parent'
import { themeSamples } from '../parent/newParent'
import { bindExisting, bindNew, depsFor, emptyResult, guard, parentSkipReason, storeForJob } from '../parent/match'
import { candidateParents, seedInfo, themedRows, type StoreParentRow } from '../parent/storeParents'
import type { ParentRow } from '../parent/feishu'
import type { StoreSnapshot } from '../parent/storeIndex'
import { log } from '../util/log'

/**
 * 第 6 步「匹配父体」（实施方案第五节，多店铺方案第七节）：
 * - 飞书来源（焕捷）：读品类对应标签页的父体；
 * - 店铺来源（爱睿特）：店铺商品快照里商品类型对得上的父体，带商品标题；
 * 让分析模型挑父体（只给编号）→ 查店铺、推算下一个变体名；都不合适时建议新建父体（不加专属号）。
 * 定下父体后，子体 SKU 的材质编码跟着父体走（第六节），不一样就重新发号、输出文件改名。
 * 开关关着、缺设置时调度器在派发前就跳过，这里只是兜底。
 */
export const step5Parent: StepHandler = async (ctx) => {
  const settings = ctx.env.settings()
  const store = storeForJob(settings, ctx.job)
  const skip = parentSkipReason(settings, store)
  if (skip) return { kind: 'skipped', patch: (j) => (j.steps[PARENT_STEP]!.note = skip) }
  const route = ctx.job.route
  if (!route) return { kind: 'skipped', patch: (j) => (j.steps[PARENT_STEP]!.note = '还没有确定品类，不匹配父体') }
  const deps = depsFor(ctx.env.parent, store.id)
  const p = settings.parent
  const cat = ctx.env.library.get().categories.find((c) => c.id === route.categoryId)
  const catName = cat?.name ?? route.categoryName
  const productTypes = cat?.productTypes ?? []
  let snap: StoreSnapshot | null = null
  // 没有合适的父体：之前按别的父体改过的子体编码退回模版库的
  const finish = async (r: ParentResult): Promise<StepResult> => {
    if (ctx.env.syncChildCode && ctx.job.sku && !ctx.signal.aborted) await ctx.env.syncChildCode(ctx.job.id, { result: r, kids: [], snap, productTypes })
    return { kind: 'done', patch: (j) => (j.parent = r) }
  }

  // 店铺商品快照：店铺来源用它挑候选；两种来源都用它统计第一个变体名的写法、查重、兜底判断子体编码
  const index = ctx.env.parent.index
  if (!index) throw new Error('程序没有接上店铺商品快照')
  // 扫描要几十秒：这张图被暂停、删除时不再等它（扫描本身照常扫完、存进缓存）
  const untilAbort = <T,>(p: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (ctx.signal.aborted) return reject(new Error('已中止'))
      const onAbort = () => reject(new Error('已中止'))
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      p.then(resolve, reject).finally(() => ctx.signal.removeEventListener('abort', onAbort))
    })

  let tab: string
  let readAt: string
  let rows: (ParentRow | StoreParentRow)[]
  let allRows: ParentRow[]
  let usedFallback = false
  if (store.parentSource === 'store') {
    tab = productTypes.length ? productTypes.join(' / ') : catName
    if (!productTypes.length) return finish(emptyResult({ tab, readAt: new Date().toISOString() }, 'none', `去模版库给「${catName}」选「店铺商品类型」（比如毛毯选 BLANKET），才能从「${store.name}」店铺里挑父体`))
    snap = await ctx.retry(() => guard(() => untilAbort(index.get(store.id))))
    readAt = snap.scannedAt
    const cands = candidateParents(snap, productTypes)
    if (!cands.length) {
      // 店里这个商品类型还没有父体：没法参照命名，下面返回「没有合适的父体」
      rows = []
      allRows = []
    } else {
      rows = cands.slice(0, MAX_CANDIDATES)
      allRows = themedRows(cands, store.abbr)
      // 店里这类父体都是日期码的（爱睿特帆布画），拆不出前缀：用「店铺缩写-材质缩写」当前缀（2026-11-04）
      if (!allRows.length && cat?.skuCode) {
        allRows = [{ sku: `${store.abbr}-${cat.skuCode}-${FALLBACK_THEME}`, asin: '', theme: FALLBACK_THEME, row: 0 }]
        usedFallback = true
      }
    }
  } else {
    // 品类改过名（如相框 → 帆布画）时，旧任务里存的还是旧名，按模版库里现在的名字找标签页
    tab = cat?.parentTab?.trim() || catName
    const read = await ctx.retry(() => guard(() => deps.sheets.rows(store.feishu.sheetUrl, tab)))
    const base = { tab, readAt: read?.readAt ?? new Date().toISOString() }
    if (!read) return finish(emptyResult(base, 'none', `飞书表里没有「${tab}」标签页，去模版库给「${catName}」选对应的标签页`))
    if (!read.rows) return finish(emptyResult(base, 'none', `「${tab}」标签页里找不到「父体SKU」表头`))
    if (!read.rows.length) return finish(emptyResult(base, 'none', `「${tab}」标签页里还没有父体`))
    readAt = base.readAt
    rows = read.rows.slice(0, MAX_CANDIDATES)
    allRows = read.rows
    // 快照只用来统计变体名写法、兜底判断编码：10 分钟～2 小时内的直接用（后台重扫），只有第一次（或很久没扫）要等；
    // 不能不等，否则同一批先跑的图和后跑的图对同一个新父体会算出两种写法。扫不了照样匹配，写日志
    snap = await untilAbort(index.get(store.id)).catch((e) => {
      if (ctx.signal.aborted) throw e
      log.warn(`「${store.name}」扫描店铺商品失败，第一个变体名按 Style01、子体编码只看父体：${(e as Error).message}`)
      return null
    })
  }
  const base = { tab, readAt }
  const seed = seedInfo(snap, (store.parentSource === 'store' ? rows : allRows).map((r) => r.sku))

  let data: { pick: number | null; confidence: number; reason: string; alternatives: number[]; new_themes: string[] }
  if (rows.length) {
    const samples = store.parentSource === 'store' ? themeSamples(usedFallback ? [] : allRows) : themeSamples(rows)
    const system = parentSystem(tab, samples, store.parentSource)
    const user = parentUser({ category: route.categoryName, scene: ctx.job.info?.scene ?? null, keywords: ctx.job.info?.keywords ?? [], rows })
    const src = await fsp.readFile(path.join(ctx.dir, ctx.job.source.file))
    const jpeg = await shrinkForAnalysis(src)
    ctx.setSnapshot({
      images: [{ no: 1, role: '竞品图', sha256: ctx.job.source.sha256 }],
      prefix: '',
      prompt: system,
      model: settings.analysis.model,
      params: { user, tab, candidates: rows.length, store: store.name, source: store.parentSource === 'store' ? '店铺扫描' : '飞书父体表' },
    })
    data = (await ctx.retry(() => chatJson(settings.analysis, { system, user, imageJpeg: jpeg, signal: ctx.signal }, ParentAnswerSchema))).data
  } else {
    // 没有候选父体（店里这个商品类型还没有父体）：不问 AI，没法起主题，也没法建议新建
    return finish(emptyResult(base, 'none', `「${store.name}」店铺里还没有「${tab}」的父体，没法参照命名建议新父体；可以手动选父体`))
  }

  const rowAt = (n: number | null) => (n !== null && n >= 1 && n <= rows.length ? rows[n - 1]! : null)
  const pick = rowAt(data.pick)
  const seen = new Set<string>()
  const candidates = [data.pick, ...data.alternatives]
    .map((n, i) => ({ row: rowAt(n), confidence: i === 0 ? data.confidence : null }))
    .filter((c): c is { row: NonNullable<typeof c.row>; confidence: number | null } => !!c.row && !seen.has(c.row.sku) && !!seen.add(c.row.sku))
    .slice(0, 3)
    .map((c) => ({ sku: c.row.sku, asin: c.row.asin, theme: c.row.theme || titleOf(c.row), confidence: c.confidence }))
  const info = { ...base, candidates, confidence: data.confidence, reason: data.reason || null }
  const call = <T,>(fn: () => Promise<T>) => ctx.retry(fn)
  const save = (r: ParentResult) => ctx.commit((j) => (j.parent = r))
  const job = ctx.job as Job

  let kids: string[] = []
  let result: ParentResult
  if (pick) {
    result = await bindExisting({
      deps,
      job,
      row: pick,
      base: { ...info, manual: false },
      threshold: p.threshold,
      commit: save,
      call,
      signal: ctx.signal,
      seed,
      onKids: (k) => (kids = k),
      fallbackTheme: titleOf(pick) || null,
    })
  } else {
    // 新建建议的前缀统计和查重要看所有父体，不只是给 AI 的前 300 个
    result = await bindNew({
      deps,
      job,
      rows: allRows,
      themes: data.new_themes,
      base: info,
      commit: save,
      call,
      signal: ctx.signal,
      seed,
      storeSkus: snap ? new Set(snap.items.map((x) => x.sku.toLowerCase())) : undefined,
    })
    // 凑数用的占位行不是店里的 SKU，不显示在「参照的父体」里
    if (usedFallback && result.proposal) {
      const fixed: ParentResult = { ...result, proposal: { ...result.proposal, basedOn: [] } }
      save(fixed)
      result = fixed
    }
  }

  // 子体材质编码跟着父体走（待确认的不改，只提示；见 Scheduler.syncChildCode）
  if (ctx.env.syncChildCode && ctx.job.sku && !ctx.signal.aborted) await ctx.env.syncChildCode(ctx.job.id, { result, kids, snap, productTypes })
  return { kind: 'done' }
}

const titleOf = (r: ParentRow | StoreParentRow): string => (r as StoreParentRow).title ?? ''
/** 只用来让前缀统计拆出「店铺缩写-材质缩写」，不会出现在建议里 */
const FALLBACK_THEME = 'Theme'
