import path from 'node:path'
import os from 'node:os'
import { z } from 'zod'
import { readJsonSync, writeJsonAtomic } from './atomic'
import { Mutex } from '../util/mutex'
import { expandHome } from '../paths'
import { registerSecret } from '../util/log'

export const DEFAULT_OUTPUT_DIR = path.join('~', 'Downloads', '主图生成')

const ImageApiSchema = z.object({
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  model: z.string().default('gpt-image-2'),
  concurrency: z.number().int().min(1).max(10).default(2),
  timeoutSec: z.number().int().min(10).max(1800).default(300),
  sendFidelity: z.boolean().default(true),
  // 中转站不认保真参数时由系统自动关闭，用户重新打开后清除
  fidelityAutoDisabled: z.boolean().default(false),
})

const AnalysisApiSchema = z.object({
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  model: z.string().default('gpt-5.5'),
  concurrency: z.number().int().min(1).max(10).default(3),
  timeoutSec: z.number().int().min(10).max(600).default(60),
})

export const SettingsSchema = z.object({
  image: ImageApiSchema.prefault({}),
  analysis: AnalysisApiSchema.prefault({}),
  outputDir: z.string().default(DEFAULT_OUTPUT_DIR),
  routeThreshold: z.number().min(0).max(1).default(0.7),
  padSquare: z.boolean().default(true),
  blankImage: z.boolean().default(true),
})

export type Settings = z.infer<typeof SettingsSchema>
export type ApiKind = 'image' | 'analysis'

export const SettingsPatchSchema = z.object({
  image: ImageApiSchema.partial().optional(),
  analysis: AnalysisApiSchema.partial().optional(),
  outputDir: z.string().optional(),
  routeThreshold: z.number().min(0).max(1).optional(),
  padSquare: z.boolean().optional(),
  blankImage: z.boolean().optional(),
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

export function maskSettings(s: Settings): Settings {
  return {
    ...s,
    image: { ...s.image, apiKey: maskKey(s.image.apiKey) },
    analysis: { ...s.analysis, apiKey: maskKey(s.analysis.apiKey) },
  }
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
    registerSecret(this.value.image.apiKey)
    registerSecret(this.value.analysis.apiKey)
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
      const next = SettingsSchema.parse({
        ...cur,
        ...stripUndefined({
          outputDir: patch.outputDir,
          routeThreshold: patch.routeThreshold,
          padSquare: patch.padSquare,
          blankImage: patch.blankImage,
        }),
        image,
        analysis,
      })
      registerSecret(next.image.apiKey)
      registerSecret(next.analysis.apiKey)
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
