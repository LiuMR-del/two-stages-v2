import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeJsonAtomic, readJsonSync } from '../../server/src/store/atomic'
import { maskSettings, SettingsStore, resolveOutputDir } from '../../server/src/store/settings'
import { rmDir, tmpDir } from '../helpers'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(rmDir))

describe('atomic', () => {
  it('写入后没有残留临时文件', async () => {
    const d = tmpDir()
    dirs.push(d)
    const f = path.join(d, 'a', 'x.json')
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeJsonAtomic(f, { i })))
    expect(readJsonSync<{ i: number }>(f)).toHaveProperty('i')
    expect(fs.readdirSync(path.dirname(f))).toEqual(['x.json'])
    expect(readJsonSync(path.join(d, 'missing.json'))).toBeNull()
  })
})

describe('SettingsStore', () => {
  it('默认值', () => {
    const d = tmpDir()
    dirs.push(d)
    const s = new SettingsStore(path.join(d, 'settings.json')).get()
    expect(s.image).toMatchObject({ model: 'gpt-image-2', concurrency: 2, timeoutSec: 300, sendFidelity: true })
    expect(s.analysis).toMatchObject({ model: 'gpt-5.6', concurrency: 3, timeoutSec: 60 })
    expect(s.routeThreshold).toBe(0.7)
    expect(s.padSquare).toBe(true)
    expect(s.blankImage).toBe(true)
    expect(resolveOutputDir(s)).toMatch(/Downloads$/)
  })

  it('Key 打码；收到打码格式时保留原值；baseUrl 去掉末尾斜杠且不补 /v1', async () => {
    const d = tmpDir()
    dirs.push(d)
    const file = path.join(d, 'settings.json')
    const store = new SettingsStore(file)
    await store.update({ image: { baseUrl: 'https://relay.example.com/', apiKey: 'sk-abcdefgh1234' } })
    expect(store.get().image.baseUrl).toBe('https://relay.example.com')
    const masked = maskSettings(store.get())
    expect(masked.image.apiKey).toBe('sk-…1234')
    await store.update({ image: { apiKey: masked.image.apiKey, model: 'm2' } })
    expect(store.get().image.apiKey).toBe('sk-abcdefgh1234')
    expect(store.get().image.model).toBe('m2')
    // 只传一个字段时，其他字段保持不变
    const { SettingsPatchSchema } = await import('../../server/src/store/settings')
    await store.update(SettingsPatchSchema.parse({ image: { apiKey: 'sk-zzzzzzzz5678' } }))
    expect(store.get().image).toMatchObject({ baseUrl: 'https://relay.example.com', model: 'm2', apiKey: 'sk-zzzzzzzz5678' })
    await store.update(SettingsPatchSchema.parse({ padSquare: false }))
    expect(store.get().image.baseUrl).toBe('https://relay.example.com')
    await store.update({ image: { apiKey: 'sk-abcdefgh1234' } })
    const reread = new SettingsStore(file).get()
    expect(reread.image.apiKey).toBe('sk-abcdefgh1234')
    expect(fs.readFileSync(file, 'utf8')).toContain('sk-abcdefgh1234')
  })
})
