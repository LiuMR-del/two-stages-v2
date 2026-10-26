import { resolvePaths } from './paths'
import { initLog, log } from './util/log'
import { readJsonSync, writeJsonAtomic } from './store/atomic'
import { createApp, createContext, listen } from './server'
import { openBrowser } from './util/platform'

const DEFAULT_PORT = 3311
const PORT_SPAN = 10
const IDLE_CHECK_MS = 60_000
const IDLE_EXIT_MINUTES = 10

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function existingInstance(serverFile: string): Promise<number | null> {
  const info = readJsonSync<{ port: number; pid: number }>(serverFile)
  if (!info?.port || !info?.pid || info.pid === process.pid || !pidAlive(info.pid)) return null
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2000)
    const r = await fetch(`http://127.0.0.1:${info.port}/api/health`, { signal: ctrl.signal })
    clearTimeout(t)
    const j = (await r.json()) as { ok?: boolean; pid?: number }
    return j?.ok && j.pid === info.pid ? info.port : null
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const paths = resolvePaths()
  initLog(paths.logsDir)
  const noBrowser = !!process.env.TS_NO_BROWSER

  const running = await existingInstance(paths.serverFile)
  if (running) {
    log.info(`服务已经在运行（端口 ${running}），直接打开页面`)
    if (!noBrowser) openBrowser(`http://127.0.0.1:${running}/`)
    process.exit(0)
  }

  const ctx = await createContext(paths)
  const app = createApp(ctx)
  const base = Number(process.env.TS_PORT) || DEFAULT_PORT
  const ports = Array.from({ length: PORT_SPAN }, (_, i) => base + i)
  const { server, port } = await listen(app, ports)
  await writeJsonAtomic(paths.serverFile, { port, pid: process.pid })
  const url = `http://127.0.0.1:${port}/`
  log.info(`服务已启动：${url}（模版库 ${paths.libraryDir}，数据 ${paths.dataDir}）`)

  await ctx.start()

  if (!noBrowser) openBrowser(url)

  if (!process.env.TS_NO_AUTOEXIT) {
    let idleMinutes = 0
    const timer = setInterval(() => {
      idleMinutes = ctx.sse.clients === 0 && ctx.isIdle() ? idleMinutes + 1 : 0
      if (idleMinutes >= IDLE_EXIT_MINUTES) {
        log.info(`已连续 ${IDLE_EXIT_MINUTES} 分钟没有页面打开、也没有待处理的任务，服务自动退出`)
        clearInterval(timer)
        server.close()
        process.exit(0)
      }
    }, IDLE_CHECK_MS)
    timer.unref()
  }

  const shutdown = () => {
    log.info('服务停止')
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

process.on('unhandledRejection', (e) => log.error(`未处理的异常：${(e as Error)?.stack ?? String(e)}`))

main().catch((e) => {
  log.error(`启动失败：${(e as Error)?.stack ?? String(e)}`)
  process.exit(1)
})
