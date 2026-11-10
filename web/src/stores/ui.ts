import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ToastLevel } from '../types'

/** 工作台的一排标签：未完成 / 需处理 / 已完成 / 识别信息 */
export type WorkTab = 'todo' | 'attention' | 'done' | 'info'
/** 看大图：给了 step 的图，大图里可以跳到这一步的详情 */
export type ViewerItem = { src: string; label: string; step?: number }

export const useUi = defineStore('ui', () => {
  const workTab = ref<WorkTab>('todo')
  /** redo 为 true 时打开详情就展开「重做这一步」 */
  const sheet = ref<null | { jobId: string; step: number; redo?: boolean }>(null)
  const settingsOpen = ref(false)
  /** 模版库当前选中：'__global' 表示全局提示词 */
  const libSel = ref<string>('__global')
  const libStyle = ref<string>('')
  const libTpl = ref<string>('default')
  const viewer = ref<null | { items: ViewerItem[]; index: number; title?: string; jobId?: string }>(null)

  function view(items: ViewerItem[], index = 0, extra: { title?: string; jobId?: string } = {}) {
    if (!items.length) return
    viewer.value = { items, index: Math.min(Math.max(index, 0), items.length - 1), ...extra }
  }

  const toasts = ref<{ id: number; level: ToastLevel; message: string }[]>([])
  let seq = 0
  function toast(message: string, level: ToastLevel = 'info') {
    const id = ++seq
    toasts.value.push({ id, level, message })
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id)
    }, level === 'error' ? 6000 : 3200)
  }

  /** 包一层：出错时弹中文提示，不向外抛 */
  async function act<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn()
    } catch (e) {
      toast((e as Error).message || '操作失败', 'error')
      return undefined
    }
  }

  return { workTab, sheet, settingsOpen, libSel, libStyle, libTpl, viewer, view, toasts, toast, act }
})
