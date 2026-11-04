/**
 * 变体命名推算（实施方案 4.1）：读父体所有子体的变体属性值，归类成命名方式（Design 01～04 算一种「Design ##」），
 * 数量最多的那种往下排一个号，位数不变。
 */

export type NamingGroup = { pattern: string; count: number }

export type NamingAnalysis = {
  /** 用来命名的变体属性，如 color */
  attribute: string
  /** 现有子体的值 */
  existing: string[]
  groups: NamingGroup[]
  /** 数量最多的那一类；没有子体时为 null */
  top: null | { key: string; prefix: string; width: number; numbered: boolean; max: number }
}

export type Naming = {
  attribute: string
  existing: string[]
  groups: NamingGroup[]
  /** null = 最多的那种命名没有编号，要手动起名 */
  next: string | null
  note: string | null
  /** 占号用：同一父体、同一命名方式的号不能重 */
  key: string | null
  number: number | null
}

/** 第一个变体名的写法：前缀 + 编号位数，如 { prefix: 'Style', width: 2 } → Style01 */
export type NamingSeed = { prefix: string; width: number }

/**
 * 没有子体、也没有可参考的同品类父体时从这个起（2026-11-04 用户确认：参考同品类最近父体最多的写法，没有用 Style01；原来固定 Design 01）
 */
export const DEFAULT_SEED: NamingSeed = { prefix: 'Style', width: 2 }
export const seedName = (s: NamingSeed, n = 1) => s.prefix + String(n).padStart(s.width, '0')
export const seedKey = (s: NamingSeed) => s.prefix + '#'.repeat(s.width)

const SPLIT = /^(.*?)(\d+)\s*$/

/** 拆成前缀 + 编号；没有编号返回 null */
export function splitValue(v: string): { prefix: string; num: number; width: number } | null {
  const m = SPLIT.exec(v.trim())
  if (!m) return null
  return { prefix: m[1]!, num: Number(m[2]), width: m[2]!.length }
}

/** 归类键：前缀 + 编号位数（显示成 Design ##）；没有编号的值本身就是一类 */
export function patternOf(v: string): string {
  const s = splitValue(v)
  return s ? s.prefix + '#'.repeat(s.width) : v.trim()
}

const share = (vals: string[]) => (vals.length ? vals.filter((v) => splitValue(v)).length / vals.length : 0)

/**
 * 有多个变体属性时（如尺寸 + 颜色），选「带编号的值」占比最高的那个；一样高取变体主题里靠前的。
 */
export function chooseAttribute(themeAttrs: string[], valuesByAttr: Record<string, string[]>): string {
  const attrs = themeAttrs.length ? themeAttrs : Object.keys(valuesByAttr)
  let best = attrs[0] ?? ''
  for (const a of attrs) if (share(valuesByAttr[a] ?? []) > share(valuesByAttr[best] ?? [])) best = a
  return best
}

export function analyzeNaming(themeAttrs: string[], children: Record<string, string>[]): NamingAnalysis {
  const valuesByAttr: Record<string, string[]> = {}
  for (const c of children) for (const [k, v] of Object.entries(c)) if (v?.trim()) (valuesByAttr[k] ??= []).push(v.trim())
  const attribute = chooseAttribute(themeAttrs, valuesByAttr)
  const existing = valuesByAttr[attribute] ?? []
  const map = new Map<string, { count: number; max: number; prefix: string; width: number; numbered: boolean; first: number }>()
  existing.forEach((v, i) => {
    const s = splitValue(v)
    const key = patternOf(v)
    const g = map.get(key) ?? { count: 0, max: -1, prefix: s?.prefix ?? v, width: s?.width ?? 0, numbered: !!s, first: i }
    g.count++
    if (s) g.max = Math.max(g.max, s.num)
    map.set(key, g)
  })
  const entries = [...map.entries()]
  // 数量最多的那一类；一样多时取最大编号更大的
  entries.sort((a, b) => b[1].count - a[1].count || b[1].max - a[1].max || a[1].first - b[1].first)
  const groups = entries.map(([pattern, g]) => ({ pattern, count: g.count }))
  const t = entries[0]
  return {
    attribute,
    existing,
    groups,
    top: t ? { key: t[0], prefix: t[1].prefix, width: t[1].width, numbered: t[1].numbered, max: t[1].max } : null,
  }
}

/**
 * 下一个变体名。taken：队列里其他任务已经分到的同父体、同命名方式的号。
 * 同一前缀不同位数的值（Design 9、Design 10）也算进最大编号，再跳过已经存在的名字，保证不撞号。
 */
export function nextName(a: NamingAnalysis, taken: number[] = [], seed: NamingSeed = DEFAULT_SEED, seedFrom: string | null = null): Naming {
  const base = { attribute: a.attribute, existing: a.existing, groups: a.groups }
  if (!a.top) {
    const n = Math.max(1, ...taken.map((x) => x + 1))
    return {
      ...base,
      next: seedName(seed, n),
      note: `这个父体还没有子体，按 ${seedName(seed)} 起${seedFrom ? `（参照${seedFrom}）` : '（同品类没有可参照的父体）'}`,
      key: seedKey(seed),
      number: n,
    }
  }
  if (!a.top.numbered) {
    return { ...base, next: null, note: `这个父体的命名没有编号，请手动起名（现有：${a.existing.join('、')}）`, key: null, number: null }
  }
  const { prefix, width } = a.top
  const lower = (s: string) => s.trim().toLowerCase()
  const used = new Set(a.existing.map(lower))
  let max = Math.max(a.top.max, ...taken)
  for (const v of a.existing) {
    const s = splitValue(v)
    if (s && lower(s.prefix) === lower(prefix)) max = Math.max(max, s.num)
  }
  let n = max + 1
  const name = (k: number) => prefix + String(k).padStart(width, '0')
  while (used.has(lower(name(n)))) n++
  return { ...base, next: name(n), note: null, key: a.top.key, number: n }
}
