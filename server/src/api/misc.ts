import fs from 'node:fs'
import type { Router } from 'express'
import { z } from 'zod'
import type { AppContext } from '../context'
import { resolveOutputDir } from '../store/settings'
import { openFolder } from '../util/platform'
import { parseBody } from './util'

export function registerMisc(r: Router, ctx: AppContext): void {
  r.get('/health', (_req, res) => {
    res.json({ ok: true, version: ctx.version, pid: process.pid })
  })

  r.post('/open-output', (req, res) => {
    parseBody(z.object({ jobId: z.string().optional() }), req.body)
    const dir = resolveOutputDir(ctx.settings.get())
    fs.mkdirSync(dir, { recursive: true })
    openFolder(dir)
    res.json({ ok: true, dir })
  })
}
