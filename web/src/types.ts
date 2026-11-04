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
  parentTab: string | null
  /** 子体 SKU 的材质缩写，如 mtfl */
  skuCode: string | null
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
export type ExtractRecipe = { prefix: string; prompt: string; size: string; scope: string; scenePrefix?: string }

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
  patternQcDeltaE: number
  mainQc: boolean
  /** 子体 SKU 的组别（7 = 深圳团队）；店铺缩写在店铺档案里，专属号用 parent.creatorMark */
  sku: { group: string }
  /** 父体匹配；飞书 App Secret 是打码后的（••••末 4 位） */
  parent: {
    enabled: boolean
    threshold: number
    creatorMark: string
    /** 飞书用应用身份读表，只要 App ID / App Secret，所有店铺共用 */
    feishu: { appId: string; appSecret: string }
  }
  stores: Store[]
  currentStoreId: string
}

/** 店铺档案；SP-API 凭证都是打码后的 */
export type Store = {
  id: string
  name: string
  abbr: string
  /** feishu = 从飞书父体表挑父体；store = 从店铺里扫描父体 */
  parentSource: 'feishu' | 'store'
  spapi: { sellerId: string; clientId: string; clientSecret: string; refreshToken: string; marketplaceId: string }
  feishu: { sheetUrl: string; recentUrls: { url: string; title: string; usedAt: string }[]; tabs: string[] }
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
  /** 跳过的原因等说明 */
  note?: string
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
  edgeMissing: string[]
  edgeExtra: string[]
  fillIssues: string[]
  mode?: 'local' | 'ai'
  layout: null | { ok: boolean; issues: string[]; ratioChecked: boolean; note: string | null }
  color: null | {
    checked: boolean
    deltaE: number | null
    gridDeltaE: number | null
    shift: { L: number; a: number; b: number; C: number } | null
    box: [number, number, number, number] | null
    issues: string[]
    note: string | null
    threshold?: number
  }
  /** 边框外延检查；null = 没做 */
  border?: null | {
    hasBorder: boolean
    overflow: string
    source: Record<string, number> | null
    pattern: Record<string, number> | null
    error: string | null
    raw?: string
  }
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
  /** 第①步判断商品放在场景里有变形，提取时不框选 */
  deformed?: boolean
  /** 子体 SKU；品类没填材质缩写时为 null */
  sku: string | null
  /** 单独暂停了这张图 */
  paused?: boolean
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
  /** 竞品图里印刷面的区域：ai 是模型给的四个角，corners 是本地往外校正后的（0～1 比例，左上、右上、右下、左下） */
  face: null | { ai: [number, number][]; corners: [number, number][]; moved: number[]; size: { width: number; height: number } }
  /** 第 6 步匹配到的父体 */
  parent: ParentResult | null
  /** 主图验收：sourceTexts 是素材图的文字，patternTexts 是主图的文字 */
  mainQc: Qc | null
  /** 服务端算好的展示状态，前端不再自己判断 */
  view: JobView
}
export type JobView = {
  phase: 'queued' | 'paused' | 'running' | 'attention' | 'done'
  runningStep: number | null
  label: string
}

export type ParentResult = {
  status: 'matched' | 'unsure' | 'none' | 'new'
  message: string | null
  tab: string
  readAt: string
  sku: string | null
  asin: string | null
  theme: string | null
  confidence: number | null
  reason: string | null
  manual: boolean
  candidates: { sku: string; asin: string; theme: string; confidence: number | null }[]
  naming: null | {
    attribute: string
    existing: string[]
    groups: { pattern: string; count: number }[]
    next: string | null
    note: string | null
    key: string | null
    number: number | null
  }
  proposal: null | { sku: string; prefix: string; theme: string; basedOn: string[]; themeCandidates: string[] }
}

export type QueueState = {
  paused: null | { by: 'user' | 'auth'; kind?: 'image' | 'analysis'; message: string }
  /** 第 6 步单独暂停的原因 */
  parentPaused: string | null
  slots: { image: { busy: number; limit: number }; analysis: { busy: number; limit: number } }
}

export type ToastLevel = 'info' | 'warn' | 'error'
