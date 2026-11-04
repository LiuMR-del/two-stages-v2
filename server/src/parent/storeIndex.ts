import { log } from '../util/log'
import { attributeValue, type SpapiClient, type SpapiPool } from './spapi'
import { themeParent } from './skuParse'

/**
 * 店铺商品快照（多店铺方案第四节，2026-11-04）：用 Listings 搜索翻完店铺所有商品，按店铺缓存 10 分钟。
 * SP-API 搜索最多只返回 1000 条（实测焕捷 1365 个只拿到 1000 个），超过时按创建日期二分成多段，每段不到 1000 条再翻。
 * 只读：只发 GET。
 */

export const SNAPSHOT_TTL_MS = 10 * 60_000
/** 超过这么久的快照不再先用着，要等重扫完 */
export const SNAPSHOT_STALE_MS = 2 * 3600_000
/** 搜索接口一次查询最多能翻到的条数 */
export const SEARCH_CAP = 1000
const PAGE_SIZE = '20'
/** 窗口小到 1 分钟还超过 1000 条就不再分（用表格批量上架可能一小时上千条，所以分到分钟），照常翻、标记不完整 */
const MIN_WINDOW_MS = 60_000
/** 最早从哪天开始分段（店铺都是之后开的） */
const EARLIEST = Date.UTC(2015, 0, 1)
/** 子体变体属性可能用到的名字，都记下来，第 6 步按父体的变体主题取 */
const VALUE_ATTRS = ['color', 'size', 'style', 'size_name', 'style_name', 'pattern_name', 'backing_material', 'frame']

export type ListingKind = 'parent' | 'child' | 'single'

export type IndexedListing = {
  sku: string
  asin: string | null
  title: string
  productType: string | null
  /** ISO 时间；没有时为空字符串 */
  createdAt: string
  status: string[]
  kind: ListingKind
  /** 父体的变体主题属性，如 ['color'] */
  themeAttributes: string[]
  childSkus: string[]
  parentSkus: string[]
  /** 变体属性值，如 { color: 'Style01' } */
  values: Record<string, string>
  /** 主题式父体（ART-cn-yklgj-cookie）拆出来的主题；日期码父体、不是父体时为空 */
  theme: string
}

export type StoreSnapshot = {
  storeId: string
  scannedAt: string
  /** 按创建时间从旧到新 */
  items: IndexedListing[]
  /** 有窗口小到 1 小时还超过 1000 条，没扫全 */
  truncated: boolean
  /** 发了多少次请求 */
  requests: number
}

/** 搜索结果里的一条转成快照里的记录 */
export function toListing(it: any, abbr: string): IndexedListing {
  const s = it?.summaries?.[0] ?? {}
  const rels = ((it?.relationships ?? []) as any[]).flatMap((g) => g?.relationships ?? [])
  const childSkus = [...new Set(rels.flatMap((r) => r?.childSkus ?? []).map(String))]
  const parentSkus = [...new Set(rels.flatMap((r) => r?.parentSkus ?? []).map(String))]
  const theme = rels.find((r) => r?.type === 'VARIATION' && Array.isArray(r?.variationTheme?.attributes))?.variationTheme?.attributes ?? []
  const level = attributeValue(it?.attributes, 'parentage_level')
  // 还没有子体的父体（如 ART-hyq-Christmas）也算父体：先看 parentage_level，没有时有子体 / 有变体主题却没有父体的算父体
  const kind: ListingKind =
    level === 'parent'
      ? 'parent'
      : level === 'child'
        ? 'child'
        : childSkus.length || (theme.length && !parentSkus.length)
          ? 'parent'
          : parentSkus.length
            ? 'child'
            : 'single'
  const values: Record<string, string> = {}
  for (const a of VALUE_ATTRS) {
    const v = attributeValue(it?.attributes, a)
    if (v) values[a] = v
  }
  const sku = String(it?.sku ?? '')
  return {
    sku,
    asin: s.asin ?? null,
    title: String(s.itemName ?? ''),
    productType: s.productType ?? null,
    createdAt: String(s.createdDate ?? ''),
    status: Array.isArray(s.status) ? s.status.map(String) : [],
    kind,
    themeAttributes: theme.map(String),
    childSkus,
    parentSkus,
    values,
    theme: kind === 'parent' ? (themeParent(sku, abbr)?.theme ?? '') : '',
  }
}

type Window = { after: number; before: number } | null

/** 每段最多多少条再开始翻页（段越小越能并发；太小了光看总数的请求就多） */
export const LEAF_TARGET = 300
/** 同时翻几段（搜索接口限速每秒 5 次，429 会自动等） */
export const SCAN_CONCURRENCY = 3

