import { describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useJobs } from '../../web/src/stores/jobs'
import type { Job } from '../../web/src/types'

/** 前端测试不引用服务端代码，这里手写图，只填分类用到的字段 */
const job = (i: number, phase: Job['view']['phase']): Job =>
  ({
    id: 'j' + i,
    order: i,
    steps: [],
    info: null,
    attention: phase === 'attention' ? { kind: 'x' } : null,
    view: { phase, runningStep: null, label: '' },
  }) as unknown as Job

describe('未完成 / 已完成 标签', () => {
  it('未完成 + 已完成 = 队列，需处理的图两边都不算；状态一变分类跟着变', () => {
    setActivePinia(createPinia())
    const jobs = useJobs()
    const list = [job(0, 'done'), job(1, 'running'), job(2, 'queued'), job(3, 'paused'), job(4, 'attention'), job(5, 'done')]
    jobs.byId = Object.fromEntries(list.map((j) => [j.id, j]))

    expect(jobs.unfinished.map((j) => j.id)).toEqual(['j1', 'j2', 'j3'])
    expect(jobs.finished.map((j) => j.id)).toEqual(['j0', 'j5'])
    expect(jobs.unfinished.length + jobs.finished.length).toBe(jobs.queued.length)

    // 已完成的图点了重做：回到未完成
    jobs.onEvent('job', { job: job(0, 'running') })
    expect(jobs.unfinished.map((j) => j.id)).toEqual(['j0', 'j1', 'j2', 'j3'])
    expect(jobs.finished.map((j) => j.id)).toEqual(['j5'])

    // 跑完：进已完成
    jobs.onEvent('job', { job: job(1, 'done') })
    expect(jobs.finished.map((j) => j.id)).toEqual(['j1', 'j5'])

    // 删掉：两边都没有
    jobs.onEvent('job-removed', { id: 'j5' })
    expect(jobs.finished.map((j) => j.id)).toEqual(['j1'])
    expect(jobs.unfinished.length + jobs.finished.length).toBe(jobs.queued.length)
  })
})
