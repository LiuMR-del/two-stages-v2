import type { Paths } from './paths'
import type { Bus } from './events/bus'
import type { SettingsStore } from './store/settings'
import type { Limiter } from './ai/limiter'
import type { LibraryStore } from './library/store'
import type { JobStore } from './store/jobs'
import type { Scheduler } from './scheduler/scheduler'
import type { BatchFolders } from './pipeline/output'
import type { FeishuSheets } from './parent/feishu'
import type { SpapiClient } from './parent/spapi'

export type AppContext = {
  version: string
  paths: Paths
  bus: Bus
  settings: SettingsStore
  limiter: Limiter
  library: LibraryStore
  jobs: JobStore
  scheduler: Scheduler
  /** 当前批次的输出文件夹 */
  batch: BatchFolders
  /** 父体匹配：飞书读表（应用身份）、SP-API */
  parent: { sheets: FeishuSheets; spapi: SpapiClient }
  sse: { clients: number }
  onSettingsSaved: () => void
  /** 监听成功后调用：加载模版库、复位任务、开始调度 */
  start: () => Promise<void>
  /** 测试里停掉服务时释放定时器 */
  stop: () => Promise<void>
  /** 没有 running、也没有可派发的 pending */
  isIdle: () => boolean
}
