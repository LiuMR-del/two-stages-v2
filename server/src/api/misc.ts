import fs from 'node:fs'
import type { Router } from 'express'
import { z } from 'zod'
import type { AppContext } from '../context'
import { resolveOutputDir } from '../store/settings'
import { openFolder } from '../util/platform'
import { HttpError, parseBody } from './util'
import { batchDir, categoryDir } from '../pipeline/output'
import { csvForDay } from '../pipeline/csv'
import { localDay } from '../util/ids'

export function registerMisc(r: Router, ctx: AppContext): void {
  r.get('/health', (_req, res) => {
    res.json({ ok: true, version: ctx.version, pid: process.pid })
  })

  r.post('/open-output', (req, res) => {
    const b = parseBody(z.object({ jobId: z.string().optional() }), req.body)
    const root = resolveOutputDir(ctx.settings.get())
    const latest = ctx.jobs.list().at(-1)
    let dir = latest ? batchDir(root, latest.outputFolder) : root
    if (b.jobId) {
      const job = ctx.jobs.get(b.jobId)
      if (!job) throw new HttpError(404, '这张图已经不在队列里了')
      if (job.route) dir = categoryDir(root, job)
    }
    if (!fs.existsSync(dir)) dir = root
    fs.mkdirSync(dir, { recursive: true })
    openFolder(dir)
    res.json({ ok: true, dir })
  })

  r.get('/info.csv', (req, res) => {
    const day = typeof req.query.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day) ? req.query.day : localDay()
    const csv = csvForDay(ctx.jobs.list(), day)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="info-${day}.csv"; filename*=UTF-8''${encodeURIComponent(`识别信息-${day}.csv`)}`)
    res.send(csv)
  })
}
