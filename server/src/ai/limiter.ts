import type { ApiKind } from '../store/settings'
import { scaled } from './retry'

const RECOVER_MS = 120_000
const DEFAULT_WAIT_SEC = 20
const MAX_WAIT_SEC = 120

type KindState = { configured: number; current: number; last429: number; cooldownUntil: number }

/**
 * 429 之后：该类接口在 Retry-After 内不再派发新步骤，并发上限临时减 1；
 * 连续 2 分钟没有新的 429 就恢复设置值。
 */
export class Limiter {
  private s: Record<ApiKind, KindState> = {
    image: { configured: 2, current: 2, last429: 0, cooldownUntil: 0 },
    analysis: { configured: 3, current: 3, last429: 0, cooldownUntil: 0 },
  }
  private timers = new Set<NodeJS.Timeout>()

  constructor(private onChange: () => void = () => {}) {}

  configure(kind: ApiKind, limit: number): void {
    const st = this.s[kind]
    const reduced = st.configured - st.current
    st.configured = Math.max(1, limit)
    st.current = Math.max(1, st.configured - Math.max(0, reduced))
    this.refresh(kind)
  }

  limit(kind: ApiKind, now = Date.now()): number {
    this.refresh(kind, now)
    return this.s[kind].current
  }

  inCooldown(kind: ApiKind, now = Date.now()): boolean {
    return now < this.s[kind].cooldownUntil
  }

  on429(kind: ApiKind, retryAfterSec: number | undefined, now = Date.now()): number {
    const st = this.s[kind]
    const sec = Math.min(MAX_WAIT_SEC, retryAfterSec ?? DEFAULT_WAIT_SEC)
    const waitMs = scaled(sec * 1000)
    st.current = Math.max(1, st.current - 1)
    st.last429 = now
    st.cooldownUntil = Math.max(st.cooldownUntil, now + waitMs)
    this.later(waitMs + 1)
    this.later(scaled(RECOVER_MS) + 1)
    return waitMs
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }

  private refresh(kind: ApiKind, now = Date.now()): void {
    const st = this.s[kind]
    if (st.current < st.configured && now - st.last429 >= scaled(RECOVER_MS)) st.current = st.configured
  }

  private later(ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t)
      this.onChange()
    }, ms)
    t.unref?.()
    this.timers.add(t)
  }
}
