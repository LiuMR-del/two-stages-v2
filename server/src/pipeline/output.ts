import fs from 'node:fs'
import path from 'node:path'
import type { Job } from '../store/jobs'
import { writeFileAtomic } from '../store/atomic'

export type OutputKind = 'pattern' | 'main' | 'blank'
export const OUTPUT_SUFFIX: Record<OutputKind, string> = { pattern: '_素材.png', main: '_主图.png', blank: '_空白.png' }

export function safeName(s: string): string {
  const t = s.replace(/[\\/:*?"<>|]/g, '_').replace(/[\x00-\x1f]/g, '').trim().replace(/[. ]+$/, '')
  return t || '未命名'
}

export function baseNameOf(originalName: string): string {
  const ext = path.extname(originalName)
  return safeName(ext ? originalName.slice(0, -ext.length) : originalName)
}

export function categoryDir(outputDir: string, job: Job): string {
  return path.join(outputDir, job.outputDay, safeName(job.route?.categoryName ?? '未分类'))
}

/**
 * 同一天、同一品类目录下，已有同名的素材图/主图文件，或者别的任务已经占了这个名字，就依次加 _2、_3。
 */
export function assignOutputBase(job: Job, others: Job[], outputDir: string, categoryName: string): string {
  const dir = path.join(outputDir, job.outputDay, safeName(categoryName))
  const base = baseNameOf(job.source.originalName)
  const taken = new Set(
    others
      .filter((o) => o.id !== job.id && o.outputDay === job.outputDay && o.route && safeName(o.route.categoryName) === safeName(categoryName))
      .map((o) => o.outputBase),
  )
  for (let n = 1; ; n++) {
    const cand = n === 1 ? base : `${base}_${n}`
    if (taken.has(cand)) continue
    if (fs.existsSync(path.join(dir, cand + OUTPUT_SUFFIX.pattern)) || fs.existsSync(path.join(dir, cand + OUTPUT_SUFFIX.main))) continue
    return cand
  }
}

export async function writeOutput(outputDir: string, job: Job, kind: OutputKind, buf: Buffer): Promise<string> {
  const dir = categoryDir(outputDir, job)
  const file = path.join(dir, job.outputBase + OUTPUT_SUFFIX[kind])
  await writeFileAtomic(file, buf)
  return file
}
