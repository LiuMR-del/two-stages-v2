import { afterEach, describe, expect, it } from 'vitest'
import { startWorld, makeCategory, uploadJobs, waitJob, isDone, hasAttention, imageRequests, getJob, collectEvents, type World } from './harness'
import { png, waitFor } from '../helpers'

let w: World | null = null
afterEach(async () => {
  await w?.close()
  w = null
})

describe('e2e 3：没找到对应品类', () => {
  it('指定品类后回到队尾并完成；新建品类进入等白底图，上传后自动放行并完成', async () => {
    w = await startWorld({ analysis: 1 })
    const api = w.api
    const frame = await makeCategory(api, '相框', [{ name: '', ratio: '3:2', white: [1500, 1000] }])
    w.mock.script({ route: [{ route: { category_id: null, style_id: null, confidence: 0.9, guess: 'T恤' } }] })
    const [tee, fr] = await uploadJobs(api, ['tee.png', 'frame.png'])
    const t1 = await waitJob(api, tee.id, hasAttention('nomatch'), 'T恤 进需处理')
    expect(t1.attention).toMatchObject({ kind: 'nomatch', step: 0, guess: 'T恤', message: 'AI 判断是「T恤」，模版库里没有这个品类' })
    expect(t1.view.phase).toBe('attention')
    const f1 = await waitJob(api, fr.id, isDone, 'frame 完成')

    const r = await api.json('POST', `/jobs/${tee.id}/resolve`, { categoryId: frame.cid })
    expect(r.status).toBe(200)
    expect(r.body.job.order).toBeGreaterThan(f1.order)
    expect(r.body.job.route).toMatchObject({ categoryId: frame.cid, manual: true, confidence: null })
    const t2 = await waitJob(api, tee.id, isDone, 'T恤 完成')
    expect(t2.steps[0].state).toBe('done')

    // 新建品类 → 等白底图 → 上传后自动放行
    const ev = collectEvents(api)
    w.mock.script({ route: [{ route: { category_id: null, style_id: null, confidence: 0.9, guess: '帆布袋' } }] })
    const [bag] = await uploadJobs(api, ['bag.png'])
    await waitJob(api, bag.id, hasAttention('nomatch'), '帆布袋 进需处理')
    const c = await api.json('POST', `/jobs/${bag.id}/create-category`)
    expect(c.status).toBe(200)
    expect(c.body.job.attention).toMatchObject({ kind: 'nowhite', step: 1 })
    expect(c.body.job.attention.message).toBe('「帆布袋」还没有白底图，上传后这张图会自动继续')
    const lib = (await api.json('GET', '/library')).body.library
    const bagCat = lib.categories.find((x: any) => x.name === '帆布袋')
    expect(bagCat).toBeTruthy()
    expect(imageRequests(w.mock).filter((q) => q.prompt!.includes('帆布袋'))).toHaveLength(0)

    await api.upload('PUT', `/library/categories/${bagCat.id}/styles/${bagCat.styles[0].id}/white`, 'file', [
      { name: 'w.png', buffer: await png(1000, 1000, { r: 255, g: 255, b: 255 }), type: 'image/png' },
    ])
    const b2 = await waitJob(api, bag.id, isDone, '帆布袋 完成')
    expect(b2.route.categoryName).toBe('帆布袋')
    await waitFor(() => ev.events.some((e) => e.name === 'toast' && e.data.message === '1 张等白底图的图已回到队列'), { label: '放行提示' })
    ev.close()
  })

  it('把握低于阈值、清单为空、重新识别', async () => {
    w = await startWorld()
    const api = w.api
    const [x] = await uploadJobs(api, ['x.png'])
    const empty = await waitJob(api, x.id, hasAttention('nomatch'))
    expect(empty.attention.message).toBe('模版库还没有品类，请先到模版库添加')
    expect(w.mock.log().filter((e) => e.endpoint === 'chat/completions')).toHaveLength(0)

    const frame = await makeCategory(api, '相框', [
      { name: '横版', ratio: '3:2', white: [1500, 1000] },
      { name: '竖版', ratio: '2:3', white: [1000, 1500] },
    ])
    w.mock.script({
      route: [
        { route: { category_id: frame.cid, style_id: frame.styles['横版']!, confidence: 0.5, guess: '相框' } },
        { route: { category_id: frame.cid, style_id: 'nope', confidence: 0.9, guess: '相框' } },
        { route: { category_id: frame.cid, style_id: frame.styles['竖版']!, confidence: 0.9, guess: '相框' } },
      ],
    })
    await api.json('POST', `/jobs/${x.id}/redo`, { step: 0 })
    const low = await waitJob(api, x.id, (j) => j.attention?.message?.includes('把握'))
    expect(low.attention.message).toBe('AI 认为是「相框·横版」，但把握只有 0.50')
    await api.json('POST', `/jobs/${x.id}/redo`, { step: 0 })
    const nostyle = await waitJob(api, x.id, (j) => j.attention?.message?.includes('款式'))
    expect(nostyle.attention.message).toBe('认出是相框，但判断不了款式')
    await api.json('POST', `/jobs/${x.id}/redo`, { step: 0 })
    const ok = await waitJob(api, x.id, isDone)
    expect(ok.route).toMatchObject({ styleName: '竖版', ratio: '2:3', manual: false })
  })
})

