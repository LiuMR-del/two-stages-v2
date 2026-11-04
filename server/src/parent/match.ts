import { currentStore, storeById, type Settings, type Store } from '../store/settings'
import type { Job, ParentResult } from '../store/jobs'
import { AiError } from '../ai/errors'
import { FeishuAuthError, FeishuError, type FeishuSheets, type ParentRow } from './feishu'
import { SpapiAuthError, SpapiError, type SpapiClient, type SpapiPool } from './spapi'
import { analyzeNaming, DEFAULT_SEED, nextName, seedKey, splitValue, type Naming, type NamingSeed } from './naming'
import type { Reservations } from './reservations'
import type { StoreIndex } from './storeIndex'
import { proposeParent } from './newParent'
import type { KeyedMutex } from '../util/mutex'

/** 飞书 / SP-API 的凭证、权限问题：第 6 步整体暂停，处理好（保存设置）后自动继续，前 5 步不受影响 */
export class ParentPauseError extends Error {}

export const NEW_PARENT_NOTE = '这是建议新建的父体，店铺里还没有，需要你手动创建'

/** 第一个变体名的写法和它参照了哪些父体（同品类最近有子体的父体，多店铺方案第七节） */
export type SeedInfo = { seed: NamingSeed; from: string | null }
export const DEFAULT_SEED_INFO: SeedInfo = { seed: DEFAULT_SEED, from: null }

/**
 * 这张图属于哪个店铺（加进队列时从批次取，job.storeId）；店铺被删了（不应该发生，删店铺时会拦）才退回当前店铺。
 */
export function storeForJob(s: Settings, job?: { storeId?: string } | null): Store {
  return (job?.storeId ? storeById(s, job.storeId) : null) ?? currentStore(s)
}

/** 店铺缺哪些父体设置（飞书来源要父体表链接和飞书应用，两种来源都要 SP-API 凭证） */
export function storeMissing(s: Settings, st: Store): string[] {
  const miss: string[] = []
  if (st.parentSource === 'feishu') {
    if (!st.feishu.sheetUrl) miss.push('父体表链接')
    if (!s.parent.feishu.appId || !s.parent.feishu.appSecret) miss.push('飞书 App ID / App Secret')
  }
  const sp = st.spapi
  if (!sp.sellerId || !sp.clientId || !sp.clientSecret || !sp.refreshToken) miss.push('SP-API 凭证')
  return miss
}

/** 开关关着、或店铺缺链接 / 飞书应用 / SP-API 凭证时第 6 步直接跳过，返回原因；不缺返回 null */
export function parentSkipReason(s: Settings, st: Store = currentStore(s)): string | null {
  if (!s.parent.enabled) return '识别父体没有打开，可以在设置里打开'
  const miss = storeMissing(s, st)
  if (miss.length) return `「${st.name}」识别父体缺：${miss.join('、')}。补齐后在详情里对第 6 步点「重新匹配」`
  return null
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
  /** 同一批里已经移出队列的图分到的号（还占着）；不给时只看队列 */
  reservations?: Reservations
  /** 店铺商品快照（店铺来源挑候选、统计变体名写法、查重）；单元测试不给 */
  index?: StoreIndex
}

/** 调度器里存的：SP-API 按店铺取客户端，用的时候用 depsFor 换成某个店铺的 ParentDeps */
export type ParentEnv = Omit<ParentDeps, 'spapi'> & { spapis: SpapiPool }

export function depsFor(env: ParentEnv, storeId: string): ParentDeps {
  const { spapis, ...rest } = env
  return { ...rest, spapi: spapis.for(storeId) }
}

type Base = Pick<ParentResult, 'tab' | 'readAt'>

export function emptyResult(base: Base, status: ParentResult['status'], message: string | null): ParentResult {
  return { ...base, status, message, sku: null, asin: null, theme: null, confidence: null, reason: null, manual: false, candidates: [], naming: null, proposal: null }
}

const lower = (s: string) => s.trim().toLowerCase()

/**
 * 别的图已经分到的、同父体同命名方式的号：队列里的图，加上同一批文件夹里已经移出队列、号还占着的图。
 */
export function takenNumbers(deps: Pick<ParentDeps, 'jobs' | 'reservations'>, self: Pick<Job, 'id' | 'outputFolder'>, sku: string, key: string | null): number[] {
  if (!key) return []
  const jobs = deps.jobs()
  const inQueue = new Set(jobs.map((j) => j.id))
  const fromQueue = jobs
    .filter((j) => j.id !== self.id && j.parent?.sku && lower(j.parent.sku) === lower(sku) && j.parent.naming?.key === key && j.parent.naming.number !== null)
    .map((j) => j.parent!.naming!.number!)
  const kept = (deps.reservations?.list(self.outputFolder) ?? [])
    .filter((r) => r.jobId !== self.id && !inQueue.has(r.jobId) && lower(r.sku) === lower(sku) && r.key === key)
    .map((r) => r.number)
  return [...fromQueue, ...kept]
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
  /** 父体还没有子体时第一个变体名的写法 */
  seed?: SeedInfo
  /** 现查到的子体 SKU（从旧到新），子体材质编码跟着它们走 */
  onKids?: (skus: string[]) => void
  /** 主题显示用（店铺来源的日期码父体没有主题时用商品标题） */
  fallbackTheme?: string | null
}): Promise<ParentResult> {
  const { deps, row } = opts
  const listing = await opts.call(() => guard(() => deps.spapi.parent(row.sku, opts.signal)))
  const common = { ...opts.base, sku: row.sku, asin: row.asin || null, theme: row.theme || opts.fallbackTheme || null, proposal: null }
  if (!listing) {
    const r: ParentResult = { ...common, status: 'unsure', message: '店铺里查不到这个父体 SKU，检查父体 SKU 是否写对（飞书父体表里的，或者刚在店里删掉了）', naming: null }
    opts.commit(r)
    return r
  }
  const kids = await opts.call(() => guard(() => deps.spapi.children(row.sku, listing.themeAttributes, opts.signal)))
  opts.onKids?.(kids.map((k) => k.sku))
  const analysis = analyzeNaming(listing.themeAttributes, kids.map((k) => k.values))
  const seed = opts.seed ?? DEFAULT_SEED_INFO
  return deps.mutex.run(lower(row.sku), () => {
    const naming = nextName(analysis, takenNumbers(deps, opts.job, row.sku, analysis.top?.key ?? seedKey(seed.seed)), seed.seed, seed.from)
    const sure = opts.base.manual || (opts.base.confidence ?? 0) >= opts.threshold
    const message = !naming.next ? naming.note : sure ? null : `把握只有 ${(opts.base.confidence ?? 0).toFixed(2)}，低于 ${opts.threshold.toFixed(2)}，请确认`
    const r: ParentResult = { ...common, asin: listing.asin ?? common.asin, status: sure && naming.next ? 'matched' : 'unsure', message, naming: namingOf(naming) }
    opts.commit(r)
    return r
  })
}

