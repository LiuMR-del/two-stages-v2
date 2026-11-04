import { describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createPinia, setActivePinia } from 'pinia'
import ParentSettings from '../../web/src/components/ParentSettings.vue'
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
      creatorMark: '5',
      feishu: { appId: '', appSecret: '' },
      ...parent,
    },
    stores: stores ?? [store('hj', '焕捷', 'HJ', 'feishu'), store('art', '爱睿特', 'ART', 'store')],
    currentStoreId,
  }
}

async function render(s: Settings): Promise<string> {
  const pinia = createPinia()
  setActivePinia(pinia)
  useSettings().settings = s
  const app = createSSRApp(ParentSettings)
  app.use(pinia)
  return renderToString(app)
}

describe('设置 ·「父体匹配」和店铺', () => {
  it('开关默认关；店铺列表照常显示（店铺缩写发 SKU 要用）', async () => {
    const html = await render(settings())
    expect(html).toContain('识别父体')
    expect(html).not.toContain('checked')
    expect(html).not.toContain('还缺')
    expect(html).toContain('焕捷')
    expect(html).toContain('爱睿特')
    expect(html).toContain('当前店铺')
  })

  it('打开但当前店铺缺链接、SP-API：开关下面直接列出还缺什么；不用登录飞书', async () => {
    const html = await render(settings({ enabled: true, feishu: { appId: 'cli_x', appSecret: '••••abcd' } }))
    expect(html).toContain('「焕捷」还缺：父体表链接、SP-API 凭证')
    expect(html).toContain('「添加文档应用」')
    expect(html).not.toContain('授权')
  })

  it('当前店铺是爱睿特（店铺扫描）：不要父体表链接，也不要飞书应用', async () => {
    const html = await render(settings({ enabled: true }, undefined, 'art'))
    expect(html).toContain('「爱睿特」还缺：SP-API 凭证')
    const ready = await render(settings({ enabled: true }, [store('hj', '焕捷', 'HJ', 'feishu'), store('art', '爱睿特', 'ART', 'store', { spapi: fullSpapi })], 'art'))
    expect(ready).toContain('「爱睿特」从店铺扫描父体还没做好')
    expect(html).toContain('没有飞书父体表，第 6 步从店铺里扫描父体')
  })

  it('都齐了不提示；App Secret、店铺 ID 用密码框；当前店铺不显示删除', async () => {
    const html = await render(
      settings({ enabled: true, feishu: { appId: 'cli_x', appSecret: '••••abcd' } }, [
        store('hj', '焕捷', 'HJ', 'feishu', { spapi: fullSpapi, feishu: { sheetUrl: 'https://x.feishu.cn/wiki/abc', recentUrls: [], tabs: [] } }),
        store('art', '爱睿特', 'ART', 'store'),
      ]),
    )
    expect(html).not.toContain('还缺')
    expect(html).toMatch(/<input type="password"[^>]*aria-label="飞书 App Secret"/)
    expect(html).toMatch(/<input type="password"[^>]*aria-label="店铺 ID"/)
    // 只有爱睿特那张卡片有删除按钮
    expect(html.match(/删除店铺/g)).toHaveLength(1)
  })
})
