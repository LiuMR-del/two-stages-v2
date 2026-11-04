import path from 'node:path'
import os from 'node:os'
import { z } from 'zod'
import fs from 'node:fs'
import { readJsonSync, writeJsonAtomic, writeFileAtomicSync } from './atomic'
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

/** 店铺自己的父体表（只有 parentSource = 'feishu' 的店铺用） */
const StoreFeishuSchema = z.object({
  sheetUrl: z.string().default(''),
  recentUrls: z.array(z.object({ url: z.string(), title: z.string(), usedAt: z.string() })).default([]),
  /** 最近一次读表读到的标签页名，模版库「对应标签页」下拉用 */
  tabs: z.array(z.string()).default([]),
})

/**
 * 店铺档案（多店铺方案 2.1，2026-11-04）：每个店铺各自的缩写、父体来源、SP-API 凭证和父体表。
 * feishu = 从飞书父体表挑父体（焕捷）；store = 从店铺里扫描父体（爱睿特，没有飞书父体表）。
 */
export const StoreSchema = z.object({
  id: z.string(),
  name: z.string(),
  abbr: z.string(),
  parentSource: z.enum(['feishu', 'store']).default('store'),
  spapi: SpapiSchema.prefault({}),
  feishu: StoreFeishuSchema.prefault({}),
})
export type Store = z.infer<typeof StoreSchema>

const ParentSchema = z.object({
  /** 「识别父体」开关，默认关闭：关着时第 6 步直接跳过，不读飞书、不调 SP-API */
  enabled: z.boolean().default(false),
  threshold: z.number().min(0).max(1).default(0.7),
  /** 飞书应用身份，所有店铺共用。原来的 creatorMark（专属号）2026-11-04 去掉：子体按批次、默认 0，父体不加 */
  feishu: FeishuSchema.prefault({}),
})
export type ParentSettings = z.infer<typeof ParentSchema>

/** 子体 SKU：店铺缩写（店铺档案里）-材质缩写 + 年份末位 + 组别 + 月日 + 专属号 + 当天序号 */
const SkuSchema = z.object({
  /** 组别（飞书「亚马逊sku目录」：7 = 深圳团队），原来叫「地区标识」（sku.region） */
  group: z.string().default('7'),
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
  stores: z.array(StoreSchema).default([]),
  /** 新的一批用哪个店铺 */
  currentStoreId: z.string().default(''),
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
    .object({ group: z.string().trim().regex(/^[A-Za-z0-9]{1,5}$/, '组别只能用 1～5 个字母或数字') })
    .partial()
    .optional(),
  parent: z
    .object({
      enabled: z.boolean().optional(),
      threshold: z.number().min(0).max(1).optional(),
      feishu: z
        .object({
          appId: z.string().max(200),
          appSecret: z.string().max(500),
        })
        .partial()
        .optional(),
    })
    .optional(),
})
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>

const ABBR = z.string().trim().regex(/^[A-Za-z0-9]{1,10}$/, '店铺缩写只能用 1～10 个字母或数字')
const STORE_NAME = z.string().trim().min(1, '店铺名称不能为空').max(20, '店铺名称最多 20 个字')

export const StoreCreateSchema = z.object({ name: STORE_NAME, abbr: ABBR, parentSource: z.enum(['feishu', 'store']).default('store') })
export type StoreCreate = z.infer<typeof StoreCreateSchema>

/** 店铺档案的修改；接口地址（endpoint / tokenUrl）不在这里，改不了 */
export const StorePatchSchema = z.object({
  name: STORE_NAME.optional(),
  abbr: ABBR.optional(),
  parentSource: z.enum(['feishu', 'store']).optional(),
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
  feishu: z.object({ sheetUrl: z.string().max(2000) }).partial().optional(),
})
export type StorePatch = z.infer<typeof StorePatchSchema>

/** 新装或旧设置迁移时的两个店铺：焕捷用飞书父体表，爱睿特从店铺扫描父体 */
export const DEFAULT_STORES: ReadonlyArray<Pick<Store, 'id' | 'name' | 'abbr' | 'parentSource'>> = [
  { id: 'hj', name: '焕捷', abbr: 'HJ', parentSource: 'feishu' },
  { id: 'art', name: '爱睿特', abbr: 'ART', parentSource: 'store' },
]

/**
 * 旧设置（只有一个店铺：parent.spapi、parent.sheetUrl、sku.store）迁移成店铺档案：原来的凭证和父体表归焕捷，再加一个空的爱睿特。
 * 返回 null 表示不用迁移。
 */
