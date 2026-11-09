import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInProcess, type Api } from '../inprocess'
import fs from 'node:fs'
import path from 'node:path'
import { png, rmDir, tmpDir } from '../helpers'
import { initialLibrary, LibrarySchema, migrateLibrary, validateIntegrity } from '../../server/src/library/schema'
import { LibraryStore } from '../../server/src/library/store'
import { startMockRelay, type MockRelay } from '../../scripts/mock-relay'
import { snapRatio } from '../../server/src/prompts/ratio'

let api: Api
let close: () => Promise<void>
let mock: MockRelay
let cid = ''
let sRect = ''

beforeAll(async () => {
  mock = await startMockRelay()
  const s = await startInProcess()
  api = s.api
  close = s.close
  await api.json('PUT', '/settings', { analysis: { baseUrl: mock.url, apiKey: 'sk-test-chat-0002' } })
  const c = await api.json('POST', '/library/categories', { name: '铝板画' })
  cid = c.body.category.id
  sRect = c.body.category.styles[0].id
  await api.json('PATCH', `/library/categories/${cid}/styles/${sRect}`, { name: '长方形', ratio: '3:2' })
})
afterAll(async () => {
  await close()
  await mock.close()
})

describe('旧版模版库（模版挂在品类上、各款式共用）升级', () => {
  const H1 = 'a'.repeat(64)
  const v1 = {
    version: 1,
    defaults: { extractPrompt: 'x', pastePrompt: 'y' },
    categories: [
      {
        id: 'c1', name: '铝板画', hint: '', extractPrompt: null, activeTemplate: 't1',
        styles: [
          { id: 's1', name: '默认', ratio: '3:2', whiteImage: null },
          { id: 's2', name: '圆形', ratio: '1:1', whiteImage: null },
        ],
        templates: [{ id: 't1', name: '花园木桩', prompt: '长方形铁皮画', images: { s1: H1 }, stylePrompts: { s2: '圆形铁皮画' }, canvasRatio: '1:1' }],
      },
    ],
  }

  it('每个款式各得到一份模版，带上自己的参考图和提示词，使用中的模版不变', () => {
    const lib = LibrarySchema.parse(migrateLibrary(v1))
    const [a, b] = lib.categories[0]!.styles
    expect(a).toMatchObject({ activeTemplate: 't1', templates: [{ id: 't1', name: '花园木桩', prompt: '长方形铁皮画', image: H1, canvasRatio: '1:1' }] })
    expect(b).toMatchObject({ activeTemplate: 't1', templates: [{ id: 't1', name: '花园木桩', prompt: '圆形铁皮画', image: null, canvasRatio: '1:1' }] })
    expect(validateIntegrity(lib)).toBeNull()
  })

  it('启动时读到旧文件就升级，并把旧文件另存一份', () => {
    const dir = tmpDir()
    try {
      const file = path.join(dir, 'library.json')
      fs.writeFileSync(file, JSON.stringify({ ...v1, categories: [{ ...v1.categories[0], templates: [{ ...v1.categories[0]!.templates[0], images: {} }] }] }))
      const store = new LibraryStore({ file, imagesDir: path.join(dir, 'images'), thumbsDir: path.join(dir, 'thumbs'), backupsDir: path.join(dir, 'backups') })
      expect(store.get().version).toBe(2)
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(2)
      expect(fs.readdirSync(dir).some((f) => f.startsWith('library.v1-'))).toBe(true)
    } finally {
      rmDir(dir)
    }
  })

  // 2026-11-09：library.json 不进 git，新装时按出厂模版 seed.json 生成；本地已有的不动
  it('本地没有模版库时按出厂模版生成，已有的不被出厂模版覆盖', () => {
    const dir = tmpDir()
    try {
      const file = path.join(dir, 'library.json')
      const seedFile = path.join(dir, 'seed.json')
      const paths = { file, seedFile, imagesDir: path.join(dir, 'images'), thumbsDir: path.join(dir, 'thumbs'), backupsDir: path.join(dir, 'backups') }
      const seed = initialLibrary()
      seed.defaults.extractPrompt = '出厂提取'
      fs.writeFileSync(seedFile, JSON.stringify(seed))
      expect(new LibraryStore(paths).get().defaults.extractPrompt).toBe('出厂提取')
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).defaults.extractPrompt).toBe('出厂提取')

      const mine = initialLibrary()
      mine.defaults.extractPrompt = '我改过的'
      fs.writeFileSync(file, JSON.stringify(mine))
      seed.defaults.extractPrompt = '出厂新版'
      fs.writeFileSync(seedFile, JSON.stringify(seed))
      expect(new LibraryStore(paths).get().defaults.extractPrompt).toBe('我改过的')
    } finally {
      rmDir(dir)
    }
  })

  it('出厂模版坏了就用空模版库启动', () => {
    const dir = tmpDir()
    try {
      const seedFile = path.join(dir, 'seed.json')
      fs.writeFileSync(seedFile, '{坏的')
      const store = new LibraryStore({ file: path.join(dir, 'library.json'), seedFile, imagesDir: path.join(dir, 'images'), thumbsDir: path.join(dir, 'thumbs'), backupsDir: path.join(dir, 'backups') })
      expect(store.get().categories).toEqual([])
    } finally {
      rmDir(dir)
    }
  })
})

describe('AI 估算比例', () => {
  it('换成好记的整数比', () => {
    expect(snapRatio(205 / 473)).toBe('3:7')
    expect(snapRatio(1.49)).toBe('3:2')
    expect(snapRatio(1)).toBe('1:1')
    expect(snapRatio(0.8)).toBe('4:5')
  })

  it('没有白底图或参考图时提示先上传', async () => {
    const r = await api.json('POST', `/library/categories/${cid}/styles/${sRect}/estimate-ratio`, {})
    expect(r.status).toBe(400)
    expect(r.body.error ?? r.body.message).toContain('白底图')
  })

  it('看白底图，返回建议比例，不改模版库', async () => {
    await api.upload('PUT', `/library/categories/${cid}/styles/${sRect}/white`, 'file', [{ name: 'w.png', buffer: await png(1000, 1000) }])
    mock.script({ chat: [{ info: { found: true, box: [380, 200, 610, 730], width_to_height: 0.43, shape: '长方形', surface: '灯罩正面', reason: '正面透光面板' } }] })
    const r = await api.json('POST', `/library/categories/${cid}/styles/${sRect}/estimate-ratio`, {})
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ratio: '3:7', shape: '长方形', surface: '灯罩正面', source: '白底图' })
    const call = mock.log().filter((e) => e.endpoint === 'chat/completions').at(-1)!
    expect(call.images).toHaveLength(1)
    expect(call.userText!.join('')).toContain('铝板画·长方形')
    const lib = (await api.json('GET', '/library')).body.library
    expect(lib.categories[0].styles.find((s: any) => s.id === sRect).ratio).toBe('3:2')
  })

  it('AI 说找不到时给出原因', async () => {
    mock.script({ chat: [{ info: { found: false, reason: '图里看不到商品' } }] })
    const r = await api.json('POST', `/library/categories/${cid}/styles/${sRect}/estimate-ratio`, {})
    expect(r.status).toBe(422)
  })
})
