import type { Paths } from './paths'
import type { Bus } from './events/bus'
import type { SettingsStore } from './store/settings'
import type { Limiter } from './ai/limiter'

export type AppContext = {
  version: string
  paths: Paths
  bus: Bus
  settings: SettingsStore
  limiter: Limiter
  sse: { clients: number }
  onSettingsSaved: () => void
  /** 监听成功后调用：加载模版库、复位任务、开始调度 */
  start: () => Promise<void>
  /** 没有 running、也没有可派发的 pending */
  isIdle: () => boolean
}