export function migrateRaw(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, any>
  if (Array.isArray(r.stores)) return null
  const p = (r.parent ?? {}) as Record<string, any>
  const hj = {
    ...DEFAULT_STORES[0]!,
    abbr: typeof r.sku?.store === 'string' && r.sku.store.trim() ? r.sku.store.trim() : 'HJ',
    spapi: p.spapi ?? {},
    feishu: { sheetUrl: p.sheetUrl ?? '', recentUrls: p.recentUrls ?? [], tabs: p.tabs ?? [] },
  }
  const { sheetUrl: _u, recentUrls: _r, tabs: _t, spapi: _s, ...parent } = p
  const sku = { group: typeof r.sku?.region === 'string' && r.sku.region ? r.sku.region : '7' }
  return { ...r, parent, sku, stores: [hj, { ...DEFAULT_STORES[1]! }], currentStoreId: hj.id }
}

/** 店铺列表不能为空，当前店铺必须存在 */
function ensureStores(s: Settings): Settings {
  const stores = s.stores.length ? s.stores : DEFAULT_STORES.map((d) => StoreSchema.parse(d))
  const currentStoreId = stores.some((x) => x.id === s.currentStoreId) ? s.currentStoreId : stores[0]!.id
  return { ...s, stores, currentStoreId }
}

export function storeById(s: Settings, id: string): Store | null {
  return s.stores.find((x) => x.id === id) ?? null
}

export function currentStore(s: Settings): Store {
  return storeById(s, s.currentStoreId) ?? s.stores[0]!
}

/**
 * 新店铺的 ID：缩写小写 + 时间。不复用删掉的店铺的 ID，免得旧批次、旧任务（按店铺 ID 记）挂到新店铺上、用新店铺的凭证。
 */
function newStoreId(s: Settings, abbr: string): string {
  const base = `${abbr.toLowerCase().replace(/[^a-z0-9]/g, '') || 'store'}-${Date.now().toString(36)}`
  let id = base
  for (let i = 2; s.stores.some((x) => x.id === id); i++) id = `${base}-${i}`
  return id
}

function checkAbbrUnique(s: Settings, abbr: string, selfId: string | null): void {
  const dup = s.stores.find((x) => x.id !== selfId && x.abbr.toLowerCase() === abbr.toLowerCase())
  if (dup) throw new SettingsError(`店铺缩写 ${abbr} 已经被「${dup.name}」用了`)
}

/** 设置内容本身不对（重名、删当前店铺等），接口返回 400 */
export class SettingsError extends Error {}

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
  return {
    ...s,
    image: { ...s.image, apiKey: maskKey(s.image.apiKey) },
    analysis: { ...s.analysis, apiKey: maskKey(s.analysis.apiKey) },
    parent: { ...s.parent, feishu: { ...f, appSecret: maskSecret(f.appSecret) } },
    stores: s.stores.map((st) => ({
      ...st,
      spapi: {
        ...st.spapi,
        sellerId: maskSecret(st.spapi.sellerId),
        clientId: maskSecret(st.spapi.clientId),
        clientSecret: maskSecret(st.spapi.clientSecret),
        refreshToken: maskSecret(st.spapi.refreshToken),
      },
    })),
  }
}

