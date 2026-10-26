import { describe, expect, it } from 'vitest'
import { MAX_ATTEMPTS, withRetry } from '../../server/src/ai/retry'
import { AiError, CancelledError } from '../../server/src/ai/errors'
import { Limiter } from '../../server/src/ai/limiter'

describe('withRetry', () => {
  it('可重试错误最多尝试 5 次', async () => {
    let calls = 0
    const seen: number[] = []
    await expect(
      withRetry(
        async () => {
          calls++
          throw new AiError('server', 'boom', 500)
        },
        { attemptsSoFar: 0, onAttempt: (n) => void seen.push(n) },
      ),
    ).rejects.toMatchObject({ type: 'server' })
    expect(calls).toBe(MAX_ATTEMPTS)
    expect(seen).toEqual([1, 2, 3, 4, 5])
  })

  it('失败几次后成功', async () => {
    let calls = 0
    const r = await withRetry(
      async () => {
        calls++
        if (calls < 3) throw new AiError('network', 'x')
        return 'ok'
      },
      { attemptsSoFar: 0 },
    )
    expect(r).toBe('ok')
    expect(calls).toBe(3)
  })

  it('不可重试错误只尝试一次', async () => {
    for (const type of ['refused', 'client', 'badOutput', 'auth'] as const) {
      let calls = 0
      await expect(
        withRetry(
          async () => {
            calls++
            throw new AiError(type, 'x')
          },
          { attemptsSoFar: 0 },
        ),
      ).rejects.toMatchObject({ type })
      expect(calls, type).toBe(1)
    }
  })

  it('429 直接抛出且不计入次数', async () => {
    const seen: number[] = []
    await expect(
      withRetry(
        async () => {
          throw new AiError('rateLimit', 'x', 429, 3)
        },
        { attemptsSoFar: 2, onAttempt: (n) => void seen.push(n) },
      ),
    ).rejects.toMatchObject({ type: 'rateLimit' })
    expect(seen).toEqual([])
  })

  it('从已有次数继续累计', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw new AiError('server', 'x')
        },
        { attemptsSoFar: 3 },
      ),
    ).rejects.toBeInstanceOf(AiError)
    expect(calls).toBe(2)
  })

  it('等待期间中止抛 CancelledError', async () => {
    const ctrl = new AbortController()
    const p = withRetry(
      async () => {
        ctrl.abort()
        throw new AiError('server', 'x')
      },
      { attemptsSoFar: 0, signal: ctrl.signal },
    )
    await expect(p).rejects.toBeInstanceOf(CancelledError)
  })
})

describe('Limiter', () => {
  it('429 后并发减 1（最低 1），冷却期内不派发，2 分钟后恢复', () => {
    const l = new Limiter()
    l.configure('image', 3)
    const t0 = 1_000_000
    expect(l.limit('image', t0)).toBe(3)
    l.on429('image', 5, t0)
    expect(l.limit('image', t0)).toBe(2)
    expect(l.inCooldown('image', t0)).toBe(true)
    l.on429('image', undefined, t0)
    l.on429('image', undefined, t0)
    expect(l.limit('image', t0)).toBe(1)
    expect(l.limit('analysis', t0)).toBe(3)
    // TS_RETRY_SCALE=0.001：2 分钟缩成 120ms
    expect(l.limit('image', t0 + 200)).toBe(3)
    expect(l.inCooldown('image', t0 + 200)).toBe(false)
    l.dispose()
  })

  it('Retry-After 最多等 120 秒', () => {
    const l = new Limiter()
    const wait = l.on429('analysis', 9999, 0)
    expect(wait).toBe(120)
    expect(l.on429('analysis', undefined, 0)).toBe(20)
    l.dispose()
  })
})
