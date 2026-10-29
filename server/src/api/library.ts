import fsp from 'node:fs/promises'
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
import { RATIO_SYSTEM, RatioAnswerSchema, ratioUser, snapRatio } from '../prompts/ratio'
import { labelOf } from '../prompts/placeholders'
import { chatJson } from '../ai/chatClient'
import { AiError, ERROR_LABEL } from '../ai/errors'
import { readSize, shrinkForAnalysis } from '../image/process'
import { detectWhiteShape } from '../image/whiteShape'

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
      z.object({
        name: z.string().optional(),
        hint: z.string().max(500).optional(),
        extractPrompt: z.string().nullable().optional(),
        parentTab: z.string().max(200).nullable().optional(),
        skuCode: z.string().max(30).nullable().optional(),
      }),
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
    const b = parseBody(
      z.object({ name: z.string().optional(), ratio: z.string().optional(), activeTemplate: z.string().optional(), pasteMode: z.enum(['auto', 'local', 'ai']).optional() }),
      req.body,
    )
    await store.mutate((d) => ops.patchStyle(d, p(req, 'cid'), p(req, 'sid'), b))
    res.json(libraryPayload(ctx))
  })

  r.delete('/library/categories/:cid/styles/:sid', async (req, res) => {
    await store.mutate((d) => ops.deleteStyle(d, p(req, 'cid'), p(req, 'sid')))
    res.json(libraryPayload(ctx))
  })

  r.put('/library/categories/:cid/styles/:sid/white', upload.single('file'), async (req, res) => {
    const buf = fileOf(req)
    const hash = await addImage(buf)
    const shape = await detectWhiteShape((await store.images.read(hash)).buffer)
    await store.mutate((d) => ops.setWhite(d, p(req, 'cid'), p(req, 'sid'), hash, shape))
    res.json(libraryPayload(ctx))
  })

  r.delete('/library/categories/:cid/styles/:sid/white', async (req, res) => {
    await store.mutate((d) => ops.setWhite(d, p(req, 'cid'), p(req, 'sid'), null))
    res.json(libraryPayload(ctx))
  })

  /** 让分析模型看白底图（没有就看参考图），估计印图案那块表面的比例；只给建议，不保存 */
  r.post('/library/categories/:cid/styles/:sid/estimate-ratio', async (req, res) => {
    const b = parseBody(z.object({ templateId: z.string().optional() }), req.body ?? {})
    const lib = store.get()
    const cat = lib.categories.find((c) => c.id === p(req, 'cid'))
    if (!cat) throw new HttpError(404, '品类不存在，可能已被删除')
    const style = cat.styles.find((s) => s.id === p(req, 'sid'))
    if (!style) throw new HttpError(404, '款式不存在，可能已被删除')
    const tpl = style.templates.find((t) => t.id === (b.templateId ?? style.activeTemplate))
    const hash = style.whiteImage ?? tpl?.image ?? null
    const found = hash ? store.images.find(hash) : null
    if (!found) throw new HttpError(400, '先上传这个款式的白底图（或参考图），AI 才能看图估算')
    const api = ctx.settings.get().analysis
    if (!api.baseUrl || !api.apiKey) throw new HttpError(400, '还没有设置分析接口，请先在设置里填写')
    const buf = await fsp.readFile(found.file)
    const { width, height } = await readSize(buf)
    let data
    try {
      ;({ data } = await chatJson(
        api,
        { system: RATIO_SYSTEM, user: ratioUser(labelOf(cat.name, style.name), cat.hint), imageJpeg: await shrinkForAnalysis(buf) },
        RatioAnswerSchema,
      ))
    } catch (e) {
      if (e instanceof AiError) throw new HttpError(502, `AI 估算失败：${ERROR_LABEL[e.type]}，${e.message}`)
      throw e
    }
    const box = data.box ?? null
    const boxRatio = box && box[2] > box[0] && box[3] > box[1] ? ((box[2] - box[0]) * width) / ((box[3] - box[1]) * height) : null
    const value = data.width_to_height ?? boxRatio
    if (!data.found || !value) throw new HttpError(422, `AI 没在图里找到印图案的表面${data.reason ? `：${data.reason}` : ''}`)
    res.json({ ratio: snapRatio(value), value, shape: data.shape, surface: data.surface, reason: data.reason, source: style.whiteImage ? '白底图' : '参考图' })
  })

  const T = '/library/categories/:cid/styles/:sid/templates'
  const ids = (req: Request) => [p(req, 'cid'), p(req, 'sid')] as const

  r.post(T, async (req, res) => {
    const b = parseBody(z.object({ name: z.string().default(''), prompt: z.string().default('') }), req.body)
    const t = await store.mutate((d) => ops.addTemplate(d, ...ids(req), b.name, b.prompt))
    res.json({ template: t, ...libraryPayload(ctx) })
  })

  r.patch(`${T}/:tid`, async (req, res) => {
    const b = parseBody(z.object({ name: z.string().optional(), prompt: z.string().optional(), canvasRatio: z.string().nullable().optional() }), req.body)
    await store.mutate((d) => ops.patchTemplate(d, ...ids(req), p(req, 'tid'), b))
    res.json(libraryPayload(ctx))
  })

  r.delete(`${T}/:tid`, async (req, res) => {
    await store.mutate((d) => ops.deleteTemplate(d, ...ids(req), p(req, 'tid')))
    res.json(libraryPayload(ctx))
  })

  r.put(`${T}/:tid/image`, upload.single('file'), async (req, res) => {
    const buf = fileOf(req)
    await store.mutate(async (d) => ops.setTemplateImage(d, ...ids(req), p(req, 'tid'), await addImage(buf)))
    res.json(libraryPayload(ctx))
  })

  r.delete(`${T}/:tid/image`, async (req, res) => {
    await store.mutate((d) => ops.setTemplateImage(d, ...ids(req), p(req, 'tid'), null))
    res.json(libraryPayload(ctx))
  })

  r.get('/library/recipe', async (req, res) => {
    const q = parseBody(z.object({ cid: z.string(), sid: z.string(), tid: z.string().optional() }), req.query)
    res.json(await recipeFor(store, q.cid, q.sid, q.tid))
  })

  r.get('/library/extract-recipe', (req, res) => {
    const q = parseBody(z.object({ cid: z.string(), sid: z.string() }), req.query)
    const lib = store.get()
    const cat = store.category(q.cid)
    const style = cat.styles.find((s) => s.id === q.sid)
    if (!style) throw new HttpError(404, '款式不存在，可能已被删除')
    // 正常流程发的是第①步裁好拉正的印刷面
    const r2 = buildExtractRequest(extractPromptFor(lib, cat, style), style.ratio, true)
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
