import { describe, expect, it, vi } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createPinia, setActivePinia } from 'pinia'
import QueueTabs from '../../web/src/components/QueueTabs.vue'
import { useJobs } from '../../web/src/stores/jobs'
import { showClearAll, useConfirmTwice } from '../../web/src/confirmTwice'
import type { Job } from '../../web/src/types'

/** 前端测试不引用服务端代码，这里手写一张排队中的图 */
const job = (i: number): Job => ({
  id: 'j' + i,
  createdAt: '2026-10-27T00:00:00.000Z',
  order: i,
  source: { file: 'source.png', originalName: `j${i}.png`, width: 100, height: 100, sha256: 'x' },
  outputDay: '2026-10-27',
  outputFolder: '主图生成-2026-10-27',
  outputBase: 'j' + i,
  route: null,
  plan: null,
  steps: Array.from({ length: 6 }, () => ({ state: 'pending' as const, attempts: 0 })),
  info: null,
  attention: null,
  override: null,
  qc: null,
  mainQc: null,
  face: null,
  parent: null,
  view: { phase: 'queued', runningStep: null, label: '排队中' },
})

async function render(paused: boolean, n: number): Promise<string> {
  const pinia = createPinia()
  setActivePinia(pinia)
  const jobs = useJobs()
  jobs.byId = Object.fromEntries(Array.from({ length: n }, (_, i) => job(i)).map((j) => [j.id, j]))
  jobs.queue = {
    paused: paused ? { by: 'user', message: '队列已暂停' } : null,
    parentPaused: null,
    slots: { image: { busy: 0, limit: 2 }, analysis: { busy: 0, limit: 3 } },
  }
  const app = createSSRApp(QueueTabs)
  app.use(pinia)
  return renderToString(app)
}

describe('清空队列按钮', () => {
  it('暂停状态下队列里有图就显示；队列空了不显示', async () => {
    expect(await render(true, 2)).toContain('清空队列')
    expect(await render(false, 2)).toContain('清空队列')
    expect(await render(true, 0)).not.toContain('清空队列')
    expect(showClearAll(1)).toBe(true)
    expect(showClearAll(0)).toBe(false)
  })

  it('点两次才清空：第一次只变成「再点一次」，过一会儿没点就恢复', async () => {
    vi.useFakeTimers()
    try {
      const action = vi.fn()
      const c = useConfirmTwice(action, 4000)
      expect(await c.click()).toBe(false)
      expect(c.armed.value).toBe(true)
      expect(action).not.toHaveBeenCalled()
      expect(await c.click()).toBe(true)
      expect(action).toHaveBeenCalledTimes(1)
      expect(c.armed.value).toBe(false)
      await c.click()
      vi.advanceTimersByTime(4001)
      expect(c.armed.value).toBe(false)
      await c.click()
      expect(action).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
