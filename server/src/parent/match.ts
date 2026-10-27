import type { Settings } from '../store/settings'
import type { Job, ParentResult } from '../store/jobs'
import { AiError } from '../ai/errors'
import { FeishuAuthError, FeishuError, type FeishuSheets, type ParentRow } from './feishu'
import { SpapiAuthError, SpapiError, type SpapiClient } from './spapi'
import { analyzeNaming, nextName, type Naming } from './naming'
import { proposeParent } from './newParent'
import type { KeyedMutex } from '../util/mutex'

/** 飞书 / SP-API 的凭证、权限问题：第 6 步整体暂停，处理好（保存设置）后自动继续，前 5 步不受影响 */
export class ParentPauseError extends Error {}

export const NEW_PARENT_NOTE = '这是建议新建的父体，飞书表和店铺里都还没有，需要你手动创建'

/** 开关关着、或缺链接 / 飞书应用 / SP-API 凭证时第 6 步直接跳过，返回原因；不缺返回 null */
export function parentSkipReason(s: Settings): string | null {
  const p = s.parent
  if (!p.enabled) return '识别父体没有打开，可以在设置里打开'
  const miss: string[] = []
  if (!p.sheetUrl) miss.push('父体表链接')
  if (!p.feishu.appId || !p.feishu.appSecret) miss.push('飞书 App ID / App Secret')
  const sp = p.spapi
  if (!sp.sellerId || !sp.clientId || !sp.clientSecret || !sp.refreshToken) miss.push('SP-API 凭证')
  return miss.length ? `识别父体缺：${miss.join('、')}。补齐后在详情里对第 6 步点「重新匹配」` : null
}

/** 凭证、权限问题转成暂停；网络、5xx 转成可重试的错误，按现有重试规则走 */
export async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof FeishuAuthError || e instanceof SpapiAuthError) throw new ParentPauseError(e.message)
    if (e instanceof FeishuError) {
      if (/^(应用没有这张表的权限|飞书应用还没开通|这个链接读不了)/.test(e.message)) {
        const msg = e.message.startsWith('这个链接') ? e.message : `这个链接读不了：${e.message}`
        throw new ParentPauseError(`${msg}。在飞书里处理好后，到设置里点「读一下试试」就会继续`)
      }
      throw new AiError('network', `飞书：${e.message}`)
    }
    // 400 这类请求本身的问题重试也没用；5xx、超时、连不上按重试规则走
    if (e instanceof SpapiError) throw new AiError(e.status >= 500 ? 'server' : e.status >= 400 ? 'client' : 'network', `SP-API：${e.message}`, e.status || undefined)
    throw e
  }
}

export type ParentDeps = {
  sheets: FeishuSheets
  spapi: SpapiClient
  /** 占号的互斥锁：按父体 SKU 加 */
  mutex: KeyedMutex
  /** 队列里所有任务，用来算别的图已经分到的号 */
  jobs: () => Job[]
}

type Base = Pick<ParentResult, 'tab' | 'readAt'>

export function emptyResult(base: Base, status: ParentResult['status'], message: string | null): ParentResult {
  return { ...base, status, message, sku: null, asin: null, theme: null, confidence: null, reason: null, manual: false, candidates: [], naming: null, proposal: null }
}

const lower = (s: string) => s.trim().toLowerCase()

/** 队列里别的任务已经分到的、同父体同命名方式的号 */
function takenNumbers(jobs: Job[], selfId: string, sku: string, key: string | null): number[] {
  if (!key) return []
  return jobs
    .filter((j) => j.id !== selfId && j.parent?.sku && lower(j.parent.sku) === lower(sku) && j.parent.naming?.key === key && j.parent.naming.number !== null)
    .map((j) => j.parent!.naming!.number!)
}

const namingOf = (n: Naming): NonNullable<ParentResult['naming']> => ({
  attribute: n.attribute,
  existing: n.existing,
  groups: n.groups,
  next: n.next,
  note: n.note,
  key: n.key,
  number: n.number,
})

/**
 * 选定一个已有父体后：查店铺、推算命名、在父体 SKU 的锁里分号并立即写进任务（commit），
 * 这样并发的同父体任务一定能看到前面分出去的号。
 */
