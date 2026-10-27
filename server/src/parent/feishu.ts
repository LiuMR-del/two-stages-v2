import type { SettingsStore } from '../store/settings'

/**
 * 飞书：用应用身份（tenant_access_token）只读表格，不写。表要在飞书里「添加文档应用」给这个应用阅读权限。
 */

const TIMEOUT_MS = 20_000
/** token 过期前这么久就换新的 */
const REFRESH_AHEAD_MS = 60_000
/** 同一个链接 + 标签页，这么久内读过的结果共用 */
export const SHEET_CACHE_MS = 5 * 60_000
const READ_RANGE = 'A1:Z1000'
const HEADER_ROWS = 5

/** App ID / Secret 没填或不对：第 6 步整体暂停，去设置检查 */
export class FeishuAuthError extends Error {}
/** 链接读不了、没有权限等：同样暂停，提示用户 */
export class FeishuError extends Error {}

/** 飞书接口里表示 token 无效、过期的错误码 */
const TOKEN_ERRORS = new Set([99991661, 99991663, 99991664, 99991668])

type Json = Record<string, any>

async function call(url: string, init: RequestInit): Promise<Json> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  let resp: Response
  try {
    resp = await fetch(url, { ...init, signal: ctrl.signal })
  } catch (e) {
    throw new FeishuError(ctrl.signal.aborted ? '飞书接口超时' : `连不上飞书：${(e as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
  let body: Json
  try {
    body = (await resp.json()) as Json
  } catch {
    throw new FeishuError(`飞书返回的不是 JSON（HTTP ${resp.status}）`)
  }
  const code = Number(body.code ?? 0)
  if (resp.status === 401 || TOKEN_ERRORS.has(code)) throw new FeishuAuthError(`飞书 token 无效（${body.msg ?? code}）`)
  if (!resp.ok || code !== 0) throw new FeishuError(String(body.msg ?? body.error_description ?? body.error ?? `HTTP ${resp.status}`) + (code ? `（${code}）` : ''))
  return body
}

// ---- 应用身份 ----

let cached: { key: string; token: string; expiresAt: number } | null = null
let pending: Promise<string> | null = null

/**
 * 应用身份的 tenant_access_token：只用 App ID / App Secret，不用登录、不会过期（快到期自动重新换）。
 * 2026-10-27 用户选的方式；原来的用户授权要在应用后台登记重定向 URL，实测报 20029。
 * force：飞书说 token 无效时重新换一次。
 */
export async function appToken(settings: SettingsStore, force = false): Promise<string> {
  const f = settings.get().parent.feishu
  if (!f.appId || !f.appSecret) throw new FeishuAuthError('还没有填飞书应用的 App ID / App Secret')
  const key = [f.baseUrl, f.appId, f.appSecret].join('|')
  if (!force && cached && cached.key === key && cached.expiresAt - REFRESH_AHEAD_MS > Date.now()) return cached.token
  pending ??= (async () => {
    try {
      const r = await call(`${f.baseUrl.replace(/\/+$/, '')}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: f.appId, app_secret: f.appSecret }),
      }).catch((e) => {
        // App ID / Secret 不对时飞书返回 10003、10014 等普通错误码，这里当作凭证问题
        if (e instanceof FeishuError && /app|secret|10003|10014|10015/i.test(e.message)) throw new FeishuAuthError(`飞书 App ID 或 App Secret 不对（${e.message}）`)
        throw e
      })
      if (!r.tenant_access_token) throw new FeishuError('飞书没有返回 tenant_access_token')
      cached = { key, token: String(r.tenant_access_token), expiresAt: Date.now() + Number(r.expire ?? 7200) * 1000 }
      return cached.token
    } finally {
      pending = null
    }
  })()
  return pending
}

/** 测试用：清掉缓存的 token */
export function resetAppToken(): void {
  cached = null
}

/** 应用没有这张表的权限、或没开通读表权限时，给用户的说明 */
export const ADD_APP_HINT = '在飞书里打开这张表，点右上角「…」→「更多」→「添加文档应用」，选这个应用（给阅读权限）'
const PERMISSION_CODES = new Set([1310213, 1310203, 131006, 1254302, 91403, 1770032])
const SCOPE_CODES = new Set([99991672, 99991679])

function explain(e: unknown): unknown {
  if (!(e instanceof FeishuError) || e instanceof FeishuAuthError) return e
  const code = Number(/（(\d+)）$/.exec(e.message)?.[1] ?? 0)
  if (SCOPE_CODES.has(code)) return new FeishuError(`飞书应用还没开通读表格 / 知识库的权限，要在开发者后台开通「查看电子表格」「查看知识库」并发布版本（${e.message}）`)
  if (PERMISSION_CODES.has(code) || /permission|forbidden|no access|无权限|没有权限/i.test(e.message)) {
    return new FeishuError(`应用没有这张表的权限：${ADD_APP_HINT}（${e.message}）`)
  }
  return e
}

// ---- 读表 ----

export type SheetLink = { kind: 'wiki' | 'sheets'; token: string }

/** /wiki/<token> 和 /sheets/<token> 两种；?sheet= 忽略，所有标签页都读 */
export function parseSheetLink(url: string): SheetLink | null {
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return null
  }
  const m = /\/(wiki|sheets)\/([A-Za-z0-9]+)/.exec(u.pathname)
  return m ? { kind: m[1] as SheetLink['kind'], token: m[2]! } : null
}

export type ParentRow = { theme: string; sku: string; asin: string; row: number }
export type SheetTab = { sheetId: string; title: string }

