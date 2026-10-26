import { AiError, CancelledError, classifyHttp, classifyThrown } from './errors'

export type HttpResult = { status: number; headers: Headers; body: Buffer; contentType: string }

/**
 * 发请求并把所有失败统一成 AiError；外部 signal 中止时抛 CancelledError。
 * 非 2xx 一律在这里分类，调用方只处理成功响应。
 */
export async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HttpResult> {
  if (signal?.aborted) throw new CancelledError()
  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, timeoutMs)
  const onAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onAbort)
  try {
    const resp = await fetch(url, { ...init, signal: ctrl.signal })
    const body = Buffer.from(await resp.arrayBuffer())
    const contentType = resp.headers.get('content-type') ?? ''
    if (!resp.ok) throw classifyHttp(resp.status, body.toString('utf8'), resp.headers.get('retry-after'))
    return { status: resp.status, headers: resp.headers, body, contentType }
  } catch (e) {
    if (signal?.aborted) throw new CancelledError()
    if (e instanceof AiError) throw e
    throw classifyThrown(e, timedOut)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export function authHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}
