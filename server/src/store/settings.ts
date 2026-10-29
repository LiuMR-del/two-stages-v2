import path from 'node:path'
import os from 'node:os'
import { z } from 'zod'
import { readJsonSync, writeJsonAtomic } from './atomic'
import { Mutex } from '../util/mutex'
import { expandHome } from '../paths'
import { registerSecret } from '../util/log'

export const DEFAULT_OUTPUT_DIR = path.join('~', 'Downloads')
/** 旧版默认值多套了一层「主图生成」，现在日期文件夹自己带这个名字 */
const OLD_DEFAULT_OUTPUT_DIR = path.join('~', 'Downloads', '主图生成')

const imageFields = {
  baseUrl: z.string(),
  apiKey: z.string(),
  model: z.string(),
  concurrency: z.number().int().min(1).max(10),
  timeoutSec: z.number().int().min(10).max(1800),
  sendFidelity: z.boolean(),
  // 中转站不认保真参数时由系统自动关闭，用户重新打开后清除
  fidelityAutoDisabled: z.boolean(),
}
const analysisFields = {
  baseUrl: z.string(),
  apiKey: z.string(),
  model: z.string(),
  concurrency: z.number().int().min(1).max(10),
  timeoutSec: z.number().int().min(10).max(600),
}

const ImageApiSchema = z.object({
  baseUrl: imageFields.baseUrl.default(''),
  apiKey: imageFields.apiKey.default(''),
  model: imageFields.model.default('gpt-image-2'),
  concurrency: imageFields.concurrency.default(2),
  timeoutSec: imageFields.timeoutSec.default(300),
  sendFidelity: imageFields.sendFidelity.default(true),
  fidelityAutoDisabled: imageFields.fidelityAutoDisabled.default(false),
})

const AnalysisApiSchema = z.object({
  baseUrl: analysisFields.baseUrl.default(''),
  apiKey: analysisFields.apiKey.default(''),
  model: analysisFields.model.default('gpt-5.6'),
  concurrency: analysisFields.concurrency.default(3),
  timeoutSec: analysisFields.timeoutSec.default(60),
})

/** 父体匹配（识别父体）。密钥、token 都会登记打码，接口返回时也打码 */
/** 飞书用应用身份读表（2026-10-27 改，不再用户授权）：只要 App ID / App Secret */
const FeishuSchema = z.object({
  appId: z.string().default(''),
  appSecret: z.string().default(''),
  /** 接口地址，测试时由程序内部指向模拟服务；设置接口不能改（否则能把 App Secret 发到别处） */
  baseUrl: z.string().default('https://open.feishu.cn'),
})

const SpapiSchema = z.object({
  sellerId: z.string().default(''),
  clientId: z.string().default(''),
  clientSecret: z.string().default(''),
  refreshToken: z.string().default(''),
  /** 美国站 */
  marketplaceId: z.string().default('ATVPDKIKX0DER'),
  endpoint: z.string().default('https://sellingpartnerapi-na.amazon.com'),
  /** LWA 换 token 的地址，同上，设置接口不能改 */
  tokenUrl: z.string().default('https://api.amazon.com/auth/o2/token'),
})

export const MAX_RECENT_URLS = 10

const ParentSchema = z.object({
  /** 「识别父体」开关，默认关闭：关着时第 6 步直接跳过，不读飞书、不调 SP-API */
  enabled: z.boolean().default(false),
  sheetUrl: z.string().default(''),
  recentUrls: z.array(z.object({ url: z.string(), title: z.string(), usedAt: z.string() })).default([]),
  /** 最近一次读表读到的标签页名，模版库「对应标签页」下拉用 */
  tabs: z.array(z.string()).default([]),
  threshold: z.number().min(0).max(1).default(0.7),
  /** 建议新建父体 SKU 时的创建人标识 */
  creatorMark: z.string().default('5'),
  feishu: FeishuSchema.prefault({}),
  spapi: SpapiSchema.prefault({}),
})
export type ParentSettings = z.infer<typeof ParentSchema>

/** 子体 SKU：店铺缩写-材质缩写 + 年份末位 + 地区标识 + 月日 + 专属号（parent.creatorMark）+ 当天序号 */
const SkuSchema = z.object({
  store: z.string().default('HJ'),
  region: z.string().default('7'),
})

