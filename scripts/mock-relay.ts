import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import express from 'express'
import multer from 'multer'
import sharp from 'sharp'
import { mountParentMock, newParentMockState, type ParentMockState } from './mock-parent'

export type Behavior =
  | 'ok'
  | 'refused'
  | 'unknownParam'
  | 'badImage'
  | 'badJson'
  | 'b64'
  | 'url'
  | 'binary'
  | {
      status?: number
      retryAfter?: number
      route?: { category_id: string | null; style_id: string | null; confidence: number; guess?: string; reason?: string; print_corners?: number[][]; print_flat?: boolean }
      info?: Record<string, unknown>
      /** 素材图验收的回复（source_texts / pattern_texts / element_score / element_issues） */
      qc?: Record<string, unknown>
      /** 主图验收的回复（pattern_texts / main_texts / element_score / fill_issues） */
      mainqc?: Record<string, unknown>
      /** 第 6 步匹配父体的回复（pick / confidence / alternatives / new_themes） */
      parent?: Record<string, unknown>
      format?: 'b64' | 'url' | 'binary'
      /** 先等这么久再响应，用来制造“运行到一半”的状态 */
      delay?: number
    }

export type MockLogEntry = {
  at: number
  endpoint: 'images/edits' | 'chat/completions' | 'models'
  behavior: Behavior
  status: number
  fields: Record<string, string>
  images: { field: string; width: number; height: number; sha256: string; bytes: number }[]
  prompt?: string
  kind?: 'route' | 'info' | 'qc' | 'mainqc' | 'parent' | 'ping' | 'other'
  system?: string
  userText?: string[]
  messageCount?: number
  maxTokens?: number
}

