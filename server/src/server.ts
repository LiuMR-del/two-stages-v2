import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import express from 'express'
import type { AppContext } from './context'
import { ensureDirs, type Paths } from './paths'
import { Bus } from './events/bus'
import { SettingsStore } from './store/settings'
import { Limiter } from './ai/limiter'
import { registerSettings } from './api/settings'
import { registerMisc } from './api/misc'
import { registerEvents } from './api/events'
import { errorHandler, HttpError } from './api/util'

export function readVersion(toolDir: string): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(toolDir, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export async function createContext(paths: Paths): Promise<AppContext> {
  ensureDirs(paths)
  const bus = new Bus()
  const settings = new SettingsStore(paths.settingsFile)
  const ctx: AppContext = {
    version: readVersion(paths.toolDir),
    paths,
    bus,
    settings,
    limiter: new Limiter(),
    sse: { clients: 0 },
    onSettingsSaved: () => {},
    start: async () => {},
    isIdle: () => true,
  }
  const applyLimits = () => {
    const s = settings.get()
    ctx.limiter.configure('image', s.image.concurrency)
    ctx.limiter.configure('analysis', s.analysis.concurrency)
  }
  applyLimits()
  ctx.onSettingsSaved = () => {
    applyLimits()
    bus.emit('settings', { settings: settings.get() })
  }
  return ctx
}

export function createApp(ctx: AppContext): express.Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '2mb' }))

  const api = express.Router()
  registerMisc(api, ctx)
  registerSettings(api, ctx)
  registerEvents(api, ctx)
  api.use(() => {
    throw new HttpError(404, '接口不存在')
  })
  app.use('/api', api)

  const webDir = ctx.paths.webDir
  if (fs.existsSync(path.join(webDir, 'index.html'))) {
    app.use(express.static(webDir, { index: 'index.html' }))
    app.get('/{*rest}', (_req, res) => res.sendFile(path.join(webDir, 'index.html')))
  } else {
    app.get('/', (_req, res) => {
      res.type('html').send('<!doctype html><meta charset="utf-8"><title>Two stages</title><p>页面还没有构建，请先运行 npm run build，或用 npm run dev 开发。</p>')
    })
  }
  app.use(errorHandler)
  return app
}

export function listen(app: express.Express, ports: number[]): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const tryAt = (i: number) => {
      if (i >= ports.length) return reject(new Error(`端口 ${ports[0]}～${ports[ports.length - 1]} 都被占用了`))
      const server = http.createServer(app)
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' || e.code === 'EACCES') tryAt(i + 1)
        else reject(e)
      })
      server.listen(ports[i], '127.0.0.1', () => {
        const addr = server.address()
        resolve({ server, port: typeof addr === 'object' && addr ? addr.port : ports[i]! })
      })
    }
    tryAt(0)
  })
}