/** 单元格可能是字符串、数字，或富文本片段（[{ text }]、{ text, link }） */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(cellText).join('').trim()
  if (typeof v === 'object') {
    const o = v as Json
    return cellText(o.text ?? o.value ?? o.link ?? '')
  }
  return ''
}

const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()

/**
 * 前 5 行里找含「父体SKU」的那一行当表头，按表头名字认列（列顺序变了也没关系）。
 * 父体 SKU 为空的行跳过；同一页里 SKU 重复的只留第一条。没有表头返回 null。
 */
export function parseParentRows(values: unknown[][]): ParentRow[] | null {
  const rows = values.map((r) => (Array.isArray(r) ? r.map(cellText) : []))
  const h = rows.slice(0, HEADER_ROWS).findIndex((r) => r.some((c) => norm(c) === norm('父体SKU')))
  if (h < 0) return null
  const col = (name: string) => rows[h]!.findIndex((c) => norm(c) === norm(name))
  const ci = { theme: col('主题'), sku: col('父体SKU'), asin: col('父体ASIN') }
  const seen = new Set<string>()
  const out: ParentRow[] = []
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i]!
    const sku = r[ci.sku] ?? ''
    if (!sku || seen.has(sku.toLowerCase())) continue
    seen.add(sku.toLowerCase())
    out.push({ theme: ci.theme >= 0 ? (r[ci.theme] ?? '') : '', sku, asin: ci.asin >= 0 ? (r[ci.asin] ?? '') : '', row: i + 1 })
  }
  return out
}

export type SheetInfo = { url: string; token: string; title: string; tabs: SheetTab[] }

/** 同一个链接 + 标签页 5 分钟内共用；正在读的请求也共用，不会同时发多次 */
export class FeishuSheets {
  private cache = new Map<string, { at: number; value: Promise<unknown> }>()

  constructor(private settings: SettingsStore) {}

  private base(): string {
    return this.settings.get().parent.feishu.baseUrl.replace(/\/+$/, '')
  }

  private async get(path: string): Promise<Json> {
    const token = await appToken(this.settings)
    try {
      return await call(this.base() + path, { headers: { Authorization: `Bearer ${token}` } })
    } catch (e) {
      if (!(e instanceof FeishuAuthError)) throw explain(e)
      // token 被提前作废：重新换一次再试，只试一次
      const fresh = await appToken(this.settings, true)
      return call(this.base() + path, { headers: { Authorization: `Bearer ${fresh}` } }).catch((e2) => {
        throw explain(e2)
      })
    }
  }

  private cached<T>(key: string, fn: () => Promise<T>, fresh: boolean): Promise<T> {
    const c = this.cache.get(key)
    if (!fresh && c && Date.now() - c.at < SHEET_CACHE_MS) return c.value as Promise<T>
    const value = fn()
    this.cache.set(key, { at: Date.now(), value })
    value.catch(() => this.cache.delete(key))
    return value
  }

  clear(): void {
    this.cache.clear()
  }

  /** 表格名和所有标签页 */
  info(url: string, fresh = false): Promise<SheetInfo> {
    return this.cached(`info|${url}`, async () => {
      const link = parseSheetLink(url)
      if (!link) throw new FeishuError('这个链接读不了：不是飞书表格或知识库链接')
      let token = link.token
      let title = ''
      if (link.kind === 'wiki') {
        const node = (await this.get(`/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(link.token)}`)).data?.node ?? {}
        if (node.obj_type && node.obj_type !== 'sheet') throw new FeishuError(`这个链接读不了：知识库里这一页不是表格（${node.obj_type}）`)
        token = String(node.obj_token ?? '')
        title = String(node.title ?? '')
        if (!token) throw new FeishuError('这个链接读不了：知识库里找不到对应的表格')
      }
      if (!title) {
        title = String((await this.get(`/open-apis/sheets/v3/spreadsheets/${token}`)).data?.spreadsheet?.title ?? '')
      }
      const sheets = ((await this.get(`/open-apis/sheets/v3/spreadsheets/${token}/sheets/query`)).data?.sheets ?? []) as Json[]
      // 多维表格等不是普通表格的页读不了 values，跳过
      const tabs = sheets
        .filter((s) => !s.resource_type || s.resource_type === 'sheet')
        .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
        .map((s) => ({ sheetId: String(s.sheet_id), title: String(s.title ?? '') }))
      return { url, token, title: title || '未命名表格', tabs }
    }, fresh)
  }

  /** 读一个标签页里的父体；标签页不存在返回 null。已经拿到 info 时传进来，不再读一遍表信息 */
  async rows(url: string, tabTitle: string, fresh = false, known?: SheetInfo): Promise<{ tab: SheetTab; rows: ParentRow[] | null; readAt: string } | null> {
    const info = known ?? (await this.info(url, fresh))
    const tab = info.tabs.find((t) => t.title === tabTitle) ?? info.tabs.find((t) => norm(t.title) === norm(tabTitle))
    if (!tab) return null
    return this.cached(`rows|${url}|${tab.sheetId}`, async () => {
      const range = encodeURIComponent(`${tab.sheetId}!${READ_RANGE}`)
      const values = ((await this.get(`/open-apis/sheets/v2/spreadsheets/${info.token}/values/${range}`)).data?.valueRange?.values ?? []) as unknown[][]
      return { tab, rows: parseParentRows(values), readAt: new Date().toISOString() }
    }, fresh)
  }
}
