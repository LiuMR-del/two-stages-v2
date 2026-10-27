import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startMockRelay, type MockRelay } from '../../scripts/mock-relay'
import { startInProcess, type Api } from '../inprocess'
import type { AppContext } from '../../server/src/context'
import { cellText, parseParentRows, parseSheetLink, FEISHU_SCOPE } from '../../server/src/parent/feishu'
import { parseSpapiCredentials, rtfToText } from '../../server/src/parent/credentials'
import { LARK_REDIRECT } from '../../server/src/parent/oauth'
import { redact } from '../../server/src/util/log'

let mock: MockRelay
let srv: Awaited<ReturnType<typeof startInProcess>>
let api: Api
let ctx: AppContext

beforeAll(async () => {
  mock = await startMockRelay()
  srv = await startInProcess()
  api = srv.api
  ctx = srv.ctx
})
afterAll(async () => {
  await srv.close()
  await mock.close()
})
beforeEach(() => mock.reset())

const FAKE = {
  sellerId: 'A1B2C3D4E5F6G7',
  clientId: 'amzn1.application-oa2-client.' + 'a1'.repeat(16),
  clientSecret: 'amzn1.oa2-cs.v1.' + 'f0'.repeat(32),
  refreshToken: 'Atzr|' + 'IwEBIAbc-_xyz'.repeat(20),
}
/** 照着真实凭证文件的结构造一份：店铺ID 是 GBK 转义的中文标签，其余三项没有标签 */
const FAKE_RTF = `{\\rtf1\\ansi\\ansicpg936\\cocoartf2822
{\\fonttbl\\f0\\fnil\\fcharset134 STSongti-SC-Regular;}
\\pard\\intbl\\itap1
\\f0\\fs29 \\cf0 \\strokec2 \\'b5\\'ea\\'c6\\'ccID\\'a3\\'ba${FAKE.sellerId}\\cell \\lastrow\\row
\\cf0 \\strokec2 ${FAKE.clientId}\\
\\cell \\lastrow\\row
\\cf0 \\strokec2 ${FAKE.clientSecret}\\
\\cell \\lastrow\\row
\\cf0 \\strokec2 ${FAKE.refreshToken}\\cell \\lastrow\\row
}`

async function useMock() {
  // 接口地址设置接口改不了，测试从程序内部指到模拟服务
  await ctx.settings.updateParent((p) => {
    Object.assign(p.feishu, { baseUrl: mock.origin, accountsUrl: mock.origin, user: null, authAppId: '', accessToken: '', accessExpiresAt: '', refreshToken: '', refreshExpiresAt: '' })
    Object.assign(p.spapi, { endpoint: mock.origin, tokenUrl: mock.origin + '/auth/o2/token' })
  })
  ctx.parent.sheets.clear()
  await api.json('PUT', '/settings', {
    parent: {
      feishu: { appId: mock.parent.feishu.appId, appSecret: mock.parent.feishu.appSecret, redirect: 'self' },
      spapi: { sellerId: mock.parent.spapi.sellerId, clientId: mock.parent.spapi.clientId, clientSecret: mock.parent.spapi.clientSecret, refreshToken: mock.parent.spapi.refreshToken },
    },
  })
}

async function authorize(): Promise<void> {
  const r = await api.json('POST', '/settings/feishu/authorize')
  const state = new URL(r.body.url).searchParams.get('state')!
  mock.parent.feishu.codes.add('code-1')
  const cb = await api.raw(`/feishu/callback?code=code-1&state=${state}`)
  expect(cb.status).toBe(200)
}

