import { readJsonSync, writeFileAtomicSync } from '../store/atomic'
import { localDay } from '../util/ids'
import { log } from '../util/log'

/** 子体 SKU 的固定部分；store 是店铺缩写，code 是（款式标记 +）材质缩写，region 是组别，mark 是这一批的专属号 */
export type SkuParts = { store: string; code: string; region: string; mark: string }
/** 发出去的 SKU 和它的三截：专属号前面、专属号、序号（「改专属号」只换中间那截） */
export type IssuedSku = { sku: string; head: string; mark: string; seq: string }

/**
 * 款式标记（横版 HB、竖版 SB）放在材质缩写前面；材质缩写带 cn- 时放在 cn- 后面：xkfb → HBxkfb，cn-xkfb → cn-HBxkfb
 */
export function withStyleMark(code: string, mark: string | null | undefined): string {
  const m = mark?.trim()
  if (!m) return code
  return code.startsWith('cn-') ? `cn-${m}${code.slice(3)}` : `${m}${code}`
}

/**
 * 用户给的规则（2026-10-29）：HJ-mtfl671029101 = 店铺缩写 HJ - 材质缩写 mtfl + 年份末位 6 + 地区标识 7 + 月日 1029 + 专属号 1 + 当天序号 01。
 * 序号超过 99 就自然变成三位。
 */
export function formatSku(p: SkuParts, day: string, n: number): string {
  return skuPrefix(p, day) + String(n).padStart(2, '0')
}

function skuHead(p: SkuParts, day: string): string {
  const [y, m, d] = day.split('-')
  return `${p.store}-${p.code}${y!.slice(-1)}${p.region}${m}${d}`
}

function skuPrefix(p: SkuParts, day: string): string {
  return skuHead(p, day) + p.mark
}

/** day → 序号前面那一截（店铺、材质、日期、专属号都在里面）→ 已经发到第几号 */
type Counts = Record<string, Record<string, number>>
/** 「改专属号」改出来的 SKU（不是按序号发的，计数器里看不出来）：day → SKU 列表 */
type Extra = Record<string, string[]>
type FileShape = { counts: Counts; extra: Extra }

/** 留几天的记录：SKU 里带月日，只有同一天发的才可能重名；跨天没清空的批次也能改专属号，所以多留几天 */
const KEEP_DAYS = 7

/**
 * 当天序号按「品类（材质缩写）」各自从 01 起，换一天重新从 01 起（用户确认）。
 * 发出去的号不收回：图删了、清空队列、换批次都接着往后排，和变体占号一样。
 * 发过的号（计数器里 1～n 的，加上改专属号改出来的）不管在哪一批，都不再发（2026-11-04 审查：两批都改成同一个专属号后会重号）。
 * 记在 data/sku.json，留最近几天；file 为 null 时只记在内存里（测试用）。
 */
export class SkuCounter {
  private mem: FileShape = { counts: {}, extra: {} }

  constructor(private file: string | null) {}

  private read(): FileShape {
    if (!this.file) return this.mem
    const raw = readJsonSync<any>(this.file)
    if (!raw || typeof raw !== 'object') return { counts: {}, extra: {} }
    // 旧格式：直接是 { day: { prefix: n } }
    if (!raw.counts) return { counts: raw as Counts, extra: {} }
    return { counts: raw.counts ?? {}, extra: raw.extra ?? {} }
  }

  private write(v: FileShape, today: string): void {
    const days = [...new Set([...Object.keys(v.counts), ...Object.keys(v.extra)])].sort().slice(-KEEP_DAYS)
    const keep = new Set([...days, today])
    const next: FileShape = {
      counts: Object.fromEntries(Object.entries(v.counts).filter(([d]) => keep.has(d))),
      extra: Object.fromEntries(Object.entries(v.extra).filter(([d]) => keep.has(d))),
    }
    if (!this.file) {
      this.mem = next
      return
    }
    try {
      writeFileAtomicSync(this.file, JSON.stringify(next))
    } catch (e) {
      log.warn(`保存 SKU 序号失败：${(e as Error).message}`)
    }
  }

  /** 这个 SKU 发过没有（不分批次、不分大小写） */
  issued(sku: string): boolean {
    const v = this.read()
    const low = sku.toLowerCase()
    for (const list of Object.values(v.extra)) if (list.some((x) => x.toLowerCase() === low)) return true
    for (const byPrefix of Object.values(v.counts)) {
      for (const [prefix, n] of Object.entries(byPrefix)) {
        if (!low.startsWith(prefix.toLowerCase())) continue
        const rest = sku.slice(prefix.length)
        if (/^\d{2,}$/.test(rest) && Number(rest) <= n) return true
      }
    }
    return false
  }

  /** 改专属号改出来的 SKU 记下来，之后不再发 */
  record(skus: string[], now = new Date()): void {
    if (!skus.length) return
    const day = localDay(now)
    const v = this.read()
    this.write({ counts: v.counts, extra: { ...v.extra, [day]: [...new Set([...(v.extra[day] ?? []), ...skus])] } }, day)
  }

  /** taken：别的任务已经用了、或者输出文件夹里已经有这个名字的文件，就跳过 */
  allocate(p: SkuParts, taken: (sku: string) => boolean, now = new Date()): string {
    return this.issue(p, taken, now).sku
  }

  issue(p: SkuParts, taken: (sku: string) => boolean, now = new Date()): IssuedSku {
    const day = localDay(now)
    const v = this.read()
    const key = skuPrefix(p, day)
    let n = (v.counts[day]?.[key] ?? 0) + 1
    while (taken(formatSku(p, day, n)) || this.issued(formatSku(p, day, n))) n++
    this.write({ counts: { ...v.counts, [day]: { ...(v.counts[day] ?? {}), [key]: n } }, extra: v.extra }, day)
    return { sku: formatSku(p, day, n), head: skuHead(p, day), mark: p.mark, seq: String(n).padStart(2, '0') }
  }
}
