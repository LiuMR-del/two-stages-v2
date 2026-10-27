import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assignOutputBase, batchDir, folderForNewJobs, newBatchFolder, writeOutput } from '../../server/src/pipeline/output'
import { JobStore, isFinished, markDone } from '../../server/src/store/jobs'
import { startInProcess } from '../inprocess'
import { Scheduler } from '../../server/src/scheduler/scheduler'
import { png } from '../helpers'
import { DEFAULT_OUTPUT_DIR, SettingsStore } from '../../server/src/store/settings'
import { fakeJob } from '../jobfixture'
import { rmDir, tmpDir } from '../helpers'

let dir = ''
afterEach(() => {
  if (dir) rmDir(dir)
  dir = ''
})

const routed = (id: string, name: string) => {
  const j = fakeJob(id)
  j.source.originalName = name
  j.route = { categoryId: 'c1', categoryName: '相框', styleId: 's1', styleName: '', ratio: '1:1', confidence: 1, reason: '', manual: false }
  return j
}

describe('输出文件', () => {
  it('按 主图/素材图/空白图 分文件夹，文件名就是原图名', async () => {
    dir = tmpDir()
    const j = routed('a', '家庭照.jpg')
    j.outputBase = assignOutputBase(j, [], dir, '相框')
    for (const k of ['main', 'pattern', 'blank'] as const) await writeOutput(dir, j, k, Buffer.from('x'))
    const day = path.join(dir, j.outputFolder, '相框')
    expect(fs.readdirSync(day).sort()).toEqual(['主图', '空白图', '素材图'])
    for (const f of ['主图', '素材图', '空白图']) expect(fs.readdirSync(path.join(day, f))).toEqual(['家庭照.png'])
  })

  it('同一天同一品类重名时加 _2', async () => {
    dir = tmpDir()
    const a = routed('a', '家庭照.jpg')
    a.outputBase = assignOutputBase(a, [], dir, '相框')
    await writeOutput(dir, a, 'main', Buffer.from('x'))
    const b = routed('b', '家庭照.png')
    expect(assignOutputBase(b, [], dir, '相框')).toBe('家庭照_2')
    const c = routed('c', '家庭照.webp')
    c.outputBase = '家庭照_2'
    expect(assignOutputBase(routed('d', '家庭照.jpg'), [a, c], dir, '相框')).toBe('家庭照_3')
  })
})

describe('保存位置', () => {
  it('旧版默认的 下载/主图生成 自动改成 下载，日期文件夹直接放进去', () => {
    dir = tmpDir()
    const file = path.join(dir, 'settings.json')
    fs.writeFileSync(file, JSON.stringify({ outputDir: path.join('~', 'Downloads', '主图生成') }))
    expect(new SettingsStore(file).get().outputDir).toBe(DEFAULT_OUTPUT_DIR)
    expect(batchDir('/x', '主图生成-2026-10-27-1530')).toBe(path.join('/x', '主图生成-2026-10-27-1530'))
  })
})

describe('每批图一个文件夹', () => {
  const at = new Date(2026, 9, 27, 15, 30)
  const job = (id: string, folder: string, done: boolean) => {
    const j = fakeJob(id)
    j.outputDay = '2026-10-27'
    j.outputFolder = folder
    if (done) for (let i = 0; i < j.steps.length; i++) markDone(j, i)
    return j
  }

  it('队列里还有今天没完成的图就跟它们同一批，否则开新文件夹（日期加时间，重名加 -2）', () => {
    dir = tmpDir()
    expect(folderForNewJobs([job('a', '主图生成-2026-10-27-0900', false)], dir, isFinished, at)).toBe('主图生成-2026-10-27-0900')
    expect(folderForNewJobs([job('a', '主图生成-2026-10-27-0900', true)], dir, isFinished, at)).toBe('主图生成-2026-10-27-1530')
    expect(folderForNewJobs([], dir, isFinished, at)).toBe('主图生成-2026-10-27-1530-2')
    fs.mkdirSync(path.join(dir, '主图生成-2026-10-27-1531'))
    expect(newBatchFolder(dir, new Date(2026, 9, 27, 15, 31))).toBe('主图生成-2026-10-27-1531-2')
    const old = job('b', '主图生成-2026-10-26-0900', false)
    old.outputDay = '2026-10-26'
    expect(folderForNewJobs([old], dir, isFinished, at)).toBe('主图生成-2026-10-27-1530-3')
  })

  it('旧任务没有文件夹字段，读入时按日期补上', () => {
    dir = tmpDir()
    const j = fakeJob('old') as any
    delete j.outputFolder
    fs.mkdirSync(path.join(dir, 'old'))
    fs.writeFileSync(path.join(dir, 'old', 'job.json'), JSON.stringify(j))
    const store = new JobStore(dir)
    store.loadAll()
    expect(store.get('old')!.outputFolder).toBe('主图生成-2026-10-26')
  })

  it('清空队列后再加的图进新文件夹；暂停时也能清空', async () => {
    const srv = await startInProcess()
    try {
      await srv.ctx.scheduler.pause()
      const files = async (n: string) => [{ name: n, buffer: await png(50, 50), type: 'image/png' }]
      const a = await srv.api.upload('POST', '/jobs', 'files', await files('a.png'))
      const b = await srv.api.upload('POST', '/jobs', 'files', await files('b.png'))
      expect(b.body.jobs[0].outputFolder).toBe(a.body.jobs[0].outputFolder)
      const r = await srv.api.json('POST', '/jobs/clear-all')
      expect(r.body.removed).toBe(2)
      expect((await srv.api.json('GET', '/jobs')).body.jobs).toEqual([])
      const c = await srv.api.upload('POST', '/jobs', 'files', await files('c.png'))
      expect(c.body.jobs[0].outputFolder).not.toBe(a.body.jobs[0].outputFolder)
      expect(c.body.jobs[0].outputFolder).toMatch(/^主图生成-\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?$/)
    } finally {
      await srv.close()
    }
  })
})

describe('暂停队列', () => {
  it('重启后仍然暂停，点继续后重启不再暂停', async () => {
    const dir2 = tmpDir()
    try {
      const file = path.join(dir2, 'queue.json')
      const mk = () => new Scheduler({ jobs: new JobStore(path.join(dir2, 'jobs')), library: null as any, settings: new SettingsStore(path.join(dir2, 's.json')), limiter: null as any, bus: null as any, stateFile: file })
      const a = mk()
      ;(a as any).emitQueue = () => {}
      a.pause()
      expect(mk().queueState.call(Object.assign(mk(), { d: { limiter: { limit: () => 1 } } })).paused?.by).toBe('user')
      ;(a as any).tick = () => {}
      a.resume()
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ paused: false })
    } finally {
      rmDir(dir2)
    }
  })
})
