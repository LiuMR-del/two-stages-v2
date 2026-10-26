import { canvasFor, ratioToWH, type ApiSize } from './canvas'
import { fillPlaceholders } from './placeholders'
import type { Category, Library, Style } from '../library/schema'

export type PlanImageRole = '白底图' | '参考图'

export type PlanMain = {
  templateId: 'default' | string
  templateName: string
  prompt: string
  image: null | { role: PlanImageRole; hash: string }
  /** 自定义模版指定的主图画布比例，只在没有参考图时生效 */
  canvasRatio?: string | null
}

export const DEFAULT_TEMPLATE_NAME = '默认 · 贴图'
const CN_NUM = ['一', '二', '三', '四', '五']

/**
 * 按品类当前（或指定）模版解析出 ③ 要用的模版内容。默认模版缺白底图时 missingWhite 为 true，
 * 调用方必须拦下，不能缺图照发。
 */
export function mainPlanFor(
  lib: Library,
  cat: Category,
  style: Style,
  templateId: string = cat.activeTemplate,
): { main: PlanMain; missingWhite: boolean; scope: string } {
  const tpl = templateId === 'default' ? undefined : cat.templates.find((t) => t.id === templateId)
  const values = { category: cat.name, style: style.name, ratio: style.ratio }
  if (!tpl) {
    return {
      main: {
        templateId: 'default',
        templateName: DEFAULT_TEMPLATE_NAME,
        prompt: fillPlaceholders(lib.defaults.pastePrompt, values),
        image: style.whiteImage ? { role: '白底图', hash: style.whiteImage } : null,
      },
      missingWhite: !style.whiteImage,
      scope: '全局共用 · 所有品类',
    }
  }
  const ref = tpl.images[style.id]
  return {
    main: {
      templateId: tpl.id,
      templateName: tpl.name,
      prompt: fillPlaceholders(tpl.prompt, values),
      image: ref ? { role: '参考图', hash: ref } : null,
      canvasRatio: tpl.canvasRatio ?? null,
    },
    missingWhite: false,
    scope: `「${cat.name}」所有款式共用`,
  }
}

export type MainSlot = {
  /** 实际发送的编号，从 1 开始；不发送为 null */
  no: number | null
  role: '白底图' | '参考图' | '素材图'
  /** 素材图运行时才有，这里为 null */
  hash: string | null
  auto: boolean
  required: boolean
}

export type MainRequest = {
  slots: MainSlot[]
  /** 按发送顺序 */
  sent: MainSlot[]
  prefix: string
  prompt: string
  size: ApiSize
}

export function roleSentence(roles: string[]): string {
  return roles.map((r, i) => `第${CN_NUM[i]}张图片是${r}`).join('，') + '。'
}

/**
 * 配方卡预览和流水线 ③ 共用：界面上显示的编号、前置句、提示词，就是实际发送的内容。
 * 有第一张图时画布按它的实际宽高算；没有时按模版指定的主图比例，再没有就按款式比例。
 * 前置句里的比例和 size 来自同一组宽高。
 */
export async function buildMainRequest(
  main: PlanMain,
  ratio: string,
  dimsOf: (hash: string) => Promise<{ width: number; height: number }>,
): Promise<MainRequest> {
  const firstRole: MainSlot['role'] = main.templateId === 'default' ? '白底图' : '参考图'
  const first: MainSlot = {
    no: main.image ? 1 : null,
    role: main.image?.role ?? firstRole,
    hash: main.image?.hash ?? null,
    auto: false,
    required: firstRole === '白底图',
  }
  const pattern: MainSlot = { no: main.image ? 2 : 1, role: '素材图', hash: null, auto: true, required: true }
  const slots = [first, pattern]
  const sent = slots.filter((s) => s.no !== null)

  let w: number
  let h: number
  if (main.image) {
    const d = await dimsOf(main.image.hash)
    w = d.width
    h = d.height
  } else {
    ;[w, h] = ratioToWH(main.canvasRatio || ratio)
  }
  const canvas = canvasFor(w, h)
  return {
    slots,
    sent,
    prefix: canvas.prefix + roleSentence(sent.map((s) => s.role)) + '\n',
    prompt: main.prompt,
    size: canvas.size,
  }
}
