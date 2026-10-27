import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { startWorld, makeCategory, uploadJobs, waitJob, isDone, imageRequests, getJobs, type World, onlyBatch } from './harness'
import { DEFAULT_EXTRACT_PROMPT, DEFAULT_PASTE_PROMPT } from '../../server/src/library/schema'
import { EXTRACT_CONSTRAINT } from '../../server/src/prompts/extract'
import { PASTE_CONSTRAINT } from '../../server/src/prompts/main'
import { localDay } from '../../server/src/util/ids'
import { waitFor } from '../helpers'

let w: World | null = null
afterEach(async () => {
  await w?.close()
  w = null
})

const dims = async (f: string) => {
  const m = await sharp(f).metadata()
  return [m.width, m.height]
}

describe('e2e 1：混合品类走完全程', () => {
  it('每个请求的图片张数、顺序、提示词都对；输出文件和 CSV 都在', async () => {
    w = await startWorld({ image: 1, analysis: 1 })
    const api = w.api
    const frame = await makeCategory(api, '相框', [
      { name: '横版', ratio: '3:2', white: [1500, 1000] },
      { name: '竖版', ratio: '2:3', white: [1000, 1500] },
    ])
    const mug = await makeCategory(api, '杯子', [{ name: '', ratio: '1:1' }], { name: '杯子场景', prompt: '把第二张图片印到第一张图片里的{品类}杯身上', images: { '': [1200, 900] } })
    const blanket = await makeCategory(api, '毛毯', [{ name: '', ratio: '5:4' }], { name: '毛毯无图', prompt: '把第一张图片做成{品类}的商品主图' })
    w.mock.script({
      route: [
        { route: { category_id: frame.cid, style_id: frame.styles['横版']!, confidence: 0.95, guess: '相框' } },
        { route: { category_id: frame.cid, style_id: frame.styles['竖版']!, confidence: 0.9, guess: '相框' } },
        { route: { category_id: mug.cid, style_id: null, confidence: 0.88, guess: '杯子' } },
        { route: { category_id: blanket.cid, style_id: 'bogus', confidence: 0.8, guess: '毛毯' } },
      ],
      info: ['ok', 'ok', 'ok', { info: { scene: '沙发上的毛毯', keywords: ['throw blanket', 'Throw Blanket', 'soft blanket'], customizable: ['图案风格'], blank_items: [] } }],
    })
    const created = await uploadJobs(api, ['frame_h.png', 'frame_v.png', 'mug.png', 'blanket.png'])
    expect(created).toHaveLength(4)
    const done = []
    for (const j of created) done.push(await waitJob(api, j.id, isDone, j.source.originalName))
    const [fh, fv, mg, bk] = done

    expect(fh.route).toMatchObject({ categoryName: '相框', styleName: '横版', ratio: '3:2', manual: false, confidence: 0.95 })
    expect(fv.route).toMatchObject({ categoryName: '相框', styleName: '竖版', ratio: '2:3' })
    expect(mg.route).toMatchObject({ categoryName: '杯子', styleName: '' })
    expect(bk.route).toMatchObject({ categoryName: '毛毯', styleName: '' })
    expect(bk.steps[4].state).toBe('skipped')
    expect(bk.info.keywords).toEqual(['throw blanket', 'soft blanket'])
    expect(fh.info.blankItemsEn).toEqual(['the name text', 'the personal photo'])

    const reqs = imageRequests(w.mock)
    expect(reqs).toHaveLength(11)
    const extract = (cat: string, ratio: string) => DEFAULT_EXTRACT_PROMPT.replace('{品类}', cat).replace('{比例}', ratio)
    const find = (start: string) => {
      const hits = reqs.filter((r) => r.prompt!.startsWith(start))
      expect(hits, start + "\n" + reqs.map((r) => JSON.stringify(r.prompt!.slice(0, 80))).join("\n")).toHaveLength(1)
      return hits[0]!
    }
    // ② 只发竞品图一张，画布和 size 按款式比例
    const e1 = find('[Canvas: 3:2 landscape format] 第一张图片是竞品商品图。\n')
    expect(e1.prompt).toBe('[Canvas: 3:2 landscape format] 第一张图片是竞品商品图。\n' + EXTRACT_CONSTRAINT + '\n' + extract('相框', '3:2'))
    expect(e1.images.map((i) => [i.field, i.width, i.height])).toEqual([['image', 800, 600]])
    expect(e1.fields).toMatchObject({ size: '1536x1024', quality: 'high', input_fidelity: 'high', n: '1' })
    expect(find('[Canvas: 2:3 portrait format] 第一张图片是竞品商品图。\n').fields.size).toBe('1024x1536')
    expect(find('[Canvas: 1:1 square format] 第一张图片是竞品商品图。\n').fields.size).toBe('1024x1024')
    expect(find('[Canvas: 5:4 landscape format] 第一张图片是竞品商品图。\n').fields.size).toBe('1536x1024')

    // ③ 默认模版：白底图 + 素材图
    const m1 = find('[Canvas: 3:2 landscape format] 第一张图片是白底图，第二张图片是素材图。\n')
    expect(m1.prompt).toBe('[Canvas: 3:2 landscape format] 第一张图片是白底图，第二张图片是素材图。\n' + PASTE_CONSTRAINT + '\n' + DEFAULT_PASTE_PROMPT)
    expect(m1.images.map((i) => [i.field, i.width, i.height])).toEqual([
      ['image[]', 1500, 1000],
      ['image[]', 1536, 1024],
    ])
    expect(m1.fields.size).toBe('1536x1024')
    const m2 = find('[Canvas: 2:3 portrait format] 第一张图片是白底图，第二张图片是素材图。\n')
    expect(m2.images.map((i) => [i.width, i.height])).toEqual([
      [1000, 1500],
      [1024, 1536],
    ])
    expect(m2.fields.size).toBe('1024x1536')
    // ③ 自定义模版有参考图：画布按参考图实际尺寸
    const m3 = find('[Canvas: 4:3 landscape format] 第一张图片是参考图，第二张图片是素材图。\n')
    expect(m3.prompt).toBe('[Canvas: 4:3 landscape format] 第一张图片是参考图，第二张图片是素材图。\n把第二张图片印到第一张图片里的杯子杯身上')
    expect(m3.images.map((i) => [i.width, i.height])).toEqual([
      [1200, 900],
      [1024, 1024],
    ])
    expect(m3.fields.size).toBe('1536x1024')
    // ③ 自定义模版无参考图：只发素材图
    const m4 = find('[Canvas: 5:4 landscape format] 第一张图片是素材图。\n')
    expect(m4.prompt).toBe('[Canvas: 5:4 landscape format] 第一张图片是素材图。\n把第一张图片做成毛毯的商品主图')
    expect(m4.images.map((i) => [i.field, i.width, i.height])).toEqual([['image', 1536, 1024]])

    // ⑤ 按主图实际宽高；清单只出现一次
    const blanks = reqs.filter((r) => r.prompt!.includes('Recreate this exact image'))
    expect(blanks).toHaveLength(3)
    for (const b of blanks) {
      expect(b.images).toHaveLength(1)
      expect(b.prompt!.match(/the name text, the personal photo/g)).toHaveLength(1)
      expect(b.prompt).not.toMatch(/fill the canvas|edge to edge|铺满画布/i)
    }

    // 快照就是实际发出的内容
    for (const [job, req] of [[fh, m1], [mg, m3], [bk, m4]] as const) {
      const snap = job.steps[2].snapshot
      expect(snap.prefix + snap.prompt).toBe(req.prompt)
      expect(snap.images.map((i: any) => i.sha256)).toEqual(req.images.map((i) => i.sha256))
      expect(snap.size).toBe(req.fields.size)
    }
    expect(fh.steps[2].snapshot.images.map((i: any) => [i.no, i.role])).toEqual([
      [1, '白底图'],
      [2, '素材图'],
    ])

    // 输出文件
    const day = localDay()
    const frameDir = path.join(onlyBatch(w), '相框')
    for (const f of ['素材图/frame_h.png', '主图/frame_h.png', '空白图/frame_h.png', '素材图/frame_v.png', '主图/frame_v.png', '空白图/frame_v.png']) {
      expect(fs.existsSync(path.join(frameDir, f)), f).toBe(true)
    }
    expect(await dims(path.join(frameDir, '主图', 'frame_h.png'))).toEqual([1536, 1536])
    expect(await dims(path.join(frameDir, '空白图', 'frame_h.png'))).toEqual([1536, 1536])
    expect(fs.existsSync(path.join(onlyBatch(w), '毛毯', '主图', 'blanket.png'))).toBe(true)
    expect(fs.existsSync(path.join(onlyBatch(w), '毛毯', '空白图', 'blanket.png'))).toBe(false)
    const csvFile = path.join(onlyBatch(w), '识别信息.csv')
    await waitFor(() => fs.existsSync(csvFile) && fs.readFileSync(csvFile, 'utf8').trim().split('\r\n').length === 5, { label: 'CSV 写完 4 行' })
    const csv = fs.readFileSync(csvFile, 'utf8')
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    const lines = csv.trim().split('\r\n')
    expect(lines[0]).toBe('原文件名,品类,款式,场景,关键词,可定制项,主图文件')
    expect(lines).toHaveLength(5)
    expect(csv).toContain('throw blanket; soft blanket')
    const dl = await api.raw(`/info.csv?day=${day}`)
    expect(dl.headers.get('content-type')).toContain('text/csv')
    expect(await dl.text()).toContain('frame_h.png')
  })
})

