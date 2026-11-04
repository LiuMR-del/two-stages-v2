import { describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createPinia, setActivePinia } from 'pinia'
import ParentSettings from '../../web/src/components/ParentSettings.vue'
import StoresSettings from '../../web/src/components/StoresSettings.vue'
import { useSettings } from '../../web/src/stores/settings'
import type { Settings, Store } from '../../web/src/types'

const emptySpapi = { sellerId: '', clientId: '', clientSecret: '', refreshToken: '', marketplaceId: 'ATVPDKIKX0DER' }
const fullSpapi = { sellerId: '••••W2P', clientId: '••••a1a1', clientSecret: '••••f0f0', refreshToken: '••••xyz1', marketplaceId: 'ATVPDKIKX0DER' }

function store(id: string, name: string, abbr: string, parentSource: Store['parentSource'], over: Partial<Store> = {}): Store {
  return { id, name, abbr, parentSource, spapi: emptySpapi, feishu: { sheetUrl: '', recentUrls: [], tabs: [] }, ...over }
}

function settings(parent: Partial<Settings['parent']> = {}, stores?: Store[], currentStoreId = 'hj'): Settings {
  const api = { baseUrl: '', apiKey: '', model: '', concurrency: 1, timeoutSec: 60 }
  return {
    image: { ...api, sendFidelity: true, fidelityAutoDisabled: false },
    analysis: api,
    outputDir: '~/Downloads',
    routeThreshold: 0.7,
    padSquare: true,
    blankImage: true,
    patternQc: true,
    patternQcThreshold: 0.9,
    patternQcDeltaE: 5,
    mainQc: true,
    sku: { group: '7' },
    parent: {
      enabled: false,
      threshold: 0.7,
      feishu: { appId: '', appSecret: '' },
      ...parent,
    },
    stores: stores ?? [store('hj', '焕捷', 'HJ', 'feishu'), store('art', '爱睿特', 'ART', 'store')],
    currentStoreId,
  }
}

async function render(s: Settings, comp: typeof ParentSettings = ParentSettings): Promise<string> {
  const pinia = createPinia()
  setActivePinia(pinia)
  useSettings().settings = s
  const app = createSSRApp(comp)
  app.use(pinia)
  return renderToString(app)
}

describe('设置 ·「父体匹配」页签', () => {
  it('开关默认关：只有开关和一句说明，没有店铺列表', async () => {
    const html = await render(settings())
    expect(html).toContain('识别父体')
    expect(html).not.toContain('checked')
    expect(html).not.toContain('还缺')
    expect(html).not.toContain('删除店铺')
  })

  it('打开但当前店铺缺链接、SP-API：直接列出还缺什么，指到「店铺」页签；不用登录飞书', async () => {
    const html = await render(settings({ enabled: true, feishu: { appId: 'cli_x', appSecret: '••••abcd' } }))
    expect(html).toContain('「焕捷」还缺：父体表链接、SP-API 凭证')
    expect(html).toContain('去「店铺」页签填')
    expect(html).toContain('飞书应用')
    expect(html).not.toContain('授权')
  })

  it('当前店铺是爱睿特（店铺扫描）：不要父体表链接；凭证齐了不提示，也不再提示「还没做好」', async () => {
    expect(await render(settings({ enabled: true }, undefined, 'art'))).toContain('「爱睿特」还缺：SP-API 凭证')
    const ready = await render(settings({ enabled: true }, [store('hj', '焕捷', 'HJ', 'feishu', { spapi: fullSpapi, feishu: { sheetUrl: 'u', recentUrls: [], tabs: [] } }), store('art', '爱睿特', 'ART', 'store', { spapi: fullSpapi })], 'art'))
    expect(ready).not.toContain('还缺')
    expect(ready).not.toContain('还没做好')
    expect(ready).toContain('从店铺里扫描的父体里挑')
  })

  it('App Secret 用密码框', async () => {
    const html = await render(settings({ enabled: true, feishu: { appId: 'cli_x', appSecret: '••••abcd' } }))
    expect(html).toMatch(/<input type="password"[^>]*aria-label="飞书 App Secret"/)
  })
})

describe('设置 ·「店铺」页签', () => {
  it('每个店铺一行概况；凭证齐的收起，缺凭证的展开；当前店铺不能删；SKU 命名的组别在这里', async () => {
    const html = await render(
      settings({}, [
        store('hj', '焕捷', 'HJ', 'feishu', { spapi: fullSpapi, feishu: { sheetUrl: 'https://x.feishu.cn/wiki/abc', recentUrls: [], tabs: [] } }),
        store('art', '爱睿特', 'ART', 'store'),
      ]),
      StoresSettings,
    )
    expect(html).toContain('焕捷')
    expect(html).toContain('爱睿特')
    expect(html).toContain('当前')
    expect(html).toContain('飞书父体表')
    expect(html).toContain('缺凭证')
    // 焕捷凭证齐，收起：没有它的父体表链接输入框；爱睿特缺凭证，展开：有店铺 ID 密码框和删除按钮
    expect(html).not.toContain('aria-label="父体表链接"')
    expect(html.match(/aria-label="店铺 ID"/g)).toHaveLength(1)
    expect(html).toMatch(/<input type="password"[^>]*aria-label="店铺 ID"/)
    expect(html.match(/删除店铺/g)).toHaveLength(1)
    expect(html).toContain('组别')
    expect(html).toContain('改专属号')
  })
})