describe('e2e 4：生图连续 5 次 500', () => {
  it('这张图进入失败，其他图照常完成；重试后完成', async () => {
    w = await startWorld({ image: 1 })
    const api = w.api
    await makeCategory(api, '地垫', [{ name: '', ratio: '3:2', white: [1200, 800] }])
    w.mock.script({ image: Array.from({ length: 5 }, () => ({ status: 500 })) })
    const [a] = await uploadJobs(api, ['a.png'])
    const failed = await waitJob(api, a.id, hasAttention('failed'), 'a 失败')
    expect(failed.attention.step).toBe(1)
    expect(failed.steps[1]).toMatchObject({ state: 'failed', attempts: 5 })
    expect(failed.attention.message).toContain('重试 4 次仍失败')
    expect(imageRequests(w.mock).filter((r) => r.status === 500)).toHaveLength(5)

    const [b] = await uploadJobs(api, ['b.png'])
    const bDone = await waitJob(api, b.id, isDone, 'b 完成')
    expect((await getJob(api, a.id)).attention.kind).toBe('failed')

    const r = await api.json('POST', `/jobs/${a.id}/retry`)
    expect(r.body.job.order).toBeGreaterThan(bDone.order)
    const aDone = await waitJob(api, a.id, isDone, 'a 重试后完成')
    expect(aDone.steps[1].attempts).toBe(1)
  })
})

describe('e2e 5：内容被拒', () => {
  it('只请求一次，不重试；可以改提示词后重做', async () => {
    w = await startWorld()
    const api = w.api
    await makeCategory(api, '地垫', [{ name: '', ratio: '3:2', white: [1200, 800] }])
    w.mock.script({ image: ['refused'] })
    const [a] = await uploadJobs(api, ['a.png'])
    const j = await waitJob(api, a.id, hasAttention('refused'))
    expect(j.attention.step).toBe(1)
    expect(j.attention.message).toMatch(/^内容被拒：/)
    expect(j.steps[1]).toMatchObject({ state: 'failed', attempts: 1 })
    expect(imageRequests(w.mock)).toHaveLength(1)

    const r = await api.json('POST', `/jobs/${a.id}/redo`, { step: 1, prompt: '只提取图案，保持原样' })
    expect(r.status).toBe(200)
    const done = await waitJob(api, a.id, isDone)
    expect(done.steps[1].snapshot.prompt).toBe('只提取图案，保持原样')
    expect(done.override).toBeNull()
  })
})
