import { describe, expect, it } from 'vitest'
import { markDone, markSkipped, resetFrom, transition, TransitionError, viewOf, type StepState } from '../../server/src/store/jobs'
import { fakeJob } from '../jobfixture'
import { decideBlankItems } from '../../server/src/pipeline/blankItems'

describe('状态流转白名单', () => {
  const ALL: StepState[] = ['pending', 'running', 'done', 'skipped', 'failed']
  const LEGAL = new Set(['pending>running', 'running>done', 'running>skipped', 'running>failed', 'running>pending', 'done>pending', 'skipped>pending', 'failed>pending'])

  it('合法流转通过，其余全部抛错', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        const j = fakeJob()
        j.steps[2]!.state = from
        const ok = LEGAL.has(`${from}>${to}`)
        if (ok) expect(() => transition(j, 2, to), `${from}→${to}`).not.toThrow()
        else expect(() => transition(j, 2, to), `${from}→${to}`).toThrow(TransitionError)
      }
    }
  })

  it('同一张图同一时刻只能有一个步骤 running', () => {
    const j = fakeJob()
    transition(j, 0, 'running')
    expect(() => transition(j, 1, 'running')).toThrow(TransitionError)
  })

  it('markDone / markSkipped 只走合法流转；resetFrom 清空产出', () => {
    const j = fakeJob()
    j.steps[0]!.state = 'failed'
    markDone(j, 0)
    expect(j.steps[0]!.state).toBe('done')
    markSkipped(j, 4)
    expect(j.steps[4]!.state).toBe('skipped')
    j.steps[1] = { state: 'done', attempts: 3, output: 'pattern.png', snapshot: { images: [], prefix: '', prompt: 'p', model: 'm' }, error: 'e' }
    resetFrom(j, 1)
    expect(j.steps[1]).toEqual({ state: 'pending', attempts: 0 })
    expect(j.steps[4]!.state).toBe('pending')
    expect(j.steps[0]!.state).toBe('done')
  })

  it('resetFrom 遇到 running 抛错（必须先中止）', () => {
    const j = fakeJob()
    transition(j, 0, 'running')
    expect(() => resetFrom(j, 0)).toThrow(TransitionError)
  })

  it('展示状态只在后端算', () => {
    const j = fakeJob()
    expect(viewOf(j)).toEqual({ phase: 'queued', runningStep: null, label: '排队中' })
    transition(j, 0, 'running')
    expect(viewOf(j)).toMatchObject({ phase: 'running', runningStep: 0, label: '识别品类中' })
    for (let i = 0; i < 5; i++) markDone(j, i)
    expect(viewOf(j).phase).toBe('done')
  })
})

describe('decideBlankItems', () => {
  it('兜底：customizable 里的照片、名字、日期类强制加入', () => {
    expect(decideBlankItems(['名字', '照片', '祝福语'], [])).toEqual({ zh: ['名字', '照片'], en: ['the name text', 'the personal photo'] })
    expect(decideBlankItems(['纪念日', '头像'], ['头像'])).toEqual({ zh: ['头像', '纪念日'], en: ['the personal photo', 'the date text'] })
  })
  it('拦截：诗、句、文案、字体、颜色、风格一律剔除', () => {
    expect(decideBlankItems(['诗句', '名字'], ['诗句', '文案', '字体颜色', '图案风格', '名字']).zh).toEqual(['名字'])
  })
  it('映射：家庭姓名、宠物、其他保留原词；英文去重', () => {
    expect(decideBlankItems(['家庭姓名'], ['家庭姓名']).en).toEqual(['the family name text'])
    expect(decideBlankItems([], ['宠物形象']).en).toEqual(['the pet portrait'])
    expect(decideBlankItems([], ['logo']).en).toEqual(['logo'])
    expect(decideBlankItems(['合照', '照片'], ['合照', '照片']).en).toEqual(['the personal photo'])
    expect(decideBlankItems(['年份'], []).en).toEqual(['the date text'])
  })
})
