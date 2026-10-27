import { describe, expect, it } from 'vitest'
import { fillPlaceholders } from '../../server/src/prompts/placeholders'
import { maxImageRef, refWarning } from '../../server/src/prompts/refcheck'
import { buildMainRequest, mainPlanFor, PASTE_CONSTRAINT, type PlanMain } from '../../server/src/prompts/main'
import { buildExtractRequest, EXTRACT_CONSTRAINT, extractPromptFor } from '../../server/src/prompts/extract'
import { initialLibrary, type Library } from '../../server/src/library/schema'
import { computeChecks } from '../../server/src/library/checks'

const H1 = 'a'.repeat(64)
const H2 = 'b'.repeat(64)

describe('fillPlaceholders', () => {
  it('替换三个占位符', () => {
    expect(fillPlaceholders('{品类}·{款式}，比例 {比例}，{品类}', { category: '相框', style: '横版', ratio: '3:2' })).toBe('相框·横版，比例 3:2，相框')
  })
  it('款式为空时清理多余的「·」和空格', () => {
    const v = { category: '毛毯', style: '', ratio: '5:4' }
    expect(fillPlaceholders('{品类}·{款式}', v)).toBe('毛毯')
    expect(fillPlaceholders('{品类} · {款式} 商品', v)).toBe('毛毯 商品')
    expect(fillPlaceholders('{款式}·{品类}', v)).toBe('毛毯')
    expect(fillPlaceholders('这是一张{品类}{款式}商品图', v)).toBe('这是一张毛毯商品图')
    expect(fillPlaceholders('款式 {款式} 的图', v)).toBe('款式 的图')
    expect(fillPlaceholders('比例 {比例}。', v)).toBe('比例 5:4。')
  })
})

describe('引用检查', () => {
  it('识别「第 N 张」', () => {
    expect(maxImageRef('把第二张图片贴到第一张')).toBe(2)
    expect(maxImageRef('第 3 张')).toBe(3)
    expect(maxImageRef('第五张')).toBe(5)
    expect(maxImageRef('没有编号')).toBe(0)
  })
  it('超出发送张数时给出警告', () => {
    expect(refWarning('把第二张贴到第一张', 2)).toBeNull()
    expect(refWarning('把第二张贴到第一张', 1)).toBe('提示词里提到「第 2 张」图片，但这里只会发送 1 张')
  })
})

const room = (image: string | null) => ({ id: 't_room', name: '客厅场景', prompt: '把第二张图片贴到第一张图片的{品类}·{款式}画面上', image, canvasRatio: null })

function sampleLib(): Library {
  const lib = initialLibrary()
  lib.categories.push(
    {
      id: 'c_frame', name: '相框', hint: '', extractPrompt: null,
      styles: [
        { id: 's_h', name: '横版', ratio: '3:2', whiteImage: H1, activeTemplate: 'default', templates: [room(H2)], pasteMode: 'auto' },
        { id: 's_v', name: '竖版', ratio: '2:3', whiteImage: null, activeTemplate: 'default', templates: [room(null)], pasteMode: 'auto' },
      ],
    },
    {
      id: 'c_mug', name: '杯子', hint: '', extractPrompt: '只提取{品类}杯身图案，比例 {比例}',
      styles: [
        { id: 's_m', name: '', ratio: '1:1', whiteImage: null, activeTemplate: 't_x', templates: [{ id: 't_x', name: '无图模版', prompt: '把第二张图片印到杯子上', image: null, canvasRatio: null }], pasteMode: 'auto' },
      ],
    },
  )
  return lib
}

const dims = async (h: string) => (h === H1 ? { width: 1500, height: 1000 } : { width: 800, height: 1000 })