export async function bindExisting(opts: {
  deps: ParentDeps
  job: Job
  row: ParentRow
  base: Base & Pick<ParentResult, 'candidates' | 'confidence' | 'reason' | 'manual'>
  threshold: number
  commit: (r: ParentResult) => void
  call: <T>(fn: () => Promise<T>) => Promise<T>
  signal?: AbortSignal
}): Promise<ParentResult> {
  const { deps, row } = opts
  const listing = await opts.call(() => guard(() => deps.spapi.parent(row.sku, opts.signal)))
  const common = { ...opts.base, sku: row.sku, asin: row.asin || null, theme: row.theme || null, proposal: null }
  if (!listing) {
    const r: ParentResult = { ...common, status: 'unsure', message: '店铺里查不到这个父体 SKU，检查飞书表里的 SKU 是否写对', naming: null }
    opts.commit(r)
    return r
  }
  const kids = await opts.call(() => guard(() => deps.spapi.children(row.sku, listing.themeAttributes, opts.signal)))
  const analysis = analyzeNaming(listing.themeAttributes, kids.map((k) => k.values))
  return deps.mutex.run(lower(row.sku), () => {
    const naming = nextName(analysis, takenNumbers(deps.jobs(), opts.job.id, row.sku, analysis.top?.key ?? 'Design ##'))
    const sure = opts.base.manual || (opts.base.confidence ?? 0) >= opts.threshold
    const message = !naming.next ? naming.note : sure ? null : `把握只有 ${(opts.base.confidence ?? 0).toFixed(2)}，低于 ${opts.threshold.toFixed(2)}，请确认`
    const r: ParentResult = { ...common, asin: listing.asin ?? common.asin, status: sure && naming.next ? 'matched' : 'unsure', message, naming: namingOf(naming) }
    opts.commit(r)
    return r
  })
}

/** 表里没有合适的父体：按 4.2 建议新建，同一批共用同一个新 SKU，子体从 Design 01 依次往后排 */
export async function bindNew(opts: {
  deps: ParentDeps
  job: Job
  rows: ParentRow[]
  themes: string[]
  creatorMark: string
  base: Base & Pick<ParentResult, 'candidates' | 'confidence' | 'reason'>
  commit: (r: ParentResult) => void
  call: <T>(fn: () => Promise<T>) => Promise<T>
  signal?: AbortSignal
}): Promise<ParentResult> {
  const { deps } = opts
  const queued = deps
    .jobs()
    .filter((j) => j.id !== opts.job.id && j.parent?.status === 'new' && j.parent.proposal)
    .map((j) => j.parent!.proposal!.sku)
  const p = await proposeParent({
    rows: opts.rows,
    themes: opts.themes,
    creatorMark: opts.creatorMark,
    queued,
    existsInStore: (sku) => opts.call(() => guard(async () => (await deps.spapi.parent(sku, opts.signal)) !== null)),
  })
  const common = { ...opts.base, manual: false }
  if (!p.ok) {
    const r =
      p.reason === 'noPrefix'
        ? { ...emptyResult(opts.base, 'none', '表里的父体 SKU 看不出命名规则，没法建议新父体'), ...common }
        : p.reason === 'noThemes'
          ? { ...emptyResult(opts.base, 'none', 'AI 认为表里没有合适的父体，但没给出新主题；可以手动选父体，或点「重新匹配」'), ...common }
          : { ...emptyResult(opts.base, 'unsure', `建议的父体 SKU 都已存在：${'tried' in p ? p.tried.join('、') : ''}，请手动起名`), ...common }
    opts.commit(r)
    return r
  }
  const prop = p.proposal
  return deps.mutex.run(lower(prop.sku), () => {
    const n = nextName(analyzeNaming([], []), takenNumbers(deps.jobs(), opts.job.id, prop.sku, 'Design ##'))
    const r: ParentResult = {
      ...common,
      status: 'new',
      message: null,
      sku: prop.sku,
      asin: null,
      theme: prop.theme,
      proposal: prop,
      naming: { ...namingOf(n), attribute: 'color', note: NEW_PARENT_NOTE },
    }
    opts.commit(r)
    return r
  })
}
