import { describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createPinia, setActivePinia } from 'pinia'
import ParentSettings from '../../web/src/components/ParentSettings.vue'
import { useSettings } from '../../web/src/stores/settings'
import type { Settings } from '../../web/src/types'

function settings(parent: Partial<Settings['parent']> = {}): Settings {
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
    parent: {
      enabled: false,
      sheetUrl: '',
      recentUrls: [],
      tabs: [],
      threshold: 0.7,
      creatorMark: '5',
      feishu: { appId: '', appSecret: '', user: null, authAppId: '', accessToken: '', accessExpiresAt: '', refreshToken: '', refreshExpiresAt: '', redirect: 'lark3000' },
      spapi: { sellerId: '', clientId: '', clientSecret: '', refreshToken: '', marketplaceId: 'ATVPDKIKX0DER' },
      ...parent,
    },
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

describe('设置 ·「父体匹配」', () => {
  it('开关默认关：其他设置折叠起来', async () => {
    const html = await render(settings())
    expect(html).toContain('识别父体')
    expect(html).not.toContain('店铺 SP-API')
    expect(html).not.toContain('checked')
  })

  it('打开但缺链接、授权、SP-API：开关下面直接列出还缺什么', async () => {
    const html = await render(settings({ enabled: true, feishu: { ...settings().parent.feishu, appId: 'cli_x', appSecret: '••••abcd' } }))
    expect(html).toContain('还缺：父体表链接、飞书授权、SP-API 凭证')
    expect(html).toContain('店铺 SP-API')
  })

  it('都齐了不提示；已授权显示授权人', async () => {
    const html = await render(
      settings({
        enabled: true,
        sheetUrl: 'https://x.feishu.cn/wiki/abc',
        feishu: { ...settings().parent.feishu, appId: 'cli_x', authAppId: 'cli_x', appSecret: '••••abcd', user: 'Liu', refreshToken: '••••ref1', refreshExpiresAt: new Date(Date.now() + 86400_000).toISOString() },
        spapi: { sellerId: '••••W2P', clientId: '••••a1a1', clientSecret: '••••f0f0', refreshToken: '••••xyz1', marketplaceId: 'ATVPDKIKX0DER' },
      }),
    )
    expect(html).not.toContain('还缺')
    expect(html).toContain('已用你的飞书账号授权（Liu）')
  })

  it('授权时用的 App ID 和现在的不一样：提示重新授权，不当作已授权', async () => {
    const html = await render(
      settings({
        enabled: true,
        sheetUrl: 'https://x.feishu.cn/wiki/abc',
        feishu: { ...settings().parent.feishu, appId: 'cli_new', authAppId: 'cli_old', appSecret: '••••abcd', user: 'Liu', refreshToken: '••••ref1' },
        spapi: { sellerId: '••••W2P', clientId: '••••a1a1', clientSecret: '••••f0f0', refreshToken: '••••xyz1', marketplaceId: 'ATVPDKIKX0DER' },
      }),
    )
    expect(html).toContain('App ID 换过了，请重新授权')
    expect(html).toContain('还缺：飞书授权')
  })
})
