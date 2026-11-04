import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startWorld, makeCategory, uploadJobs, waitJob, getJob, isDone, type World } from './harness'
import { localDay } from '../../server/src/util/ids'

/** 多店铺方案第 3 段：一批一个店铺、按店铺缩写和款式标记发 SKU、专属号默认 0、「改专属号」 */

let w: World | null = null
afterEach(async () => {
  await w?.close()
  w = null
})

const ymd = () => {
  const [y, m, d] = localDay().split('-')
  return `${y!.slice(-1)}7${m}${d}`
}

describe('e2e：店铺切换和 SKU', () => {
  it('款式标记加在材质前；队列有图不能换店铺；清空后换到爱睿特，新的一批用 ART、进新文件夹', async () => {
    w = await startWorld()
    const api = w.api
    const canvas = await makeCategory(api, '帆布画', [
      { name: '横版', ratio: '3:2', white: [1500, 1000] },
      { name: '竖版', ratio: '2:3', white: [1000, 1500] },
    ])
    expect((await api.json('PATCH', `/library/categories/${canvas.cid}`, { skuCode: 'xkfb' })).status).toBe(200)
    expect((await api.json('PATCH', `/library/categories/${canvas.cid}/styles/${canvas.styles['横版']}`, { skuMark: 'hb' })).status).toBe(200)
    expect((await api.json('PATCH', `/library/categories/${canvas.cid}/styles/${canvas.styles['竖版']}`, { skuMark: 'SB' })).status).toBe(200)
    expect((await api.json('PATCH', `/library/categories/${canvas.cid}/styles/${canvas.styles['竖版']}`, { skuMark: 'S1' })).status).toBe(400)

    w.mock.script({ route: [{ route: { category_id: canvas.cid, style_id: canvas.styles['竖版']!, confidence: 0.9 } }] })
    const [a] = await uploadJobs(api, ['a.png'])
    const da = await waitJob(api, a.id, isDone)
    const [b] = await uploadJobs(api, ['b.png'])
    const db = await waitJob(api, b.id, isDone)
    expect(da.sku).toBe(`HJ-SBxkfb${ymd()}001`)
    expect(db.sku).toBe(`HJ-HBxkfb${ymd()}001`)
    expect(da.storeId).toBe('hj')
    expect((await api.json('GET', '/batch')).body).toMatchObject({ storeId: 'hj', storeName: '焕捷', mark: '0', folder: da.outputFolder })

    // 队列里有图：不能换店铺，也不能删焕捷
    const blocked = await api.json('POST', '/stores/art/use')
    expect(blocked.status).toBe(409)
    expect(blocked.body.error).toContain('清空队列')
    expect((await api.json('GET', '/settings')).body.currentStoreId).toBe('hj')

    expect((await api.json('POST', '/jobs/clear-all')).status).toBe(200)
    const used = await api.json('POST', '/stores/art/use')
    expect(used.status).toBe(200)
    expect(used.body.currentStoreId).toBe('art')
    const [c] = await uploadJobs(api, ['c.png'])
    const dc = await waitJob(api, c.id, isDone)
    expect(dc.storeId).toBe('art')
    expect(dc.sku).toBe(`ART-HBxkfb${ymd()}001`)
    expect(dc.outputFolder).not.toBe(da.outputFolder)
    expect((await api.json('GET', '/batch')).body).toMatchObject({ storeId: 'art', storeName: '爱睿特', mark: '0' })
    // 当前店铺不能删；队列里还有爱睿特的图，也不能切回焕捷
    expect([400, 409]).toContain((await api.json('DELETE', '/stores/art')).status)
    expect((await api.json('POST', '/stores/hj/use')).status).toBe(409)

    // 重启后：还是爱睿特，同一批接着用
    await w.restart()
    const [d] = await uploadJobs(w.api, ['d.png'])
    const dd = await waitJob(w.api, d.id, isDone)
    expect(dd).toMatchObject({ storeId: 'art', outputFolder: dc.outputFolder, sku: `ART-HBxkfb${ymd()}002` })
  })
})

