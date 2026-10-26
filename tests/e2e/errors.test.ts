import { afterEach, describe, expect, it } from 'vitest'
import { startWorld, makeCategory, uploadJobs, waitJob, isDone, imageRequests, getJob, type World } from './harness'
import { waitFor } from '../helpers'

let w: World | null = null
afterEach(async () => {
  await w?.close()
  w = null
})

describe('e2e 6：401', () => {
  it('只有生图类步骤暂停，分析照常进行；保存设置后自动继续', async () => {
    w = await startWorld()
    const api = w.api
    await makeCategory(api, '地垫', [{ name: '', ratio: '3:2', white: [1200, 800] }])
    w.mock.script({ image: [{ status: 401 }] })
    const [a] = await uploadJobs(api, ['a.png'])
    const q = await waitFor(async () => {
      const r = (await api.json('GET', '/queue')).body
      return r.paused ? r : null
    })
    expect(q.paused).toEqual({ by: 'auth', kind: 'image', message: '生图接口 Key 无效或无权限' })
    const aj = await getJob(api, a.id)
    expect(aj.attention).toBeNull()
    expect(aj.steps[1].state).toBe('pending')

    const [b] = await uploadJobs(api, ['b.png'])
    const bj = await waitJob(api, b.id, (j) => j.steps[0].state === 'done', 'b 的识别照常完成')
    expect(bj.steps[1].state).toBe('pending')
    await new Promise((r) => setTimeout(r, 200))
    expect(imageRequests(w.mock)).toHaveLength(1)

    const s = await api.json('PUT', '/settings', { image: { apiKey: 'sk-new-image-key-4321' } })
    expect(s.body.image.apiKey).toBe('sk-…4321')
    expect((await api.json('GET', '/queue')).body.paused).toBeNull()
    await waitJob(api, a.id, isDone, 'a 完成')
    await waitJob(api, b.id, isDone, 'b 完成')
  })
})

describe('e2e 7：429', () => {
  it('等待后继续，不计入重试次数', async () => {
    w = await startWorld()
    const api = w.api
    await makeCategory(api, '地垫', [{ name: '', ratio: '3:2', white: [1200, 800] }])
    w.mock.script({ image: [{ status: 429, retryAfter: 1 }], route: [{ status: 429 }] })
    const [a] = await uploadJobs(api, ['a.png'])
    const done = await waitJob(api, a.id, isDone)
    expect(done.steps[0].attempts).toBe(1)
    expect(done.steps[1].attempts).toBe(1)
    const extracts = imageRequests(w.mock).filter((r) => r.prompt!.includes('竞品商品图'))
    expect(extracts.map((r) => r.status)).toEqual([429, 200])
  })
})

describe('e2e 8：中转站不支持保真参数', () => {
  it('自动降级，之后的请求都不带这两个参数，sendFidelity 写成 false', async () => {
    w = await startWorld({ image: 1 })
    const api = w.api
    await makeCategory(api, '地垫', [{ name: '', ratio: '3:2', white: [1200, 800] }])
    w.mock.script({ image: ['unknownParam'] })
    const [a, b] = await uploadJobs(api, ['a.png', 'b.png'])
    const aDone = await waitJob(api, a.id, isDone)
    await waitJob(api, b.id, isDone)
    const reqs = imageRequests(w.mock)
    expect(reqs[0]!.status).toBe(400)
    expect(reqs[0]!.fields.input_fidelity).toBe('high')
    for (const r of reqs.slice(1)) {
      expect(r.fields.quality).toBeUndefined()
      expect(r.fields.input_fidelity).toBeUndefined()
    }
    expect(aDone.steps[1].attempts).toBe(1)
    expect(aDone.steps[1].snapshot.params).toEqual({ n: 1, size: '1536x1024' })
    const s = (await api.json('GET', '/settings')).body
    expect(s.image.sendFidelity).toBe(false)
    expect(s.image.fidelityAutoDisabled).toBe(true)
    // 用户重新打开后清掉自动关闭的标记
    const s2 = await api.json('PUT', '/settings', { image: { sendFidelity: true } })
    expect(s2.body.image).toMatchObject({ sendFidelity: true, fidelityAutoDisabled: false })
  })
})

describe('任务接口的其他情况', () => {
  it('非 PNG/JPG/WebP 转成 PNG；解不开的逐张报错，其余照常入队', async () => {
    w = await startWorld()
    const api = w.api
    const sharp = (await import('sharp')).default
    const gif = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#3a6' } }).gif().toBuffer()
    const r = await api.upload('POST', '/jobs', 'files', [
      { name: '动图.gif', buffer: gif, type: 'image/gif' },
      { name: '坏文件.png', buffer: Buffer.from('not an image at all'), type: 'image/png' },
    ])
    expect(r.status).toBe(200)
    expect(r.body.jobs).toHaveLength(1)
    expect(r.body.jobs[0].source).toMatchObject({ file: 'source.png', originalName: '动图.gif', width: 300, height: 200 })
    expect(r.body.errors).toEqual([{ name: '坏文件.png', error: '无法识别的图片格式，或文件已损坏' }])
    const thumb = await api.raw(`/jobs/${r.body.jobs[0].id}/files/source?size=thumb`)
    expect(thumb.status).toBe(200)
    expect((await api.raw(`/jobs/${r.body.jobs[0].id}/files/other`)).status).toBe(400)
  })

  it('删除正在运行的任务：先中止请求再删；清除已完成', async () => {
    w = await startWorld({ image: 1, analysis: 1 })
    const api = w.api
    await makeCategory(api, '地垫', [{ name: '', ratio: '3:2', white: [1200, 800] }])
    w.mock.script({ image: [{ delay: 5000 }] })
    const [a, b] = await uploadJobs(api, ['a.png', 'b.png'])
    await waitJob(api, a.id, (j) => j.steps[1].state === 'running')
    const d = await api.json('DELETE', `/jobs/${a.id}`)
    expect(d.status).toBe(200)
    expect(await getJob(api, a.id)).toBeUndefined()
    await waitJob(api, b.id, isDone, 'b 完成')
    const c = await api.json('POST', '/jobs/clear-done')
    expect(c.body.removed).toBe(1)
    expect((await api.json('GET', '/jobs')).body.jobs).toEqual([])
    expect((await api.json('DELETE', `/jobs/${b.id}`)).status).toBe(404)
  })
})
