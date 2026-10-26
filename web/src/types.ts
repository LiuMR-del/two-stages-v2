// 与 server/src 里 zod 推导出的类型保持一致

export type Style = { id: string; name: string; ratio: string; whiteImage: string | null }
export type Template = { id: string; name: string; prompt: string; images: Record<string, string>; canvasRatio: string | null }
export type Category = {
  id: string
  name: string
  hint: string
  extractPrompt: string | null
  activeTemplate: string
  styles: Style[]
  templates: Template[]
}
export type Library = {
  version: 1
  defaults: { extractPrompt: string; pastePrompt: string }
  categories: Category[]
}

export type CheckLevel = 'ok' | 'warn' | 'error'
export type StyleCheck = { level: CheckLevel; messages: string[] }
export type Checks = Record<string, { level: CheckLevel; styles: Record<string, StyleCheck> }>

export type RecipeImage = { no: number | null; role: string; hash: string | null; auto: boolean; required: boolean }
export type Recipe = {
  images: RecipeImage[]
  prefix: string
  prompt: string
  scope: string
  size: string
  templateId: string
  templateName: string
  warnings: string[]
}
export type ExtractRecipe = { prefix: string; prompt: string; size: string; scope: string }

export type ApiSettings = {
  baseUrl: string
  apiKey: string
  model: string
  concurrency: number
  timeoutSec: number
}
export type Settings = {
  image: ApiSettings & { sendFidelity: boolean; fidelityAutoDisabled: boolean }
  analysis: ApiSettings
  outputDir: string
  routeThreshold: number
  padSquare: boolean
  blankImage: boolean
}

export type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed'
export type StepSnapshot = {
  images: { no: number; role: string; sha256: string }[]
  prefix: string
  prompt: string
  model: string
  size?: string
  params?: Record<string, unknown>
}
export type StepRecord = {
  state: StepState
  attempts: number
  startedAt?: string
  endedAt?: string
  error?: string
  snapshot?: StepSnapshot
  output?: string
}
export type AttentionKind = 'nomatch' | 'nowhite' | 'failed' | 'refused'
export type Job = {
  id: string
  createdAt: string
  order: number
  source: { file: string; originalName: string; width: number; height: number; sha256: string }
  outputDay: string
  outputBase: string
  route: null | {
    categoryId: string
    styleId: string
    categoryName: string
    styleName: string
    ratio: string
    confidence: number | null
    reason: string | null
    manual: boolean
  }
  plan: null | {
    extractPrompt: string
    main: { templateId: string; templateName: string; prompt: string; image: null | { role: '白底图' | '参考图'; hash: string }; canvasRatio?: string | null }
  }
  steps: StepRecord[]
  info: null | { scene: string; keywords: string[]; customizable: string[]; blankItems: string[]; blankItemsEn: string[] }
  attention: null | { kind: AttentionKind; step: number; message: string; guess?: string; at: string }
  override: null | { step: number; prompt: string }
  /** 服务端算好的展示状态，前端不再自己判断 */
  view: JobView
}
export type JobView = {
  phase: 'queued' | 'running' | 'attention' | 'done'
  runningStep: number | null
  label: string
}

export type QueueState = {
  paused: null | { by: 'user' | 'auth'; kind?: 'image' | 'analysis'; message: string }
  slots: { image: { busy: number; limit: number }; analysis: { busy: number; limit: number } }
}

export type ToastLevel = 'info' | 'warn' | 'error'
