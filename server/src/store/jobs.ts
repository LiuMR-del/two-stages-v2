import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { writeFileAtomicSync } from './atomic'
import { log } from '../util/log'

export const STEP_COUNT = 6
export const STEP_NAMES = ['识别品类', '提取素材', '生成主图', '信息识别', '空白图', '匹配父体'] as const
/** 第 6 步「匹配父体」的下标 */
export const PARENT_STEP = 5

const StepStateSchema = z.enum(['pending', 'running', 'done', 'skipped', 'failed'])
export type StepState = z.infer<typeof StepStateSchema>

const SnapshotSchema = z.object({
  images: z.array(z.object({ no: z.number(), role: z.string(), sha256: z.string() })),
  prefix: z.string(),
  prompt: z.string(),
  model: z.string(),
  size: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  /** local = 本地合成，没有调用 AI */
  mode: z.enum(['ai', 'local']).optional(),
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
  /** 跳过的原因等说明（如「识别父体没有打开」） */
  note: z.string().optional(),
})
export type StepRecord = z.infer<typeof StepRecordSchema>

const PlanMainSchema = z.object({
  templateId: z.string(),
  templateName: z.string(),
  prompt: z.string(),
  image: z.object({ role: z.enum(['白底图', '参考图']), hash: z.string() }).nullable(),
  canvasRatio: z.string().nullable().optional(),
  /** 默认模版的贴图方式（款式上的设置）；旧任务没有，按 AI 贴图 */
  pasteMode: z.enum(['auto', 'local', 'ai']).optional(),
})

/** 第②步里的素材图验收结果 */
const QcSchema = z.object({
  /** pending = 素材图已提取、等验收 */
  state: z.enum(['pending', 'pass', 'fail', 'bypassed']),
  at: z.string().optional(),
  threshold: z.number().optional(),
  score: z.number().nullable().default(null),
  sourceTexts: z.array(z.string()).default([]),
  patternTexts: z.array(z.string()).default([]),
  textOk: z.boolean().nullable().default(null),
  textDiffs: z.array(z.string()).default([]),
  elementIssues: z.array(z.string()).default([]),
  /** 竞品图印刷面四边有、素材图没有的（如做旧边）；素材图多出来的（如金属边） */
  edgeMissing: z.array(z.string()).default([]),
  edgeExtra: z.array(z.string()).default([]),
  /** 主图验收：印刷面没铺满、露出底材 */
  fillIssues: z.array(z.string()).default([]),
  /** 主图验收：local = 本地合成后本地核对，ai = 发了分析请求 */
  mode: z.enum(['local', 'ai']).optional(),
  layout: z.object({ ok: z.boolean(), issues: z.array(z.string()), ratioChecked: z.boolean(), note: z.string().nullable() }).nullable().default(null),
  /** 和竞品图印刷面的色差（2026-10-27 用户要求加） */
  color: z
    .object({
      checked: z.boolean(),
      deltaE: z.number().nullable(),
      gridDeltaE: z.number().nullable(),
      shift: z.object({ L: z.number(), a: z.number(), b: z.number(), C: z.number() }).nullable(),
      box: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
      issues: z.array(z.string()),
      note: z.string().nullable(),
      threshold: z.number().optional(),
    })
    .nullable()
    .default(null),
  /** 边框外延检查（单独的一次分析请求）；null = 没做（旧任务、主图验收）；error = 请求没成功，不拦 */
  border: z
    .object({
      hasBorder: z.boolean(),
      overflow: z.string(),
      source: z.record(z.string(), z.number()).nullable(),
      pattern: z.record(z.string(), z.number()).nullable(),
      error: z.string().nullable().default(null),
      raw: z.string().optional(),
    })
    .nullable()
    .default(null),
  /** 不合格的原因，按 文字 → 元素 → 颜色 → 版面 */
  reasons: z.array(z.string()).default([]),
  snapshot: SnapshotSchema.optional(),
  /** 模型原始回复 */
  raw: z.string().optional(),
})
export type Qc = z.infer<typeof QcSchema>

