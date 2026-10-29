import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startWorld, makeCategory, uploadJobs, waitJob, isDone, type World } from './harness'
import { localDay } from '../../server/src/util/ids'

let w: World | null = null
afterEach(async () => {
  await w?.close()
  w = null
})

const prefix = () => {
  const [y, m, d] = localDay().split('-')
  return `HJ-mtfl${y!.slice(-1)}7${m}${d}`
}

describe('e2e：子体 SKU 和按 SKU 命名的输出文件', () => {
  it('品类填了材质缩写：每张图发一个 SKU，输出文件用它命名；清空队列、重启后接着往后排；没填的品类用原文件名', async () => {
    w = await startWorld()
    const api = w.api
    const blanket = await makeCategory(api, '毛毯', [{ name: '', ratio: '4:5', white: [1200, 1500] }])
    const { cid } = blanket
    expect((await api.json('PATCH', `/library/categories/${cid}`, { skuCode: 'mtfl' })).status).toBe(200)
    expect((await api.json('PATCH', `/library/categories/${cid}`, { skuCode: 'mt fl' })).status).toBe(400)
    expect((await api.json('PUT', '/settings', { parent: { creatorMark: '1' } })).status).toBe(200)

    const jobs = await uploadJobs(api, ['a.png', 'b.png'])
    const done = await Promise.all(jobs.map((j) => waitJob(api, j.id, isDone)))
    const skus = done.map((d) => d.sku).sort()
    expect(skus).toEqual([`${prefix()}101`, `${prefix()}102`])
    for (const d of done) {
      expect(d.outputBase).toBe(d.sku)
      const catDir = path.join(w.outDir, d.outputFolder, '毛毯')
      expect(fs.existsSync(path.join(catDir, '主图', d.sku + '.png'))).toBe(true)
      expect(fs.existsSync(path.join(catDir, '素材图', d.sku + '.png'))).toBe(true)
    }
    const csv = fs.readFileSync(path.join(w.outDir, done[0]!.outputFolder, '识别信息.csv'), 'utf8')
    expect(csv).toContain(`a.png,${done.find((d) => d.source.originalName === 'a.png')!.sku},毛毯`)

    // 清空队列开新批次，序号不重来
    expect((await api.json('POST', '/jobs/clear-all')).status).toBe(200)
    const [c] = await uploadJobs(api, ['c.png'])
    expect((await waitJob(api, c.id, isDone)).sku).toBe(`${prefix()}103`)

    // 重启后接着排
    await w.restart()
    const [d] = await uploadJobs(w.api, ['d.png'])
    expect((await waitJob(w.api, d.id, isDone)).sku).toBe(`${prefix()}104`)

    // 清掉材质缩写：不发 SKU，文件名用原图名
    expect((await w.api.json('PATCH', `/library/categories/${cid}`, { skuCode: '' })).status).toBe(200)
    const [e] = await uploadJobs(w.api, ['e.png'])
    const de = await waitJob(w.api, e.id, isDone)
    expect(de.sku).toBeNull()
    expect(de.outputBase).toBe('e')
  })
})
