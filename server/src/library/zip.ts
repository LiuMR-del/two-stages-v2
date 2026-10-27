import { strToU8, strFromU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { LibrarySchema, migrateLibrary, referencedHashes, validateIntegrity, type Category, type Library } from './schema'
import { sha256, normalizeLibraryImage, type ImageStore } from './images'
import type { LibraryStore } from './store'
import { HttpError } from '../util/errors'
import { newCategoryId, newStyleId } from '../util/ids'
import { sniffImageType, EXT_OF } from '../image/process'

export async function exportZip(lib: Library, images: ImageStore): Promise<Buffer> {
  const files: Zippable = { 'library.json': strToU8(JSON.stringify(lib, null, 2)) }
  for (const h of referencedHashes(lib)) {
    const f = images.find(h)
    if (!f) continue
    const { buffer } = await images.read(h)
    files[`images/${h}.${f.ext}`] = [new Uint8Array(buffer), { level: 0 }]
  }
  return Buffer.from(zipSync(files, { level: 6 }))
}

type Parsed = { lib: Library; images: Map<string, { ext: string; buffer: Buffer }> }

export async function parseZip(buf: Buffer): Promise<Parsed> {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(new Uint8Array(buf))
  } catch {
    throw new HttpError(400, '不是有效的 zip 文件')
  }
  const names = Object.keys(entries)
  const jsonName = names.find((n) => n === 'library.json') ?? names.find((n) => /(^|\/)library\.json$/.test(n))
  if (!jsonName) throw new HttpError(400, 'zip 里没有 library.json，不是模版库导出的文件')
  const root = jsonName.slice(0, jsonName.length - 'library.json'.length)
  let raw: unknown
  try {
    raw = JSON.parse(strFromU8(entries[jsonName]!))
  } catch {
    throw new HttpError(400, 'library.json 不是合法的 JSON')
  }
  const r = LibrarySchema.safeParse(migrateLibrary(raw))
  if (!r.success) {
    const i = r.error.issues[0]!
    throw new HttpError(400, `library.json 格式不对：${i.path.join('.')} ${i.message}`)
  }
  const integrity = validateIntegrity(r.data)
  if (integrity) throw new HttpError(400, `library.json 内容有问题：${integrity}`)

  const images = new Map<string, { ext: string; buffer: Buffer }>()
  for (const n of names) {
    const m = new RegExp(`^${escapeRe(root)}images/([a-f0-9]{64})\\.(png|jpg|webp)$`).exec(n)
    if (!m) continue
    const buffer = Buffer.from(entries[n]!)
    const type = sniffImageType(buffer)
    if (!type || EXT_OF[type] !== m[2] || sha256(buffer) !== m[1]) throw new HttpError(400, `图片 ${n} 已损坏或和文件名对不上`)
    images.set(m[1]!, { ext: m[2]!, buffer })
  }
  for (const h of referencedHashes(r.data)) {
    if (!images.has(h)) throw new HttpError(400, `模版库引用的图片 ${h.slice(0, 8)}… 在 zip 里找不到，整包不导入`)
  }
  for (const [h, img] of images) {
    try {
      await normalizeLibraryImage(img.buffer)
    } catch {
      throw new HttpError(400, `图片 ${h.slice(0, 8)}… 无法解码`)
    }
  }
  return { lib: r.data, images }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 同名品类整个覆盖但保留本地 id；款式按名称对上的也沿用本地 id（模版跟着款式走），
 * 这样队列里引用它们的任务不会因为导入而变成「品类或款式已被删除」。
 */
export function mergeLibraries(local: Library, incoming: Library): Library {
  const out = structuredClone(local)
  const usedCatIds = new Set(out.categories.map((c) => c.id))
  for (const inc of incoming.categories) {
    const idx = out.categories.findIndex((c) => c.name === inc.name)
    if (idx >= 0) {
      out.categories[idx] = remapCategory(inc, out.categories[idx]!)
    } else {
      const c = structuredClone(inc)
      if (usedCatIds.has(c.id)) c.id = newCategoryId()
      usedCatIds.add(c.id)
      out.categories.push(c)
    }
  }
  return out
}

function remapCategory(inc: Category, local: Category): Category {
  const c = structuredClone(inc)
  c.id = local.id
  const usedS = new Set<string>()
  for (const s of c.styles) {
    const match = local.styles.find((ls) => ls.name === s.name && !usedS.has(ls.id))
    const id = match ? match.id : usedS.has(s.id) || local.styles.some((ls) => ls.id === s.id) ? newStyleId() : s.id
    usedS.add(id)
    s.id = id
  }
  return c
}

export async function importZip(store: LibraryStore, buf: Buffer, mode: 'merge' | 'replace'): Promise<{ categories: number }> {
  const parsed = await parseZip(buf)
  await store.mutate(async (draft) => {
    for (const [h, img] of parsed.images) await store.images.addExact(h, img.ext, img.buffer)
    if (mode === 'replace') {
      store.backupCurrent()
      draft.defaults = parsed.lib.defaults
      draft.categories = parsed.lib.categories
    } else {
      draft.categories = mergeLibraries(draft, parsed.lib).categories
    }
  })
  await store.cleanOrphans()
  return { categories: parsed.lib.categories.length }
}
