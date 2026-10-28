import fs from 'node:fs'
import path from 'node:path'
import type { Job } from '../store/jobs'
import { readJsonSync, writeFileAtomicSync } from '../store/atomic'
import { log } from '../util/log'

/**
 * 每批分出去的变体号（2026-10-28 用户确认）：只要还在同一批文件夹里（识别信息 CSV 里有这一行），号就一直占着，
 * 图从队列里移走（删除、清除已完成）也不释放；只有这张图重新匹配、换了父体时才换成新的号。
 * 点「清空队列」开新文件夹后，新批次只看店铺里的实际子体和新队列。
 */
export type Reservation = { jobId: string; sku: string; key: string; number: number }

export class Reservations {
  private cache = new Map<string, Reservation[]>()

  /** dir 不给时只记在内存里（单元测试） */
  constructor(private dir?: string) {}

  private file(folder: string): string | null {
    return this.dir ? path.join(this.dir, `${folder}.parents.json`) : null
  }

  list(folder: string): Reservation[] {
    let v = this.cache.get(folder)
    if (!v) {
      const f = this.file(folder)
      v = (f ? readJsonSync<Reservation[]>(f) : null) ?? []
      this.cache.set(folder, v)
    }
    return v
  }

  private save(folder: string, v: Reservation[]): void {
    this.cache.set(folder, v)
    const f = this.file(folder)
    if (!f) return
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true })
      writeFileAtomicSync(f, JSON.stringify(v))
    } catch (e) {
      log.warn(`保存占号记录失败：${(e as Error).message}`)
    }
  }

  /** 任务每次变化时调用：有分到的号就记下（覆盖这张图原来的号），没有就删掉这张图的记录 */
  sync(job: Job): void {
    const folder = job.outputFolder
    if (!folder) return
    const cur = this.list(folder)
    const n = job.parent?.naming
    const want: Reservation | null = job.parent?.sku && n?.key && n.number !== null ? { jobId: job.id, sku: job.parent.sku, key: n.key, number: n.number } : null
    const old = cur.find((r) => r.jobId === job.id)
    if (!want && !old) return
    if (want && old && old.sku === want.sku && old.key === want.key && old.number === want.number) return
    this.save(folder, [...cur.filter((r) => r.jobId !== job.id), ...(want ? [want] : [])])
  }
}
