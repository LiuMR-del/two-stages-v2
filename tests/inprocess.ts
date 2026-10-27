import path from 'node:path'
import type http from 'node:http'
import { resolvePaths } from '../server/src/paths'
import { createApp, createContext, listen } from '../server/src/server'
import type { AppContext } from '../server/src/context'
import { rmDir, tmpDir } from './helpers'

export type Api = {
  base: string
  json<T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }>
  upload<T = any>(method: string, p: string, field: string, files: { name: string; buffer: Buffer; type?: string }[]): Promise<{ status: number; body: T }>
  raw(p: string): Promise<Response>
}

export function makeApi(base: string): Api {
  return {
    base,
    async json(method, p, body) {
      const r = await fetch(base + p, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await r.text()
      return { status: r.status, body: text ? JSON.parse(text) : null }
    },
    async upload(method, p, field, files) {
      const form = new FormData()
      for (const f of files) form.append(field, new Blob([new Uint8Array(f.buffer)], { type: f.type ?? 'application/octet-stream' }), f.name)
      const r = await fetch(base + p, { method, body: form })
      return { status: r.status, body: (await r.json()) as any }
    },
    raw: (p) => fetch(base + p),
  }
}

export async function startInProcess(): Promise<{ api: Api; ctx: AppContext; dir: string; close: () => Promise<void> }> {
  const dir = tmpDir()
  const ctx = await createContext(resolvePaths({ libraryDir: path.join(dir, 'library'), dataDir: path.join(dir, 'data') }))
  await ctx.settings.update({ outputDir: path.join(dir, 'out') })
  await ctx.start()
  const { server, port } = await listen(createApp(ctx), [0])
  return {
    api: makeApi(`http://127.0.0.1:${port}/api`),
    ctx,
    dir,
    close: async () => {
      ;(server as http.Server).closeAllConnections()
      await new Promise<void>((r) => (server as http.Server).close(() => r()))
      await ctx.stop()
      rmDir(dir)
    },
  }
}
