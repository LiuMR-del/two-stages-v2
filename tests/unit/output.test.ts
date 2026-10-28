import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assignOutputBase, batchDir, BatchFolders, nextBatchFolder, writeOutput } from '../../server/src/pipeline/output'
import { writeBatchCsv } from '../../server/src/pipeline/csv'
import { JobStore } from '../../server/src/store/jobs'
import { startInProcess } from '../inprocess'
import { Scheduler } from '../../server/src/scheduler/scheduler'
import { png } from '../helpers'
import { DEFAULT_OUTPUT_DIR, SettingsStore } from '../../server/src/store/settings'
import { fakeJob } from '../jobfixture'
import { localDay } from '../../server/src/util/ids'
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

describe('每批图一个文件夹（只有清空队列才开新的）', () => {
  const d27 = new Date(2026, 9, 27, 15, 30)
  const d28 = new Date(2026, 9, 28, 9, 0)
  const mk = () => new BatchFolders(path.join(dir, 'data', 'batch.json'), () => path.join(dir, 'out'))

  it('跑完不清空继续同一个文件夹；清空后依次 -1、-2', () => {
    dir = tmpDir()
    const b = mk()
    expect(b.current([], d27)).toBe('主图生成-2026-10-27')
    expect(b.current([], new Date(2026, 9, 27, 18, 0))).toBe('主图生成-2026-10-27')
    b.close()
    expect(b.current([], d27)).toBe('主图生成-2026-10-27-1')
    expect(b.current([], d27)).toBe('主图生成-2026-10-27-1')
    b.close()
    b.close()
    expect(b.current([], d27)).toBe('主图生成-2026-10-27-2')
  })

  it('磁盘上已经有的名字跳过', () => {
    dir = tmpDir()
    fs.mkdirSync(path.join(dir, 'out', '主图生成-2026-10-27'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'out', '主图生成-2026-10-27-1'))
    fs.mkdirSync(path.join(dir, 'out', '主图生成-2026-10-27-3'))
    const b = mk()
    expect(b.current([], d27)).toBe('主图生成-2026-10-27-2')
    b.close()
    expect(b.current([], d27)).toBe('主图生成-2026-10-27-4')
    expect(nextBatchFolder(path.join(dir, 'out'), '2026-10-27', null)).toBe('主图生成-2026-10-27-2')
  })

  it('换了一天从新日期不带序号的名字开始', () => {
    dir = tmpDir()
    const b = mk()
    expect(b.current([], d27)).toBe('主图生成-2026-10-27')
    b.close()
    expect(b.current([], d27)).toBe('主图生成-2026-10-27-1')
    expect(b.current([], d28)).toBe('主图生成-2026-10-28')
    expect(b.current([], d28)).toBe('主图生成-2026-10-28')
  })

  it('重启后接着用；第一次用时队列里有今天的图就接着用它们的文件夹', () => {
    dir = tmpDir()
    expect(mk().current([], d27)).toBe('主图生成-2026-10-27')
    expect(mk().current([], d27)).toBe('主图生成-2026-10-27')
    const a = mk()
    a.close()
    expect(mk().current([], d27)).toBe('主图生成-2026-10-27-1')

    const dir2 = tmpDir()
    try {
      const j = fakeJob('a')
      j.outputDay = '2026-10-27'
      j.outputFolder = '主图生成-2026-10-27-1530'
      const b = new BatchFolders(path.join(dir2, 'batch.json'), () => dir2)
      expect(b.current([j], d27)).toBe('主图生成-2026-10-27-1530')
      expect(new BatchFolders(path.join(dir2, 'batch.json'), () => dir2).current([], d27)).toBe('主图生成-2026-10-27-1530')
      // 旧版「日期-时分」的 1530 不是批次序号：清空后从不带序号的名字找空位
      b.close()
      expect(b.current([], d27)).toBe('主图生成-2026-10-27')
    } finally {
      rmDir(dir2)
    }
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

  it('暂停时也能清空；清空后再加的图进 -1，「清除已完成」不开新文件夹', async () => {
    const srv = await startInProcess()
    try {
      await srv.ctx.scheduler.pause()
      const day = localDay()
      const files = async (n: string) => [{ name: n, buffer: await png(50, 50), type: 'image/png' }]
      const a = await srv.api.upload('POST', '/jobs', 'files', await files('a.png'))
      const b = await srv.api.upload('POST', '/jobs', 'files', await files('b.png'))
      expect(a.body.jobs[0].outputFolder).toBe(`主图生成-${day}`)
      expect(b.body.jobs[0].outputFolder).toBe(a.body.jobs[0].outputFolder)
      expect((await srv.api.json('POST', '/jobs/clear-done')).body.removed).toBe(0)
      const r = await srv.api.json('POST', '/jobs/clear-all')
      expect(r.body.removed).toBe(2)
      expect((await srv.api.json('GET', '/jobs')).body.jobs).toEqual([])
      const c = await srv.api.upload('POST', '/jobs', 'files', await files('c.png'))
      expect(c.body.jobs[0].outputFolder).toBe(`主图生成-${day}-1`)
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

describe('识别信息 CSV', () => {
  it('父体结果启用六列；none 和建议新建也保留状态', async () => {
    dir = tmpDir()
    const rows = path.join(dir, 'data', 'batches', 'p.json')
    const j = routed('p', 'p.png')
    j.outputFolder = 'p'
    j.steps[3]!.state = 'done'
    j.info = { scene: '场景', keywords: ['k'], customizable: [], blankItems: [], blankItemsEn: [] }
    j.parent = {
      status: 'new', message: null, tab: '铝板画', readAt: new Date().toISOString(), sku: 'HJ-cn-yklgj5-Snowman', asin: null, theme: 'Snowman', confidence: null, reason: null, manual: false,
      candidates: [], naming: { attribute: 'color', existing: [], groups: [], next: 'Design 01', note: '需要手动创建', key: 'Design ##', number: 1 },
      proposal: { sku: 'HJ-cn-yklgj5-Snowman', prefix: 'HJ-cn-yklgj5', theme: 'Snowman', basedOn: ['HJ-cn-yklgj-Christmas'], themeCandidates: ['Snowman'] },
    }
    await writeBatchCsv(dir, [j], 'p', rows)
    const text = fs.readFileSync(path.join(dir, 'p', '识别信息.csv'), 'utf8')
    expect(text).toContain('父体主题,父体SKU,父体ASIN,建议变体名,父体把握,父体状态')
    expect(text).toContain('Snowman,HJ-cn-yklgj5-Snowman,,Design 01,,建议新建')
    const none = { ...j, id: 'none', parent: { ...j.parent, status: 'none' as const, sku: null, theme: null, naming: null, proposal: null, message: '没有合适的父体' } }
    await writeBatchCsv(dir, [none], 'p', rows)
    expect(fs.readFileSync(path.join(dir, 'p', '识别信息.csv'), 'utf8')).toContain(',,,,,,没有合适的父体')
  })

  it('旧保存行在出现父体结果时补足六列并保留', async () => {
    dir = tmpDir()
    const rows = path.join(dir, 'data', 'batches', 'p.json')
    const old = routed('old', 'old.png')
    old.outputFolder = 'p'
    old.steps[3]!.state = 'done'
    old.info = { scene: '旧场景', keywords: ['k'], customizable: [], blankItems: [], blankItemsEn: [] }
    await writeBatchCsv(dir, [old], 'p', rows)
    const current = routed('current', 'current.png')
    current.outputFolder = 'p'
    current.steps[3]!.state = 'done'
    current.info = { scene: '新场景', keywords: ['k'], customizable: [], blankItems: [], blankItemsEn: [] }
    current.parent = { status: 'matched', message: null, tab: '铝板画', readAt: new Date().toISOString(), sku: 'P', asin: 'A', theme: 'T', confidence: 0.9, reason: null, manual: false, candidates: [], naming: { attribute: 'color', existing: [], groups: [], next: 'Design 01', note: null, key: 'Design ##', number: 1 }, proposal: null }
    await writeBatchCsv(dir, [current], 'p', rows)
    const saved = JSON.parse(fs.readFileSync(rows, 'utf8')) as { row: string[] }[]
    expect(saved).toHaveLength(2)
    expect(saved.every((r) => r.row).valueOf()).toBeTruthy()
    expect(saved[0].row).toHaveLength(13)
    expect(saved[0].row.slice(7)).toEqual(['', '', '', '', '', ''])
  })

  it('清除已完成后同一文件夹再加图，CSV 里前面的行不丢；队列里的图重做后行更新', async () => {
    dir = tmpDir()
    const rows = path.join(dir, 'data', 'batches', 'b.json')
    const done = (id: string, scene: string) => {
      const j = routed(id, id + '.png')
      j.outputFolder = 'b'
      j.createdAt = `2026-10-27T00:00:0${id.length}.000Z`
      j.steps[3]!.state = 'done'
      j.info = { scene, keywords: ['k'], customizable: [], blankItems: [], blankItemsEn: [] }
      return j
    }
    const csv = () => fs.readFileSync(path.join(dir, 'b', '识别信息.csv'), 'utf8')
    await writeBatchCsv(dir, [done('a', '场景A'), done('bb', '场景B')], 'b', rows)
    expect(csv().trim().split('\r\n')).toHaveLength(3)
    // a、bb 已经清除，只剩新加的 ccc
    await writeBatchCsv(dir, [done('ccc', '场景C')], 'b', rows)
    expect(csv().trim().split('\r\n')).toHaveLength(4)
    expect(csv()).toContain('场景A')
    await writeBatchCsv(dir, [done('ccc', '场景C2')], 'b', rows)
    expect(csv()).toContain('场景C2')
    expect(csv()).not.toContain('场景C,')
    expect(csv().trim().split('\r\n')).toHaveLength(4)
  })
})

