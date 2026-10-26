import type { Settings } from '../store/settings'
import type { LibraryStore } from '../library/store'
import type { Attention, Job, StepSnapshot } from '../store/jobs'

export type StepEnv = {
  settings: () => Settings
  library: LibraryStore
  outputDir: () => string
  /** 中转站不认保真参数、降级重发成功后调用 */
  onFidelityDowngrade: (message: string) => Promise<void>
}

export type StepCtx = {
  env: StepEnv
  /** 只读；要改的字段通过结果里的 patch 交回调度器 */
  job: Readonly<Job>
  dir: string
  signal: AbortSignal
  /** 包一层重试，并把每次尝试计入 attempts */
  retry<T>(fn: () => Promise<T>): Promise<T>
  /** 请求发出前记录实际发送的内容 */
  setSnapshot(s: StepSnapshot): void
  /** 立即写入任务记录（例如 ② 开始时解析好的 plan），之后即使这一步被打断也不会丢 */
  commit(patch: JobPatch): void
}

export type JobPatch = (job: Job) => void

export type StepResult =
  | { kind: 'done'; output?: string; patch?: JobPatch; skipNext?: boolean }
  | { kind: 'skipped'; patch?: JobPatch }
  | { kind: 'attention'; state: 'failed' | 'pending'; attention: Omit<Attention, 'at'>; patch?: JobPatch }

export type StepHandler = (ctx: StepCtx) => Promise<StepResult>
