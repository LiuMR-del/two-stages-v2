import path from 'node:path'
import type { Job } from '../store/jobs'
import { writeFileAtomic } from '../store/atomic'
import { OUTPUT_SUFFIX, safeName } from './output'

const HEADER = ['原文件名', '品类', '款式', '场景', '关键词', '可定制项', '主图文件']

function cell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

export function csvForDay(jobs: Job[], day: string): string {
  const rows = jobs
    .filter((j) => j.outputDay === day && j.steps[3]!.state === 'done' && j.info && j.route)
    .map((j) => [
      j.source.originalName,
      j.route!.categoryName,
      j.route!.styleName,
      j.info!.scene,
      j.info!.keywords.join('; '),
      j.info!.customizable.join('、'),
      path.join(safeName(j.route!.categoryName), j.outputBase + OUTPUT_SUFFIX.main),
    ])
  return '\uFEFF' + [HEADER, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}

export const CSV_NAME = '识别信息.csv'

export async function writeDayCsv(outputDir: string, jobs: Job[], day: string): Promise<void> {
  await writeFileAtomic(path.join(outputDir, day, CSV_NAME), csvForDay(jobs, day))
}
