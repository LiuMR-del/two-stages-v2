import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startMockRelay, type MockRelay } from '../../scripts/mock-relay'
import { startInProcess, type Api } from '../inprocess'
import type { AppContext } from '../../server/src/context'
import { cellText, parseParentRows, parseSheetLink, resetAppToken } from '../../server/src/parent/feishu'
import { parseSpapiCredentials, rtfToText } from '../../server/src/parent/credentials'
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
beforeEach(() => {
  mock.reset()
  resetAppToken()
})

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
    p.feishu.baseUrl = mock.origin
    Object.assign(p.spapi, { endpoint: mock.origin, tokenUrl: mock.origin + '/auth/o2/token' })
  })
  ctx.parent.sheets.clear()
  await api.json('PUT', '/settings', {
    parent: {
      feishu: { appId: mock.parent.feishu.appId, appSecret: mock.parent.feishu.appSecret },
      spapi: { sellerId: mock.parent.spapi.sellerId, clientId: mock.parent.spapi.clientId, clientSecret: mock.parent.spapi.clientSecret, refreshToken: mock.parent.spapi.refreshToken },
    },
  })
}

describe('父体匹配设置', () => {
  it('默认关闭；阈值 0.7、创建人标识 5、美国站', async () => {
    const s = (await api.json('GET', '/settings')).body.parent
    expect(s).toMatchObject({ enabled: false, threshold: 0.7, creatorMark: '5', sheetUrl: '', recentUrls: [] })
    expect(s.spapi.marketplaceId).toBe('ATVPDKIKX0DER')
    expect(Object.keys(s.feishu).sort()).toEqual(['appId', 'appSecret', 'baseUrl'])
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
    await api.json('PUT', '/settings', { parent: { spapi: { tokenUrl: 'http://evil.example/token' }, feishu: { baseUrl: 'http://evil.example' } } } as any)
    expect(ctx.settings.get().parent.spapi.tokenUrl).toBe(before)
    expect(ctx.settings.get().parent.feishu.baseUrl).not.toBe('http://evil.example')
  })

  it('别的网页跨站提交（带别的 Origin）一律拒绝：换不了凭证、退不了授权', async () => {
    const evil = (path: string, body: string) =>
      fetch(api.base + path, { method: 'POST', headers: { Origin: 'http://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body })
    expect((await evil('/settings/spapi/import', `text=${encodeURIComponent('店铺ID：AEVIL1234567')}`)).status).toBe(403)
    expect((await evil('/settings/parent/test', '')).status).toBe(403)
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

describe('飞书应用身份', () => {
  it('只用 App ID / App Secret 读表，不用登录；token 复用，不每次都换', async () => {
    await useMock()
    mock.parent.feishu.sheets.shtA = { title: '父体分类汇总', tabs: [{ sheet_id: 's1', title: '铝板画', values: [['父体SKU'], ['A-1']] }] }
    const r = await api.json('POST', '/settings/parent/test', { url: 'https://x.feishu.cn/sheets/shtA' })
    expect(r.body).toMatchObject({ ok: true, title: '父体分类汇总' })
    ctx.parent.sheets.clear()
    await api.json('POST', '/settings/parent/test', { url: 'https://x.feishu.cn/sheets/shtA' })
    expect(mock.parent.calls.filter((c) => c.path === '/auth/v3/tenant_access_token/internal')).toHaveLength(1)
    // 飞书只读：除了换 token，全是 GET
    expect(mock.parent.calls.filter((c) => c.service === 'feishu' && c.method !== 'GET' && c.path !== '/auth/v3/tenant_access_token/internal')).toEqual([])
  })

  it('App Secret 不对：提示去设置检查（第 6 步会暂停）', async () => {
    await useMock()
    await api.json('PUT', '/settings', { parent: { feishu: { appSecret: 'wrong-secret-0000' } } })
    mock.parent.feishu.sheets.shtA = { title: 'T', tabs: [] }
    const r = await api.json('POST', '/settings/parent/test', { url: 'https://x.feishu.cn/sheets/shtA' })
    expect(r.body).toMatchObject({ ok: false, auth: true })
    expect(r.body.message).toContain('App ID 或 App Secret 不对')
  })

  it('表没给应用加权限：告诉用户怎么「添加文档应用」', async () => {
    await useMock()
    mock.parent.feishu.sheets.shtE = { title: 'T', tabs: [], denied: true }
    mock.parent.feishu.wiki.wikiE = 'shtE'
    for (const url of ['https://x.feishu.cn/sheets/shtE', 'https://x.feishu.cn/wiki/wikiE']) {
      ctx.parent.sheets.clear()
      const r = await api.json('POST', '/settings/parent/test', { url })
      expect(r.body.ok).toBe(false)
      expect(r.body.message).toContain('「添加文档应用」')
    }
  })

  it('token 被飞书提前作废：重新换一次再试；连不上飞书报普通错误', async () => {
    await useMock()
    mock.parent.feishu.sheets.shtD = { title: '表D', tabs: [] }
    await api.json('POST', '/settings/parent/test', { url: 'https://x.feishu.cn/sheets/shtD' })
    mock.parent.feishu.access.clear()
    ctx.parent.sheets.clear()
    expect((await api.json('POST', '/settings/parent/test', { url: 'https://x.feishu.cn/sheets/shtD' })).body.ok).toBe(true)
    await ctx.settings.updateParent((p) => (p.feishu.baseUrl = 'http://127.0.0.1:9'))
    resetAppToken()
    ctx.parent.sheets.clear()
    const net = await api.json('POST', '/settings/parent/test', { url: 'https://x.feishu.cn/sheets/shtD' })
    expect(net.body.ok).toBe(false)
    expect(net.body.auth).toBeUndefined()
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
