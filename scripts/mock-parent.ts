import type express from 'express'

/**
 * 模拟飞书和店铺 SP-API，挂在模拟中转站上。测试改 state 控制返回内容；每个请求都记一条，
 * 用来断言「开关关着时零请求」。
 */

/** values 为 null：读这一页时报错 */
export type MockSheetTab = { sheet_id: string; title: string; values: unknown[][] | null }
export type MockListing = { sku: string; asin?: string; parentSku?: string; status?: string; attributes?: Record<string, unknown>; variationTheme?: string[] }

export type ParentMockState = {
  feishu: {
    appId: string
    appSecret: string
    user: string
    /** 换 token 时 access / refresh 的有效期（秒） */
    accessTtl: number
    refreshTtl: number
    /** 合法的授权 code */
    codes: Set<string>
    access: Map<string, number>
    refresh: Set<string>
    wiki: Record<string, string>
    sheets: Record<string, { title: string; tabs: MockSheetTab[] }>
  }
  spapi: {
    clientId: string
    clientSecret: string
    refreshToken: string
    sellerId: string
    access: Set<string>
    listings: MockListing[]
  }
  calls: { at: number; service: 'feishu' | 'spapi'; method: string; path: string }[]
}

export function newParentMockState(): ParentMockState {
  return {
    feishu: {
      appId: 'cli_mock',
      appSecret: 'mock-app-secret-0001',
      user: '测试用户',
      accessTtl: 7200,
      refreshTtl: 604800,
      codes: new Set(),
      access: new Map(),
      refresh: new Set(),
      wiki: {},
      sheets: {},
    },
    spapi: {
      clientId: 'amzn1.application-oa2-client.mock',
      clientSecret: 'amzn1.oa2-cs.v1.mock',
      refreshToken: 'Atzr|mock-refresh-token-0001',
      sellerId: 'AMOCKSELLER01',
      access: new Set(),
      listings: [],
    },
    calls: [],
  }
}

let seq = 0