describe('e2e 2：运行到一半追加图片', () => {
  it('先加的图不受影响，新加的图排在后面', async () => {
    w = await startWorld({ image: 1, analysis: 1 })
    const api = w.api
    await makeCategory(api, '地垫', [{ name: '', ratio: '3:2', white: [1200, 800] }])
    w.mock.setDefaultDelay(120)
    const first = await uploadJobs(api, ['a.png', 'b.png'])
    await waitJob(api, first[0].id, (j) => j.steps[1].state === 'running', 'a 进入 ②')
    const later = await uploadJobs(api, ['c.png', 'd.png'])
    for (const j of [...first, ...later]) await waitJob(api, j.id, isDone, j.source.originalName)
    const all = await getJobs(api)
    const order = Object.fromEntries(all.map((j: any) => [j.source.originalName, j.order]))
    expect(order['c.png']).toBeGreaterThan(order['b.png'])
    expect(order['d.png']).toBeGreaterThan(order['c.png'])
    const reqs = imageRequests(w.mock)
    const mainIdx = (name: string) => {
      const job = all.find((j: any) => j.source.originalName === name)
      const sha = job.steps[2].snapshot.images.at(-1).sha256
      return reqs.findIndex((r) => r.images.length === 2 && r.images[1]!.sha256 === sha)
    }
    expect(mainIdx('a.png')).toBeLessThan(mainIdx('c.png'))
    expect(mainIdx('b.png')).toBeLessThan(mainIdx('c.png'))
    expect(mainIdx('c.png')).toBeLessThan(mainIdx('d.png'))
    const a = all.find((j: any) => j.source.originalName === 'a.png')
    expect(a.steps.map((s: any) => s.attempts)).toEqual([1, 1, 1, 1, 1, 0])
    // 识别父体默认关闭：第 6 步跳过，一个飞书、店铺、父体匹配请求都没有
    for (const j of all) expect(j.steps[5]).toMatchObject({ state: 'skipped', note: '识别父体没有打开，可以在设置里打开' })
    for (const j of all) expect(j.parent).toBeNull()
    expect(w.mock.parent.calls).toEqual([])
    expect(w.mock.log().filter((e) => e.kind === 'parent')).toEqual([])
    await waitFor(async () => (await api.json('GET', '/queue')).body.slots.image.busy === 0)
  })
})
