import { describe, expect, it } from 'vitest'
import { AiError, classifyHttp, classifyThrown, cleanMessage, isRetryable } from '../../server/src/ai/errors'
import { registerSecret } from '../../server/src/util/log'

const body = (message: string) => JSON.stringify({ error: { message, type: 'invalid_request_error' } })

describe('classifyHttp', () => {
  it('5xx / 408 / 425 → server，可重试', () => {
    for (const s of [500, 502, 503, 504, 408, 425]) {
      const e = classifyHttp(s, body('boom'))
      expect(e.type, String(s)).toBe('server')
      expect(isRetryable(e)).toBe(true)
    }
  })
  it('429 → rateLimit，带 Retry-After', () => {
    const e = classifyHttp(429, body('slow down'), '7')
    expect(e.type).toBe('rateLimit')
    expect(e.retryAfterSec).toBe(7)
    expect(isRetryable(e)).toBe(false)
  })
  it('401 / 403 → auth', () => {
    expect(classifyHttp(401, body('bad key')).type).toBe('auth')
    expect(classifyHttp(403, body('forbidden')).type).toBe('auth')
  })
  it('400 + 参数名 + 不支持字样 → unknownParam', () => {
    expect(classifyHttp(400, body('Unknown parameter: input_fidelity')).type).toBe('unknownParam')
    expect(classifyHttp(400, body("Unrecognized request argument supplied: quality")).type).toBe('unknownParam')
    expect(classifyHttp(400, body('extra fields not permitted: input_fidelity')).type).toBe('unknownParam')
  })
  it('400 只有参数名、没有不支持字样，不算 unknownParam', () => {
    expect(classifyHttp(400, JSON.stringify({ error: { message: 'quality too low' } })).type).toBe('client')
  })
  it('400 / 422 + 安全拦截字样 → refused，不可重试', () => {
    const e = classifyHttp(400, body('Your request was rejected by the safety system'))
    expect(e.type).toBe('refused')
    expect(isRetryable(e)).toBe(false)
    expect(classifyHttp(422, JSON.stringify({ error: { message: 'content_policy_violation' } })).type).toBe('refused')
    expect(classifyHttp(400, JSON.stringify({ message: '图片包含敏感内容' })).type).toBe('refused')
  })
  it('其余 4xx → client，不可重试', () => {
    const e = classifyHttp(404, 'not found')
    expect(e.type).toBe('client')
    expect(isRetryable(e)).toBe(false)
    expect(classifyHttp(413, '<html>too large</html>').message).toContain('网页')
  })
})

describe('classifyThrown', () => {
  it('fetch 异常和超时 → network', () => {
    expect(classifyThrown(new TypeError('fetch failed'), false).type).toBe('network')
    expect(classifyThrown(new Error('aborted'), true).message).toBe('请求超时')
    expect(isRetryable(classifyThrown(new Error('x'), false))).toBe(true)
  })
  it('badImage 可重试，badOutput 不可重试', () => {
    expect(isRetryable(new AiError('badImage', 'x'))).toBe(true)
    expect(isRetryable(new AiError('badOutput', 'x'))).toBe(false)
  })
})

describe('cleanMessage', () => {
  it('截断到 300 字并去掉 Key', () => {
    registerSecret('sk-secret-abcdefghijkl')
    const m = cleanMessage('bad key sk-secret-abcdefghijkl ' + 'x'.repeat(400))
    expect(m).not.toContain('sk-secret-abcdefghijkl')
    expect(m.length).toBeLessThanOrEqual(301)
  })
  it('去掉 base64 图片内容', () => {
    const m = cleanMessage('payload data:image/png;base64,' + 'A'.repeat(500))
    expect(m).not.toMatch(/AAAAAAAAAA/)
  })
})
