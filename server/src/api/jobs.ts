import fs from 'node:fs'
import path from 'node:path'
import type { Router, Request } from 'express'
import { z } from 'zod'
import sharp from 'sharp'
import type { AppContext } from '../context'
import { HttpError, parseBody } from './util'
import { upload } from './library'
import { newSteps, withView, type Job } from '../store/jobs'
import { localDay, newJobId } from '../util/ids'
import { EXT_OF, readSize, sniffImageType } from '../image/process'
import { normalizeLibraryImage, sha256 } from '../library/images'
import { writeJobImage, JOB_FILES } from '../pipeline/files'
import { baseNameOf } from '../pipeline/output'
import { log } from '../util/log'

const MAX_FILES = 500

/** 非 PNG/JPG/WebP 的图片转成 PNG；带 EXIF 旋转的先转正 */
async function normalizeSource(buf: Buffer): Promise<{ buffer: Buffer; ext: string }> {
  if (sniffImageType(buf)) {
    const n = await normalizeLibraryImage(buf)
    return { buffer: n.buffer, ext: n.ext }
  }
  try {
    const png = await sharp(buf).rotate().png().toBuffer()
    return { buffer: png, ext: EXT_OF.png }
  } catch {
    throw new Error('无法识别的图片格式，或文件已损坏')
  }
}

export function registerJobs(r: Router, ctx: AppContext): void {
  const { jobs, scheduler } = ctx
  const id = (req: Request) => String(req.params.id)

  r.get('/jobs', (_req, res) => {
    res.json({ jobs: jobs.list().map(withView), queue: scheduler.queueState() })
  })

  r.post('/jobs', upload.array('files', MAX_FILES), async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? []
    if (!files.length) throw new HttpError(400, '没有收到图片（表单字段名应为 files）')
    const created: ReturnType<typeof withView>[] = []
    const errors: { name: string; error: string }[] = []
    for (const f of files) {
      const name = path.basename(f.originalname || 'image')
      try {
        const { buffer, ext } = await normalizeSource(f.buffer)
        const { width, height } = await readSize(buffer)
        const jobId = newJobId()
        const dir = jobs.dirOf(jobId)
        const file = `source.${ext}`
        await writeJobImage(dir, 'source', file, buffer)
        const job: Job = {
          id: jobId,
          createdAt: new Date().toISOString(),
          order: jobs.maxOrder() + 1,
          source: { file, originalName: name, width, height, sha256: sha256(buffer) },
          outputDay: localDay(),
          outputBase: baseNameOf(name),
          route: null,
          plan: null,
          steps: newSteps(),
          info: null,
          attention: null,
          override: null,
        }
        await jobs.create(job)
        created.push(withView(job))
      } catch (e) {
        errors.push({ name, error: (e as Error).message })
        log.warn(`「${name}」没有加入队列：${(e as Error).message}`)
      }
    }
    if (created.length) log.info(`加入队列 ${created.length} 张图`)
    scheduler.tick()
    res.json({ jobs: created, errors })
  })

  r.post('/jobs/clear-done', async (_req, res) => {
    res.json({ removed: await scheduler.clearDone() })
  })

  r.delete('/jobs/:id', async (req, res) => {
    await scheduler.remove(id(req))
    res.json({ ok: true })
  })

  r.post('/jobs/:id/redo', async (req, res) => {
    const b = parseBody(
      z.object({ step: z.number().int().min(0).max(4), prompt: z.string().max(20000).optional(), categoryId: z.string().optional(), styleId: z.string().optional() }),
      req.body,
    )
    res.json({ job: withView(await scheduler.redo(id(req), b)) })
  })

  r.post('/jobs/:id/resolve', async (req, res) => {
    const b = parseBody(z.object({ categoryId: z.string(), styleId: z.string().optional() }), req.body)
    res.json({ job: withView(await scheduler.resolve(id(req), b.categoryId, b.styleId)) })
  })

  r.post('/jobs/:id/create-category', async (req, res) => {
    res.json({ job: withView(await scheduler.createCategory(id(req))) })
  })

  r.post('/jobs/:id/retry', async (req, res) => {
    res.json({ job: withView(await scheduler.retry(id(req))) })
  })

  r.get('/jobs/:id/files/:kind', (req, res) => {
    const job = jobs.get(id(req))
    if (!job) throw new HttpError(404, '这张图已经不在队列里了')
    const kind = String(req.params.kind)
    if (!['source', 'pattern', 'main', 'blank'].includes(kind)) throw new HttpError(400, '文件类型只能是 source、pattern、main、blank')
    const dir = jobs.dirOf(job.id)
    const file =
      req.query.size === 'thumb'
        ? path.join(dir, 'thumbs', `${kind}.webp`)
        : path.join(dir, kind === 'source' ? job.source.file : JOB_FILES[kind as keyof typeof JOB_FILES])
    if (!fs.existsSync(file)) throw new HttpError(404, '文件还没有生成')
    res.setHeader('Cache-Control', 'no-cache')
    res.sendFile(file)
  })

  r.get('/queue', (_req, res) => {
    res.json(scheduler.queueState())
  })

  r.post('/queue/pause', (_req, res) => {
    scheduler.pause()
    res.json(scheduler.queueState())
  })

  r.post('/queue/resume', (_req, res) => {
    scheduler.resume()
    res.json(scheduler.queueState())
  })
}
