import { readJsonSync, writeFileAtomicSync } from '../store/atomic'
import { localDay } from '../util/ids'
import { log } from '../util/log'

/** 子体 SKU 的固定部分；code 是品类的材质缩写，mark 是专属号（设置里 parent.creatorMark） */
export type SkuParts = { store: string; code: string; region: string; mark: string }

/**
 * 用户给的规则（2026-10-29）：HJ-mtfl671029101 = 店铺缩写 HJ - 材质缩写 mtfl + 年份末位 6 + 地区标识 7 + 月日 1029 + 专属号 1 + 当天序号 01。
 * 序号超过 99 就自然变成三位。
 */
export function formatSku(p: SkuParts, day: string, n: number): string {
  return skuPrefix(p, day) + String(n).padStart(2, '0')
}

function skuPrefix(p: SkuParts, day: string): string {
  const [y, m, d] = day.split('-')
  return `${p.store}-${p.code}${y!.slice(-1)}${p.region}${m}${d}${p.mark}`
}

/** day → 序号前面那一截（店铺、材质、日期、专属号都在里面）→ 已经发到第几号 */
type Counts = Record<string, Record<string, number>>

/**
 * 当天序号按「品类（材质缩写）」各自从 01 起，换一天重新从 01 起（用户确认）。
 * 发出去的号不收回：图删了、清空队列、换批次都接着往后排，和变体占号一样。
 * 记在 data/sku.json，只留当天的；file 为 null 时只记在内存里（测试用）。
 */
export class SkuCounter {
  private mem: Counts = {}

  constructor(private file: string | null) {}

  private read(): Counts {
    return this.file ? (readJsonSync<Counts>(this.file) ?? {}) : this.mem
  }

  /** taken：别的任务已经用了、或者输出文件夹里已经有这个名字的文件，就跳过 */
  allocate(p: SkuParts, taken: (sku: string) => boolean, now = new Date()): string {
    const day = localDay(now)
    const all = this.read()
    const key = skuPrefix(p, day)
    let n = (all[day]?.[key] ?? 0) + 1
    while (taken(formatSku(p, day, n))) n++
    const next: Counts = { [day]: { ...(all[day] ?? {}), [key]: n } }
    if (this.file) {
      try {
        writeFileAtomicSync(this.file, JSON.stringify(next))
      } catch (e) {
        log.warn(`保存 SKU 序号失败：${(e as Error).message}`)
      }
    } else this.mem = next
    return formatSku(p, day, n)
  }
}