/**
 * 翻完店铺所有商品。先看总数，不到 LEAF_TARGET 直接翻；否则把时间段对半分，每段先只查 1 条看总数，
 * 分到每段不到 LEAF_TARGET（也一定不到 1000 的上限）为止，再几段同时翻。同一个 SKU 在两段边界上出现两次时只留一条。
 * 翻页按创建时间从旧到新排（接口默认按最后修改时间倒序，扫描期间有商品改了价格库存就会挪位置，页边界上的会漏掉）。
 * 各段总数加起来比全店总数少（没有创建时间、早于 2015 年的商品）、或者某段翻不完时标记 truncated。
 * 任何一个请求失败，其他段不再发新请求，整次扫描失败。
 */
export async function scanStore(
  client: SpapiClient,
  abbr: string,
  signal?: AbortSignal,
  now = Date.now(),
  opts: { leafTarget?: number; concurrency?: number } = {},
): Promise<Omit<StoreSnapshot, 'storeId' | 'scannedAt'>> {
  const leafTarget = Math.min(opts.leafTarget ?? LEAF_TARGET, SEARCH_CAP - 1)
  const concurrency = opts.concurrency ?? SCAN_CONCURRENCY
  const bySku = new Map<string, IndexedListing>()
  let requests = 0
  let truncated = false
  let failed = false
  const q = (w: Window): Record<string, string> => (w ? { createdAfter: new Date(w.after).toISOString(), createdBefore: new Date(w.before).toISOString() } : {})

  // 同时在飞的请求不超过 concurrency 个（看总数的请求也算）
  let active = 0
  const waiting: (() => void)[] = []
  const send = async (query: Record<string, string>) => {
    if (failed) throw new Error('扫描已经失败')
    while (active >= concurrency) await new Promise<void>((r) => waiting.push(r))
    active++
    requests++
    try {
      return await client.search(query, signal)
    } catch (e) {
      failed = true
      throw e
    } finally {
      active--
      waiting.shift()?.()
    }
  }

  const count = async (w: Window): Promise<number> => Number((await send({ ...q(w), pageSize: '1' }))?.numberOfResults ?? 0)
  const pageAll = async (w: Window) => {
    let token: string | undefined
    const maxPages = Math.ceil(SEARCH_CAP / Number(PAGE_SIZE)) + 1
    for (let page = 0; page < maxPages; page++) {
      const query: Record<string, string> = { ...q(w), includedData: 'summaries,relationships,attributes', pageSize: PAGE_SIZE, sortBy: 'createdDate', sortOrder: 'ASC' }
      if (token) query.pageToken = token
      const body = await send(query)
      for (const it of body?.items ?? []) {
        const l = toListing(it, abbr)
        if (l.sku) bySku.set(l.sku, l)
      }
      token = body?.pagination?.nextToken
      if (!token) return
    }
    truncated = true
  }
  /** 分出要翻的段 */
  const leaves: Window[] = []
  let covered = 0
  const split = async (w: { after: number; before: number }, n: number): Promise<void> => {
    if (n === 0) return
    if (n <= leafTarget || w.before - w.after <= MIN_WINDOW_MS) {
      if (n >= SEARCH_CAP) truncated = true
      covered += n
      leaves.push(w)
      return
    }
    const mid = Math.floor((w.after + w.before) / 2)
    const a = { after: w.after, before: mid }
    const b = { after: mid, before: w.before }
    const [na, nb] = await Promise.all([count(a), count(b)])
    await Promise.all([split(a, na), split(b, nb)])
  }

  const total = await count(null)
  if (total <= leafTarget) {
    leaves.push(null)
    covered = total
  } else await split({ after: EARLIEST, before: now + 86400_000 }, total)
  if (covered < total) {
    truncated = true
    log.warn(`扫描店铺商品：按创建时间分段只覆盖到 ${covered} / ${total} 个（有商品没有创建时间或早于 2015 年），快照不全`)
  }
  // 几段同时翻
  let next = 0
  const worker = async () => {
    while (next < leaves.length && !failed) await pageAll(leaves[next++]!)
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, leaves.length) }, worker))
  const items = [...bySku.values()].sort((x, y) => x.createdAt.localeCompare(y.createdAt))
  return { items, truncated, requests }
}

type Entry = { snap: StoreSnapshot; at: number; key: string }
/** 店铺缩写（拆主题用）和换了就要重扫的东西（店铺 ID、站点） */
export type StoreKey = { abbr: string; sellerId: string; marketplaceId: string }
const keyOf = (k: StoreKey) => [k.abbr, k.sellerId, k.marketplaceId].join('|')

/** 后台重扫失败后，这么久内不再在后台重试（否则每张图都触发一整轮扫描） */
const BACKGROUND_RETRY_MS = 60_000

type Pending = { promise: Promise<StoreSnapshot>; key: string }