export const SettingsSchema = z.object({
  image: ImageApiSchema.prefault({}),
  analysis: AnalysisApiSchema.prefault({}),
  outputDir: z.string().default(DEFAULT_OUTPUT_DIR),
  routeThreshold: z.number().min(0).max(1).default(0.7),
  padSquare: z.boolean().default(true),
  blankImage: z.boolean().default(true),
  /** 素材图提取后和竞品图对比验收；关着时不发验收请求 */
  patternQc: z.boolean().default(true),
  /** 图案元素相似分低于这个值不合格；2026-10-27 实测 Bennett 细节明显变样仍有 0.88，用户确认提到 0.9 */
  patternQcThreshold: z.number().min(0).max(1).default(0.9),
  /** 主图生成后和素材图对比验收（本地合成在本地核对，AI 贴图发一次分析请求） */
  mainQc: z.boolean().default(true),
  /** 素材图和竞品图印刷面的色差 ΔE 超过这个值不合格 */
  patternQcDeltaE: z.number().min(1).max(100).default(5),
  parent: ParentSchema.prefault({}),
  sku: SkuSchema.prefault({}),
})

export type Settings = z.infer<typeof SettingsSchema>
export type ApiKind = 'image' | 'analysis'

// 不能用带 default 的 schema 再 .partial()：zod 4 会把没传的字段填成默认值，部分保存就把别的设置冲掉了
export const SettingsPatchSchema = z.object({
  image: z.object(imageFields).partial().optional(),
  analysis: z.object(analysisFields).partial().optional(),
  outputDir: z.string().optional(),
  routeThreshold: z.number().min(0).max(1).optional(),
  padSquare: z.boolean().optional(),
  blankImage: z.boolean().optional(),
  patternQc: z.boolean().optional(),
  patternQcThreshold: z.number().min(0).max(1).optional(),
  patternQcDeltaE: z.number().min(1).max(100).optional(),
  mainQc: z.boolean().optional(),
  sku: z
    .object({ store: z.string().trim().regex(/^[A-Za-z0-9]{1,10}$/, '店铺缩写只能用 1～10 个字母或数字'), region: z.string().trim().regex(/^[A-Za-z0-9]{1,5}$/, '地区标识只能用 1～5 个字母或数字') })
    .partial()
    .optional(),
  parent: z
    .object({
      enabled: z.boolean().optional(),
      sheetUrl: z.string().max(2000).optional(),
      threshold: z.number().min(0).max(1).optional(),
      creatorMark: z.string().trim().regex(/^[A-Za-z0-9]{0,10}$/, '专属号只能用字母或数字').optional(),
      feishu: z
        .object({
          appId: z.string().max(200),
          appSecret: z.string().max(500),
        })
        .partial()
        .optional(),
      spapi: z
        .object({
          sellerId: z.string().max(100),
          clientId: z.string().max(500),
          clientSecret: z.string().max(500),
          refreshToken: z.string().max(4000),
          marketplaceId: z.string().max(50),
        })
        .partial()
        .optional(),
    })
    .optional(),
})
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>

export function normalizeBaseUrl(u: string): string {
  return u.trim().replace(/\/+$/, '')
}

export function maskKey(key: string): string {
  if (!key) return ''
  return `sk-…${key.slice(-4)}`
}

export function isMaskedKey(key: string): boolean {
  return /^sk-….{0,4}$/.test(key)
}

/** 父体匹配的密钥打码：只露末 4 位 */
export function maskSecret(v: string): string {
  if (!v) return ''
  return `••••${v.slice(-4)}`
}

export function isMaskedSecret(v: string): boolean {
  return v.startsWith('••••')
}

export function maskSettings(s: Settings): Settings {
  const f = s.parent.feishu
  const sp = s.parent.spapi
  return {
    ...s,
    image: { ...s.image, apiKey: maskKey(s.image.apiKey) },
    analysis: { ...s.analysis, apiKey: maskKey(s.analysis.apiKey) },
    parent: {
      ...s.parent,
      feishu: { ...f, appSecret: maskSecret(f.appSecret) },
      spapi: {
        ...sp,
        sellerId: maskSecret(sp.sellerId),
        clientId: maskSecret(sp.clientId),
        clientSecret: maskSecret(sp.clientSecret),
        refreshToken: maskSecret(sp.refreshToken),
      },
    },
  }
}