describe('e2e：改专属号', () => {
  it('预览不改东西；有冲突不改；改了之后三类文件、CSV、队列里的图都换成新号，移出队列的图也改；之后发的号也用新号', async () => {
    w = await startWorld()
    const api = w.api
    const blanket = await makeCategory(api, '毛毯', [{ name: '', ratio: '4:5', white: [1200, 1500] }])
    expect((await api.json('PATCH', `/library/categories/${blanket.cid}`, { skuCode: 'mtfl' })).status).toBe(200)
    const head = `HJ-mtfl${ymd()}`

    const first = await uploadJobs(api, ['a.png', 'b.png'])
    await Promise.all(first.map((j) => waitJob(api, j.id, isDone)))
    expect((await api.json('POST', '/jobs/clear-done')).body.removed).toBe(2)
    const [c] = await uploadJobs(api, ['c.png'])
    const dc = await waitJob(api, c.id, isDone)
    expect(dc.sku).toBe(`${head}003`)
    const catDir = path.join(w.outDir, dc.outputFolder, '毛毯')
    const has = (kind: string, sku: string) => fs.existsSync(path.join(catDir, kind, sku + '.png'))
    expect(has('主图', `${head}001`) && has('素材图', `${head}001`)).toBe(true)

    // 预览：三张都列出来，不动文件
    const pre = await api.json('POST', '/batch/mark', { mark: '1' })
    expect(pre.status).toBe(200)
    expect(pre.body).toMatchObject({ from: '0', to: '1', applied: false })
    expect(pre.body.items.map((x: any) => [x.old, x.next, x.inQueue, x.conflict])).toEqual([
      [`${head}001`, `${head}101`, false, null],
      [`${head}002`, `${head}102`, false, null],
      [`${head}003`, `${head}103`, true, null],
    ])
    expect(has('主图', `${head}001`)).toBe(true)

    // 输出文件夹里已经有新名字：算冲突，不改
    fs.writeFileSync(path.join(catDir, '主图', `${head}102.png`), 'x')
    const clash = await api.json('POST', '/batch/mark', { mark: '1', apply: true })
    expect(clash.body.applied).toBe(false)
    expect(clash.body.items.find((x: any) => x.next === `${head}102`).conflict).toContain('输出文件夹')
    expect(has('主图', `${head}001`)).toBe(true)
    fs.rmSync(path.join(catDir, '主图', `${head}102.png`))

    const done = await api.json('POST', '/batch/mark', { mark: '1', apply: true })
    expect(done.body.applied).toBe(true)
    for (const n of ['1', '2', '3']) {
      expect(has('主图', `${head}10${n}`) && has('素材图', `${head}10${n}`)).toBe(true)
      expect(has('主图', `${head}00${n}`) || has('素材图', `${head}00${n}`)).toBe(false)
    }
    const csv = fs.readFileSync(path.join(w.outDir, dc.outputFolder, '识别信息.csv'), 'utf8')
    expect(csv).toContain(`${head}101`)
    expect(csv).toContain(`${head}103`)
    expect(csv).not.toContain(`${head}001`)
    expect(csv).toContain(path.join('毛毯', '主图', `${head}102.png`))
    const nc = await getJob(api, c.id)
    expect(nc).toMatchObject({ sku: `${head}103`, outputBase: `${head}103`, skuMeta: { head, mark: '1', seq: '03' } })
    expect((await api.json('GET', '/batch')).body.mark).toBe('1')

    // 之后再发的号用新专属号，跳过已经占了的
    const [d] = await uploadJobs(api, ['d.png'])
    expect((await waitJob(api, d.id, isDone)).sku).toBe(`${head}104`)
    // 格式不对
    expect((await api.json('POST', '/batch/mark', { mark: '1-' })).status).toBe(400)

    // 改回 0：001～003 原来就是这几张图自己的，不算「发过的号」冲突；d 改回 0 是 004，0 号下没发过
    const back = await api.json('POST', '/batch/mark', { mark: '0' })
    expect(back.body.items.map((x: any) => [x.next, x.conflict])).toEqual([
      [`${head}001`, null],
      [`${head}002`, null],
      [`${head}003`, null],
      [`${head}004`, null],
    ])

    // 队列里有焕捷的图：不能改焕捷的缩写
    expect((await api.json('PATCH', '/stores/hj', { abbr: 'HJX' })).status).toBe(409)
  })

  it('同一天两批都改成同一个专属号，再加图不会和前一批重号', async () => {
    w = await startWorld()
    const api = w.api
    const blanket = await makeCategory(api, '毛毯', [{ name: '', ratio: '4:5', white: [1200, 1500] }])
    expect((await api.json('PATCH', `/library/categories/${blanket.cid}`, { skuCode: 'mtfl' })).status).toBe(200)
    const head = `HJ-mtfl${ymd()}`
    // 第一批 2 张改成 5
    const one = await uploadJobs(api, ['a.png', 'b.png'])
    await Promise.all(one.map((j) => waitJob(api, j.id, isDone)))
    expect((await api.json('POST', '/batch/mark', { mark: '5', apply: true })).body.applied).toBe(true)
    // 清空开第二批，加 1 张（0 号第 3 个），也改成 5
    expect((await api.json('POST', '/jobs/clear-all')).status).toBe(200)
    const [c] = await uploadJobs(api, ['c.png'])
    expect((await waitJob(api, c.id, isDone)).sku).toBe(`${head}003`)
    const second = await api.json('POST', '/batch/mark', { mark: '5', apply: true })
    expect(second.body.items.map((x: any) => x.next)).toEqual([`${head}503`])
    // 第二批再加图：5 号的 501、502 是第一批的，503 是这一批的，从 504 起
    const [d] = await uploadJobs(api, ['d.png'])
    expect((await waitJob(api, d.id, isDone)).sku).toBe(`${head}504`)
    // 第二批改成 6 再改回 5：503、504 是自己以前的号，不算冲突
    const toSix = await api.json('POST', '/batch/mark', { mark: '6', apply: true })
    expect(toSix.body.applied).toBe(true)
    const backToFive = await api.json('POST', '/batch/mark', { mark: '5' })
    expect(backToFive.body.items.map((x: any) => [x.next, x.conflict])).toEqual([
      [`${head}503`, null],
      [`${head}504`, null],
    ])
    // 6 号下 603、604 是改出来的，601 没发过：新图拿 601，不会和谁重
    const [e] = await uploadJobs(api, ['e.png'])
    expect((await waitJob(api, e.id, isDone)).sku).toBe(`${head}601`)
  })
})