/**
 * 按店铺缓存快照；同一个店铺同一时间只扫一次，并发的请求共用。
 * 正在扫的那次用的是旧凭证（缓存键变了）、或者这次要强制重扫时，排在它后面再扫一次，不拿它的结果。
 */
export class StoreIndex {
  private cache = new Map<string, Entry>()
  private pending = new Map<string, Pending>()
  /** 排在正在扫的那次后面的下一次（多个强制重扫共用一次） */
  private queued = new Map<string, Promise<StoreSnapshot>>()
  /** 店铺删掉、清缓存时加一，扫描结束时代数变了就不写回缓存 */
  private gen = new Map<string, number>()
  private lastFail = new Map<string, number>()

  constructor(
    private spapis: SpapiPool,
    private keyFor: (storeId: string) => StoreKey,
    private ttlMs = SNAPSHOT_TTL_MS,
    private now = () => Date.now(),
    private staleMs = SNAPSHOT_STALE_MS,
  ) {}

  /**
   * 10 分钟内的快照直接用；超过 10 分钟但不到 2 小时的也先用着，同时在后台重扫（第 6 步不用等）；
   * 没有快照、超过 2 小时、或者 force（「重新扫描」、改专属号查重）时等扫完。
   * 凭证换了店铺、换了站点、改了缩写，旧快照作废。
   */
  async get(storeId: string, opts: { force?: boolean } = {}): Promise<StoreSnapshot> {
    const key = keyOf(this.keyFor(storeId))
    const hit = this.cache.get(storeId)
    const usable = !opts.force && hit && hit.key === key ? hit : null
    const age = usable ? this.now() - usable.at : Infinity
    if (usable && age < this.ttlMs) return usable.snap
    if (usable && age < this.staleMs) {
      const failedAt = this.lastFail.get(storeId)
      if (failedAt === undefined || this.now() - failedAt >= BACKGROUND_RETRY_MS) {
        void this.refresh(storeId, false).catch((e) => log.warn(`后台重扫店铺商品失败：${(e as Error).message}`))
      }
      return usable.snap
    }
    return this.refresh(storeId, !!opts.force)
  }

  /** 后台先扫一遍（启动时、换店铺时），失败只记日志 */
  warm(storeId: string): void {
    void this.get(storeId).catch((e) => log.warn(`预先扫描店铺商品失败：${(e as Error).message}`))
  }

  scanning(storeId: string): boolean {
    return this.pending.has(storeId) || this.queued.has(storeId)
  }

  private refresh(storeId: string, fresh: boolean): Promise<StoreSnapshot> {
    const key = keyOf(this.keyFor(storeId))
    const cur = this.pending.get(storeId)
    if (!cur) return this.start(storeId)
    if (cur.key === key && !fresh) return cur.promise
    let q = this.queued.get(storeId)
    if (!q) {
      q = cur.promise
        .catch(() => null)
        .then(() => {
          this.queued.delete(storeId)
          return this.pending.get(storeId)?.promise ?? this.start(storeId)
        })
      this.queued.set(storeId, q)
    }
    return q
  }

  private start(storeId: string): Promise<StoreSnapshot> {
    const k = this.keyFor(storeId)
    const key = keyOf(k)
    const gen = this.gen.get(storeId) ?? 0
    const promise = (async () => {
      const started = this.now()
      try {
        const r = await scanStore(this.spapis.for(storeId), k.abbr)
        const snap: StoreSnapshot = { storeId, scannedAt: new Date(started).toISOString(), ...r }
        if ((this.gen.get(storeId) ?? 0) === gen) this.cache.set(storeId, { snap, at: started, key })
        this.lastFail.delete(storeId)
        log.info(`扫描店铺商品：${r.items.length} 个，${r.requests} 次请求${r.truncated ? '（快照不全）' : ''}`)
        return snap
      } catch (e) {
        this.lastFail.set(storeId, this.now())
        throw e
      } finally {
        this.pending.delete(storeId)
      }
    })()
    this.pending.set(storeId, { promise, key })
    return promise
  }

  /** 只看缓存，不发请求（发 SKU 查重用，不为它等扫描）；过期的也返回，调用方自己看 scannedAt */
  peek(storeId: string): StoreSnapshot | null {
    const hit = this.cache.get(storeId)
    return hit && hit.key === keyOf(this.keyFor(storeId)) ? hit.snap : null
  }

  /** 店铺删了、测试里清缓存：丢掉缓存；正在扫的那次结束后也不写回 */
  clear(storeId?: string): void {
    const ids = storeId ? [storeId] : [...new Set([...this.cache.keys(), ...this.pending.keys()])]
    for (const id of ids) {
      this.cache.delete(id)
      this.gen.set(id, (this.gen.get(id) ?? 0) + 1)
    }
  }
}

