/**
 * 从店铺里已有的 SKU 拆出材质编码、父体主题（多店铺方案第四、六节，2026-11-04）。
 * 规则按飞书「亚马逊sku目录」和两个店铺的实际 SKU 定：
 *   子体 ART-mtfl671103401 / ART-cn-yklgj-Farm-671031701；父体 ART-cn-yklgj-cookie / HJ-cn-yklgj5-Christmas Dumpling（带专属号）
 *   日期码父体 ART-cn-yklgj6709107000-P / mtfl760820700-P（看不出主题）
 * 材质编码是小写字母，`cn-` 表示中国发货。编码前面可能带 HB / SB 标记（HJ-HBxkfb671030404、HJ-SBlbh…、ART-HB-xkfb671014701，
 * HB = 横版、SB = 竖版，2026-11-04 用户确认），算进编码里原样保留；其他大写开头的段（HJ-、YMY-、随机的 Z9-PX7O-E911）不当编码。
 */

/** 只认见过的 HB / SB 标记，别的两字母大写（HJ-、NC- 这种店铺缩写或随机 SKU）不当标记 */
const CODE_RE = /^((?:cn-)?(?:[HS]B-?)?[a-z]+)(?=[0-9\s-]|$)/

function stripStore(sku: string, abbr: string): { rest: string; hadStore: boolean } {
  const s = sku.trim()
  const head = `${abbr}-`.toLowerCase()
  // 店里有 HJ- HBfbxk671023301 这种横杠后多一个空格的，去掉
  return s.toLowerCase().startsWith(head) && abbr ? { rest: s.slice(head.length).trimStart(), hadStore: true } : { rest: s, hadStore: false }
}

/** SKU 里的材质编码；拆不出来返回 null。店铺缩写不分大小写，没有店铺缩写的旧 SKU 也拆（mtfl760820700-P → mtfl） */
export function materialCode(sku: string, abbr: string): string | null {
  const { rest } = stripStore(sku, abbr)
  const code = CODE_RE.exec(rest)?.[1]
  if (!code || /(^|-)cn$/.test(code)) return null
  return code
}

export type ThemeParent = {
  /** 店铺缩写-材质编码，不带专属号（父体不加专属号，2026-11-04 用户确认）：HJ-cn-yklgj5-… → HJ-cn-yklgj */
  prefix: string
  /** 材质编码 */
  code: string
  /** SKU 里写的主题原样：Christmas Dumpling、old love */
  theme: string
}

/**
 * 主题式父体（店铺缩写-材质编码[专属号]-主题）拆成前缀和主题；日期码父体、没有店铺缩写的旧 SKU 返回 null。
 * 主题要有字母、不能以数字开头、不能是单个字母（-P、-F、-H 是日期码父体的尾巴）。
 */
export function themeParent(sku: string, abbr: string): ThemeParent | null {
  const { rest, hadStore } = stripStore(sku, abbr)
  if (!hadStore) return null
  // 编码后面可以跟专属号（HJ-cn-yklgj5-…）或者一段数字（HJ-xkfb-2607-Wrestling、HJ-cn-dd-2-Halloween Doormat）
  const m = /^((?:cn-)?(?:[HS]B-?)?[a-z]+)\d*(?:-\d+)?-(.+)$/.exec(rest)
  if (!m || m[1] === 'cn') return null
  const theme = m[2]!.trim()
  // 日期码父体的尾巴：-P、-F、-H，也可能是 -P2、-PH
  if (!/[A-Za-z]/.test(theme) || /^\d/.test(theme) || /^[A-Z]{1,2}\d?$/i.test(theme)) return null
  return { prefix: `${sku.trim().slice(0, abbr.length)}-${m[1]}`, code: m[1]!, theme }
}

/**
 * 一组 SKU 里出现最多的材质编码；一样多时取排在后面（较新）的那个。都拆不出来返回 null。
 * skus 按创建时间从旧到新排。
 */
export function majorityCode(skus: string[], abbr: string): string | null {
  const stat = new Map<string, { count: number; last: number }>()
  skus.forEach((s, i) => {
    const c = materialCode(s, abbr)
    if (!c) return
    const g = stat.get(c) ?? { count: 0, last: -1 }
    g.count++
    g.last = i
    stat.set(c, g)
  })
  let best: [string, { count: number; last: number }] | null = null
  for (const e of stat) if (!best || e[1].count > best[1].count || (e[1].count === best[1].count && e[1].last > best[1].last)) best = e
  return best?.[0] ?? null
}
