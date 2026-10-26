import type { Paths } from './paths'
import type { Bus } from './events/bus'
import type { SettingsStore } from './store/settings'
import type { Limiter } from './ai/limiter'
import type { LibraryStore } from './library/store'
import type { JobStore } from './store/jobs'
import type { Scheduler } from './scheduler/scheduler'

export type AppContext = {
  version: string
  paths: Paths
  bus: Bus
  settings: SettingsStore
  limiter: Limiter
  library: LibraryStore
  jobs: JobStore
  scheduler: Scheduler
  sse: { clients: number }
  onSettingsSaved: () => void
  /** 监听成功后调用：加载模版库、复位任务、开始调度 */
  start: () => Promise<void>
  /** 测试里停掉服务时释放定时器 */
  stop: () => Promise<void>
  /** 没有 running、也没有可派发的 pending */
  isIdle: () => boolean
}
