import { describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createPinia, setActivePinia } from 'pinia'
import InfoTable from '../../web/src/components/InfoTable.vue'
import { useJobs } from '../../web/src/stores/jobs'
import { useUi } from '../../web/src/stores/ui'
import type { Job, ParentResult } from '../../web/src/types'

function parent(status: ParentResult['status']): ParentResult {
  return {
    status,
    message: status === 'none' ? '毛毯标签页里没有合适的父体' : null,
    tab: '毛毯', readAt: '2026-10-28T00:00:00.000Z',
    sku: status === 'new' ? 'HJ-mtfl5-Love' : status === 'none' ? null : 'HJ-mtfl-Love',
    asin: status === 'new' || status === 'none' ? null : 'B0TEST',
    theme: status === 'none' ? null : 'Love', confidence: status === 'none' ? null : 0.91,
    reason: null, manual: false, candidates: [], proposal: status === 'new' ? { sku: 'HJ-mtfl5-Love', prefix: 'HJ-mtfl5', theme: 'Love', basedOn: ['HJ-mtfl-Christmas'], themeCandidates: ['Love', 'Family'] } : null,
    naming: status === 'none' ? null : { attribute: 'color', existing: ['Design 01'], groups: [{ pattern: 'Design ##', count: 1 }], next: 'Design 02', note: status === 'new' ? '需要手动创建' : null, key: 'Design ##', number: 2 },
  }
}

function job(id: string, p: ParentResult | null): Job {
  return {
    id, createdAt: '2026-10-28T00:00:00.000Z', order: 1,
    source: { file: 'source.png', originalName: `${id}.png`, width: 100, height: 100, sha256: 'x' },
    outputDay: '2026-10-28', outputFolder: '主图生成-2026-10-28', outputBase: id,
    route: { categoryId: 'c', styleId: 's', categoryName: '毛毯', styleName: '', ratio: '1:1', confidence: 0.9, reason: null, manual: false },
    plan: null, steps: [{ state: 'done', attempts: 1 }, { state: 'done', attempts: 1 }, { state: 'done', attempts: 1 }, { state: 'done', attempts: 1 }, { state: 'skipped', attempts: 0 }, { state: 'done', attempts: 1 }],
    info: { scene: '家庭场景', keywords: ['throw blanket'], customizable: [], blankItems: [], blankItemsEn: [] }, attention: null, override: null, qc: null, face: null, parent: p, mainQc: null,
    view: { phase: 'done', runningStep: null, label: '完成' },
  }
}

async function render(parentResult: ParentResult | null): Promise<string> {
  const pinia = createPinia()
  setActivePinia(pinia)
  const jobs = useJobs()
  jobs.byId = { j: job('j', parentResult) }
  jobs.queue = { paused: null, parentPaused: null, slots: { image: { busy: 0, limit: 1 }, analysis: { busy: 0, limit: 1 } } }
  useUi()
  const app = createSSRApp(InfoTable)
  app.use(pinia)
  return renderToString(app)
}

describe('识别信息表 · 父体列', () => {
  it('没有父体结果时不显示父体列', async () => {
    const html = await render(null)
    expect(html).not.toContain('下一个变体名')
    expect(html).not.toContain('复制父体 SKU')
  })

  it('已有父体结果时显示 SKU、变体名和复制按钮', async () => {
    const html = await render(parent('matched'))
    expect(html).toContain('父体')
    expect(html).toContain('下一个变体名')
    expect(html).toContain('HJ-mtfl-Love')
    expect(html).toContain('Design 02')
    expect(html).toContain('复制父体 SKU')
    expect(html).toContain('复制推荐变体名')
  })

  it('没有合适的父体显示原因和手动选；建议新建显示建议标签', async () => {
    const none = await render(parent('none'))
    expect(none).toContain('毛毯标签页里没有合适的父体')
    expect(none).toContain('手动选')
    const newer = await render(parent('new'))
    expect(newer).toContain('建议新建')
    expect(newer).toContain('HJ-mtfl5-Love')
    expect(newer).toContain('需手动创建')
  })
})
