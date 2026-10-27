import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startWorld, makeCategory, uploadJobs, waitJob, isDone, imageRequests, onlyBatch, type World } from './harness'
import { DEFAULT_PASTE_PROMPT } from '../../server/src/library/schema'
import { localDay } from '../../server/src/util/ids'
import { waitFor } from '../helpers'

let w: World | null = null
afterEach(async () => {
  await w?.close()
  w = null
})

const outFiles = (w: World, cat: string) =>
  fs
    .readdirSync(path.join(onlyBatch(w), cat), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.png'))
    .map((f) => f.split(path.sep).join('/'))
    .sort()

describe('e2e 9：运行中杀掉进程再启动', () => {
  it('正在跑的步骤从断点继续，没有重复的输出文件', async () => {
    w = await startWorld({ image: 1 })
    const api = w.api
    await makeCategory(api, '地垫', [{ name: '', ratio: '3:2', white: [1200, 800] }])
    w.mock.script({ image: ['ok', { delay: 5000 }] })
    const [a] = await uploadJobs(api, ['a.png'])
    await waitJob(api, a.id, (j) => j.steps[2].state === 'running', 'a 正在生成主图')
    await waitFor(() => imageRequests(w!.mock).some((r) => r.images.length === 2), { label: '③ 的请求已发出' })
    await w.restart({ kill: true })
    const done = await waitJob(w.api, a.id, isDone, 'a 重启后完成')
    expect(done.steps.map((s: any) => s.state)).toEqual(['done', 'done', 'done', 'done', 'done', 'skipped'])
    expect(done.steps[1].attempts).toBe(1)
    expect(done.steps[2].attempts).toBe(1)
    expect(outFiles(w, '地垫')).toEqual(['主图/a.png', '空白图/a.png', '素材图/a.png'])
    // 被杀时那次请求算一次，重启后又发一次
    expect(imageRequests(w.mock).filter((r) => r.images.length === 2)).toHaveLength(2)
  })
})

describe('e2e 10：从 ③ 重做并改提示词', () => {
  it('下游步骤重跑，输出文件被覆盖，override 只生效一次', async () => {
    w = await startWorld()
    const api = w.api
    await makeCategory(api, '地垫', [{ name: '', ratio: '3:2', white: [1200, 800] }])
    const [a] = await uploadJobs(api, ['a.png'])
    const first = await waitJob(api, a.id, isDone)
    const mainFile = path.join(onlyBatch(w), '地垫', '主图', 'a.png')
    const before = fs.readFileSync(mainFile)

    const r = await api.json('POST', `/jobs/${a.id}/redo`, { step: 2, prompt: '新的贴图提示词' })
    expect(r.status).toBe(200)
    expect(r.body.job.override).toEqual({ step: 2, prompt: '新的贴图提示词' })
    expect(r.body.job.steps.map((s: any) => s.state)).toEqual(['done', 'done', expect.stringMatching(/^(pending|running)$/), 'pending', 'pending', 'pending'])
    expect(r.body.job.order).toBe(first.order)
    const second = await waitJob(api, a.id, isDone)
    expect(second.override).toBeNull()
    expect(second.steps[2].snapshot.prompt).toBe('新的贴图提示词')
    expect(second.steps[2].snapshot.prefix).toBe(first.steps[2].snapshot.prefix)
    const mains = imageRequests(w.mock).filter((q) => q.images.length === 2)
    expect(mains.at(-1)!.prompt).toBe(first.steps[2].snapshot.prefix + '新的贴图提示词')
    expect(w.mock.log().filter((e) => e.kind === 'info')).toHaveLength(2)
    expect(imageRequests(w.mock).filter((q) => q.prompt!.includes('竞品商品图'))).toHaveLength(1)
    expect(imageRequests(w.mock).filter((q) => q.prompt!.includes('Recreate'))).toHaveLength(2)
    expect(fs.readFileSync(mainFile).equals(before)).toBe(false)
    expect(outFiles(w, '地垫')).toEqual(['主图/a.png', '空白图/a.png', '素材图/a.png'])

    await api.json('POST', `/jobs/${a.id}/redo`, { step: 2 })
    const third = await waitJob(api, a.id, isDone)
    expect(third.steps[2].snapshot.prompt).toBe(DEFAULT_PASTE_PROMPT)

    const bad = await api.json('POST', `/jobs/${a.id}/redo`, { step: 7 })
    expect(bad.status).toBe(400)
  })
})

describe('e2e 11：运行中修改当前使用的模版', () => {
  it('已经进入 ② 的任务仍用旧的 plan；新任务用新模版', async () => {
    w = await startWorld({ image: 1 })
    const api = w.api
    const c = await makeCategory(api, '杯子', [{ name: '', ratio: '1:1' }], { name: '场景', prompt: '旧模版：把第一张图片印到{品类}上' })
    w.mock.setDefaultDelay(300)
    const [a] = await uploadJobs(api, ['a.png'])
    await waitJob(api, a.id, (j) => !!j.plan && j.steps[1].state === 'running', 'a 进入 ②')
    await api.json('PATCH', `/library/categories/${c.cid}/styles/${Object.values(c.styles)[0]}/templates/${c.tid}`, { prompt: '新模版：{品类}换个场景' })
    const [b] = await uploadJobs(api, ['b.png'])
    w.mock.setDefaultDelay(0)
    const aDone = await waitJob(api, a.id, isDone)
    const bDone = await waitJob(api, b.id, isDone)
    expect(aDone.steps[2].snapshot.prompt).toBe('旧模版：把第一张图片印到杯子上')
    expect(bDone.steps[2].snapshot.prompt).toBe('新模版：杯子换个场景')
  })
})
