import path from 'node:path'
import type { Job } from '../store/jobs'
import { writeFileAtomic } from '../store/atomic'
import { batchDir, outputRel, safeName } from './output'

const HEADER = ['原文件名', '品类', '款式', '场景', '关键词', '可定制项', '主图文件']

function cell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

function csvOf(jobs: Job[]): string {
  const rows = jobs
    .filter((j) => j.steps[3]!.state === 'done' && j.info && j.route)
    .map((j) => [
      j.source.originalName,
      j.route!.categoryName,
      j.route!.styleName,
      j.info!.scene,
      j.info!.keywords.join('; '),
      j.info!.customizable.join('、'),
      path.join(safeName(j.route!.categoryName), outputRel('main', j.outputBase)),
    ])
  return '\uFEFF' + [HEADER, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}

/** 界面上按天导出 */
export const csvForDay = (jobs: Job[], day: string) => csvOf(jobs.filter((j) => j.outputDay === day))

export const CSV_NAME = '识别信息.csv'

/** 每批文件夹里放一份，只含这一批的图；主图文件路径相对这个文件夹 */
export async function writeBatchCsv(outputDir: string, jobs: Job[], folder: string): Promise<void> {
  await writeFileAtomic(path.join(batchDir(outputDir, folder), CSV_NAME), csvOf(jobs.filter((j) => j.outputFolder === folder)))
}
