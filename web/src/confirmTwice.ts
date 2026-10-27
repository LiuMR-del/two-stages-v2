import { ref } from 'vue'

/** 危险操作要点两次：第一次只是变成「再点一次」，几秒内没点第二次就恢复 */
export function useConfirmTwice(action: () => unknown, timeoutMs = 4000) {
  const armed = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  async function click(): Promise<boolean> {
    if (!armed.value) {
      armed.value = true
      timer = setTimeout(() => (armed.value = false), timeoutMs)
      return false
    }
    clearTimeout(timer)
    armed.value = false
    await action()
    return true
  }
  return { armed, click }
}

/** 「清空队列」按钮：队列里有图就显示，和运行 / 暂停状态无关 */
export const showClearAll = (jobCount: number) => jobCount > 0
