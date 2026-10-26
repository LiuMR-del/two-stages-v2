import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { writeFileAtomicSync } from './atomic'
import { log } from '../util/log'

export const STEP_COUNT = 5
export const STEP_NAMES = ['识别品类', '提取素材', '生成主图', '信息识别', '空白图'] as const

const StepStateSchema = z.enum(['pending', 'running', 'done', 'skipped', 'failed'])
export type StepState = z.infer<typeof StepStateSchema>

const SnapshotSchema = z.object({
  images: z.array(z.object({ no: z.number(), role: z.string(), sha256: z.string() })),
  prefix: z.string(),
  prompt: z.string(),
  model: z.string(),
  size: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
})
export type StepSnapshot = z.infer<typeof SnapshotSchema>

const StepRecordSchema = z.object({
  state: StepStateSchema,
  attempts: z.number().int().min(0),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  error: z.string().optional(),
  snapshot: SnapshotSchema.optional(),
  output: z.string().optional(),
})
export type StepRecord = z.infer<typeof StepRecordSchema>

const PlanMainSchema = z.object({
  templateId: z.string(),
  templateName: z.string(),
  prompt: z.string(),
  image: z.object({ role: z.enum(['白底图', '参考图']), hash: z.string() }).nullable(),
})

export const JobSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  order: z.number(),
  source: z.object({ file: z.string(), originalName: z.string(), width: z.number(), height: z.number(), sha256: z.string() }),
  outputDay: z.string(),
  outputBase: z.string(),
  route: z
    .object({
      categoryId: z.string(),
      styleId: z.string(),
      categoryName: z.string(),
      styleName: z.string(),
      ratio: z.string(),
      confidence: z.number().nullable(),
      reason: z.string().nullable(),
      manual: z.boolean(),
    })
    .nullable(),
  plan: z.object({ extractPrompt: z.string(), main: PlanMainSchema }).nullable(),
  steps: z.array(StepRecordSchema).length(STEP_COUNT),
  info: z
    .object({
      scene: z.string(),
      keywords: z.array(z.string()),
      customizable: z.array(z.string()),
      blankItems: z.array(z.string()),
      blankItemsEn: z.array(z.string()),
    })
    .nullable(),
  attention: z
    .object({
      kind: z.enum(['nomatch', 'nowhite', 'failed', 'refused']),
      step: z.number().int().min(0).max(4),
      message: z.string(),
      guess: z.string().optional(),
      at: z.string(),
    })
    .nullable(),
  override: z.object({ step: z.number().int(), prompt: z.string() }).nullable(),
})
export type Job = z.infer<typeof JobSchema>
export type Route = NonNullable<Job['route']>
export type Plan = NonNullable<Job['plan']>
export type Attention = NonNullable<Job['attention']>

// ---- 状态流转白名单：只有这里能改 steps[i].state ----

const ALLOWED: Record<StepState, readonly StepState[]> = {
  pending: ['running'],
  running: ['done', 'skipped', 'failed', 'pending'],
  done: ['pending'],
  skipped: ['pending'],
  failed: ['pending'],
}

export class TransitionError extends Error {}

export function transition(job: Job, i: number, to: StepState): void {
  const step = job.steps[i]
  if (!step) throw new TransitionError(`步骤编号不对：${i}`)
  const from = step.state
  if (!ALLOWED[from].includes(to)) {
    throw new TransitionError(`不允许的状态变化：第 ${i + 1} 步 ${from} → ${to}`)
  }
  if (to === 'running' && job.steps.some((s, k) => k !== i && s.state === 'running')) {
    throw new TransitionError('同一张图同一时刻只能有一个步骤在运行')
  }
  step.state = to
  const now = new Date().toISOString()
  if (to === 'running') {
    step.startedAt = now
    delete step.endedAt
  } else if (to === 'pending') {
    delete step.endedAt
  } else {
    step.endedAt = now
  }
}

/** 用合法的流转把某一步直接标为完成（手动指定品类等场景） */
export function markDone(job: Job, i: number): void {
  const s = job.steps[i]!.state
  if (s === 'done') return
  if (s !== 'pending') transition(job, i, 'pending')
  transition(job, i, 'running')
  transition(job, i, 'done')
}

