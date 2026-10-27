import { afterEach, describe, expect, it } from 'vitest'
import { startWorld, makeCategory, type World } from './harness'

const worlds: World[] = []
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close()
})

describe('e2e 12：模版库导出导入', () => {
  it('导出后在空库导入数据一致；合并模式同名品类覆盖原品类', async () => {
    const a = await startWorld()
    worlds.push(a)
    await makeCategory(
      a.api,
      '相框',
      [
        { name: '横版', ratio: '3:2', white: [1500, 1000] },
        { name: '竖版', ratio: '2:3', white: [1000, 1500] },
      ],
      { name: '客厅', prompt: '把第二张图片贴到第一张图片的画上', images: { 横版: [1200, 900] } },
      '挂墙相框',
    )
    await makeCategory(a.api, '毛毯', [{ name: '', ratio: '5:4', white: [1250, 1000] }])
    await a.api.json('PUT', '/library/defaults', { extractPrompt: '导出前改过的提取提示词 {品类}' })
    const src = (await a.api.json('GET', '/library')).body
    const zip = Buffer.from(await (await a.api.raw('/library/export')).arrayBuffer())

    const b = await startWorld()
    worlds.push(b)
    const imp = await b.api.upload('POST', '/library/import?mode=replace', 'file', [{ name: 'lib.zip', buffer: zip }])
    expect(imp.status).toBe(200)
    const got = (await b.api.json('GET', '/library')).body
    expect(got.library).toEqual(src.library)
    expect(got.checks).toEqual(src.checks)
    for (const c of src.library.categories) {
      for (const s of c.styles) {
        if (!s.whiteImage) continue
        expect((await b.api.raw(`/library/images/${s.whiteImage}`)).status).toBe(200)
      }
    }

    const c = await startWorld()
    worlds.push(c)
    const local = await makeCategory(c.api, '相框', [{ name: '', ratio: '1:1' }], undefined, '本地的说明')
    await makeCategory(c.api, '杯子', [{ name: '', ratio: '1:1' }])
    const merged = await c.api.upload('POST', '/library/import?mode=merge', 'file', [{ name: 'lib.zip', buffer: zip }])
    expect(merged.status).toBe(200)
    const lib = merged.body.library
    expect(lib.categories.map((x: any) => x.name)).toEqual(['相框', '杯子', '毛毯'])
    const frame = lib.categories[0]
    expect(frame.id).toBe(local.cid)
    expect(frame.hint).toBe('挂墙相框')
    expect(frame.styles.map((s: any) => [s.name, s.ratio])).toEqual([
      ['横版', '3:2'],
      ['竖版', '2:3'],
    ])
    for (const s of frame.styles) {
      expect(s.templates[0].name).toBe('客厅')
      expect(s.activeTemplate).toBe(s.templates[0].id)
    }
    expect(frame.styles[0].templates[0].image).toBeTruthy()
    expect(frame.styles[1].templates[0].image).toBeNull()
    expect(lib.defaults.extractPrompt).not.toBe('导出前改过的提取提示词 {品类}')
  })
})
