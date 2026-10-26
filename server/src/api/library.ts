import type { Router, Request } from 'express'
import multer from 'multer'
import { z } from 'zod'
import type { AppContext } from '../context'
import { HttpError, parseBody } from './util'
import { ops } from '../library/store'
import { computeChecks } from '../library/checks'
import { recipeFor } from '../library/recipe'
import { exportZip, importZip } from '../library/zip'
import { UnsupportedImageError } from '../library/images'
import { buildExtractRequest, extractPromptFor } from '../prompts/extract'

export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 }, defParamCharset: 'utf8' })

function fileOf(req: Request): Buffer {
  const f = req.file
  if (!f) throw new HttpError(400, '没有收到文件（表单字段名应为 file）')
  return f.buffer
}

export function libraryPayload(ctx: AppContext) {
  const library = ctx.library.get()
  return { library, checks: computeChecks(library) }
}

export function registerLibrary(r: Router, ctx: AppContext): void {
  const store = ctx.library
  const p = (req: Request, k: string) => String(req.params[k])

  const addImage = async (buf: Buffer) => {
    try {
      return await store.images.add(buf)
    } catch (e) {
      if (e instanceof UnsupportedImageError) throw new HttpError(400, e.message)
      throw e
    }
  }

  r.get('/library', (_req, res) => {
    res.json(libraryPayload(ctx))
  })

  r.put('/library/defaults', async (req, res) => {
    const b = parseBody(z.object({ extractPrompt: z.string().optional(), pastePrompt: z.string().optional() }), req.body)
    await store.mutate((d) => {
      if (b.extractPrompt !== undefined) d.defaults.extractPrompt = b.extractPrompt
      if (b.pastePrompt !== undefined) d.defaults.pastePrompt = b.pastePrompt
    })
    res.json(libraryPayload(ctx))
  })

  r.post('/library/categories', async (req, res) => {
    const b = parseBody(z.object({ name: z.string() }), req.body)
    const c = await store.mutate((d) => ops.addCategory(d, b.name))
    res.json({ category: c, ...libraryPayload(ctx) })
  })

  r.put('/library/categories/order', async (req, res) => {
    const b = parseBody(z.object({ ids: z.array(z.string()) }), req.body)
    await store.mutate((d) => ops.reorder(d, b.ids))
    res.json(libraryPayload(ctx))
  })

  r.patch('/library/categories/:cid', async (req, res) => {
    const b = parseBody(
      z.object({ name: z.string().optional(), hint: z.string().max(500).optional(), extractPrompt: z.string().nullable().optional(), activeTemplate: z.string().optional() }),
      req.body,
    )
    await store.mutate((d) => ops.patchCategory(d, p(req, 'cid'), b))
    res.json(libraryPayload(ctx))
  })

  r.delete('/library/categories/:cid', async (req, res) => {
    await store.mutate((d) => ops.deleteCategory(d, p(req, 'cid')))
    res.json(libraryPayload(ctx))
  })

  r.post('/library/categories/:cid/styles', async (req, res) => {
    const b = parseBody(z.object({ name: z.string(), ratio: z.string() }), req.body)
    const s = await store.mutate((d) => ops.addStyle(d, p(req, 'cid'), b.name, b.ratio))
    res.json({ style: s, ...libraryPayload(ctx) })
  })

  r.patch('/library/categories/:cid/styles/:sid', async (req, res) => {
    const b = parseBody(z.object({ name: z.string().optional(), ratio: z.string().optional() }), req.body)
    await store.mutate((d) => ops.patchStyle(d, p(req, 'cid'), p(req, 'sid'), b))
    res.json(libraryPayload(ctx))
  })

  r.delete('/library/categories/:cid/styles/:sid', async (req, res) => {
    await store.mutate((d) => ops.deleteStyle(d, p(req, 'cid'), p(req, 'sid')))
    res.json(libraryPayload(ctx))
  })

  r.put('/library/categories/:cid/styles/:sid/white', upload.single('file'), async (req, res) => {
    const buf = fileOf(req)
    await store.mutate(async (d) => ops.setWhite(d, p(req, 'cid'), p(req, 'sid'), await addImage(buf)))
    res.json(libraryPayload(ctx))
  })

  r.delete('/library/categories/:cid/styles/:sid/white', async (req, res) => {
    await store.mutate((d) => ops.setWhite(d, p(req, 'cid'), p(req, 'sid'), null))
    res.json(libraryPayload(ctx))
  })

  r.post('/library/categories/:cid/templates', async (req, res) => {
    const b = parseBody(z.object({ name: z.string().default(''), prompt: z.string().default('') }), req.body)
    const t = await store.mutate((d) => ops.addTemplate(d, p(req, 'cid'), b.name, b.prompt))
    res.json({ template: t, ...libraryPayload(ctx) })
  })

  r.patch('/library/categories/:cid/templates/:tid', async (req, res) => {
    const b = parseBody(z.object({ name: z.string().optional(), prompt: z.string().optional() }), req.body)
    await store.mutate((d) => ops.patchTemplate(d, p(req, 'cid'), p(req, 'tid'), b))
    res.json(libraryPayload(ctx))
  })

  r.delete('/library/categories/:cid/templates/:tid', async (req, res) => {
    await store.mutate((d) => ops.deleteTemplate(d, p(req, 'cid'), p(req, 'tid')))
    res.json(libraryPayload(ctx))
  })

  r.put('/library/categories/:cid/templates/:tid/images/:sid', upload.single('file'), async (req, res) => {
    const buf = fileOf(req)
    await store.mutate(async (d) => ops.setTemplateImage(d, p(req, 'cid'), p(req, 'tid'), p(req, 'sid'), await addImage(buf)))
    res.json(libraryPayload(ctx))
  })

  r.delete('/library/categories/:cid/templates/:tid/images/:sid', async (req, res) => {
    await store.mutate((d) => ops.setTemplateImage(d, p(req, 'cid'), p(req, 'tid'), p(req, 'sid'), null))
    res.json(libraryPayload(ctx))
  })

  r.get('/library/recipe', async (req, res) => {
    const q = parseBody(z.object({ cid: z.string(), sid: z.string(), tid: z.string().optional() }), req.query)
    res.json(await recipeFor(store.get(), store.images, q.cid, q.sid, q.tid))
  })

  r.get('/library/extract-recipe', (req, res) => {
    const q = parseBody(z.object({ cid: z.string(), sid: z.string() }), req.query)
    const lib = store.get()
    const cat = store.category(q.cid)
    const style = cat.styles.find((s) => s.id === q.sid)
    if (!style) throw new HttpError(404, '款式不存在，可能已被删除')
    const r2 = buildExtractRequest(extractPromptFor(lib, cat, style), style.ratio)
    res.json({ ...r2, scope: cat.extractPrompt?.trim() ? `「${cat.name}」单独设置` : '全局默认' })
  })

  r.get('/library/images/:hash', async (req, res) => {
    const hash = p(req, 'hash')
    const file = req.query.size === 'thumb' ? await store.images.thumbFile(hash) : store.images.find(hash)?.file
    if (!file) throw new HttpError(404, '图片不存在')
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.sendFile(file)
  })

  r.get('/library/export', async (_req, res) => {
    const zip = await exportZip(store.get(), store.images)
    const d = new Date()
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="library-${stamp}.zip"; filename*=UTF-8''${encodeURIComponent(`模版库-${stamp}.zip`)}`)
    res.send(zip)
  })

  r.post('/library/import', upload.single('file'), async (req, res) => {
    const mode = req.query.mode === 'replace' ? 'replace' : req.query.mode === 'merge' ? 'merge' : null
    if (!mode) throw new HttpError(400, '导入方式要选「合并」或「替换」')
    const r2 = await importZip(store, fileOf(req), mode)
    res.json({ imported: r2.categories, ...libraryPayload(ctx) })
  })
}
