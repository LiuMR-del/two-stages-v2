import type { SettingsStore } from '../store/settings'

/**
 * 店铺 SP-API：只做读取（Listings Items 的 get / search），不调用任何会修改商品的接口。
 * access token 用 LWA refresh token 换，缓存到过期前 1 分钟。
 */

const TIMEOUT_MS = 20_000
const REFRESH_AHEAD_MS = 60_000
/** 429 时最多等几次（等待不算重试次数，但也不能无限等） */
const MAX_THROTTLE_WAITS = 6
const DEFAULT_THROTTLE_SEC = 2
const PAGE_SIZE = '20'
const MAX_PAGES = 50

export type ParentListing = { sku: string; asin: string | null; themeAttributes: string[] }
export type ChildListing = { sku: string; asin: string | null; status: string[]; values: Record<string, string> }

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new SpapiError('已中止'))
    })
  })

/** attributes 里某个属性的第一个值（{ color: [{ value: 'Design 01', ... }] }） */
export function attributeValue(attrs: unknown, name: string): string | null {
  const list = (attrs as Record<string, unknown> | null)?.[name]
  if (!Array.isArray(list) || !list.length) return null
  const first = list[0] as Record<string, unknown>
  const v = first?.value ?? (first?.standardized_values as unknown[] | undefined)?.[0]
  return v === undefined || v === null ? null : String(v)
}

/** 变体主题里的属性（如 ['color']），在 relationships 里 */
export function themeAttributes(body: any): string[] {
  for (const group of body?.relationships ?? []) {
    for (const r of group?.relationships ?? []) {
      const attrs = r?.variationTheme?.attributes
      if (r?.type === 'VARIATION' && Array.isArray(attrs) && attrs.length) return attrs.map(String)
    }
  }
  return []
}

/** 凭证错误（401 / 403）：第 6 步整体暂停，去设置检查 */
export class SpapiAuthError extends Error {}
export class SpapiError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly retryAfterSec: number | null = null,
  ) {
    super(message)
  }
}

type Cached = { key: string; token: string; expiresAt: number }

export class SpapiClient {
  private cached: Cached | null = null
  private pending: Promise<string> | null = null

  constructor(private settings: SettingsStore) {}

  private creds() {
    return this.settings.get().parent.spapi
  }

  missing(): string[] {
    const s = this.creds()
    return [
      ['sellerId', '店铺 ID'],
      ['clientId', 'Client ID'],
      ['clientSecret', 'Client Secret'],
      ['refreshToken', 'Refresh Token'],
    ]
      .filter(([k]) => !s[k as keyof typeof s])
      .map(([, label]) => label!)
  }

