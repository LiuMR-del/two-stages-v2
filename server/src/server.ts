import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import express from 'express'
import type { AppContext } from './context'
import { ensureDirs, type Paths } from './paths'
import { Bus } from './events/bus'
import { resolveOutputDir, SettingsStore } from './store/settings'
import { BatchFolders } from './pipeline/output'
import { FeishuSheets } from './parent/feishu'
import { SpapiClient } from './parent/spapi'
import { registerParent } from './api/parent'
import { Limiter } from './ai/limiter'
import { registerSettings } from './api/settings'
import { registerMisc } from './api/misc'
import { registerEvents } from './api/events'
import { registerLibrary } from './api/library'
import { LibraryStore } from './library/store'
import { computeChecks } from './library/checks'
import { JobStore, withView } from './store/jobs'
import { Scheduler } from './scheduler/scheduler'
import { registerJobs } from './api/jobs'
import { log } from './util/log'
import { errorHandler, HttpError, sameOriginGuard } from './api/util'

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
  const library = new LibraryStore({
    file: paths.libraryFile,
    imagesDir: paths.libraryImagesDir,
    thumbsDir: paths.libraryThumbsDir,
    backupsDir: paths.libraryBackupsDir,
  })
  library.onChange((lib) => bus.emit('library', { library: lib, checks: computeChecks(lib) }))
  const jobs = new JobStore(paths.jobsDir, (job) => bus.emit('job', { job: withView(job) }))
  let scheduler: Scheduler | null = null
  const limiter = new Limiter(() => scheduler?.tick())
  scheduler = new Scheduler({ jobs, library, settings, limiter, bus, stateFile: path.join(paths.dataDir, 'queue.json'), csvRowsDir: path.join(paths.dataDir, 'batches') })
  const sched = scheduler
  library.onChange(() => sched.onLibraryChanged())
  const ctx: AppContext = {
    version: readVersion(paths.toolDir),
    paths,
    bus,
    settings,
    limiter,
    library,
    jobs,
    scheduler: sched,
    batch: new BatchFolders(path.join(paths.dataDir, 'batch.json'), () => resolveOutputDir(settings.get())),
    parent: {
      sheets: new FeishuSheets(settings),
      spapi: new SpapiClient(settings),
    },
    sse: { clients: 0 },
    onSettingsSaved: () => {},
    start: async () => {
      await library.cleanOrphans()
      const n = jobs.loadAll()
      sched.recover()
      if (n) log.info(`读取到 ${n} 个任务，从断点继续`)
      sched.onLibraryChanged()
      sched.tick()
    },
    stop: async () => {
      sched.stop()
      limiter.dispose()
      await jobs.flush()
    },
    isIdle: () => sched.isIdle(),
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
    sched.onSettingsSaved()
  }
  return ctx
}

export function createApp(ctx: AppContext): express.Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '2mb' }))

  const api = express.Router()
  api.use(sameOriginGuard)
  registerMisc(api, ctx)
  registerSettings(api, ctx)
  registerEvents(api, ctx)
  registerLibrary(api, ctx)
  registerJobs(api, ctx)
  registerParent(api, ctx)
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
