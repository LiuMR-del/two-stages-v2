import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockRelay, type MockRelay } from '../../scripts/mock-relay'
import { makeApi, type Api } from '../inprocess'
import { png, rmDir, tmpDir, waitFor } from '../helpers'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })
}

export type Server = {
  api: Api
  dir: string
  pid: number
  logs: () => string
  kill: () => Promise<void>
  stop: () => Promise<void>
}

/** 启动真实服务进程；dir 复用时就是「重启」 */
export async function startServer(dir: string): Promise<Server> {
  const port = await freePort()
  let out = ''
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server', 'src', 'index.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      TS_DATA_DIR: path.join(dir, 'data'),
      TS_LIBRARY_DIR: path.join(dir, 'library'),
      TS_PORT: String(port),
      TS_NO_BROWSER: '1',
      TS_NO_AUTOEXIT: '1',
      TS_RETRY_SCALE: '0.001',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout!.on('data', (d) => (out += d))
  child.stderr!.on('data', (d) => (out += d))
  const info = await waitFor(
    async () => {
      if (child.exitCode !== null) throw new Error('服务进程退出了：\n' + out)
      const f = path.join(dir, 'data', 'server.json')
      if (!fs.existsSync(f)) return null
      const j = JSON.parse(fs.readFileSync(f, 'utf8'))
      if (j.pid !== child.pid) return null
      const r = await fetch(`http://127.0.0.1:${j.port}/api/health`)
      return r.ok ? (j as { port: number; pid: number }) : null
    },
    { timeout: 30_000, label: '服务启动' },
  )
  const exited = new Promise<void>((r) => child.once('exit', () => r()))
  return {
    api: makeApi(`http://127.0.0.1:${info.port}/api`),
    dir,
    pid: child.pid!,
    logs: () => out,
    kill: async () => {
      child.kill('SIGKILL')
      await exited
    },
    stop: async () => {
      if (child.exitCode === null) child.kill('SIGTERM')
      await exited
    },
  }
}

export type World = {
  mock: MockRelay
  srv: Server
  api: Api
  dir: string
  outDir: string
  restart: (opts?: { kill?: boolean }) => Promise<void>
  close: () => Promise<void>
}

export async function startWorld(opts: { image?: number; analysis?: number } = {}): Promise<World> {
  const dir = tmpDir('ts-e2e-')
  const mock = await startMockRelay()
  const outDir = path.join(dir, 'out')
  const w: World = {
    mock,
    srv: await startServer(dir),
    api: null as unknown as Api,
    dir,
    outDir,
    restart: async ({ kill } = {}) => {
      if (kill) await w.srv.kill()
      else await w.srv.stop()
      w.srv = await startServer(dir)
      w.api = w.srv.api
    },
    close: async () => {
      await w.srv.stop()
      await mock.close()
      rmDir(dir)
    },
  }
  w.api = w.srv.api
  const r = await w.api.json('PUT', '/settings', {
    image: { baseUrl: mock.url, apiKey: 'sk-test-image-0001', concurrency: opts.image ?? 2 },
    analysis: { baseUrl: mock.url, apiKey: 'sk-test-chat-0002', concurrency: opts.analysis ?? 3 },
    outputDir: outDir,
  })
  if (r.status !== 200) throw new Error('设置保存失败：' + JSON.stringify(r.body))
  return w
}

// ---- 模版库搭建 ----

export type StyleSpec = { name: string; ratio: string; white?: [number, number] }
export type TemplateSpec = { name: string; prompt: string; images?: Record<string, [number, number]> }