  private async fetchJson(url: string, init: RequestInit): Promise<{ status: number; body: any; headers: Headers }> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const resp = await fetch(url, { ...init, signal: ctrl.signal })
      const text = await resp.text()
      let body: any = null
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        body = { raw: text.slice(0, 200) }
      }
      return { status: resp.status, body, headers: resp.headers }
    } catch (e) {
      throw new SpapiError(ctrl.signal.aborted ? 'SP-API 超时' : `连不上 SP-API：${(e as Error).message}`)
    } finally {
      clearTimeout(timer)
    }
  }

  private async accessToken(): Promise<string> {
    const s = this.creds()
    const miss = this.missing()
    if (miss.length) throw new SpapiAuthError(`SP-API 凭证不全，缺：${miss.join('、')}`)
    // 凭证任何一项改了都要重新换 token，否则「测试连接」测的还是旧凭证
    const key = [s.tokenUrl, s.clientId, s.clientSecret, s.refreshToken].join('|')
    if (this.cached && this.cached.key === key && this.cached.expiresAt - REFRESH_AHEAD_MS > Date.now()) return this.cached.token
    this.pending ??= (async () => {
      try {
        const r = await this.fetchJson(s.tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.refreshToken, client_id: s.clientId, client_secret: s.clientSecret }).toString(),
        })
        if (r.status === 400 || r.status === 401 || r.status === 403) {
          throw new SpapiAuthError(`SP-API 凭证不对，换 token 失败（${r.body?.error_description ?? r.body?.error ?? r.status}）`)
        }
        if (r.status >= 300 || !r.body?.access_token) throw new SpapiError(`SP-API 换 token 失败（HTTP ${r.status}）`, r.status)
        this.cached = { key, token: String(r.body.access_token), expiresAt: Date.now() + Number(r.body.expires_in ?? 3600) * 1000 }
        return this.cached.token
      } finally {
        this.pending = null
      }
    })()
    return this.pending
  }

  /** 只允许 GET */
  async get(path: string, query: Record<string, string> = {}): Promise<{ status: number; body: any }> {
    const token = await this.accessToken()
    const s = this.creds()
    const q = new URLSearchParams(query).toString()
    const r = await this.fetchJson(`${s.endpoint.replace(/\/+$/, '')}${path}${q ? `?${q}` : ''}`, {
      method: 'GET',
      headers: { 'x-amz-access-token': token, Accept: 'application/json' },
    })
    if (r.status === 401 || r.status === 403) {
      this.cached = null
      throw new SpapiAuthError(`SP-API 没有权限或凭证不对（HTTP ${r.status}${r.body?.errors?.[0]?.message ? `：${r.body.errors[0].message}` : ''}）`)
    }
    if (r.status === 429) {
      const ra = Number(r.headers.get('retry-after'))
      throw new SpapiError('SP-API 限流', 429, Number.isFinite(ra) && ra > 0 ? ra : null)
    }
    if (r.status >= 500) throw new SpapiError(`SP-API 出错（HTTP ${r.status}）`, r.status)
    return { status: r.status, body: r.body }
  }

  /** 429 按 Retry-After 等待后再发，不算重试次数 */
  private async getPatiently(path: string, query: Record<string, string>, signal?: AbortSignal) {
    for (let i = 0; ; i++) {
      try {
        return await this.get(path, query)
      } catch (e) {
        if (!(e instanceof SpapiError) || e.status !== 429 || i >= MAX_THROTTLE_WAITS) throw e
        await sleep((e.retryAfterSec ?? DEFAULT_THROTTLE_SEC) * 1000, signal)
      }
    }
  }

  private seller() {
    return encodeURIComponent(this.creds().sellerId)
  }

  /** 父体的 ASIN 和变体主题属性；店铺里没有这个 SKU 返回 null */
  async parent(sku: string, signal?: AbortSignal): Promise<ParentListing | null> {
    const s = this.creds()
    const r = await this.getPatiently(`/listings/2021-08-01/items/${this.seller()}/${encodeURIComponent(sku)}`, { marketplaceIds: s.marketplaceId, includedData: 'summaries,relationships' }, signal)
    if (r.status === 404) return null
    if (r.status >= 400) throw new SpapiError(`查父体失败：HTTP ${r.status}${r.body?.errors?.[0]?.message ? `，${r.body.errors[0].message}` : ''}`, r.status)
    return { sku, asin: r.body?.summaries?.[0]?.asin ?? null, themeAttributes: themeAttributes(r.body) }
  }

  /**
   * 父体下所有子体，按 pageToken 翻完。不同状态（含未完成）的都算，避免撞名。
   * attrs：要取值的属性（变体主题里的）；为空时取常见的 color / style / size_name / pattern_name。
   */
  async children(parentSku: string, attrs: string[], signal?: AbortSignal): Promise<ChildListing[]> {
    const s = this.creds()
    const want = attrs.length ? attrs : ['color', 'style', 'size_name', 'pattern_name']
    const out: ChildListing[] = []
    let token: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const q: Record<string, string> = { marketplaceIds: s.marketplaceId, variationParentSku: parentSku, includedData: 'summaries,attributes', pageSize: PAGE_SIZE }
      if (token) q.pageToken = token
      const r = await this.getPatiently(`/listings/2021-08-01/items/${this.seller()}`, q, signal)
      if (r.status >= 400) throw new SpapiError(`查子体失败：HTTP ${r.status}${r.body?.errors?.[0]?.message ? `，${r.body.errors[0].message}` : ''}`, r.status)
      for (const it of r.body?.items ?? []) {
        if (it?.sku === parentSku) continue
        const values: Record<string, string> = {}
        for (const a of want) {
          const v = attributeValue(it?.attributes, a)
          if (v) values[a] = v
        }
        out.push({ sku: String(it?.sku), asin: it?.summaries?.[0]?.asin ?? null, status: it?.summaries?.[0]?.status ?? [], values })
      }
      token = r.body?.pagination?.nextToken
      if (!token) break
    }
    return out
  }

  /** 换 token 并查一次店铺（按卖家搜一条商品） */
  async test(): Promise<{ ok: boolean; message: string }> {
    const s = this.creds()
    try {
      const r = await this.get(`/listings/2021-08-01/items/${encodeURIComponent(s.sellerId)}`, { marketplaceIds: s.marketplaceId, pageSize: '1' })
      if (r.status >= 400) return { ok: false, message: `连接失败：HTTP ${r.status}${r.body?.errors?.[0]?.message ? `，${r.body.errors[0].message}` : ''}` }
      return { ok: true, message: `连接正常${typeof r.body?.numberOfResults === 'number' ? `，店铺里有 ${r.body.numberOfResults} 个商品` : ''}` }
    } catch (e) {
      return { ok: false, message: `连接失败：${(e as Error).message}` }
    }
  }
}
