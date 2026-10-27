import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '../api'
import type { Job, QueueState } from '../types'
import type { ViewerItem } from './ui'

export const STEP_NAMES = ['识别品类', '提取素材', '生成主图', '信息识别', '空白图'] as const
export type FileKind = 'source' | 'pattern' | 'main' | 'blank'
const STEP_OF_KIND: Record<FileKind, number> = { source: -1, pattern: 1, main: 2, blank: 4 }
const VIEW_KINDS: { kind: FileKind; label: string; step: number }[] = [
  { kind: 'source', label: '竞品图', step: 0 },
  { kind: 'pattern', label: '素材图', step: 1 },
  { kind: 'main', label: '主图', step: 2 },
  { kind: 'blank', label: '空白图', step: 4 },
]

const UPLOAD_BATCH = 20

export const useJobs = defineStore('jobs', () => {
  const byId = ref<Record<string, Job>>({})
  const queue = ref<QueueState | null>(null)
  const uploading = ref<null | { done: number; total: number; ratio: number }>(null)

  const all = computed(() => Object.values(byId.value).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1)))
  const queued = computed(() => all.value.filter((j) => !j.attention))
  const attention = computed(() => all.value.filter((j) => j.attention))
  const finished = computed(() => all.value.filter((j) => j.view.phase === 'done'))
  const withInfo = computed(() => all.value.filter((j) => j.info && j.steps[3]!.state === 'done'))
  const runningCount = computed(() => all.value.filter((j) => j.view.phase === 'running').length)

  async function load() {
    const r = await api.get<{ jobs: Job[]; queue: QueueState }>('/jobs')
    byId.value = Object.fromEntries(r.jobs.map((j) => [j.id, j]))
    queue.value = r.queue
  }

  function onEvent(name: string, data: any) {
    if (name === 'job') byId.value = { ...byId.value, [data.job.id]: data.job }
    else if (name === 'job-removed') {
      const next = { ...byId.value }
      delete next[data.id]
      byId.value = next
    } else if (name === 'queue') queue.value = data
  }

  /** 缩略图地址带上这一步结束的时间，重做后自动换新图 */
  function fileUrl(job: Job, kind: FileKind, thumb = true) {
    const step = STEP_OF_KIND[kind]
    const v = step >= 0 ? job.steps[step]!.endedAt ?? '' : job.createdAt
    return `/api/jobs/${job.id}/files/${kind}?${thumb ? 'size=thumb&' : ''}v=${encodeURIComponent(v)}`
  }

  /** 这张图已有的原图，按 竞品图 → 素材图 → 主图 → 空白图 排，给看大图用 */
  function viewItems(job: Job): (ViewerItem & { kind: FileKind })[] {
    return VIEW_KINDS.filter((k) => k.kind === 'source' || job.steps[STEP_OF_KIND[k.kind]]!.state === 'done').map((k) => ({
      kind: k.kind,
      label: k.label,
      step: k.step,
      src: fileUrl(job, k.kind, false),
    }))
  }

  async function upload(files: File[]): Promise<{ added: number; errors: { name: string; error: string }[] }> {
    const errors: { name: string; error: string }[] = []
    let added = 0
    uploading.value = { done: 0, total: files.length, ratio: 0 }
    try {
      for (let i = 0; i < files.length; i += UPLOAD_BATCH) {
        const batch = files.slice(i, i + UPLOAD_BATCH)
        const r = await api.upload<{ jobs: Job[]; errors: { name: string; error: string }[] }>('POST', '/jobs', 'files', batch, (ratio) => {
          uploading.value = { done: i, total: files.length, ratio: (i + ratio * batch.length) / files.length }
        })
        added += r.jobs.length
        errors.push(...r.errors)
      }
    } finally {
      uploading.value = null
    }
    return { added, errors }
  }

  const post = (p: string, b: unknown = {}) => api.post(p, b)
  return {
    byId,
    queue,
    uploading,
    all,
    queued,
    attention,
    finished,
    withInfo,
    runningCount,
    load,
    onEvent,
    fileUrl,
    viewItems,
    upload,
    /** 读系统剪贴板里复制的文件；supported 为 false 表示这台电脑不支持，copied 是复制的文件数（不一定是图片） */
    fromClipboard: () =>
      api.post<{ supported: boolean; copied: number; jobs: Job[]; errors: { name: string; error: string }[] }>('/jobs/from-clipboard'),
    remove: (id: string) => api.del(`/jobs/${id}`),
    redo: (id: string, body: { step: number; prompt?: string; categoryId?: string; styleId?: string }) => post(`/jobs/${id}/redo`, body),
    resolve: (id: string, categoryId: string, styleId: string) => post(`/jobs/${id}/resolve`, { categoryId, styleId }),
    createCategory: (id: string) => post(`/jobs/${id}/create-category`),
    retry: (id: string) => post(`/jobs/${id}/retry`),
    /** 素材图没过验收，仍然使用 */
    acceptQc: (id: string) => post(`/jobs/${id}/qc-accept`),
    clearDone: () => post('/jobs/clear-done'),
    clearAll: () => post('/jobs/clear-all'),
    pause: () => post('/queue/pause'),
    resume: () => post('/queue/resume'),
    openFolder: (jobId?: string) => post('/open-output', jobId ? { jobId } : {}),
  }
})
