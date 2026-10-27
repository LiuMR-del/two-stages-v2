import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Scheduler } from '../../server/src/scheduler/scheduler'
import { JobStore, markDone } from '../../server/src/store/jobs'
import { LibraryStore } from '../../server/src/library/store'
import { SettingsStore } from '../../server/src/store/settings'
import { Limiter } from '../../server/src/ai/limiter'
import { Bus } from '../../server/src/events/bus'
import { AiError } from '../../server/src/ai/errors'
import type { StepHandler, StepResult } from '../../server/src/pipeline/types'
import { rmDir, tmpDir, waitFor } from '../helpers'
import { fakeJob } from '../jobfixture'

type Pending = { jobId: string; step: number; resolve: (r: StepResult) => void; reject: (e: unknown) => void }

let dir: string
let jobs: JobStore
let sched: Scheduler
let settings: SettingsStore
let limiter: Limiter
let started: Pending[]

function handler(step: number): StepHandler {
  return (ctx) =>
    new Promise<StepResult>((resolve, reject) => {
      started.push({ jobId: ctx.job.id, step, resolve, reject })
    })
}

async function setup(limits: { image: number; analysis: number }) {
  dir = tmpDir()
  started = []
  jobs = new JobStore(path.join(dir, 'jobs'))
  settings = new SettingsStore(path.join(dir, 'settings.json'))
  await settings.update({ image: { concurrency: limits.image }, analysis: { concurrency: limits.analysis }, outputDir: path.join(dir, 'out') })
  limiter = new Limiter(() => sched.tick())
  limiter.configure('image', limits.image)
  limiter.configure('analysis', limits.analysis)
  const library = new LibraryStore({
    file: path.join(dir, 'library.json'),
    imagesDir: path.join(dir, 'img'),
    thumbsDir: path.join(dir, 'img', 't'),
    backupsDir: path.join(dir, 'bk'),
  })
  sched = new Scheduler({ jobs, library, settings, limiter, bus: new Bus(), handlers: [0, 1, 2, 3, 4].map(handler) })
}

async function addJob(id: string, doneUpTo = -1) {
  const j = fakeJob(id, jobs.maxOrder() + 1)
  for (let i = 0; i <= doneUpTo; i++) markDone(j, i)
  await jobs.create(j)
  return j
}

const flush = () => new Promise((r) => setTimeout(r, 5))
const startedKeys = () => started.map((p) => `${p.jobId}:${p.step}`)
const finish = (jobId: string, step: number, r: StepResult = { kind: 'done' }) => {
  const p = started.find((x) => x.jobId === jobId && x.step === step)!
  p.resolve(r)
}

beforeEach(() => {})
afterEach(async () => {
  sched.stop()
  limiter.dispose()
  await jobs.flush()
  rmDir(dir)
})

describe('调度器', () => {
  it('按 order 推进：先把排在前面的图推进完', async () => {
    await setup({ image: 2, analysis: 3 })
    await addJob('a', 0)
    await addJob('b', 0)
    await addJob('c', 0)
    sched.tick()
    await flush()
    expect(startedKeys()).toEqual(['a:1', 'b:1'])
    finish('a', 1)
    await flush()
    // a 的下一步 ③ 排在 c 前面
    expect(startedKeys()).toEqual(['a:1', 'b:1', 'a:2'])
    expect(jobs.get('c')!.steps[1]!.state).toBe('pending')
  })

  it('生图和分析两类槽位互不影响', async () => {
    await setup({ image: 1, analysis: 1 })
    await addJob('a', 0)
    await addJob('b', 0)
    await addJob('c')
    sched.tick()
    await flush()
    expect(startedKeys()).toEqual(['a:1', 'c:0'])
    expect(sched.queueState().slots).toEqual({ image: { busy: 1, limit: 1 }, analysis: { busy: 1, limit: 1 } })
  })

  it('新加的任务排在后面，不打断正在跑的', async () => {
    await setup({ image: 1, analysis: 1 })
    await addJob('a', 0)
    sched.tick()
    await flush()
    const late = await addJob('z', 0)
    expect(late.order).toBeGreaterThan(jobs.get('a')!.order)
    sched.tick()
    await flush()
    expect(startedKeys()).toEqual(['a:1'])
    finish('a', 1)
    await flush()
    expect(startedKeys()).toEqual(['a:1', 'a:2'])
    finish('a', 2)
    await flush()
    expect(startedKeys()).toEqual(['a:1', 'a:2', 'a:3', 'z:1'])
  })

  it('用户暂停后不再派发，继续后恢复；正在跑的不受影响', async () => {
    await setup({ image: 2, analysis: 2 })
    await addJob('a', 0)
    sched.pause()
    sched.tick()
    await flush()
    expect(started).toHaveLength(0)
    expect(sched.queueState().paused).toMatchObject({ by: 'user' })
    sched.resume()
    await flush()
    expect(startedKeys()).toEqual(['a:1'])
  })

  it('401 只暂停那一类接口，保存设置后自动继续', async () => {
    await setup({ image: 2, analysis: 2 })
    await addJob('a', 0)
    sched.tick()
    await flush()
    started[0]!.reject(new AiError('auth', 'HTTP 401', 401))
    await flush()
    expect(jobs.get('a')!.steps[1]!.state).toBe('pending')
    expect(sched.queueState().paused).toMatchObject({ by: 'auth', kind: 'image' })
    await addJob('b')
    sched.tick()
    await flush()
    expect(startedKeys()).toEqual(['a:1', 'b:0'])
    sched.onSettingsSaved()
    await flush()
    expect(startedKeys()).toEqual(['a:1', 'b:0', 'a:1'])
  })

  it('429 退回 pending、不计次数，冷却后继续', async () => {
    await setup({ image: 2, analysis: 2 })
    await addJob('a', 0)
    sched.tick()
    await flush()
    started[0]!.reject(new AiError('rateLimit', 'HTTP 429', 429, 1))
    await flush()
    expect(jobs.get('a')!.steps[1]).toMatchObject({ state: expect.stringMatching(/pending|running/), attempts: 0 })
    await waitFor(() => started.length === 2, { timeout: 2000 })
    expect(startedKeys()).toEqual(['a:1', 'a:1'])
  })

  it('失败只影响这一张图', async () => {
    await setup({ image: 2, analysis: 2 })
    await addJob('a', 0)
    await addJob('b', 0)
    sched.tick()
    await flush()
    started[0]!.reject(new AiError('server', 'HTTP 502', 502))
    finish('b', 1)
    await flush()
    expect(jobs.get('a')!.attention).toMatchObject({ kind: 'failed', step: 1 })
    expect(jobs.get('a')!.steps[1]!.state).toBe('failed')
    expect(startedKeys()).toContain('b:2')
  })

  it('④ 判定无需空白图时 ⑤ 直接跳过，不占生图位置', async () => {
    await setup({ image: 1, analysis: 1 })
    await addJob('a', 2)
    sched.tick()
    await flush()
    expect(startedKeys()).toEqual(['a:3'])
    finish('a', 3, { kind: 'done', skipNext: true })
    await flush()
    expect(jobs.get('a')!.steps[4]!.state).toBe('skipped')
    expect(startedKeys()).toEqual(['a:3'])
    expect(sched.isIdle()).toBe(true)
  })
})