function registerParentSecrets(s: Settings): void {
  registerSecret(s.parent.feishu.appSecret)
  for (const st of s.stores) {
    for (const v of [st.spapi.clientId, st.spapi.clientSecret, st.spapi.refreshToken, st.spapi.sellerId]) registerSecret(v)
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
  /** 原文件是旧结构或读不懂、还没备份成功：保存前要先补上备份，补不上不许保存（否则会把原文件里的凭证冲掉） */
  private backupPending: string | null = null

  constructor(private file: string) {
    const raw = readJsonSync(file)
    const migrated = migrateRaw(raw)
    const parsed = SettingsSchema.safeParse(migrated ?? raw ?? {})
    this.value = ensureStores(parsed.success ? parsed.data : SettingsSchema.parse({}))
    if (this.value.outputDir === OLD_DEFAULT_OUTPUT_DIR) this.value.outputDir = DEFAULT_OUTPUT_DIR
    registerSecret(this.value.image.apiKey)
    registerSecret(this.value.analysis.apiKey)
    registerParentSecrets(this.value)
    // 旧结构（要迁移）或读不懂（字段超范围等，内存里只能用默认值）：先把原文件留一份，再写回
    if (raw !== null && raw !== undefined && (migrated || !parsed.success)) {
      this.backupPending = parsed.success ? 'v1' : 'bad'
      if (this.backup() && parsed.success) {
        try {
          writeFileAtomicSync(file, JSON.stringify(this.value, null, 2))
        } catch {
          // 写不了就下次再迁移，内存里已经是新结构
        }
      }
    }
  }

  /** 复制一份原文件（settings.v1-时间.json 或 settings.bad-时间.json）；成功返回 true */
  private backup(): boolean {
    if (!this.backupPending) return true
    try {
      fs.copyFileSync(this.file, this.file.replace(/\.json$/, '') + `.${this.backupPending}-${Date.now()}.json`)
      this.backupPending = null
      return true
    } catch {
      return false
    }
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
        ...stripUndefined({ enabled: pp?.enabled, threshold: pp?.threshold }),
        feishu: { ...cur.parent.feishu, ...stripMasked(pp?.feishu) },
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
        sku: { ...cur.sku, ...stripUndefined({ group: patch.sku?.group?.trim() }) },
      })
      return this.commit(next)
    })
  }

  private async commit(draft: Settings): Promise<Settings> {
    if (!this.backup()) throw new SettingsError('原来的设置文件还没备份成功，先不保存，免得把里面的凭证冲掉。请检查 data 文件夹能不能写入')
    const next = ensureStores(SettingsSchema.parse(draft))
    registerSecret(next.image.apiKey)
    registerSecret(next.analysis.apiKey)
    registerParentSecrets(next)
    await writeJsonAtomic(this.file, next)
    this.value = next
    return next
  }

  /** 程序内部改父体设置（飞书接口地址等），不经过接口校验 */
  async updateParent(fn: (p: ParentSettings) => void): Promise<Settings> {
    return this.mutex.run(async () => {
      const draft = structuredClone(this.value)
      fn(draft.parent)
      return this.commit(draft)
    })
  }

  /** 程序内部改某个店铺（用过的链接、读到的标签页、测试时指向模拟服务的接口地址），不经过接口校验 */
  async updateStoreRaw(id: string, fn: (st: Store) => void): Promise<Settings> {
    return this.mutex.run(async () => {
      const draft = structuredClone(this.value)
      const st = storeById(draft, id)
      if (!st) throw new SettingsError('没有这个店铺')
      fn(st)
      return this.commit(draft)
    })
  }

  /** 接口改店铺：打码的值原样传回时不改原值；缩写不能和别的店铺重 */
  async updateStore(id: string, patch: StorePatch): Promise<Settings> {
    return this.mutex.run(async () => {
      const draft = structuredClone(this.value)
      const st = storeById(draft, id)
      if (!st) throw new SettingsError('没有这个店铺')
      if (patch.abbr !== undefined) checkAbbrUnique(draft, patch.abbr, id)
      Object.assign(st, stripUndefined({ name: patch.name, abbr: patch.abbr, parentSource: patch.parentSource }))
      st.spapi = { ...st.spapi, ...stripMasked(patch.spapi) }
      if (patch.feishu?.sheetUrl !== undefined) st.feishu.sheetUrl = patch.feishu.sheetUrl.trim()
      return this.commit(draft)
    })
  }

  async addStore(c: StoreCreate): Promise<{ settings: Settings; id: string }> {
    return this.mutex.run(async () => {
      const draft = structuredClone(this.value)
      checkAbbrUnique(draft, c.abbr, null)
      const id = newStoreId(draft, c.abbr)
      draft.stores.push(StoreSchema.parse({ id, name: c.name, abbr: c.abbr, parentSource: c.parentSource }))
      return { settings: await this.commit(draft), id }
    })
  }

  /** 换当前店铺（新的一批用它）；队列里有没有图由接口那边拦 */
  async setCurrentStore(id: string): Promise<Settings> {
    return this.mutex.run(async () => {
      const draft = structuredClone(this.value)
      if (!storeById(draft, id)) throw new SettingsError('没有这个店铺')
      draft.currentStoreId = id
      return this.commit(draft)
    })
  }

  /** 当前店铺不能删，至少留一个 */
  async removeStore(id: string): Promise<Settings> {
    return this.mutex.run(async () => {
      const draft = structuredClone(this.value)
      if (!storeById(draft, id)) throw new SettingsError('没有这个店铺')
      if (draft.currentStoreId === id) throw new SettingsError('当前店铺不能删，先换到别的店铺')
      draft.stores = draft.stores.filter((x) => x.id !== id)
      return this.commit(draft)
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
