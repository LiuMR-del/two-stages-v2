import type { ParentRow } from './feishu'

/**
 * 建议新建父体（实施方案 4.2）：表里没有合适的父体时，按同一标签页的命名方式起一个新父体 SKU，主题跟着图变。
 * 例：毛毯 HJ-mtfl-Love（HJ 店铺、mtfl 材质缩写、Love 主题），亚克力挂件 HJ-cn-yklgj-Christmas（cn = 中国发货）。
 * 2026-11-04 起父体不加专属号（多店铺方案第一节）：表里的 HJ-mtfl5-… 前缀去掉末尾数字后是 HJ-mtfl。
 */

export const MAX_BASED_ON = 5
const MAX_SAMPLES = 15

/**
 * 一行的前缀和英文主题：SKU 以「-主题」结尾就去掉这段；
 * 主题列不是 SKU 里的写法时（实测表里主题是中文「圣诞节婴儿」，SKU 是 …-Christmas Baby），按最后一个「-」拆。
 */
export function splitSku(row: Pick<ParentRow, 'sku' | 'theme'>): { prefix: string; theme: string } | null {
  const sku = row.sku.trim()
  const theme = row.theme.trim()
  if (theme && sku.toLowerCase().endsWith(`-${theme.toLowerCase()}`)) {
    const prefix = sku.slice(0, sku.length - theme.length - 1)
    if (prefix) return { prefix, theme: sku.slice(prefix.length + 1) }
  }
  const i = sku.lastIndexOf('-')
  if (i <= 0 || i === sku.length - 1) return null
  return { prefix: sku.slice(0, i), theme: sku.slice(i + 1) }
}

/** 出现最多的前缀；一样多时取表里靠后（较新）的那个。basedOn：参照的表里 SKU，最多 5 个，较新的在前 */
export function derivePrefix(rows: ParentRow[]): { prefix: string; basedOn: string[] } | null {
  const stat = new Map<string, { count: number; last: number; skus: string[] }>()
  rows.forEach((r, i) => {
    const s = splitSku(r)
    if (!s) return
    const g = stat.get(s.prefix) ?? { count: 0, last: -1, skus: [] }
    g.count++
    g.last = i
    g.skus.push(r.sku)
    stat.set(s.prefix, g)
  })
  let best: [string, { count: number; last: number; skus: string[] }] | null = null
  for (const e of stat) {
    if (!best || e[1].count > best[1].count || (e[1].count === best[1].count && e[1].last > best[1].last)) best = e
  }
  if (!best) return null
  return { prefix: best[0], basedOn: [...best[1].skus].reverse().slice(0, MAX_BASED_ON) }
}

/** 前缀最后一段末尾的数字换成创建人标识，没有数字就补上：HJ-cn-yklgj / HJ-cn-yklgj3 → HJ-cn-yklgj5 */
export function withCreator(prefix: string, mark: string): string {
  const i = prefix.lastIndexOf('-')
  const head = i >= 0 ? prefix.slice(0, i + 1) : ''
  const last = (i >= 0 ? prefix.slice(i + 1) : prefix).replace(/\d+$/, '')
  return head + last + mark.trim()
}

/** 给模型参考的主题样例：表里 SKU 末尾的英文主题 */
export function themeSamples(rows: ParentRow[]): string[] {
  const out: string[] = []
  for (const r of [...rows].reverse()) {
    const t = splitSku(r)?.theme
    if (t && !out.includes(t)) out.push(t)
    if (out.length >= MAX_SAMPLES) break
  }
  return out
}

/** 去掉 SKU 里不能用的字符，空格保留；每个词首字母大写，最多 3 个词 */
export function cleanTheme(t: string): string {
  return t
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ')
}

export type Proposal = { sku: string; prefix: string; theme: string; basedOn: string[]; themeCandidates: string[] }

/**
 * 依次试候选主题：和表里的父体 SKU 重名（大小写不敏感）就换下一个；同一批里别的图已经建议了同一个新 SKU 就直接共用；
 * 否则到店铺里只读查一次，已存在就换下一个。返回 null 表示都重名了。
 */
export async function proposeParent(opts: {
  rows: ParentRow[]
  themes: string[]
  /** 同一批里已经建议的新父体 SKU */
  queued: string[]
  existsInStore: (sku: string) => Promise<boolean>
}): Promise<{ ok: true; proposal: Proposal } | { ok: false; reason: 'noPrefix' | 'noThemes' } | { ok: false; reason: 'taken'; tried: string[] }> {
  const base = derivePrefix(opts.rows)
  if (!base) return { ok: false, reason: 'noPrefix' }
  const prefix = withCreator(base.prefix, '')
  const themes = [...new Set(opts.themes.map(cleanTheme).filter(Boolean))]
  if (!themes.length) return { ok: false, reason: 'noThemes' }
  const inTable = new Set(opts.rows.map((r) => r.sku.trim().toLowerCase()))
  const queued = new Map(opts.queued.map((s) => [s.toLowerCase(), s]))
  const tried: string[] = []
  for (const theme of themes) {
    const sku = `${prefix}-${theme}`
    tried.push(sku)
    if (inTable.has(sku.toLowerCase())) continue
    const shared = queued.get(sku.toLowerCase())
    if (shared) return { ok: true, proposal: { sku: shared, prefix, theme, basedOn: base.basedOn, themeCandidates: themes } }
    if (await opts.existsInStore(sku)) continue
    return { ok: true, proposal: { sku, prefix, theme, basedOn: base.basedOn, themeCandidates: themes } }
  }
  return { ok: false, reason: 'taken', tried }
}
