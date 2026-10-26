import sharp from 'sharp'
import { AiError, CancelledError } from './errors'
import { authHeaders, request } from './http'
import type { Settings } from '../store/settings'
import { log } from '../util/log'

export type ImageInput = { buffer: Buffer; mime: string; filename: string }

export type ImageEditRequest = {
  images: ImageInput[]
  prefix: string
  prompt: string
  size: string
  signal?: AbortSignal
}

export type ImageEditResult = {
  buffer: Buffer
  width: number
  height: number
  params: Record<string, unknown>
  downgraded: boolean
}

const URL_FETCH_TIMEOUT_MS = 60_000

export type ImageApi = Settings['image']

export async function editImage(
  api: ImageApi,
  req: ImageEditRequest,
  onDowngrade?: (message: string) => void | Promise<void>,
): Promise<ImageEditResult> {
  if (!api.baseUrl) throw new AiError('client', '还没有填写生图接口地址')
  if (!req.prompt.trim()) throw new AiError('client', '提示词为空，已拦截，不发送请求')
  if (req.images.length === 0) throw new AiError('client', '没有要发送的图片')

  const send = async (withFidelity: boolean) => {
    const form = new FormData()
    form.append('model', api.model)
    form.append('prompt', req.prefix + req.prompt)
    const field = req.images.length > 1 ? 'image[]' : 'image'
    for (const img of req.images) {
      form.append(field, new Blob([new Uint8Array(img.buffer)], { type: img.mime }), img.filename)
    }
    form.append('n', '1')
    form.append('size', req.size)
    if (withFidelity) {
      form.append('quality', 'high')
      form.append('input_fidelity', 'high')
    }
    const res = await request(
      `${api.baseUrl}/images/edits`,
      { method: 'POST', headers: authHeaders(api.apiKey), body: form },
      api.timeoutSec * 1000,
      req.signal,
    )
    return parseImageResponse(res.body, res.contentType, req.signal)
  }

  let downgraded = false
  let withFidelity = api.sendFidelity
  let buf: Buffer
  try {
    buf = await send(withFidelity)
  } catch (e) {
    if (!(e instanceof AiError) || e.type !== 'unknownParam' || !withFidelity) throw e
    log.warn(`中转站不认保真参数，去掉 quality / input_fidelity 后重发：${e.message}`)
    withFidelity = false
    buf = await send(false)
    downgraded = true
    // 降级请求成功了才下结论，避免误判后把保真参数永久关掉
    await onDowngrade?.(e.message)
  }

  let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>
  try {
    meta = await sharp(buf).metadata()
    if (!meta.width || !meta.height) throw new Error('no size')
  } catch {
    throw new AiError('badImage', '返回的图片无法解码')
  }
  const params: Record<string, unknown> = { n: 1, size: req.size }
  if (withFidelity) Object.assign(params, { quality: 'high', input_fidelity: 'high' })
  return { buffer: buf, width: meta.width, height: meta.height, params, downgraded }
}

async function parseImageResponse(body: Buffer, contentType: string, signal?: AbortSignal): Promise<Buffer> {
  if (contentType.startsWith('image/')) return body
  let json: any
  try {
    json = JSON.parse(body.toString('utf8'))
  } catch {
    const text = body.toString('utf8')
    if (/^\s*<(!doctype|html)/i.test(text)) {
      throw new AiError('badImage', '返回的是网页而不是图片（可能是地址填错或被网关拦截）')
    }
    throw new AiError('badImage', '返回内容里取不到图片')
  }
  const item = json?.data?.[0]
  if (item?.b64_json) {
    const buf = Buffer.from(String(item.b64_json), 'base64')
    if (buf.length === 0) throw new AiError('badImage', '返回的图片内容为空')
    return buf
  }
  if (item?.url) {
    if (signal?.aborted) throw new CancelledError()
    const res = await request(String(item.url), { method: 'GET' }, URL_FETCH_TIMEOUT_MS, signal)
    return res.body
  }
  if (json?.error) throw new AiError('client', String(json.error?.message ?? JSON.stringify(json.error)))
  throw new AiError('badImage', '返回内容里取不到图片')
}
