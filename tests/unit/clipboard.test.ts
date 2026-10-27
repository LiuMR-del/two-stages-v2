import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { png, rmDir, tmpDir } from '../helpers'
import { startInProcess } from '../inprocess'

const clip = vi.hoisted(() => ({ paths: null as string[] | null }))
vi.mock('../../server/src/util/platform', async (orig) => ({
  ...(await orig<typeof import('../../server/src/util/platform')>()),
  readClipboardFiles: async () => clip.paths,
}))

let srv: Awaited<ReturnType<typeof startInProcess>>
let src = ''
beforeEach(async () => {
  srv = await startInProcess()
  await srv.ctx.scheduler.pause()
  src = tmpDir()
})
afterEach(async () => {
  await srv.close()
  rmDir(src)
})

describe('粘贴访达里复制的文件', () => {
  it('读系统剪贴板的文件路径，文件夹逐层展开，只收图片，用原文件名', async () => {
    fs.writeFileSync(path.join(src, '家庭照.png'), await png(300, 200))
    fs.mkdirSync(path.join(src, '一批'))
    fs.writeFileSync(path.join(src, '一批', '毛毯.png'), await png(200, 200))
    fs.writeFileSync(path.join(src, '一批', '说明.txt'), 'x')
    fs.writeFileSync(path.join(src, '一批', '.DS_Store'), 'x')
    clip.paths = [path.join(src, '家庭照.png'), path.join(src, '一批')]
    const r = await srv.api.json('POST', '/jobs/from-clipboard')
    expect(r.status).toBe(200)
    expect(r.body.supported).toBe(true)
    expect(r.body.copied).toBe(2)
    expect(r.body.jobs.map((j: any) => j.source.originalName)).toEqual(['家庭照.png', '毛毯.png'])
  })

  it('复制的不是图片、剪贴板里没有文件、系统不支持', async () => {
    fs.writeFileSync(path.join(src, 'a.pdf'), 'x')
    clip.paths = [path.join(src, 'a.pdf')]
    expect((await srv.api.json('POST', '/jobs/from-clipboard')).body).toMatchObject({ supported: true, copied: 1, jobs: [] })
    clip.paths = []
    expect((await srv.api.json('POST', '/jobs/from-clipboard')).body).toMatchObject({ supported: true, copied: 0, jobs: [] })
    clip.paths = null
    expect((await srv.api.json('POST', '/jobs/from-clipboard')).body).toMatchObject({ supported: false, jobs: [] })
  })

  it('别的网站发来的请求不读剪贴板', async () => {
    clip.paths = [path.join(src, 'x.png')]
    const r = await fetch(srv.api.base + '/jobs/from-clipboard', { method: 'POST', headers: { Origin: 'https://evil.example' } })
    expect(r.status).toBe(403)
  })
})
