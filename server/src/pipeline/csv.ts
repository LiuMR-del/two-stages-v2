import path from 'node:path'
import type { Job } from '../store/jobs'
import { readJsonSync, writeFileAtomic } from '../store/atomic'
import { batchDir, outputRel, safeName } from './output'

const BASE_HEADER = ['原文件名', 'SKU', '品类', '款式', '场景', '关键词', '可定制项', '主图文件']
/** 2026-10-29 在第 2 列加了 SKU；之前存下的行没有这一列 */
const SKU_COL = 1
const ROW_VERSION = 2
const PARENT_HEADER = ['父体主题', '父体SKU', '父体ASIN', '建议变体名', '父体把握', '父体状态']
const HEADER = [...BASE_HEADER, ...PARENT_HEADER]

function cell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

const hasInfo = (j: Job) => j.steps[3]!.state === 'done' && !!j.info && !!j.route
const hasParent = (j: Job) => j.parent !== null

function parentStatus(status: NonNullable<Job['parent']>['status']): string {
  return { matched: '已匹配', unsure: '待确认', none: '没有合适的父体', new: '建议新建' }[status]
}

function rowOf(j: Job, includeParent = false): string[] {
  const row = [
    j.source.originalName,
    j.sku ?? '',
    j.route!.categoryName,
    j.route!.styleName,
    j.info!.scene,
    j.info!.keywords.join('; '),
    j.info!.customizable.join('、'),
    path.join(safeName(j.route!.categoryName), outputRel('main', j.outputBase)),
  ]
  if (!includeParent) return row
  const p = j.parent
  row.push(
    p?.theme ?? '',
    p?.sku ?? '',
    p?.asin ?? '',
    p?.naming?.next ?? '',
    p?.confidence === null || p?.confidence === undefined ? '' : p.confidence.toFixed(2),
    p ? parentStatus(p.status) : '',
  )
  return row
}

function render(rows: string[][], includeParent = false): string {
  const header = includeParent ? HEADER : BASE_HEADER
  return '\uFEFF' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}

function csvOf(jobs: Job[]): string {
  const includeParent = jobs.some(hasParent)
  return render(jobs.filter(hasInfo).map((j) => rowOf(j, includeParent)), includeParent)
}

/** 界面上按天导出 */
export const csvForDay = (jobs: Job[], day: string) => csvOf(jobs.filter((j) => j.outputDay === day))

type SavedRow = { id: string; createdAt: string; row: string[]; v?: number }

function normalizeRow(saved: SavedRow, includeParent: boolean): SavedRow {
  let row = saved.row
  if ((saved.v ?? 1) < ROW_VERSION) row = [...row.slice(0, SKU_COL), '', ...row.slice(SKU_COL)]
  if (includeParent && row.length < HEADER.length) row = [...row, ...Array(HEADER.length - row.length).fill('')]
  return { ...saved, row, v: ROW_VERSION }
}

export const CSV_NAME = '识别信息.csv'

/**
 * 每批文件夹里放一份，只含这一批的图；主图文件路径相对这个文件夹。
 * 「清除已完成」后新图还进同一个文件夹，所以已经移出队列的图的行记在 rowsFile 里，重写时保留。
 */
/** drop：用户在队列里删掉的图，它的行也从 CSV 里去掉（移出队列的图的行保留） */
export async function writeBatchCsv(outputDir: string, jobs: Job[], folder: string, rowsFile?: string, drop: string[] = []): Promise<void> {
  const inFolder = jobs.filter((j) => j.outputFolder === folder)
  const saved = new Map<string, SavedRow>()
  for (const r of (rowsFile ? readJsonSync<SavedRow[]>(rowsFile) : null) ?? []) saved.set(r.id, normalizeRow(r, false))
  for (const id of drop) saved.delete(id)
  const includeParent = inFolder.some(hasParent) || [...saved.values()].some((r) => r.row.length >= HEADER.length)
  for (const j of inFolder) {
    if (hasInfo(j)) saved.set(j.id, { id: j.id, createdAt: j.createdAt, row: rowOf(j, includeParent), v: ROW_VERSION })
    else saved.delete(j.id)
  }
  const rows = [...saved.values()]
    .map((r) => normalizeRow(r, includeParent))
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1))
  if (rowsFile) await writeFileAtomic(rowsFile, JSON.stringify(rows))
  await writeFileAtomic(path.join(batchDir(outputDir, folder), CSV_NAME), render(rows.map((r) => r.row), includeParent))
}
