import { onBeforeUnmount, ref } from 'vue'

const DELAY_MS = 800

/**
 * 停止输入 800ms 或失去焦点时保存；保存成功短暂显示「已保存」。
 * 同一时刻只有一个保存在飞，期间的新内容排到下一次。
 */
export function useAutosave(save: (value: string) => Promise<unknown>) {
  const status = ref<'' | 'saving' | 'saved' | 'error'>('')
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: string | null = null
  let inflight: Promise<void> | null = null
  let last: string | null = null
  let hideTimer: ReturnType<typeof setTimeout> | null = null

  async function run(): Promise<void> {
    if (inflight) {
      await inflight
      return run()
    }
    if (pending === null || pending === last) return
    const v = pending
    pending = null
    status.value = 'saving'
    inflight = (async () => {
      try {
        await save(v)
        last = v
        status.value = 'saved'
        if (hideTimer) clearTimeout(hideTimer)
        hideTimer = setTimeout(() => status.value === 'saved' && (status.value = ''), 1800)
      } catch {
        status.value = 'error'
      } finally {
        inflight = null
      }
    })()
    await inflight
  }

  function input(v: string) {
    pending = v
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void run(), DELAY_MS)
  }

  function flush(v?: string) {
    if (v !== undefined) pending = v
    if (timer) clearTimeout(timer)
    return run()
  }

  /** 外部内容变化（比如切换了品类）时调用，避免把旧值当成未保存 */
  function reset(v: string) {
    if (timer) clearTimeout(timer)
    pending = null
    last = v
    status.value = ''
  }

  onBeforeUnmount(() => void flush())
  return { status, input, flush, reset }
}