export async function makeCategory(api: Api, name: string, styles: StyleSpec[], tpl?: TemplateSpec, hint = '') {
  const c = await api.json('POST', '/library/categories', { name })
  if (c.status !== 200) throw new Error(JSON.stringify(c.body))
  const cid = c.body.category.id as string
  const firstId = c.body.category.styles[0].id as string
  const ids: Record<string, string> = {}
  for (const [i, s] of styles.entries()) {
    if (i === 0) {
      await api.json('PATCH', `/library/categories/${cid}/styles/${firstId}`, { name: s.name, ratio: s.ratio })
      ids[s.name] = firstId
    } else {
      const r = await api.json('POST', `/library/categories/${cid}/styles`, { name: s.name, ratio: s.ratio })
      ids[s.name] = r.body.style.id
    }
    if (s.white) {
      const up = await api.upload('PUT', `/library/categories/${cid}/styles/${ids[s.name]}/white`, 'file', [
        { name: 'w.png', buffer: await png(s.white[0], s.white[1], { r: 250, g: 250, b: 250 }), type: 'image/png' },
      ])
      if (up.status !== 200) throw new Error(JSON.stringify(up.body))
    }
  }
  if (hint) await api.json('PATCH', `/library/categories/${cid}`, { hint })
  let tid: string | null = null
  if (tpl) {
    const t = await api.json('POST', `/library/categories/${cid}/templates`, { name: tpl.name, prompt: tpl.prompt })
    tid = t.body.template.id
    for (const [sname, [w, h]] of Object.entries(tpl.images ?? {})) {
      await api.upload('PUT', `/library/categories/${cid}/templates/${tid}/images/${ids[sname]}`, 'file', [
        { name: 'ref.png', buffer: await png(w, h, { r: 200, g: 190, b: 170 }), type: 'image/png' },
      ])
    }
    await api.json('PATCH', `/library/categories/${cid}`, { activeTemplate: tid })
  }
  return { cid, styles: ids, tid }
}

// ---- 任务 ----

let colorSeed = 1
export async function uploadJobs(api: Api, names: string[], size: [number, number] = [800, 600]) {
  const files = []
  for (const n of names) {
    colorSeed = (colorSeed * 37) % 251
    files.push({ name: n, buffer: await png(size[0], size[1], { r: colorSeed, g: 100, b: 150 }), type: 'image/png' })
  }
  const r = await api.upload('POST', '/jobs', 'files', files)
  if (r.status !== 200) throw new Error(JSON.stringify(r.body))
  return r.body.jobs as any[]
}

export async function getJobs(api: Api): Promise<any[]> {
  return (await api.json('GET', '/jobs')).body.jobs
}

export async function getJob(api: Api, id: string): Promise<any> {
  return (await getJobs(api)).find((j) => j.id === id)
}

export async function waitJob(api: Api, id: string, pred: (j: any) => boolean, label = '', timeout = 30_000): Promise<any> {
  let last: any
  try {
    return await waitFor(
      async () => {
        last = await getJob(api, id)
        return last && pred(last) ? last : null
      },
      { timeout, label },
    )
  } catch (e) {
    throw new Error(`${(e as Error).message}\n最后状态：${JSON.stringify(last && { steps: last.steps.map((s: any) => s.state + '/' + s.attempts + (s.error ? ':' + s.error : '')), attention: last.attention }, null, 1)}`)
  }
}

export const isDone = (j: any) => j.view.phase === 'done'
export const hasAttention = (kind?: string) => (j: any) => !!j.attention && (!kind || j.attention.kind === kind)

export function imageRequests(mock: MockRelay) {
  return mock.log().filter((e) => e.endpoint === 'images/edits')
}

/** 订阅 /api/events，收集事件（只用于断言 toast 之类） */
export function collectEvents(api: Api) {
  const events: { name: string; data: any }[] = []
  const ctrl = new AbortController()
  void (async () => {
    try {
      const r = await fetch(api.base + '/events', { signal: ctrl.signal })
      const reader = r.body!.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const name = /^event: (.+)$/m.exec(block)?.[1]
          const data = /^data: (.+)$/m.exec(block)?.[1]
          if (name && data) events.push({ name, data: JSON.parse(data) })
        }
      }
    } catch {
      // 关闭时会中止
    }
  })()
  return { events, close: () => ctrl.abort() }
}