export type MockRelay = {
  port: number
  url: string
  /** route / info / qc 只被对应类型的分析请求消费，优先于 chat */
  script(s: { image?: Behavior[]; chat?: Behavior[]; route?: Behavior[]; info?: Behavior[]; qc?: Behavior[]; mainqc?: Behavior[]; parent?: Behavior[] }): void
  setDefaultDelay(ms: number): void
  log(): MockLogEntry[]
  reset(): void
  /** 模拟飞书和 SP-API 的状态，测试直接改；origin 是它们的接口地址 */
  parent: ParentMockState
  origin: string
  close(): Promise<void>
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/** 不出近白色：素材图验收会把整张近白的图当成空白图 */
function colorFor(prompt: string): { r: number; g: number; b: number } {
  const h = createHash('sha256').update(prompt).digest()
  return { r: Math.min(h[0]!, 200), g: Math.min(h[1]!, 200), b: Math.min(h[2]!, 200) }
}

function parseSize(size: string | undefined): [number, number] {
  const m = /^(\d+)x(\d+)$/.exec(size ?? '')
  return m ? [Number(m[1]), Number(m[2])] : [1024, 1024]
}

/** 默认验收合格 */
const DEFAULT_QC = { source_texts: ['HAPPY FAMILY'], pattern_texts: ['Happy Family'], print_box: [0, 0, 1, 1], element_score: 0.95, element_issues: [], edge_missing: [], edge_extra: [] }
const DEFAULT_PARENT = { pick: 1, confidence: 0.9, reason: '模拟判断', alternatives: [], new_themes: [] }
const DEFAULT_MAINQC = { pattern_texts: ['HAPPY FAMILY'], main_texts: ['Happy Family'], print_box: [0, 0, 1, 1], element_score: 0.95, element_issues: [], fill_issues: [] }

const DEFAULT_INFO = {
  scene: '温馨客厅里挂着的定制相框，适合节日送礼',
  keywords: ['photo frame', 'custom picture frame', 'personalized gift'],
  customizable: ['名字', '照片', '祝福语'],
  blank_items: ['名字', '照片'],
}

function defaultRoute(system: string) {
  const m = /- 品类 id: (c_[A-Za-z0-9]+)｜名称: ([^｜\n]*)｜[^\n]*?款式: (s_[A-Za-z0-9]+)/.exec(system)
  if (!m) return { category_id: null, style_id: null, confidence: 0.9, reason: '清单为空', guess: '未知商品' }
  return { category_id: m[1], style_id: m[3], confidence: 0.9, reason: '模拟判断', guess: m[2] }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function startMockRelay(opts: { port?: number } = {}): Promise<MockRelay> {
  const queues: { image: Behavior[]; chat: Behavior[]; route: Behavior[]; info: Behavior[]; qc: Behavior[]; mainqc: Behavior[]; parent: Behavior[] } = {
    image: [],
    chat: [],
    route: [],
    info: [],
    qc: [],
    mainqc: [],
    parent: [],
  }
  const entries: MockLogEntry[] = []
  const stored = new Map<string, Buffer>()
  let defaultDelay = 0

  const app = express()
  app.use(express.json({ limit: '60mb' }))
  app.use(express.urlencoded({ extended: false }))
  let parentState = newParentMockState()
  mountParentMock(app, () => parentState)
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } })

  const errorBody = (message: string, type = 'invalid_request_error') => ({ error: { message, type } })

  app.post('/__mock/script', (req, res) => {
    const body = req.body ?? {}
    if (Array.isArray(body.image)) queues.image.push(...body.image)
    if (Array.isArray(body.chat)) queues.chat.push(...body.chat)
    if (Array.isArray(body.route)) queues.route.push(...body.route)
    if (Array.isArray(body.info)) queues.info.push(...body.info)
    if (Array.isArray(body.qc)) queues.qc.push(...body.qc)
    if (Array.isArray(body.mainqc)) queues.mainqc.push(...body.mainqc)
    if (Array.isArray(body.parent)) queues.parent.push(...body.parent)
    if (typeof body.defaultDelayMs === 'number') defaultDelay = body.defaultDelayMs
    res.json({ ok: true, pending: { image: queues.image.length, chat: queues.chat.length, route: queues.route.length, info: queues.info.length, qc: queues.qc.length } })
  })
  app.get('/__mock/log', (_req, res) => res.json(entries))
  app.post('/__mock/reset', (_req, res) => {
    for (const q of Object.values(queues)) q.length = 0
    entries.length = 0
    defaultDelay = 0
    res.json({ ok: true })
  })
  app.get('/__mock/img/:id', (req, res) => {
    const b = stored.get(req.params.id)
    if (!b) return void res.status(404).end()
    res.type('png').send(b)
  })

  app.get('/v1/models', (_req, res) => {
    entries.push({ at: Date.now(), endpoint: 'models', behavior: 'ok', status: 200, fields: {}, images: [] })
    res.json({ object: 'list', data: [{ id: 'gpt-image-2' }, { id: 'gpt-5.6' }] })
  })

  app.post('/v1/images/edits', upload.any(), async (req, res) => {
    const behavior: Behavior = queues.image.shift() ?? 'ok'
    const files = (req.files as Express.Multer.File[]) ?? []
    const fields: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.body ?? {})) fields[k] = String(v)
    const images: MockLogEntry['images'] = []
    for (const f of files) {
      let width = 0
      let height = 0
      try {
        const meta = await sharp(f.buffer).metadata()
        width = meta.width ?? 0
        height = meta.height ?? 0
      } catch {
        // 记录下来，由测试断言
      }
      images.push({ field: f.fieldname, width, height, sha256: sha256(f.buffer), bytes: f.size })
    }
    const entry: MockLogEntry = { at: Date.now(), endpoint: 'images/edits', behavior, status: 200, fields, images, prompt: fields.prompt }
    entries.push(entry)
    const b = typeof behavior === 'object' ? behavior : {}
    const delay = b.delay ?? defaultDelay
    if (delay) await sleep(delay)

    const fail = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      entry.status = status
      res.status(status).set(headers).json(body)
    }
    if (typeof b.status === 'number' && b.status >= 400) {
      const headers: Record<string, string> = b.status === 429 && b.retryAfter !== undefined ? { 'Retry-After': String(b.retryAfter) } : {}
      return fail(b.status, errorBody(`mock error ${b.status}`), headers)
    }
    if (behavior === 'refused') return fail(400, errorBody('Your request was rejected as a result of our safety system (content_policy_violation).'))
    if (behavior === 'unknownParam') return fail(400, errorBody('Unknown parameter: input_fidelity'))
    if (behavior === 'badJson') {
      res.type('application/json').send('{"data": [ broken')
      return
    }
    if (behavior === 'badImage') {
      res.json({ data: [{ b64_json: Buffer.from('this is not an image').toString('base64') }] })
      return
    }
    // size=auto 时真实接口照着第一张输入图出图
    const [w, h] = fields.size === 'auto' && images[0]?.width ? [images[0].width, images[0].height] : parseSize(fields.size)
    const key = (fields.prompt ?? '') + images.map((i) => i.sha256).join()
    let background = colorFor(key)
    // 提取素材图跟竞品图同色、生成主图跟素材图同色（只按提示词微调 ±2），默认能过验收的色差检查
    const p = fields.prompt ?? ''
    const like = p.includes('竞品商品图') || p.includes('商品印刷面') || p.includes('第一张图片是素材图') ? files[0] : p.includes('第二张图片是素材图') ? files[1] : undefined
    if (like) {
      try {
        const st = await sharp(like.buffer).stats()
        const jitter = (createHash('sha256').update(key).digest()[0]! % 5) - 2
        const ch = (i: number) => Math.max(0, Math.min(255, Math.round(st.channels[i]!.mean) + jitter))
        background = { r: ch(0), g: ch(1), b: ch(2) }
      } catch {
        // 竞品图读不了就用默认颜色
      }
    }
    const png = await sharp({ create: { width: w, height: h, channels: 3, background } }).png().toBuffer()
    const format = behavior === 'url' || behavior === 'binary' || behavior === 'b64' ? behavior : (b.format ?? 'b64')
    if (format === 'binary') {
      res.type('image/png').send(png)
    } else if (format === 'url') {
      const id = randomBytes(6).toString('hex')
      stored.set(id, png)
      res.json({ data: [{ url: `http://127.0.0.1:${port}/__mock/img/${id}` }] })
    } else {
      res.json({ created: Date.now(), data: [{ b64_json: png.toString('base64') }] })
    }
  })

  app.post('/v1/chat/completions', async (req, res) => {
    const body = req.body ?? {}
    const messages: any[] = Array.isArray(body.messages) ? body.messages : []
    const system = String(messages.find((m) => m.role === 'system')?.content ?? '')
    const userText: string[] = []
    const images: MockLogEntry['images'] = []
    const imageBufs: Buffer[] = []
    for (const m of messages.filter((x) => x.role === 'user')) {
      const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]
      for (const p of parts) {
        if (p.type === 'text') userText.push(String(p.text))
        if (p.type === 'image_url') {
          const url = String(p.image_url?.url ?? '')
          const buf = Buffer.from(url.replace(/^data:[^,]*,/, ''), 'base64')
          imageBufs.push(buf)
          let width = 0
          let height = 0
          try {
            const meta = await sharp(buf).metadata()
            width = meta.width ?? 0
            height = meta.height ?? 0
          } catch {
            // 记录下来，由测试断言
          }
          images.push({ field: url.slice(0, url.indexOf(',')), width, height, sha256: sha256(buf), bytes: buf.length })
        }
      }
    }
    const kind: MockLogEntry['kind'] = system.includes('品类清单')
      ? 'route'
      : system.includes('亚马逊电商主图分析助手')
        ? 'info'
        : system.includes('素材图验收助手')
          ? 'qc'
          : system.includes('主图验收助手')
            ? 'mainqc'
            : system.includes('亚马逊父体匹配助手')
              ? 'parent'
              : body.max_tokens === 1
          ? 'ping'
          : 'other'
    if (kind === 'ping') {
      entries.push({ at: Date.now(), endpoint: 'chat/completions', behavior: 'ok', status: 200, fields: { model: String(body.model) }, images, kind, system, userText, messageCount: messages.length, maxTokens: body.max_tokens })
      return void res.json({ model: body.model, choices: [{ message: { role: 'assistant', content: 'h' } }] })
    }
    const specific = kind === 'route' ? queues.route : kind === 'info' ? queues.info : kind === 'qc' ? queues.qc : kind === 'mainqc' ? queues.mainqc : kind === 'parent' ? queues.parent : null
    const behavior: Behavior = specific?.shift() ?? queues.chat.shift() ?? 'ok'
    const entry: MockLogEntry = {
      at: Date.now(),
      endpoint: 'chat/completions',
      behavior,
      status: 200,
      fields: { model: String(body.model), temperature: String(body.temperature) },
      images,
      kind,
      system,
      userText,
      messageCount: messages.length,
      maxTokens: body.max_tokens,
    }
    entries.push(entry)
    const b = typeof behavior === 'object' ? behavior : {}
    const delay = b.delay ?? defaultDelay
    if (delay) await sleep(delay)
    if (typeof b.status === 'number' && b.status >= 400) {
      entry.status = b.status
      const headers: Record<string, string> = b.status === 429 && b.retryAfter !== undefined ? { 'Retry-After': String(b.retryAfter) } : {}
      return void res.status(b.status).set(headers).json(errorBody(`mock error ${b.status}`))
    }
    if (behavior === 'refused') {
      entry.status = 400
      return void res.status(400).json(errorBody('content_policy_violation: rejected by moderation'))
    }
    // 主图验收：印刷面框按主图里非白的区域给（主图补方时两边有白边）
    let mainBox: number[] | null = null
    if (kind === 'mainqc' && imageBufs[1]) {
      try {
        const { info } = await sharp(imageBufs[1]).trim({ background: '#ffffff', threshold: 10 }).toBuffer({ resolveWithObject: true })
        const m = await sharp(imageBufs[1]).metadata()
        const x0 = -(info.trimOffsetLeft ?? 0)
        const y0 = -(info.trimOffsetTop ?? 0)
        mainBox = [x0 / m.width!, y0 / m.height!, (x0 + info.width) / m.width!, (y0 + info.height) / m.height!]
      } catch {
        mainBox = null
      }
    }
    let content: string
    if (behavior === 'badJson') content = '抱歉，我无法按格式输出。'
    else if (b.route) content = JSON.stringify({ reason: '模拟判断', guess: '模拟品类', ...b.route })
    else if (b.info) content = '```json\n' + JSON.stringify(b.info) + '\n```'
    else if (b.qc) content = JSON.stringify({ ...DEFAULT_QC, ...b.qc })
    else if (b.parent) content = JSON.stringify({ ...DEFAULT_PARENT, ...b.parent })
    else if (b.mainqc) content = JSON.stringify({ ...DEFAULT_MAINQC, print_box: mainBox ?? DEFAULT_MAINQC.print_box, ...b.mainqc })
    else if (kind === 'route') content = JSON.stringify(defaultRoute(system))
    else if (kind === 'info') content = '这是分析结果：\n```json\n' + JSON.stringify(DEFAULT_INFO) + '\n```'
    else if (kind === 'qc') content = JSON.stringify(DEFAULT_QC)
    else if (kind === 'parent') content = JSON.stringify(DEFAULT_PARENT)
    else if (kind === 'mainqc') content = JSON.stringify({ ...DEFAULT_MAINQC, print_box: mainBox ?? DEFAULT_MAINQC.print_box })
    else content = '{}'
    res.json({ model: body.model, choices: [{ index: 0, message: { role: 'assistant', content } }] })
  })

  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0

  return {
    port,
    url: `http://127.0.0.1:${port}/v1`,
    script(s) {
      if (s.image) queues.image.push(...s.image)
      if (s.chat) queues.chat.push(...s.chat)
      if (s.route) queues.route.push(...s.route)
      if (s.info) queues.info.push(...s.info)
      if (s.qc) queues.qc.push(...s.qc)
      if (s.mainqc) queues.mainqc.push(...s.mainqc)
      if (s.parent) queues.parent.push(...s.parent)
    },
    setDefaultDelay(ms) {
      defaultDelay = ms
    },
    log: () => entries.slice(),
    get parent() {
      return parentState
    },
    origin: `http://127.0.0.1:${port}`,
    reset() {
      parentState = newParentMockState()
      for (const q of Object.values(queues)) q.length = 0
      entries.length = 0
      defaultDelay = 0
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_PORT) || 3999
  startMockRelay({ port }).then((m) => {
    console.log(`模拟中转站已启动：${m.url}（地址填这个，Key 随便填）`)
  })
}
