import type { ParentRow } from './feishu'
import type { IndexedListing, StoreSnapshot } from './storeIndex'
import { analyzeNaming, DEFAULT_SEED, seedName, type NamingSeed } from './naming'
import { majorityCode, materialCode, themeParent } from './skuParse'

/**
 * 店铺来源（爱睿特，没有飞书父体表）的父体：从店铺商品快照里挑（多店铺方案第七节，2026-11-04）。
 * 也给两种来源共用：新父体第一个变体名的写法、子体材质编码跟着父体走（第六节）。
 */

/** 父体清单里的一行：主题式父体（ART-cn-yklgj-cookie）主题从 SKU 拆；日期码父体主题为空，带上商品标题给 AI 看 */
export type StoreParentRow = ParentRow & { title: string; productType: string | null; createdAt: string }

/** 去掉 cn- 和横竖版标记：cn-HBxkfb → xkfb */
export const bareCode = (c: string) => c.replace(/^cn-/, '').replace(/^[HS]B-?/, '')

/**
 * 商品类型属于 productTypes 的父体，新建的排前面。
 * 不按材质编码过滤（2026-11-04 实测：模版库庭院灯是 cn-tyntyd，爱睿特店里是 tyntyt，按编码过滤会把它们全排除掉）；
 * 同一商品类型里不同材质的（亚克力挂件和陶瓷挂件都是 HANGING_ORNAMENT）由提示词要求 AI 看 SKU 和标题区分。
 */
export function candidateParents(snap: StoreSnapshot, productTypes: string[]): StoreParentRow[] {
  const want = new Set(productTypes.map((t) => t.toUpperCase()))
  return snap.items
    .filter((x) => x.kind === 'parent' && x.productType && want.has(x.productType.toUpperCase()))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((x, i) => ({ sku: x.sku, asin: x.asin ?? '', theme: x.theme, row: i + 1, title: x.title, productType: x.productType, createdAt: x.createdAt }))
}

/** 建议新父体时统计前缀用：只要主题式父体，主题写成 SKU 里的写法（这样 splitSku 按「-主题」结尾拆） */
export function themedRows(rows: StoreParentRow[], abbr: string): ParentRow[] {
  return rows
    .map((r) => ({ r, t: themeParent(r.sku, abbr) }))
    .filter((x) => x.t)
    .sort((a, b) => a.r.createdAt.localeCompare(b.r.createdAt))
    .map(({ r, t }, i) => ({ sku: r.sku, asin: r.asin, theme: t!.theme, row: i + 1 }))
}

/** 快照里某个父体的子体（按创建时间从旧到新） */
export function childrenOf(snap: StoreSnapshot, parentSku: string): IndexedListing[] {
  const low = parentSku.toLowerCase()
  return snap.items.filter((x) => x.kind === 'child' && x.parentSkus.some((p) => p.toLowerCase() === low))
}

/** 统计第一个变体名的写法时，看同品类最近几个有子体的父体 */
export const SEED_PARENTS = 10

/**
 * 新父体（或还没有子体的父体）第一个变体名的写法：同品类最近 SEED_PARENTS 个有子体的父体里，
 * 每个父体取它最多的那种带编号的命名（Style##、design ##），再取出现最多的；一样多取较新的。都没有返回 null（调用方用 Style01）。
 */
export function namingSeed(snap: StoreSnapshot | null, parentSkus: string[]): (NamingSeed & { basedOn: string[] }) | null {
  if (!snap) return null
  const wanted = new Set(parentSkus.map((s) => s.toLowerCase()))
  const parents = snap.items
    .filter((x) => x.kind === 'parent' && wanted.has(x.sku.toLowerCase()))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const stat = new Map<string, { seed: NamingSeed; count: number; newest: number; basedOn: string[] }>()
  let used = 0
  parents.forEach((p, i) => {
    if (used >= SEED_PARENTS) return
    const kids = childrenOf(snap, p.sku)
    if (!kids.length) return
    const a = analyzeNaming(p.themeAttributes, kids.map((k) => k.values))
    if (!a.top?.numbered) return
    used++
    const g = stat.get(a.top.key) ?? { seed: { prefix: a.top.prefix, width: a.top.width }, count: 0, newest: i, basedOn: [] }
    g.count++
    g.basedOn.push(p.sku)
    stat.set(a.top.key, g)
  })
  let best: { seed: NamingSeed; count: number; newest: number; basedOn: string[] } | null = null
  for (const g of stat.values()) if (!best || g.count > best.count || (g.count === best.count && g.newest < best.newest)) best = g
  return best ? { ...best.seed, basedOn: best.basedOn } : null
}

