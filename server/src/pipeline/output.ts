import fs from 'node:fs'
import path from 'node:path'
import type { Job } from '../store/jobs'
import { readJsonSync, writeFileAtomic, writeFileAtomicSync } from '../store/atomic'
import { log } from '../util/log'
import { localDay } from '../util/ids'

export type OutputKind = 'pattern' | 'main' | 'blank'
/** 每种图一个子文件夹，里面的文件名就是原图名 */
export const OUTPUT_FOLDER: Record<OutputKind, string> = { main: '主图', pattern: '素材图', blank: '空白图' }

export function safeName(s: string): string {
  const t = s.replace(/[\\/:*?"<>|]/g, '_').replace(/[\x00-\x1f]/g, '').trim().replace(/[. ]+$/, '')
  return t || '未命名'
}

export function baseNameOf(originalName: string): string {
  const ext = path.extname(originalName)
  return safeName(ext ? originalName.slice(0, -ext.length) : originalName)
}

/** 一批图一个文件夹，直接放在保存位置下，如 下载/主图生成-2026-10-27-1 */
export function batchDir(outputDir: string, folder: string): string {
  return path.join(outputDir, folder)
}

/** 第 n 批：0 → 主图生成-2026-10-27，1 → 主图生成-2026-10-27-1 */
export function batchFolderName(day: string, n: number): string {
  return n === 0 ? `主图生成-${day}` : `主图生成-${day}-${n}`
}

/** 旧版「日期-时分」（如 -1530）不是批次序号，按没有记录处理 */
const MAX_BATCH_INDEX = 999

function batchIndex(day: string, folder: string): number | null {
  if (folder === batchFolderName(day, 0)) return 0
  const m = new RegExp(`^主图生成-${day}-(\\d+)$`).exec(folder)
  return m && Number(m[1]) <= MAX_BATCH_INDEX ? Number(m[1]) : null
}

/** after 之后的下一个名字；磁盘上已经有的跳过 */
export function nextBatchFolder(outputDir: string, day: string, after: string | null): string {
  const i = after === null ? null : batchIndex(day, after)
  for (let n = i === null ? 0 : i + 1; ; n++) {
    const cand = batchFolderName(day, n)
    if (!fs.existsSync(path.join(outputDir, cand))) return cand
  }
}

type BatchState = { day: string; folder: string; closed: boolean }

/**
 * 当前批次用哪个文件夹，存在 data/batch.json，重启后接着用。
 * 只有清空队列（close）或换了日期才开新文件夹；图跑完了但没清空，新加的图还进同一个。
 */
export class BatchFolders {
  constructor(
    private file: string,
    private outputDir: () => string,
  ) {}

  private read(): BatchState | null {
    const s = readJsonSync<Partial<BatchState>>(this.file)
    return s && typeof s.day === 'string' && typeof s.folder === 'string' ? { day: s.day, folder: s.folder, closed: s.closed === true } : null
  }

  private save(s: BatchState): void {
    try {
      writeFileAtomicSync(this.file, JSON.stringify(s))
    } catch (e) {
      log.warn(`保存当前批次文件夹失败：${(e as Error).message}`)
    }
  }

  /** 新加的图放进哪个文件夹；jobs 只在第一次用（没有记录）时参考：队列里有今天的图就接着用它们的文件夹 */
  current(jobs: Job[], now = new Date()): string {
    const day = localDay(now)
    let st = this.read()
    if (!st) {
      const last = jobs.filter((j) => j.outputDay === day && j.outputFolder).at(-1)
      if (last) {
        st = { day, folder: last.outputFolder, closed: false }
        this.save(st)
      }
    }
    if (st && st.day === day && !st.closed) return st.folder
    const folder = nextBatchFolder(this.outputDir(), day, st && st.day === day ? st.folder : null)
    this.save({ day, folder, closed: false })
    return folder
  }

  /** 清空队列：之后加的图进下一个文件夹 */
  close(): void {
    const st = this.read()
    if (st && !st.closed) this.save({ ...st, closed: true })
  }
}

export function categoryDir(outputDir: string, job: Job): string {
  return path.join(batchDir(outputDir, job.outputFolder), safeName(job.route?.categoryName ?? '未分类'))
}

/** 相对品类目录的路径，如 主图/家庭照.png */
export function outputRel(kind: OutputKind, base: string): string {
  return path.join(OUTPUT_FOLDER[kind], base + '.png')
}

/**
 * 同一批、同一品类目录下，已有同名的素材图/主图文件，或者别的任务已经占了这个名字，就依次加 _2、_3。
 */
export function assignOutputBase(job: Job, others: Job[], outputDir: string, categoryName: string): string {
  const dir = path.join(batchDir(outputDir, job.outputFolder), safeName(categoryName))
  const base = baseNameOf(job.source.originalName)
  const taken = new Set(
    others
      .filter((o) => o.id !== job.id && o.outputFolder === job.outputFolder && o.route && safeName(o.route.categoryName) === safeName(categoryName))
      .map((o) => o.outputBase),
  )
  for (let n = 1; ; n++) {
    const cand = n === 1 ? base : `${base}_${n}`
    if (taken.has(cand)) continue
    if (fs.existsSync(path.join(dir, outputRel('pattern', cand))) || fs.existsSync(path.join(dir, outputRel('main', cand)))) continue
    return cand
  }
}

export async function writeOutput(outputDir: string, job: Job, kind: OutputKind, buf: Buffer): Promise<string> {
  const file = path.join(categoryDir(outputDir, job), outputRel(kind, job.outputBase))
  await writeFileAtomic(file, buf)
  return file
}
