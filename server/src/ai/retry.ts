import { AiError, CancelledError, isRetryable } from './errors'

export const RETRY_DELAYS_SEC = [3, 6, 10, 15]
export const MAX_ATTEMPTS = RETRY_DELAYS_SEC.length + 1

export function timeScale(): number {
  const v = Number(process.env.TS_RETRY_SCALE)
  return Number.isFinite(v) && v > 0 ? v : 1
}

export function scaled(ms: number): number {
  return Math.max(0, Math.round(ms * timeScale()))
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError())
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new CancelledError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export type RetryOptions = {
  /** 这一步之前已经计入的尝试次数（重启或 429 退回后继续累计） */
  attemptsSoFar: number
  /** 每完成一次计数的尝试就回调一次，参数是累计次数 */
  onAttempt?: (attempts: number, error?: AiError) => void | Promise<void>
  onRetryWait?: (attempts: number, delayMs: number, error: AiError) => void
  signal?: AbortSignal
}

/**
 * 429 和 auth 不在这里处理：直接抛给调度器（退回 pending），429 不计入尝试次数。
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let attempts = opts.attemptsSoFar
  for (;;) {
    let result: T
    try {
      result = await fn()
    } catch (e) {
      if (e instanceof CancelledError) throw e
      if (e instanceof AiError && e.type === 'rateLimit') throw e
      attempts++
      await opts.onAttempt?.(attempts, e instanceof AiError ? e : undefined)
      if (isRetryable(e) && attempts < MAX_ATTEMPTS) {
        const delay = scaled(RETRY_DELAYS_SEC[Math.min(attempts, RETRY_DELAYS_SEC.length) - 1]! * 1000)
        opts.onRetryWait?.(attempts, delay, e as AiError)
        await sleep(delay, opts.signal)
        continue
      }
      throw e
    }
    attempts++
    await opts.onAttempt?.(attempts)
    return result
  }
}
