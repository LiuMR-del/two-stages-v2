import fs from 'node:fs'
import path from 'node:path'
import type { Job } from '../store/jobs'
import { writeFileAtomic } from '../store/atomic'
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

/** 一批图一个文件夹，直接放在保存位置下，如 下载/主图生成-2026-10-27-1530 */
export function batchDir(outputDir: string, folder: string): string {
  return path.join(outputDir, folder)
}

const recentFolders = new Set<string>()

/** 新批次的文件夹名：日期加开始时间；同一分钟里已经有了（磁盘上或本次运行刚分出去的）就加 -2、-3 */
export function newBatchFolder(outputDir: string, now = new Date()): string {
  const hm = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
  const base = `主图生成-${localDay(now)}-${hm}`
  for (let n = 1; ; n++) {
    const cand = n === 1 ? base : `${base}-${n}`
    if (recentFolders.has(cand) || fs.existsSync(path.join(outputDir, cand))) continue
    recentFolders.add(cand)
    return cand
  }
}

/**
 * 新加的图归到哪一批：队列里还有没完成的今天的图（含需处理），就跟它们同一批；
 * 否则（队列清空了，或者之前的都跑完了）开一个新文件夹。
 */
export function folderForNewJobs(jobs: Job[], outputDir: string, isFinished: (j: Job) => boolean, now = new Date()): string {
  const open = jobs.filter((j) => !isFinished(j) && j.outputDay === localDay(now) && j.outputFolder).at(-1)
  return open ? open.outputFolder : newBatchFolder(outputDir, now)
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