/** 表里没有合适的父体：按 4.2 建议新建，同一批共用同一个新 SKU，子体按同品类最近父体的写法从 01 依次往后排（没有可参照的从 Style01） */
export async function bindNew(opts: {
  deps: ParentDeps
  job: Job
  rows: ParentRow[]
  themes: string[]
  base: Base & Pick<ParentResult, 'candidates' | 'confidence' | 'reason'>
  commit: (r: ParentResult) => void
  call: <T>(fn: () => Promise<T>) => Promise<T>
  signal?: AbortSignal
  seed?: SeedInfo
  /** 店铺里已有的 SKU（快照），查重时先看它，不用每个都查一次店铺 */
  storeSkus?: Set<string>
}): Promise<ParentResult> {
  const { deps } = opts
  const queued = [
    ...deps
      .jobs()
      .filter((j) => j.id !== opts.job.id && j.parent?.status === 'new' && j.parent.proposal)
      .map((j) => j.parent!.proposal!.sku),
    // 同一批里已经移出队列、建议过的新父体也共用
    ...(deps.reservations?.list(opts.job.outputFolder) ?? []).filter((r) => r.jobId !== opts.job.id).map((r) => r.sku),
  ]
  const p = await proposeParent({
    rows: opts.rows,
    themes: opts.themes,
    queued,
    existsInStore: (sku) => (opts.storeSkus?.has(sku.toLowerCase()) ? Promise.resolve(true) : opts.call(() => guard(async () => (await deps.spapi.parent(sku, opts.signal)) !== null))),
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
    // 同一批里别的图已经建议了同一个新父体：沿用它的写法，号才排得到一起
    const sibling = deps
      .jobs()
      .find((j) => j.id !== opts.job.id && j.parent?.status === 'new' && j.parent.proposal && lower(j.parent.proposal.sku) === lower(prop.sku) && j.parent.naming?.key)
    const key = sibling?.parent?.naming?.key
    const own = opts.seed ?? DEFAULT_SEED_INFO
    const sharedSeed =
      key && /#+$/.test(key) && key !== seedKey(own.seed)
        ? { seed: { prefix: key.replace(/#+$/, ''), width: key.length - key.replace(/#+$/, '').length }, from: `这一批里别的图建议的同一个新父体` }
        : null
    const seed = sharedSeed ?? own
    const n = nextName(analyzeNaming([], []), takenNumbers(deps, opts.job, prop.sku, seedKey(seed.seed)), seed.seed, seed.from)
    const r: ParentResult = {
      ...common,
      status: 'new',
      message: null,
      sku: prop.sku,
      asin: null,
      theme: prop.theme,
      proposal: prop,
      naming: { ...namingOf(n), attribute: 'color', note: `${NEW_PARENT_NOTE}。${n.note}` },
    }
    opts.commit(r)
    return r
  })
}

/**
 * 手动上下调整变体名（2026-10-28 用户要求）：按方向一格一格找，跳过店铺里已有的名字和同一批里别的图占着的号。
 * 只在这一类命名有编号时可用；调整后在父体 SKU 的锁里写进任务。
 */
export async function shiftNumber(deps: ParentDeps, job: Job, delta: 1 | -1, commit: (r: ParentResult) => void): Promise<ParentResult> {
  const p = job.parent
  const n = p?.naming
  if (!p?.sku || !n?.next || !n.key || n.number === null) throw new Error('这张图的变体名没有编号，没法上下调整')
  const sp = splitValue(n.next)
  if (!sp) throw new Error('这张图的变体名没有编号，没法上下调整')
  return deps.mutex.run(lower(p.sku), () => {
    const used = new Set<number>(takenNumbers(deps, job, p.sku!, n.key))
    for (const v of n.existing) {
      const s = splitValue(v)
      if (s && lower(s.prefix) === lower(sp.prefix)) used.add(s.num)
    }
    let k = n.number! + delta
    while (k > 0 && used.has(k)) k += delta
    if (k <= 0) throw new Error('再往下都被占了，没有更小的可用编号')
    const r: ParentResult = { ...p, naming: { ...n, number: k, next: sp.prefix + String(k).padStart(sp.width, '0') } }
    commit(r)
    return r
  })
}
