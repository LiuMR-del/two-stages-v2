import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { startMockRelay, type MockRelay } from '../../scripts/mock-relay'
import { editImage, type ImageApi } from '../../server/src/ai/imageClient'
import { chatJson, REASK_TEXT, type AnalysisApi } from '../../server/src/ai/chatClient'
import { AiError } from '../../server/src/ai/errors'
import { png } from '../helpers'

let mock: MockRelay
beforeAll(async () => {
  mock = await startMockRelay()
})
afterAll(() => mock.close())
beforeEach(() => mock.reset())

const imageApi = (o: Partial<ImageApi> = {}): ImageApi => ({
  baseUrl: mock.url,
  apiKey: 'sk-test-key-0000',
  model: 'gpt-image-2',
  concurrency: 2,
  timeoutSec: 30,
  sendFidelity: true,
  fidelityAutoDisabled: false,
  ...o,
})
const chatApi = (): AnalysisApi => ({ baseUrl: mock.url, apiKey: 'sk-test-key-0000', model: 'gpt-5.5', concurrency: 3, timeoutSec: 30 })

async function img(w = 64, h = 64) {
  return { buffer: await png(w, h), mime: 'image/png', filename: 'a.png' }
}

describe('imageClient', () => {
  it('一张图用 image 字段，带保真参数，前置句拼在提示词前', async () => {
    const r = await editImage(imageApi(), { images: [await img()], prefix: '[Canvas: 3:2 landscape format] ', prompt: '提取', size: '1536x1024' })
    expect([r.width, r.height]).toEqual([1536, 1024])
    const e = mock.log()[0]!
    expect(e.images.map((i) => i.field)).toEqual(['image'])
    expect(e.fields).toMatchObject({ model: 'gpt-image-2', n: '1', size: '1536x1024', quality: 'high', input_fidelity: 'high' })
    expect(e.prompt).toBe('[Canvas: 3:2 landscape format] 提取')
  })

  it('多张图用 image[] 字段并保持顺序', async () => {
    await editImage(imageApi({ sendFidelity: false }), { images: [await img(10, 20), await img(30, 40)], prefix: '', prompt: 'p', size: '1024x1024' })
    const e = mock.log()[0]!
    expect(e.images.map((i) => [i.field, i.width, i.height])).toEqual([
      ['image[]', 10, 20],
      ['image[]', 30, 40],
    ])
    expect(e.fields.quality).toBeUndefined()
    expect(e.fields.input_fidelity).toBeUndefined()
  })

  it('兼容 b64 / url / binary 三种返回', async () => {
    for (const fmt of ['b64', 'url', 'binary'] as const) {
      mock.script({ image: [fmt] })
      const r = await editImage(imageApi(), { images: [await img()], prefix: '', prompt: 'p', size: '1024x1536' })
      expect([r.width, r.height], fmt).toEqual([1024, 1536])
    }
  })

  it('不支持保真参数：同一次尝试内去掉重发，成功后才回调', async () => {
    mock.script({ image: ['unknownParam'] })
    let notified = ''
    const r = await editImage(imageApi(), { images: [await img()], prefix: '', prompt: 'p', size: '1024x1024' }, (m) => {
      notified = m
    })
    expect(r.downgraded).toBe(true)
    expect(notified).toContain('input_fidelity')
    const [a, b] = mock.log()
    expect(a!.fields.input_fidelity).toBe('high')
    expect(b!.fields.input_fidelity).toBeUndefined()
    expect(b!.fields.quality).toBeUndefined()
    expect(r.params).toEqual({ n: 1, size: '1024x1024' })
  })

  it('降级重发也失败时不回调', async () => {
    mock.script({ image: ['unknownParam', { status: 500 }] })
    let notified = false
    await expect(
      editImage(imageApi(), { images: [await img()], prefix: '', prompt: 'p', size: '1024x1024' }, () => {
        notified = true
      }),
    ).rejects.toMatchObject({ type: 'server' })
    expect(notified).toBe(false)
  })

  it('错误分类：badImage / refused / auth / rateLimit / badJson', async () => {
    const cases: [Parameters<MockRelay['script']>[0], string][] = [
      [{ image: ['badImage'] }, 'badImage'],
      [{ image: ['badJson'] }, 'badImage'],
      [{ image: ['refused'] }, 'refused'],
      [{ image: [{ status: 401 }] }, 'auth'],
      [{ image: [{ status: 429, retryAfter: 2 }] }, 'rateLimit'],
      [{ image: [{ status: 502 }] }, 'server'],
    ]
    for (const [s, type] of cases) {
      mock.script(s)
      const p = editImage(imageApi(), { images: [await img()], prefix: '', prompt: 'p', size: '1024x1024' })
      await expect(p, type).rejects.toMatchObject({ type })
    }
  })

  it('提示词为空时本地拦截，不发请求', async () => {
    await expect(editImage(imageApi(), { images: [await img()], prefix: '[Canvas] ', prompt: '  ', size: '1024x1024' })).rejects.toBeInstanceOf(AiError)
    expect(mock.log()).toHaveLength(0)
  })

  it('超时归为 network', async () => {
    mock.script({ image: [{ delay: 1500 }] })
    await expect(
      editImage(imageApi({ timeoutSec: 1 }), { images: [await img()], prefix: '', prompt: 'p', size: '1024x1024' }),
    ).rejects.toMatchObject({ type: 'network', message: '请求超时' })
  })

  it('连接不上归为 network', async () => {
    await expect(
      editImage(imageApi({ baseUrl: 'http://127.0.0.1:1/v1' }), { images: [await img()], prefix: '', prompt: 'p', size: '1024x1024' }),
    ).rejects.toMatchObject({ type: 'network' })
  })
})

describe('chatClient', () => {
  const schema = z.object({ scene: z.string().min(1), keywords: z.array(z.string()) })
  const system = '你是亚马逊电商主图分析助手。'

  it('发送 system、文字和图片，temperature 0，解析带围栏的 JSON', async () => {
    const jpg = Buffer.from(await (await import('sharp')).default({ create: { width: 20, height: 10, channels: 3, background: '#000' } }).jpeg().toBuffer())
    const r = await chatJson(chatApi(), { system, user: '请分析', imageJpeg: jpg }, schema)
    expect(r.data.scene).toBeTruthy()
    const e = mock.log()[0]!
    expect(e.fields.temperature).toBe('0')
    expect(e.system).toBe(system)
    expect(e.userText).toEqual(['请分析'])
    expect(e.images).toHaveLength(1)
    expect(e.images[0]).toMatchObject({ field: 'data:image/jpeg;base64', width: 20, height: 10 })
  })

  it('格式不对时追问一次，第二次成功', async () => {
    mock.script({ chat: ['badJson', 'ok'] })
    const r = await chatJson(chatApi(), { system, user: '请分析' }, schema)
    expect(r.data.keywords.length).toBeGreaterThan(0)
    const [, second] = mock.log()
    expect(second!.userText).toEqual(['请分析', REASK_TEXT])
  })

  it('追问后仍不对，记为 badOutput', async () => {
    mock.script({ chat: ['badJson', { info: { scene: '' , keywords: [] } }] })
    await expect(chatJson(chatApi(), { system, user: '请分析' }, schema)).rejects.toMatchObject({ type: 'badOutput' })
    expect(mock.log()).toHaveLength(2)
  })

  it('HTTP 错误照常分类', async () => {
    mock.script({ chat: [{ status: 403 }] })
    await expect(chatJson(chatApi(), { system, user: 'x' }, schema)).rejects.toMatchObject({ type: 'auth' })
  })
})
