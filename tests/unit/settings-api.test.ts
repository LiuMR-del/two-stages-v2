import type http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMockRelay, type MockRelay } from '../../scripts/mock-relay'
import { resolvePaths } from '../../server/src/paths'
import { createApp, createContext, listen } from '../../server/src/server'
import { rmDir, tmpDir } from '../helpers'

let mock: MockRelay
let server: http.Server
let base: string
let dir: string

beforeAll(async () => {
  mock = await startMockRelay()
  dir = tmpDir()
  const ctx = await createContext(resolvePaths({ libraryDir: `${dir}/library`, dataDir: `${dir}/data` }))
  const r = await listen(createApp(ctx), [0])
  server = r.server
  base = `http://127.0.0.1:${r.port}/api`
})
afterAll(async () => {
  server.close()
  await mock.close()
  rmDir(dir)
})

const j = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: (await r.json()) as any }
}

describe('设置接口', () => {
  it('health', async () => {
    const r = await j('GET', '/health')
    expect(r.body).toMatchObject({ ok: true, pid: process.pid })
  })

  it('没填地址时测试连接给出提示', async () => {
    const r = await j('POST', '/settings/test', { kind: 'image' })
    expect(r.body).toEqual({ ok: false, message: '请先填写地址和 Key' })
  })

  it('保存后 Key 打码返回，用模拟中转站测试连接成功', async () => {
    const saved = await j('PUT', '/settings', {
      image: { baseUrl: mock.url + '/', apiKey: 'sk-image-key-9999' },
      analysis: { baseUrl: mock.url, apiKey: 'sk-chat-key-8888' },
    })
    expect(saved.body.image.apiKey).toBe('sk-…9999')
    expect(saved.body.image.baseUrl).toBe(mock.url)
    const got = await j('GET', '/settings')
    expect(got.body.analysis.apiKey).toBe('sk-…8888')
    expect(JSON.stringify(got.body)).not.toContain('sk-image-key-9999')

    const ti = await j('POST', '/settings/test', { kind: 'image' })
    expect(ti.body.ok).toBe(true)
    const ta = await j('POST', '/settings/test', { kind: 'analysis' })
    expect(ta.body.ok).toBe(true)
    const ping = mock.log().find((e) => e.kind === 'ping')
    expect(ping?.maxTokens).toBe(1)
    expect(mock.log().some((e) => e.endpoint === 'models')).toBe(true)
  })

  it('参数不合法返回中文错误', async () => {
    const r = await j('PUT', '/settings', { routeThreshold: 3 })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/参数不正确/)
    const r2 = await j('GET', '/nope')
    expect(r2.status).toBe(404)
    expect(r2.body.error).toBe('接口不存在')
  })
})