function registerParentSecrets(p: ParentSettings): void {
  for (const v of [p.feishu.appSecret, p.spapi.clientId, p.spapi.clientSecret, p.spapi.refreshToken, p.spapi.sellerId]) {
    registerSecret(v)
  }
}

/** 打码的值原样传回来时不改原值 */
function stripMasked<T extends object | undefined>(p: T): Partial<NonNullable<T>> {
  if (!p) return {}
  return Object.fromEntries(
    Object.entries(p).filter(([, v]) => v !== undefined && !(typeof v === 'string' && isMaskedSecret(v))).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]),
  ) as Partial<NonNullable<T>>
}

export function resolveOutputDir(s: Settings): string {
  const raw = s.outputDir.trim() || DEFAULT_OUTPUT_DIR
  return path.resolve(expandHome(raw === '~' ? os.homedir() : raw))
}

export class SettingsStore {
  private value: Settings
  private mutex = new Mutex()

  constructor(private file: string) {
    const raw = readJsonSync(file)
    const parsed = SettingsSchema.safeParse(raw ?? {})
    this.value = parsed.success ? parsed.data : SettingsSchema.parse({})
    if (this.value.outputDir === OLD_DEFAULT_OUTPUT_DIR) this.value.outputDir = DEFAULT_OUTPUT_DIR
    registerSecret(this.value.image.apiKey)
    registerSecret(this.value.analysis.apiKey)
    registerParentSecrets(this.value.parent)
  }

  get(): Settings {
    return this.value
  }

  async update(patch: SettingsPatch): Promise<Settings> {
    return this.mutex.run(async () => {
      const cur = this.value
      const image = { ...cur.image, ...stripMaskedKey(patch.image) }
      const analysis = { ...cur.analysis, ...stripMaskedKey(patch.analysis) }
      image.baseUrl = normalizeBaseUrl(image.baseUrl)
      analysis.baseUrl = normalizeBaseUrl(analysis.baseUrl)
      image.apiKey = image.apiKey.trim()
      analysis.apiKey = analysis.apiKey.trim()
      if (patch.image?.sendFidelity === true) image.fidelityAutoDisabled = false
      const pp = patch.parent
      const parent = {
        ...cur.parent,
        ...stripUndefined({ enabled: pp?.enabled, sheetUrl: pp?.sheetUrl?.trim(), threshold: pp?.threshold, creatorMark: pp?.creatorMark?.trim() }),
        feishu: { ...cur.parent.feishu, ...stripMasked(pp?.feishu) },
        spapi: { ...cur.parent.spapi, ...stripMasked(pp?.spapi) },
      }
      const next = SettingsSchema.parse({
        ...cur,
        ...stripUndefined({
          outputDir: patch.outputDir,
          routeThreshold: patch.routeThreshold,
          padSquare: patch.padSquare,
          blankImage: patch.blankImage,
          patternQc: patch.patternQc,
          patternQcThreshold: patch.patternQcThreshold,
          patternQcDeltaE: patch.patternQcDeltaE,
          mainQc: patch.mainQc,
        }),
        image,
        analysis,
        parent,
        sku: { ...cur.sku, ...stripUndefined({ store: patch.sku?.store?.trim(), region: patch.sku?.region?.trim() }) },
      })
      registerSecret(next.image.apiKey)
      registerSecret(next.analysis.apiKey)
      registerParentSecrets(next.parent)
      await writeJsonAtomic(this.file, next)
      this.value = next
      return next
    })
  }

  /** 程序内部改父体设置（授权换到的 token、用过的链接），不经过接口校验 */
  async updateParent(fn: (p: ParentSettings) => void): Promise<Settings> {
    return this.mutex.run(async () => {
      const draft = structuredClone(this.value)
      fn(draft.parent)
      const next = SettingsSchema.parse(draft)
      registerParentSecrets(next.parent)
      await writeJsonAtomic(this.file, next)
      this.value = next
      return next
    })
  }
}

function stripMaskedKey<T extends { apiKey?: string } | undefined>(p: T): Partial<NonNullable<T>> {
  if (!p) return {}
  const out = stripUndefined({ ...p }) as Partial<NonNullable<T>> & { apiKey?: string }
  if (out.apiKey !== undefined && isMaskedKey(out.apiKey)) delete out.apiKey
  return out
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}