/** 第 6 步「匹配父体」的结果（实施方案 2.3） */
const ParentResultSchema = z.object({
  /** new = 建议新建父体 */
  status: z.enum(['matched', 'unsure', 'none', 'new']),
  /** none / unsure 的原因 */
  message: z.string().nullable(),
  tab: z.string(),
  readAt: z.string(),
  sku: z.string().nullable(),
  asin: z.string().nullable(),
  theme: z.string().nullable(),
  confidence: z.number().nullable(),
  reason: z.string().nullable(),
  manual: z.boolean(),
  candidates: z.array(z.object({ sku: z.string(), asin: z.string(), theme: z.string(), confidence: z.number().nullable() })),
  naming: z
    .object({
      attribute: z.string(),
      existing: z.array(z.string()),
      groups: z.array(z.object({ pattern: z.string(), count: z.number() })),
      next: z.string().nullable(),
      note: z.string().nullable(),
      /** 占号用：命名方式（如 Design ##）和分到的号 */
      key: z.string().nullable().default(null),
      number: z.number().nullable().default(null),
    })
    .nullable(),
  proposal: z
    .object({
      sku: z.string(),
      prefix: z.string(),
      theme: z.string(),
      basedOn: z.array(z.string()),
      themeCandidates: z.array(z.string()),
    })
    .nullable(),
})
export type ParentResult = z.infer<typeof ParentResultSchema>

export const JobSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  order: z.number(),
  source: z.object({ file: z.string(), originalName: z.string(), width: z.number(), height: z.number(), sha256: z.string() }),
  outputDay: z.string(),
  /** 这张图的输出文件夹名（保存位置下的一级文件夹），同一批图共用；旧任务读入时按日期补上 */
  outputFolder: z.string().default(''),
  outputBase: z.string(),
  /** 第①步判断：竞品图里商品放在场景里有变形（搭着、折叠、起褶），提取时不框选，整张图交给生图模型矫正 */
  deformed: z.boolean().default(false),
  /** 子体 SKU（品类填了材质缩写才有）；有的话输出文件名就用它 */
  sku: z.string().nullable().default(null),
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
      kind: z.enum(['nomatch', 'nowhite', 'failed', 'refused', 'qc']),
      step: z.number().int().min(0).max(STEP_COUNT - 1),
      message: z.string(),
      guess: z.string().optional(),
      at: z.string(),
    })
    .nullable(),
  override: z.object({ step: z.number().int(), prompt: z.string() }).nullable(),
  qc: QcSchema.nullable().default(null),
  /** 第 6 步匹配到的父体；没打开识别父体、旧任务时为 null */
  parent: ParentResultSchema.nullable().default(null),
  /** 竞品图里商品印刷面的区域（第①步模型给四个角，本地往外校正）；没有时第②步按整张竞品图提取 */
  face: z
    .object({
      ai: z.array(z.tuple([z.number(), z.number()])).length(4),
      corners: z.array(z.tuple([z.number(), z.number()])).length(4),
      moved: z.array(z.number()),
      size: z.object({ width: z.number(), height: z.number() }),
    })
    .nullable()
    .default(null),
  /** 第③步里的主图验收，字段同 qc：sourceTexts 是素材图的文字，patternTexts 是主图的文字 */
  mainQc: QcSchema.nullable().default(null),
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
  if (n <= 1) job.qc = null
  if (n <= 2) job.mainQc = null
  // 第 6 步重跑：分到的号随之释放
  if (n <= PARENT_STEP) job.parent = null
  for (let i = n; i < STEP_COUNT; i++) {
    const s = job.steps[i]!
    if (s.state !== 'pending') transition(job, i, 'pending')
    s.attempts = 0
    delete s.output
    delete s.snapshot
    delete s.error
    delete s.note
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
  if (r >= 0) return { phase: 'running', runningStep: r, label: r === 4 ? '生成空白图中' : r === 1 && job.qc?.state === 'pending' ? '验收素材中' : r === 2 && job.mainQc?.state === 'pending' ? '验收主图中' : r === PARENT_STEP ? '匹配父体中' : `${STEP_NAMES[r]}中` }
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
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
        // 旧任务只有 5 步：补上第 6 步（跳过），需要的话在详情里对第 6 步点重做
        if (Array.isArray(raw?.steps) && raw.steps.length === STEP_COUNT - 1) {
          raw.steps.push({ state: 'skipped', attempts: 0, note: '这张图是加父体功能之前跑的，没有匹配父体' })
        }
        const r = JobSchema.safeParse(raw)
        if (!r.success) {
          log.warn(`任务记录 ${ent.name} 格式不对，已跳过`)
          continue
        }
        if (!r.data.outputFolder) r.data.outputFolder = `主图生成-${r.data.outputDay}`
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
