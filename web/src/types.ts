// 与 server/src 里 zod 推导出的类型保持一致

export type Template = { id: string; name: string; prompt: string; image: string | null; canvasRatio: string | null }
/** 自定义模版属于款式，款式之间互不影响 */
export type PasteMode = 'auto' | 'local' | 'ai'
export type Style = {
  id: string
  name: string
  ratio: string
  whiteImage: string | null
  activeTemplate: string
  templates: Template[]
  /** 默认模版的贴图方式 */
  pasteMode: PasteMode
}
export type WhiteShape = { ok: boolean; shape: 'rect' | 'ellipse' | null; bbox: { x: number; y: number; w: number; h: number } | null; fill: number | null; holes: number; reason: string }
export type Category = {
  id: string
  name: string
  hint: string
  extractPrompt: string | null
  styles: Style[]
}
export type Library = {
  version: 2
  defaults: { extractPrompt: string; pastePrompt: string }
  categories: Category[]
  whiteChecks: Record<string, WhiteShape>
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
  /** 只有默认模版有：auto 是按白底图自动判断的结果，mode 是实际用的 */
  paste: null | { setting: PasteMode; auto: { mode: 'local' | 'ai'; reason: string } | null; mode: 'local' | 'ai'; note: string | null }
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
  patternQc: boolean
  patternQcThreshold: number
}

export type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed'
export type StepSnapshot = {
  images: { no: number; role: string; sha256: string }[]
  prefix: string
  prompt: string
  model: string
  size?: string
  params?: Record<string, unknown>
  /** local = 本地合成，没有调用 AI */
  mode?: 'ai' | 'local'
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
export type AttentionKind = 'nomatch' | 'nowhite' | 'failed' | 'refused' | 'qc'
export type Qc = {
  state: 'pending' | 'pass' | 'fail' | 'bypassed'
  at?: string
  threshold?: number
  score: number | null
  sourceTexts: string[]
  patternTexts: string[]
  textOk: boolean | null
  textDiffs: string[]
  elementIssues: string[]
  layout: null | { ok: boolean; issues: string[]; ratioChecked: boolean; note: string | null }
  reasons: string[]
  snapshot?: StepSnapshot
  raw?: string
}
export type Job = {
  id: string
  createdAt: string
  order: number
  source: { file: string; originalName: string; width: number; height: number; sha256: string }
  outputDay: string
  outputFolder: string
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
    main: {
      templateId: string
      templateName: string
      prompt: string
      image: null | { role: '白底图' | '参考图'; hash: string }
      canvasRatio?: string | null
      pasteMode?: PasteMode
    }
  }
  steps: StepRecord[]
  info: null | { scene: string; keywords: string[]; customizable: string[]; blankItems: string[]; blankItemsEn: string[] }
  attention: null | { kind: AttentionKind; step: number; message: string; guess?: string; at: string }
  override: null | { step: number; prompt: string }
  qc: Qc | null
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