describe('父体匹配设置', () => {
  it('默认关闭；阈值 0.7、创建人标识 5、美国站', async () => {
    const s = (await api.json('GET', '/settings')).body.parent
    expect(s).toMatchObject({ enabled: false, threshold: 0.7, creatorMark: '5', sheetUrl: '', recentUrls: [] })
    expect(s.spapi.marketplaceId).toBe('ATVPDKIKX0DER')
    expect(s.feishu.redirect).toBe('lark3000')
  })

  it('密钥打码返回；打码的值原样传回不覆盖原值；日志里也打码', async () => {
    await api.json('PUT', '/settings', { parent: { feishu: { appId: 'cli_x', appSecret: 'feishu-secret-abcd' }, spapi: { clientSecret: 'amzn1.oa2-cs.v1.zzzz9876' } } })
    const got = (await api.json('GET', '/settings')).body.parent
    expect(got.feishu.appSecret).toBe('••••abcd')
    expect(got.spapi.clientSecret).toBe('••••9876')
    await api.json('PUT', '/settings', { parent: { feishu: { appSecret: '••••abcd' } } })
    expect(ctx.settings.get().parent.feishu.appSecret).toBe('feishu-secret-abcd')
    expect(redact('用了 feishu-secret-abcd 和 amzn1.oa2-cs.v1.zzzz9876')).toBe('用了 *** 和 ***')
  })

  it('凭证要发往的接口地址不能通过设置接口改', async () => {
    const before = ctx.settings.get().parent.spapi.tokenUrl
    await api.json('PUT', '/settings', { parent: { spapi: { tokenUrl: 'http://evil.example/token' }, feishu: { baseUrl: 'http://evil.example' } } })
    expect(ctx.settings.get().parent.spapi.tokenUrl).toBe(before)
    expect(ctx.settings.get().parent.feishu.baseUrl).not.toBe('http://evil.example')
  })

  it('别的网页跨站提交（带别的 Origin）一律拒绝：换不了凭证、退不了授权', async () => {
    const evil = (path: string, body: string) =>
      fetch(api.base + path, { method: 'POST', headers: { Origin: 'http://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body })
    expect((await evil('/settings/spapi/import', `text=${encodeURIComponent('店铺ID：AEVIL1234567')}`)).status).toBe(403)
    expect((await evil('/settings/feishu/logout', '')).status).toBe(403)
    expect((await evil('/jobs/clear-all', '')).status).toBe(403)
    expect(ctx.settings.get().parent.spapi.sellerId).not.toBe('AEVIL1234567')
  })
})

describe('SP-API 凭证导入', () => {
  it('RTF 原文里能取出四项（不依赖 textutil）', () => {
    expect(parseSpapiCredentials(FAKE_RTF)).toEqual(FAKE)
    expect(rtfToText(FAKE_RTF)).toContain('店铺ID：')
    expect(parseSpapiCredentials(`Seller ID: ${FAKE.sellerId}\n${FAKE.clientId}\n${FAKE.clientSecret}\n${FAKE.refreshToken}`)).toEqual(FAKE)
  })

  it('上传 RTF：存进设置，接口不回显明文', async () => {
    const r = await api.upload('POST', '/settings/spapi/import', 'file', [{ name: '凭证.rtf', buffer: Buffer.from(FAKE_RTF, 'latin1'), type: 'application/rtf' }])
    expect(r.status).toBe(200)
    expect(r.body.found).toEqual({ sellerId: true, clientId: true, clientSecret: true, refreshToken: true })
    const text = JSON.stringify(r.body)
    for (const v of Object.values(FAKE)) expect(text).not.toContain(v)
    expect(ctx.settings.get().parent.spapi).toMatchObject(FAKE)
    expect(r.body.settings.parent.spapi.refreshToken).toBe('••••' + FAKE.refreshToken.slice(-4))
  })

  it('没有标签时不把站点 ID、AWS 访问密钥当成店铺 ID', () => {
    expect(parseSpapiCredentials(`站点 ATVPDKIKX0DER\n${FAKE.clientId}`).sellerId).toBeNull()
    expect(parseSpapiCredentials(`AKIAIOSFODNN7EXAMPLE A1B2C3D4E5F6G7`).sellerId).toBe('A1B2C3D4E5F6G7')
    expect(parseSpapiCredentials(`A1B2C3D4E5F6G7 A9Z8Y7X6W5V4U3`).sellerId).toBeNull()
  })

  it('粘贴文字也行；什么都没找到时报错', async () => {
    expect((await api.json('POST', '/settings/spapi/import', { text: `店铺ID：${FAKE.sellerId}` })).body.found.sellerId).toBe(true)
    const bad = await api.json('POST', '/settings/spapi/import', { text: '随便一段字' })
    expect(bad.status).toBe(400)
  })
})

describe('SP-API 测试连接', () => {
  it('凭证对：换 token 并查一次店铺；凭证错：给出原因', async () => {
    await useMock()
    mock.parent.spapi.listings = [{ sku: 'X-1' }, { sku: 'X-2' }]
    const ok = await api.json('POST', '/settings/spapi/test')
    expect(ok.body).toEqual({ ok: true, message: '连接正常，店铺里有 2 个商品' })
    await api.json('PUT', '/settings', { parent: { spapi: { clientSecret: 'amzn1.oa2-cs.v1.wrong' } } })
    const bad = await api.json('POST', '/settings/spapi/test')
    expect(bad.body.ok).toBe(false)
    expect(bad.body.message).toContain('SP-API 凭证不对')
    // 只读：没有任何非 GET 的商品接口请求
    // 只读：除了换 token，对店铺的请求全是 GET
    const shop = mock.parent.calls.filter((c) => c.service === 'spapi' && c.path !== '/token')
    expect(shop.length).toBeGreaterThan(0)
    expect(shop.filter((c) => c.method !== 'GET')).toEqual([])
  })
})

describe('飞书授权', () => {
  it('授权页地址带 App ID、回调、只读 scope 和 state；回调换 token，显示授权人', async () => {
    await useMock()
    const r = await api.json('POST', '/settings/feishu/authorize')
    const u = new URL(r.body.url)
    expect(u.origin + u.pathname).toBe(mock.origin + '/open-apis/authen/v1/authorize')
    expect(u.searchParams.get('client_id')).toBe(mock.parent.feishu.appId)
    expect(u.searchParams.get('scope')).toBe(FEISHU_SCOPE)
    expect(u.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/feishu\/callback$/)
    mock.parent.feishu.codes.add('good')
    const html = await (await api.raw(`/feishu/callback?code=good&state=${u.searchParams.get('state')}`)).text()
    expect(html).toContain('授权成功，可以关闭这个页面')
    const f = (await api.json('GET', '/settings')).body.parent.feishu
    expect(f.user).toBe('测试用户')
    expect(f.accessToken).toMatch(/^••••/)
    // state 只能用一次
    expect((await api.raw(`/feishu/callback?code=good&state=${u.searchParams.get('state')}`)).status).toBe(400)
  })

  it('access token 过期时用 refresh token 换新的，并保存新的 refresh token；refresh 也过期时报授权过期', async () => {
    await useMock()
    await authorize()
    mock.parent.feishu.sheets.shtA = { title: '父体分类汇总', tabs: [] }
    const oldRefresh = ctx.settings.get().parent.feishu.refreshToken
    await ctx.settings.updateParent((p) => (p.feishu.accessExpiresAt = new Date(Date.now() - 1000).toISOString()))
    ctx.parent.sheets.clear()
    const ok = await api.json('POST', '/settings/parent/test', { url: 'https://x.feishu.cn/sheets/shtA' })
    expect(ok.body.ok).toBe(true)
    const f = ctx.settings.get().parent.feishu
    expect(f.refreshToken).not.toBe(oldRefresh)
    expect(mock.parent.feishu.refresh.has(oldRefresh)).toBe(false)

    await ctx.settings.updateParent((p) => {
      p.feishu.accessExpiresAt = new Date(Date.now() - 1000).toISOString()
      p.feishu.refreshExpiresAt = new Date(Date.now() - 1000).toISOString()
    })
    ctx.parent.sheets.clear()
    const bad = await api.json('POST', '/settings/parent/test', { url: 'https://x.feishu.cn/sheets/shtA' })
    expect(bad.body).toMatchObject({ ok: false, auth: true, message: '飞书授权已过期，去设置重新授权' })
  })

  it('飞书超时、连不上不算授权过期；飞书说 access token 无效时先用 refresh token 换一次再试', async () => {
    await useMock()
    await authorize()
    mock.parent.feishu.sheets.shtD = { title: '表D', tabs: [] }
    // 服务端提前作废了 access token（本地还以为没过期）
    mock.parent.feishu.access.clear()
    const r = await api.json('POST', '/settings/parent/test', { url: 'https://x.feishu.cn/sheets/shtD' })
    expect(r.body.ok).toBe(true)
    // 换 token 时网络出错：报普通错误，不把授权标成过期
    await ctx.settings.updateParent((p) => (p.feishu.accessExpiresAt = new Date(Date.now() - 1000).toISOString()))
    await ctx.settings.updateParent((p) => (p.feishu.baseUrl = 'http://127.0.0.1:9'))
    ctx.parent.sheets.clear()
    const net = await api.json('POST', '/settings/parent/test', { url: 'https://x.feishu.cn/sheets/shtD' })
    expect(net.body.ok).toBe(false)
    expect(net.body.auth).toBeUndefined()
    const f = ctx.settings.get().parent.feishu
    expect(new Date(f.refreshExpiresAt).getTime()).toBeGreaterThan(Date.now())
    expect(f.refreshToken).not.toBe('')
  })

  it('借用 lark-mcp 的 localhost:3000/callback：临时在 3000 端口接收一次', async (t) => {
    await useMock()
    await api.json('PUT', '/settings', { parent: { feishu: { redirect: 'lark3000' } } })
    const r = await api.json('POST', '/settings/feishu/authorize')
    if (r.status === 409) return t.skip() // 这台机器上 3000 端口正被占用
    const u = new URL(r.body.url)
    expect(u.searchParams.get('redirect_uri')).toBe(LARK_REDIRECT)
    mock.parent.feishu.codes.add('c3000')
    const cb = await fetch(`http://127.0.0.1:3000/callback?code=c3000&state=${u.searchParams.get('state')}`)
    expect(await cb.text()).toContain('授权成功')
    expect(ctx.settings.get().parent.feishu.user).toBe('测试用户')
    // 收到一次就关掉
    await new Promise((r2) => setTimeout(r2, 50))
    await expect(fetch('http://127.0.0.1:3000/callback')).rejects.toThrow()
    await expect(fetch('http://[::1]:3000/callback')).rejects.toThrow()
  })
})

describe('读飞书表', () => {
  it('链接解析：wiki 和 sheets 两种，?sheet= 忽略', () => {
    expect(parseSheetLink('https://jvp0pdxrgz8.feishu.cn/wiki/K7iKwxoJDilnu9kJoQvcdNbDnoe?sheet=0ddCxN')).toEqual({ kind: 'wiki', token: 'K7iKwxoJDilnu9kJoQvcdNbDnoe' })
    expect(parseSheetLink('https://x.feishu.cn/sheets/shtcnAbC123?sheet=abc')).toEqual({ kind: 'sheets', token: 'shtcnAbC123' })
    expect(parseSheetLink('https://x.feishu.cn/docx/abc')).toBeNull()
    expect(parseSheetLink('不是链接')).toBeNull()
  })

  it('表头在前 5 行里找「父体SKU」，按名字认列；空 SKU 跳过、重复只留第一条；富文本单元格取文字', () => {
    expect(cellText([{ text: 'HJ-cn-' }, { text: 'yklgj' }])).toBe('HJ-cn-yklgj')
    const rows = parseParentRows([
      ['父体分类汇总'],
      ['备注', '父体 ASIN', '父体SKU', '主题'],
      ['', 'B0AAA', 'HJ-cn-yklgj-Christmas', 'Christmas'],
      ['', 'B0BBB', [{ text: 'HJ-cn-yklgj-Christmas Baby' }], 'Christmas Baby'],
      ['', '', '', '空的跳过'],
      ['', 'B0CCC', 'hj-cn-yklgj-christmas', '重复的跳过'],
    ])
    expect(rows).toEqual([
      { theme: 'Christmas', sku: 'HJ-cn-yklgj-Christmas', asin: 'B0AAA', row: 3 },
      { theme: 'Christmas Baby', sku: 'HJ-cn-yklgj-Christmas Baby', asin: 'B0BBB', row: 4 },
    ])
    expect(parseParentRows([['a'], ['b'], ['c'], ['d'], ['e'], ['父体SKU']])).toBeNull()
  })

  it('读一下试试：知识库链接换成表格，返回表格名、标签页和父体数量；记进用过的链接', async () => {
    await useMock()
    await authorize()
    mock.parent.feishu.wiki.wikiTok = 'shtB'
    mock.parent.feishu.sheets.shtB = {
      title: '父体分类汇总',
      tabs: [
        { sheet_id: 's1', title: '铝板画', values: [['主题', '父体SKU', '父体ASIN'], ['Love', 'HJ-lbh5-Love', 'B01'], ['Home', 'HJ-lbh5-Home', 'B02']] },
        { sheet_id: 's2', title: '说明', values: [['这一页没有表头']] },
      ],
    }
    const url = 'https://jvp0pdxrgz8.feishu.cn/wiki/wikiTok?sheet=s1'
    const r = await api.json('POST', '/settings/parent/test', { url })
    expect(r.body).toEqual({
      ok: true,
      title: '父体分类汇总',
      tabs: [
        { title: '铝板画', count: 2, header: true },
        { title: '说明', count: 0, header: false },
      ],
    })
    const p = ctx.settings.get().parent
    expect(p.recentUrls[0]).toMatchObject({ url, title: '父体分类汇总' })
    expect(p.tabs).toEqual(['铝板画', '说明'])
    // 某一页读不了只标在那一页，不让整张表失败
    mock.parent.feishu.sheets.shtB!.tabs.push({ sheet_id: 'gone', title: '坏页', values: null })
    const partial = await api.json('POST', '/settings/parent/test', { url })
    expect(partial.body.ok).toBe(true)
    expect(partial.body.tabs[0]).toEqual({ title: '铝板画', count: 2, header: true })
    expect(partial.body.tabs[2]).toMatchObject({ title: '坏页', count: 0, header: false, error: expect.stringContaining('sheet not found') })
    const bad = await api.json('POST', '/settings/parent/test', { url: 'https://x.feishu.cn/sheets/nope' })
    expect(bad.body.ok).toBe(false)
    expect(bad.body.message).toMatch(/^这个链接读不了/)
  })

  it('5 分钟内同一个链接 + 标签页只读一次', async () => {
    await useMock()
    await authorize()
    mock.parent.feishu.sheets.shtC = { title: 'T', tabs: [{ sheet_id: 's1', title: '铝板画', values: [['父体SKU'], ['A-1']] }] }
    ctx.parent.sheets.clear()
    const before = mock.parent.calls.filter((c) => c.path.includes('/values/')).length
    const url = 'https://x.feishu.cn/sheets/shtC'
    const [a, b] = await Promise.all([ctx.parent.sheets.rows(url, '铝板画'), ctx.parent.sheets.rows(url, '铝板画')])
    await ctx.parent.sheets.rows(url, '铝板画')
    expect(a!.rows).toEqual([{ theme: '', sku: 'A-1', asin: '', row: 2 }])
    expect(b!.rows).toEqual(a!.rows)
    expect(mock.parent.calls.filter((c) => c.path.includes('/values/')).length - before).toBe(1)
  })
})