/** 第一个变体名的写法和说明：同品类最近有子体的父体里最多的那种；没有用 Style01 */
export function seedInfo(snap: StoreSnapshot | null, parentSkus: string[]): { seed: NamingSeed; from: string | null } {
  const s = namingSeed(snap, parentSkus)
  if (!s) return { seed: DEFAULT_SEED, from: null }
  const shown = s.basedOn.slice(0, 3).join('、') + (s.basedOn.length > 3 ? ` 等 ${s.basedOn.length} 个父体` : '')
  return { seed: { prefix: s.prefix, width: s.width }, from: `同品类最近的父体 ${shown}，它们多用 ${seedName(s)} 这种写法` }
}

/** 往前看多久的同类商品（第六节第 4 条） */
export const RECENT_DAYS = 60

/** fromKids：编码是从父体下的子体拆出来的（这时横竖版标记跟着子体取舍） */
export type CodeDecision = { code: string; why: string; fromKids: boolean } | null

/** 去掉横竖版标记，保留 cn-：cn-HBxkfb → cn-xkfb，HB-xkfb → xkfb */
export function stripStyleMark(c: string): string {
  const cn = c.startsWith('cn-')
  const rest = (cn ? c.slice(3) : c).replace(/^[HS]B-?/, '')
  return (cn ? 'cn-' : '') + rest
}

/** 编码里的横竖版标记（HB / SB），没有返回 null */
export function styleMarkOf(c: string): string | null {
  return /^(?:cn-)?([HS]B)-?[a-z]/.exec(c)?.[1] ?? null
}

/**
 * 横竖版标记怎么取舍（2026-11-04 审查后定，用户在第 3 段预览里确认过「父体下子体都是 xkfb：HBxkfb → xkfb」）：
 * - 编码是从父体下的子体拆出来的：子体都不带标记 → 去掉；子体带的标记和这张图的款式一样 → 照用；
 *   子体带的标记和这张图的款式相反（竖版图挂到横版子体多的父体下）→ 保留这张图自己的标记（图本身是竖版）。
 * - 别的情况（看父体 SKU、新父体前缀、同类商品，都拆不出这张图的横竖版）→ 保留这张图自己的标记。
 */
export function withOwnMark(d: NonNullable<CodeDecision>, ownMark: string | null | undefined): string {
  const own = ownMark?.trim().toUpperCase() || null
  const bare = stripStyleMark(d.code)
  const add = (m: string | null) => (!m ? bare : bare.startsWith('cn-') ? `cn-${m}${bare.slice(3)}` : `${m}${bare}`)
  if (d.fromKids) {
    const kidMark = styleMarkOf(d.code)
    if (!kidMark) return bare
    if (!own || kidMark === own) return d.code
    return add(own)
  }
  return add(own)
}

/**
 * 子体材质编码跟着父体走（第六节），按顺序找，找到就停：
 * 1. 已有父体：它的子体 SKU 里最多的编码；2. 子体拆不出来：父体 SKU 本身；3. 建议新建的父体：新前缀里的编码；
 * 4. 都拆不出来：快照里同商品类型最近 60 天新建商品最多的编码；5. 都没有：null（保持模版库的编码）。
 */
export function decideChildCode(o: {
  abbr: string
  parentSku: string | null
  /** 已有父体的子体 SKU（现查的），从旧到新 */
  kids: string[]
  /** 建议新建时的前缀，如 ART-cn-yklgj */
  newPrefix: string | null
  snap: StoreSnapshot | null
  productTypes: string[]
  /** 模版库里这个品类的材质缩写，第 4 条兜底时核对材质 */
  libraryCode?: string | null
  now?: number
}): CodeDecision {
  if (o.newPrefix) {
    const c = materialCode(o.newPrefix + '-x', o.abbr)
    if (c) return { code: c, why: `按建议新建的父体 ${o.newPrefix}`, fromKids: false }
  }
  if (o.parentSku) {
    const k = majorityCode(o.kids, o.abbr)
    if (k) return { code: k, why: `按父体 ${o.parentSku} 下的子体`, fromKids: true }
    const p = materialCode(o.parentSku, o.abbr)
    if (p) return { code: p, why: `按父体 SKU ${o.parentSku}`, fromKids: false }
  }
  if (o.snap && o.productTypes.length) {
    const want = new Set(o.productTypes.map((t) => t.toUpperCase()))
    const since = new Date((o.now ?? Date.now()) - RECENT_DAYS * 86400_000).toISOString()
    const recent = o.snap.items.filter((x) => x.productType && want.has(x.productType.toUpperCase()) && x.createdAt >= since).map((x) => x.sku)
    const c = majorityCode(recent, o.abbr)
    // 同一商品类型里可能是别的材质（亚克力挂件和陶瓷挂件），去掉 cn- 和标记后和模版库的编码不一样就不改
    if (c && (!o.libraryCode || bareCode(c).toLowerCase() === bareCode(o.libraryCode).toLowerCase())) {
      return { code: c, why: `按店铺里最近 ${RECENT_DAYS} 天同类商品（${o.productTypes.join('/')}）`, fromKids: false }
    }
  }
  return null
}
