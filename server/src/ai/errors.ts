import { redact } from '../util/log'

export type AiErrorType =
  | 'network'
  | 'server'
  | 'badImage'
  | 'rateLimit'
  | 'auth'
  | 'unknownParam'
  | 'refused'
  | 'badOutput'
  | 'client'

export class AiError extends Error {
  constructor(
    public type: AiErrorType,
    message: string,
    public status?: number,
    public retryAfterSec?: number,
  ) {
    super(cleanMessage(message))
    this.name = 'AiError'
  }
}

/** 删除任务等主动中止，不算失败，也不重试 */
export class CancelledError extends Error {
  constructor() {
    super('已取消')
    this.name = 'CancelledError'
  }
}

export const RETRYABLE: ReadonlySet<AiErrorType> = new Set(['network', 'server', 'badImage'])

export function isRetryable(e: unknown): boolean {
  return e instanceof AiError && RETRYABLE.has(e.type)
}

export function cleanMessage(msg: string): string {
  const s = redact(String(msg ?? '')).replace(/\s+/g, ' ').trim()
  return s.length > 300 ? s.slice(0, 300) + '…' : s
}

const UNKNOWN_PARAM_WORDS = /unknown|unrecognized|unsupported|not support|invalid|extra/i
const PARAM_NAMES = /input_fidelity|quality/
const REFUSED_WORDS = /content[_ ]?policy|safety|moderation|rejected|violat|违规|敏感/i

export function extractErrorText(body: string): string {
  try {
    const j = JSON.parse(body)
    const m = j?.error?.message ?? j?.message ?? j?.error ?? j?.detail
    if (typeof m === 'string' && m) return m
    if (m) return JSON.stringify(m)
  } catch {
    // 不是 JSON
  }
  if (/^\s*<(!doctype|html)/i.test(body)) {
    return '响应是网页而不是接口数据（可能是请求体过大或地址填错，被网关拦截）'
  }
  return body
}

export function parseRetryAfter(v: string | null | undefined): number | undefined {
  if (!v) return undefined
  const n = Number(v)
  if (Number.isFinite(n) && n >= 0) return n
  const t = Date.parse(v)
  if (!Number.isNaN(t)) return Math.max(0, (t - Date.now()) / 1000)
  return undefined
}

/**
 * 分类时用完整响应体判断：中转站的长错误体里参数名可能在很靠后的位置，截断后再判会漏判。
 */
export function classifyHttp(status: number, body: string, retryAfter?: string | null): AiError {
  const text = extractErrorText(body)
  const msg = `HTTP ${status}：${text || '(无内容)'}`
  if (status === 401 || status === 403) return new AiError('auth', msg, status)
  if (status === 429) return new AiError('rateLimit', msg, status, parseRetryAfter(retryAfter))
  if (status >= 500 || status === 408 || status === 425) return new AiError('server', msg, status)
  if (status === 400 && UNKNOWN_PARAM_WORDS.test(body) && PARAM_NAMES.test(body)) {
    return new AiError('unknownParam', msg, status)
  }
  if ((status === 400 || status === 422) && REFUSED_WORDS.test(body)) return new AiError('refused', msg, status)
  return new AiError('client', msg, status)
}

export function classifyThrown(e: unknown, timedOut: boolean): AiError {
  if (e instanceof AiError) return e
  if (timedOut) return new AiError('network', '请求超时')
  const err = e as { message?: string; cause?: { code?: string; message?: string } }
  const detail = err?.cause?.code || err?.cause?.message || err?.message || String(e)
  return new AiError('network', `网络错误：${detail}`)
}

export const ERROR_LABEL: Record<AiErrorType, string> = {
  network: '网络错误',
  server: '中转站服务出错',
  badImage: '返回的图片无法使用',
  rateLimit: '请求太频繁被限流',
  auth: 'Key 无效或无权限',
  unknownParam: '中转站不支持保真参数',
  refused: '内容被拒',
  badOutput: '分析结果格式不对',
  client: '请求被拒绝',
}
