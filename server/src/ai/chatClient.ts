import type { z } from 'zod'
import { AiError } from './errors'
import { authHeaders, request } from './http'
import { extractFirstJsonObject } from './json'
import type { Settings } from '../store/settings'

export type AnalysisApi = Settings['analysis']

export const REASK_TEXT = '只输出符合格式的 JSON 对象，不要任何其他文字'

export type ChatRequest = {
  system: string
  user: string
  /** 已经过 shrinkForAnalysis 的 JPEG */
  imageJpeg?: Buffer
  /** 多张图时按顺序发送（同样是缩小后的 JPEG） */
  images?: Buffer[]
  signal?: AbortSignal
}

type Message = { role: 'system' | 'user' | 'assistant'; content: unknown }

async function complete(api: AnalysisApi, messages: Message[], signal?: AbortSignal, extra: Record<string, unknown> = {}): Promise<string> {
  if (!api.baseUrl) throw new AiError('client', '还没有填写分析接口地址')
  const res = await request(
    `${api.baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(api.apiKey) },
      body: JSON.stringify({ model: api.model, temperature: 0, messages, ...extra }),
    },
    api.timeoutSec * 1000,
    signal,
  )
  let json: any
  try {
    json = JSON.parse(res.body.toString('utf8'))
  } catch {
    const text = res.body.toString('utf8')
    if (/^\s*<(!doctype|html)/i.test(text)) {
      throw new AiError('server', '返回的是网页而不是接口数据（可能是请求体过大或地址填错，被网关拦截）')
    }
    throw new AiError('badOutput', '分析接口返回的不是 JSON')
  }
  const content = json?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((p: any) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('')
  }
  throw new AiError('badOutput', '分析接口没有返回内容')
}

export async function chatJson<S extends z.ZodType>(
  api: AnalysisApi,
  req: ChatRequest,
  schema: S,
): Promise<{ data: z.infer<S>; raw: string }> {
  const userContent: unknown[] = [{ type: 'text', text: req.user }]
  for (const img of req.images ?? (req.imageJpeg ? [req.imageJpeg] : [])) {
    userContent.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img.toString('base64')}` } })
  }
  const messages: Message[] = [
    { role: 'system', content: req.system },
    { role: 'user', content: userContent },
  ]
  let lastProblem = ''
  for (let round = 0; round < 2; round++) {
    const raw = await complete(api, messages, req.signal)
    let parsed: unknown
    try {
      parsed = extractFirstJsonObject(raw)
    } catch {
      lastProblem = '回复里没有合法的 JSON'
      if (round === 0) messages.push({ role: 'user', content: REASK_TEXT })
      continue
    }
    const v = schema.safeParse(parsed)
    if (v.success) return { data: v.data, raw }
    lastProblem = '字段不符合要求：' + v.error.issues.map((i) => `${i.path.join('.') || '(根)'} ${i.message}`).join('；')
    if (round === 0) messages.push({ role: 'user', content: REASK_TEXT })
  }
  throw new AiError('badOutput', `分析结果格式不对，已追问一次仍不合格（${lastProblem}）`)
}

export async function pingChat(api: AnalysisApi, timeoutMs: number): Promise<string> {
  const res = await request(
    `${api.baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(api.apiKey) },
      body: JSON.stringify({ model: api.model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    },
    timeoutMs,
  )
  try {
    return String(JSON.parse(res.body.toString('utf8'))?.model ?? api.model)
  } catch {
    return api.model
  }
}

export async function pingModels(api: { baseUrl: string; apiKey: string }, timeoutMs: number): Promise<number | null> {
  const res = await request(`${api.baseUrl}/models`, { method: 'GET', headers: authHeaders(api.apiKey) }, timeoutMs)
  try {
    const j = JSON.parse(res.body.toString('utf8'))
    return Array.isArray(j?.data) ? j.data.length : null
  } catch {
    return null
  }
}