describe('buildMainRequest', () => {
  it('默认模版：白底图 + 素材图，画布按白底图实际尺寸', async () => {
    const lib = sampleLib()
    const cat = lib.categories[0]!
    const { main, missingWhite } = mainPlanFor(lib, cat, cat.styles[0]!)
    expect(missingWhite).toBe(false)
    const r = await buildMainRequest(main, '3:2', dims)
    expect(r.sent.map((s) => [s.no, s.role, s.hash])).toEqual([
      [1, '白底图', H1],
      [2, '素材图', null],
    ])
    expect(r.prefix).toBe('[Canvas: 3:2 landscape format] 第一张图片是白底图，第二张图片是素材图。\n' + PASTE_CONSTRAINT + '\n')
    expect(r.size).toBe('1536x1024')
    expect(r.prompt).toBe(lib.defaults.pastePrompt)
  })

  it('自定义模版有参考图：参考图 + 素材图，画布按参考图实际尺寸', async () => {
    const lib = sampleLib()
    const cat = lib.categories[0]!
    const { main, scope } = mainPlanFor(lib, cat, cat.styles[0]!, 't_room')
    const r = await buildMainRequest(main, '3:2', dims)
    expect(r.sent.map((s) => [s.no, s.role, s.hash])).toEqual([
      [1, '参考图', H2],
      [2, '素材图', null],
    ])
    expect(r.prefix).toBe('[Canvas: 4:5 portrait format] 第一张图片是参考图，第二张图片是素材图。\n')
    expect(r.size).toBe('1024x1024')
    expect(r.prompt).toBe('把第二张图片贴到第一张图片的相框·横版画面上')
    expect(scope).toBe('只给「相框·横版」用')
  })

  it('自定义模版没有参考图：只发素材图，画布按款式比例', async () => {
    const lib = sampleLib()
    const cat = lib.categories[0]!
    const { main } = mainPlanFor(lib, cat, cat.styles[1]!, 't_room')
    const r = await buildMainRequest(main, '2:3', dims)
    expect(r.slots.map((s) => [s.no, s.role])).toEqual([
      [null, '参考图'],
      [1, '素材图'],
    ])
    expect(r.prefix).toBe('[Canvas: 2:3 portrait format] 第一张图片是素材图。\n')
    expect(r.size).toBe('1024x1536')
  })

  it('自定义模版指定了主图比例：没有参考图时画布和 size 按它算，有参考图时仍按参考图', async () => {
    const lib = sampleLib()
    const cat = lib.categories[0]!
    for (const s of cat.styles) s.templates[0]!.canvasRatio = '1:1'
    const noRef = await buildMainRequest(mainPlanFor(lib, cat, cat.styles[1]!, 't_room').main, '2:3', dims)
    expect(noRef.prefix).toBe('[Canvas: 1:1 square format] 第一张图片是素材图。\n')
    expect(noRef.size).toBe('1024x1024')
    const withRef = await buildMainRequest(mainPlanFor(lib, cat, cat.styles[0]!, 't_room').main, '3:2', dims)
    expect(withRef.prefix.startsWith('[Canvas: 4:5 portrait format]')).toBe(true)
  })

  it('默认模版缺白底图时标出 missingWhite', () => {
    const lib = sampleLib()
    const cat = lib.categories[0]!
    expect(mainPlanFor(lib, cat, cat.styles[1]!).missingWhite).toBe(true)
  })

  it('贴图约束只加在默认模版上（2026-10-27）；自定义模版的前置句和提示词不动', async () => {
    const lib = sampleLib()
    const cat = lib.categories[0]!
    const def = await buildMainRequest(mainPlanFor(lib, cat, cat.styles[0]!).main, '3:2', dims)
    expect(def.prefix).toContain('like an opaque sticker laid over the whole face')
    const custom = await buildMainRequest(mainPlanFor(lib, cat, cat.styles[0]!, 't_room').main, '3:2', dims)
    expect(custom.prefix + custom.prompt).not.toMatch(/sticker|fill the canvas|edge to edge|铺满画布/i)
  })
})

describe('提取请求', () => {
  it('品类单独设置的提取提示词优先，占位符替换；前置句按款式比例', () => {
    const lib = sampleLib()
    const mug = lib.categories[1]!
    expect(extractPromptFor(lib, mug, mug.styles[0]!)).toBe('只提取杯子杯身图案，比例 1:1')
    const frame = lib.categories[0]!
    expect(extractPromptFor(lib, frame, frame.styles[1]!)).toContain('这是一张相框商品图')
    const r = buildExtractRequest('x', '2:3')
    expect(r.prefix).toBe('[Canvas: 2:3 portrait format] 第一张图片是竞品商品图。\n' + EXTRACT_CONSTRAINT + '\n')
    expect(r.size).toBe('1024x1536')
    // 意思不能少：铺满、不带产品边框圆角、不重画、比例差一点补背景不裁文字
    for (const k of ['edge to edge', 'rounded corners', 'Do not rearrange, redraw', 'never crop, squeeze or drop any text']) expect(EXTRACT_CONSTRAINT).toContain(k)
  })
})

describe('computeChecks', () => {
  it('默认模版缺白底图为 error；引用超出为 warn；品类取最差', () => {
    const lib = sampleLib()
    const c = computeChecks(lib)
    expect(c.c_frame!.styles.s_h).toEqual({ level: 'ok', messages: [] })
    expect(c.c_frame!.styles.s_v).toEqual({ level: 'error', messages: ['缺白底图'] })
    expect(c.c_frame!.level).toBe('error')
    expect(c.c_mug!.styles.s_m!.level).toBe('warn')
    expect(c.c_mug!.styles.s_m!.messages[0]).toBe('提示词里提到「第 2 张」图片，但这里只会发送 1 张')
  })

  it('模版提示词为空为 error', () => {
    const lib = sampleLib()
    lib.categories[1]!.styles[0]!.templates[0]!.prompt = '  '
    expect(computeChecks(lib).c_mug!.styles.s_m).toMatchObject({ level: 'error', messages: ['模版提示词为空'] })
  })

  it('使用中的模版被删掉时回退默认模版', () => {
    const lib = sampleLib()
    lib.categories[1]!.styles[0]!.activeTemplate = 't_gone'
    expect(computeChecks(lib).c_mug!.styles.s_m!.messages).toEqual(['缺白底图'])
  })
})