export function mountParentMock(app: express.Express, state: () => ParentMockState): void {
  const record = (service: 'feishu' | 'spapi') => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    state().calls.push({ at: Date.now(), service, method: req.method, path: req.path })
    next()
  }
  app.use('/open-apis', record('feishu'))
  app.use('/auth/o2', record('spapi'))
  app.use('/listings', record('spapi'))

  // ---- 飞书 ----
  app.post('/open-apis/authen/v2/oauth/token', (req, res) => {
    const f = state().feishu
    const b = req.body ?? {}
    if (b.client_id !== f.appId || b.client_secret !== f.appSecret) return void res.status(400).json({ code: 20002, error: 'invalid_client', error_description: '应用凭证不对' })
    let ok = false
    if (b.grant_type === 'authorization_code' && f.codes.has(b.code)) {
      f.codes.delete(b.code)
      ok = true
    } else if (b.grant_type === 'refresh_token' && f.refresh.has(b.refresh_token)) {
      f.refresh.delete(b.refresh_token)
      ok = true
    }
    if (!ok) return void res.status(400).json({ code: 20064, error: 'invalid_grant', error_description: 'code 或 refresh_token 无效' })
    const n = ++seq
    const access = `u-acc-${n}`
    const refresh = `u-ref-${n}`
    f.access.set(access, Date.now() + f.accessTtl * 1000)
    f.refresh.add(refresh)
    res.json({ code: 0, access_token: access, expires_in: f.accessTtl, refresh_token: refresh, refresh_token_expires_in: f.refreshTtl, token_type: 'Bearer' })
  })

  const authed = (req: express.Request, res: express.Response): boolean => {
    const t = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    const exp = t ? state().feishu.access.get(t) : undefined
    if (!exp || exp < Date.now()) {
      res.status(401).json({ code: 99991677, msg: 'user access token expired' })
      return false
    }
    return true
  }

  app.get('/open-apis/authen/v1/user_info', (req, res) => {
    if (authed(req, res)) res.json({ code: 0, data: { name: state().feishu.user } })
  })
  app.get('/open-apis/wiki/v2/spaces/get_node', (req, res) => {
    if (!authed(req, res)) return
    const obj = state().feishu.wiki[String(req.query.token)]
    if (!obj) return void res.json({ code: 131005, msg: 'not found' })
    res.json({ code: 0, data: { node: { obj_token: obj, obj_type: 'sheet', title: state().feishu.sheets[obj]?.title ?? '' } } })
  })
  app.get('/open-apis/sheets/v3/spreadsheets/:token/sheets/query', (req, res) => {
    if (!authed(req, res)) return
    const s = state().feishu.sheets[req.params.token]
    if (!s) return void res.json({ code: 1310214, msg: 'spreadsheet not found' })
    res.json({ code: 0, data: { sheets: s.tabs.map((t, index) => ({ sheet_id: t.sheet_id, title: t.title, index })) } })
  })
  app.get('/open-apis/sheets/v3/spreadsheets/:token', (req, res) => {
    if (!authed(req, res)) return
    const s = state().feishu.sheets[req.params.token]
    if (!s) return void res.json({ code: 1310214, msg: 'spreadsheet not found' })
    res.json({ code: 0, data: { spreadsheet: { title: s.title, token: req.params.token } } })
  })
  app.get('/open-apis/sheets/v2/spreadsheets/:token/values/:range', (req, res) => {
    if (!authed(req, res)) return
    const s = state().feishu.sheets[req.params.token]
    const sheetId = String(req.params.range).split('!')[0]
    const tab = s?.tabs.find((t) => t.sheet_id === sheetId)
    if (!tab || !tab.values) return void res.json({ code: 1310211, msg: 'sheet not found' })
    res.json({ code: 0, data: { valueRange: { range: req.params.range, values: tab.values } } })
  })

  // ---- SP-API ----
  app.post('/auth/o2/token', (req, res) => {
    const sp = state().spapi
    const b = req.body ?? {}
    if (b.client_id !== sp.clientId || b.client_secret !== sp.clientSecret) return void res.status(401).json({ error: 'invalid_client', error_description: 'Client authentication failed' })
    if (b.grant_type !== 'refresh_token' || b.refresh_token !== sp.refreshToken) return void res.status(400).json({ error: 'invalid_grant', error_description: 'The request has an invalid grant parameter' })
    const t = `Atza|mock-${++seq}`
    sp.access.add(t)
    res.json({ access_token: t, token_type: 'bearer', expires_in: 3600 })
  })

  const spAuthed = (req: express.Request, res: express.Response): boolean => {
    const sp = state().spapi
    if (!sp.access.has(String(req.headers['x-amz-access-token'] ?? ''))) {
      res.status(403).json({ errors: [{ code: 'Unauthorized', message: 'Access to requested resource is denied.' }] })
      return false
    }
    if (req.params.sellerId !== sp.sellerId) {
      res.status(403).json({ errors: [{ code: 'Unauthorized', message: 'seller id mismatch' }] })
      return false
    }
    return true
  }
  const item = (l: MockListing) => ({
    sku: l.sku,
    summaries: [{ marketplaceId: 'ATVPDKIKX0DER', asin: l.asin ?? null, status: [l.status ?? 'BUYABLE'] }],
    attributes: l.attributes ?? {},
    relationships: l.variationTheme ? [{ marketplaceId: 'ATVPDKIKX0DER', relationships: [{ type: 'VARIATION', variationTheme: { attributes: l.variationTheme, theme: l.variationTheme.join('/').toUpperCase() } }] }] : [],
  })
  app.get('/listings/2021-08-01/items/:sellerId', (req, res) => {
    if (!spAuthed(req, res)) return
    const parent = req.query.variationParentSku ? String(req.query.variationParentSku) : null
    const all = state().spapi.listings.filter((l) => (parent ? l.parentSku === parent : true))
    const size = Number(req.query.pageSize ?? 10)
    const start = Number(req.query.pageToken ?? 0)
    const page = all.slice(start, start + size)
    res.json({ numberOfResults: all.length, items: page.map(item), pagination: start + size < all.length ? { nextToken: String(start + size) } : undefined })
  })
  app.get('/listings/2021-08-01/items/:sellerId/:sku', (req, res) => {
    if (!spAuthed(req, res)) return
    const l = state().spapi.listings.find((x) => x.sku === req.params.sku)
    if (!l) return void res.status(404).json({ errors: [{ code: 'NOT_FOUND', message: 'SKU not found' }] })
    res.json(item(l))
  })
}