/** 不需要执行的步骤：pending → running → skipped，不占并发位置 */
export function markSkipped(job: Job, i: number): void {
  const s = job.steps[i]!.state
  if (s === 'skipped') return
  if (s !== 'pending') transition(job, i, 'pending')
  transition(job, i, 'running')
  transition(job, i, 'skipped')
}

/** 第 n 步及之后全部回到 pending 并清空产出；调用前必须先中止正在运行的步骤 */
export function resetFrom(job: Job, n: number): void {
  if (job.steps.some((s, i) => i >= n && s.state === 'running')) throw new TransitionError('有步骤正在运行，要先中止才能重置')
  for (let i = n; i < STEP_COUNT; i++) {
    const s = job.steps[i]!
    if (s.state !== 'pending') transition(job, i, 'pending')
    s.attempts = 0
    delete s.output
    delete s.snapshot
    delete s.error
    delete s.startedAt
    delete s.endedAt
  }
}

export function newSteps(): StepRecord[] {
  return Array.from({ length: STEP_COUNT }, () => ({ state: 'pending' as const, attempts: 0 }))
}

/** 第一个没有完成的步骤；全部完成返回 -1 */
export function currentStep(job: Job): number {
  return job.steps.findIndex((s) => s.state !== 'done' && s.state !== 'skipped')
}

export function isFinished(job: Job): boolean {
  return !job.attention && currentStep(job) === -1
}

export function runningStep(job: Job): number {
  return job.steps.findIndex((s) => s.state === 'running')
}

// ---- 展示状态只在后端算一份 ----

export type JobView = { phase: 'queued' | 'running' | 'attention' | 'done'; runningStep: number | null; label: string }

export function viewOf(job: Job): JobView {
  const r = runningStep(job)
  if (job.attention) return { phase: 'attention', runningStep: r >= 0 ? r : null, label: '需处理' }
  if (r >= 0) return { phase: 'running', runningStep: r, label: r === 4 ? '生成空白图中' : `${STEP_NAMES[r]}中` }
  if (currentStep(job) === -1) return { phase: 'done', runningStep: null, label: '完成' }
  return { phase: 'queued', runningStep: null, label: '排队中' }
}

export const withView = (job: Job) => ({ ...job, view: viewOf(job) })

// ---- 存储 ----

export class JobStore {
  private jobs = new Map<string, Job>()

  constructor(
    private dir: string,
    private onChange: (job: Job) => void = () => {},
  ) {
    fs.mkdirSync(dir, { recursive: true })
  }

  dirOf(id: string): string {
    return path.join(this.dir, id)
  }

  fileOf(id: string, name: string): string {
    return path.join(this.dir, id, name)
  }

  loadAll(): number {
    for (const ent of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const file = path.join(this.dir, ent.name, 'job.json')
      if (!fs.existsSync(file)) continue
      try {
        const r = JobSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')))
        if (!r.success) {
          log.warn(`任务记录 ${ent.name} 格式不对，已跳过`)
          continue
        }
        this.jobs.set(r.data.id, r.data)
      } catch (e) {
        log.warn(`任务记录 ${ent.name} 读取失败，已跳过：${(e as Error).message}`)
      }
    }
    return this.jobs.size
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1))
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id)
  }

  maxOrder(): number {
    let m = 0
    for (const j of this.jobs.values()) m = Math.max(m, j.order)
    return m
  }

  async create(job: Job): Promise<void> {
    this.jobs.set(job.id, job)
    this.persist(job)
    this.onChange(job)
  }

  /** 改内存并立即落盘：接口和事件里看到的状态，就是磁盘上的状态 */
  update(id: string, fn: (job: Job) => void): Job {
    const job = this.jobs.get(id)
    if (!job) throw new Error(`任务不存在：${id}`)
    fn(job)
    this.persist(job)
    this.onChange(job)
    return job
  }

  moveToEnd(job: Job): void {
    job.order = this.maxOrder() + 1
  }

  private persist(job: Job): void {
    try {
      writeFileAtomicSync(path.join(this.dir, job.id, 'job.json'), JSON.stringify(job, null, 2))
    } catch (e) {
      log.error(`保存任务 ${job.id} 失败：${(e as Error).message}`)
    }
  }

  async flush(): Promise<void> {}

  async remove(id: string): Promise<void> {
    this.jobs.delete(id)
    await fsp.rm(path.join(this.dir, id), { recursive: true, force: true })
  }
}
