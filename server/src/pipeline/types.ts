import type { Settings } from '../store/settings'
import type { LibraryStore } from '../library/store'
import type { Attention, Job, ParentResult, StepSnapshot } from '../store/jobs'
import type { StoreSnapshot } from '../parent/storeIndex'
import type { ParentEnv } from '../parent/match'

export type StepEnv = {
  settings: () => Settings
  library: LibraryStore
  outputDir: () => string
  /** 中转站不认保真参数、降级重发成功后调用 */
  onFidelityDowngrade: (message: string) => Promise<void>
  /** 第 6 步：飞书读表、SP-API、占号的锁、队列里所有任务 */
  parent: ParentEnv
  /** 第 6 步定下父体后，子体 SKU 的材质编码跟着父体走（多店铺方案第六节，见 Scheduler.syncChildCode）；改不了不让第 6 步失败 */
  syncChildCode?: (jobId: string, o: { result: ParentResult; kids: string[]; snap: StoreSnapshot | null; productTypes: string[] }) => Promise<void>
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
  /** 这一步还没完，回到排队等下一段（第②步提取完等验收） */
  | { kind: 'requeue'; patch?: JobPatch }
  | { kind: 'attention'; state: 'failed' | 'pending'; attention: Omit<Attention, 'at'>; patch?: JobPatch }

export type StepHandler = (ctx: StepCtx) => Promise<StepResult>
