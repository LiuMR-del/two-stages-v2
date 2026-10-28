import fs from 'node:fs'
import path from 'node:path'
import { readJsonSync, writeFileAtomicSync, writeJsonAtomic } from '../store/atomic'
import { Mutex } from '../util/mutex'
import { HttpError } from '../util/errors'
import { log } from '../util/log'
import { ImageStore } from './images'
import { initialLibrary, LibrarySchema, migrateLibrary, referencedHashes, upgradeDefaults, validateIntegrity, type Category, type Library, type Style, type WhiteShapeRecord } from './schema'
import { detectWhiteShape } from '../image/whiteShape'
import { newCategoryId, newStyleId, newTemplateId } from '../util/ids'
import { ratioToWH } from '../prompts/canvas'

export type LibraryPaths = { file: string; imagesDir: string; thumbsDir: string; backupsDir: string }

const MAX_BACKUPS = 10

export class LibraryStore {
  private value: Library
  private mutex = new Mutex()
  readonly images: ImageStore
  private listeners: ((lib: Library) => void)[] = []
  private shapeCache = new Map<string, WhiteShapeRecord>()

  constructor(private p: LibraryPaths) {
    fs.mkdirSync(p.imagesDir, { recursive: true })
    fs.mkdirSync(p.thumbsDir, { recursive: true })
    this.images = new ImageStore(p.imagesDir, p.thumbsDir)
    const raw = readJsonSync(p.file)
    if (raw === null) {
      this.value = initialLibrary()
      fs.writeFileSync(p.file, JSON.stringify(this.value, null, 2))
    } else {
      const migrated = migrateLibrary(raw)
      const r = LibrarySchema.safeParse(migrated)
      if (!r.success) {
        const bad = path.join(path.dirname(p.file), `library.broken-${Date.now()}.json`)
        fs.copyFileSync(p.file, bad)
        log.error(`模版库文件格式不对，已另存为 ${bad}，这次用空模版库启动`)
        this.value = initialLibrary()
      } else {
        this.value = r.data
        if (migrated !== raw) {
          const old = path.join(path.dirname(p.file), `library.v1-${Date.now()}.json`)
          fs.copyFileSync(p.file, old)
          writeFileAtomicSync(p.file, JSON.stringify(this.value, null, 2))
          log.info(`模版库已升级：自定义模版改为每个款式各一套（旧文件另存为 ${old}）`)
        }
        if (upgradeDefaults(this.value)) {
          this.backupCurrent()
          writeFileAtomicSync(p.file, JSON.stringify(this.value, null, 2))
          log.info('全局默认的提取 / 贴图提示词还是旧版默认，已换成新版默认（改过的不动；旧文件在 backups 里）')
        }
      }
    }
  }

  get(): Library {
    return this.value
  }

  onChange(fn: (lib: Library) => void): void {
    this.listeners.push(fn)
  }

  /** 只在启动时和导入完成后调用；和写操作串行，避免删掉刚上传、还没写进库的图 */
  cleanOrphans(): Promise<number> {
    return this.mutex.run(() => this.images.cleanOrphans(referencedHashes(this.value)))
  }

  /**
   * 白底图的图形检测结果：库里有就直接用，没有就现算；图片还在库里引用着才存进库。
   * buffer 给了就不再读库里的图（任务目录里复制的那份）。
   */
  async whiteShape(hash: string, buffer?: Buffer): Promise<WhiteShapeRecord> {
    const cached = this.value.whiteChecks[hash] ?? this.shapeCache.get(hash)
    if (cached) return cached
    const buf = buffer ?? (await this.images.read(hash)).buffer
    const shape = await detectWhiteShape(buf)
    this.shapeCache.set(hash, shape)
    if (referencedHashes(this.value).has(hash)) {
      await this.mutate((d) => {
        d.whiteChecks[hash] = shape
      }).catch((e) => log.warn(`保存白底图检测结果失败：${(e as Error).message}`))
    }
    return shape
  }

  category(cid: string): Category {
    const c = this.value.categories.find((x) => x.id === cid)
    if (!c) throw new HttpError(404, '品类不存在，可能已被删除')
    return c
  }

  /** 所有写操作都走这里：串行、校验、原子写、通知 */
  async mutate<T>(fn: (draft: Library) => T | Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      const draft = structuredClone(this.value)
      const result = await fn(draft)
      const parsed = LibrarySchema.safeParse(draft)
      if (!parsed.success) {
        const i = parsed.error.issues[0]!
        throw new HttpError(400, i.message || '模版库数据不合法')
      }
      const integrity = validateIntegrity(parsed.data)
      if (integrity) throw new HttpError(400, integrity)
      await writeJsonAtomic(this.p.file, parsed.data)
      this.value = parsed.data
      for (const l of this.listeners) l(this.value)
      return result
    })
  }

  /** 只能在 mutate 回调里调用 */
  backupCurrent(): void {
    fs.mkdirSync(this.p.backupsDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    fs.copyFileSync(this.p.file, path.join(this.p.backupsDir, `library-${stamp}.json`))
    const files = fs
      .readdirSync(this.p.backupsDir)
      .filter((f) => /^library-.*\.json$/.test(f))
      .sort()
    for (const f of files.slice(0, Math.max(0, files.length - MAX_BACKUPS))) {
      fs.rmSync(path.join(this.p.backupsDir, f), { force: true })
    }
  }
}

// ---- 供接口调用的具体操作；都在 mutate 的草稿上执行 ----

function findCat(lib: Library, cid: string): Category {
  const c = lib.categories.find((x) => x.id === cid)
  if (!c) throw new HttpError(404, '品类不存在，可能已被删除')
  return c
}

export function findStyle(lib: Library, cid: string, sid: string): Style {
  const s = findCat(lib, cid).styles.find((x) => x.id === sid)
  if (!s) throw new HttpError(404, '款式不存在，可能已被删除')
  return s
}

function findTemplate(lib: Library, cid: string, sid: string, tid: string) {
  const t = findStyle(lib, cid, sid).templates.find((x) => x.id === tid)
  if (!t) throw new HttpError(404, '模版不存在，可能已被删除')
  return t
}

function checkCategoryName(lib: Library, name: string, exceptId?: string): string {
  const n = name.trim()
  if (n.length < 1 || n.length > 20) throw new HttpError(400, '品类名称要 1～20 个字')
  if (lib.categories.some((c) => c.name === n && c.id !== exceptId)) throw new HttpError(400, `已经有叫「${n}」的品类了`)
  return n
}

function checkRatio(ratio: string): string {
  try {
    const [w, h] = ratioToWH(ratio)
    return `${w}:${h}`
  } catch (e) {
    throw new HttpError(400, (e as Error).message)
  }
}

export const ops = {
  addCategory(lib: Library, name: string): Category {
    const c: Category = {
      id: newCategoryId(),
      name: checkCategoryName(lib, name),
      hint: '',
      extractPrompt: null,
      parentTab: null,
      styles: [{ id: newStyleId(), name: '', ratio: '1:1', whiteImage: null, activeTemplate: 'default', templates: [], pasteMode: 'auto' }],
    }
    lib.categories.push(c)
    return c
  },

  patchCategory(lib: Library, cid: string, p: { name?: string; hint?: string; extractPrompt?: string | null; parentTab?: string | null }): Category {
    const c = findCat(lib, cid)
    if (p.name !== undefined) c.name = checkCategoryName(lib, p.name, cid)
    if (p.hint !== undefined) c.hint = p.hint
    if (p.extractPrompt !== undefined) c.extractPrompt = p.extractPrompt
    if (p.parentTab !== undefined) c.parentTab = p.parentTab?.trim() || null
    return c
  },

  deleteCategory(lib: Library, cid: string): void {
    findCat(lib, cid)
    lib.categories = lib.categories.filter((c) => c.id !== cid)
  },

  reorder(lib: Library, ids: string[]): void {
    const cur = lib.categories.map((c) => c.id)
    if (ids.length !== cur.length || new Set(ids).size !== ids.length || !ids.every((id) => cur.includes(id))) {
      throw new HttpError(400, '排序列表和现有品类对不上，请刷新页面后再试')
    }
    lib.categories = ids.map((id) => lib.categories.find((c) => c.id === id)!)
  },

  addStyle(lib: Library, cid: string, name: string, ratio: string) {
    const c = findCat(lib, cid)
    const n = name.trim()
    if (!n) throw new HttpError(400, '款式名称不能为空')
    if (n.length > 20) throw new HttpError(400, '款式名称不能超过 20 个字')
    if (c.styles.some((s) => s.name === n)) throw new HttpError(400, `「${c.name}」已经有叫「${n}」的款式了`)
    // 单款式品类的款式没有名字；加第二个款式时给它补一个，否则两个款式没法区分
    for (const s of c.styles) if (!s.name) s.name = n === '默认' ? '原款式' : '默认'
    const st: Style = { id: newStyleId(), name: n, ratio: checkRatio(ratio), whiteImage: null, activeTemplate: 'default', templates: [], pasteMode: 'auto' }
    c.styles.push(st)
    return st
  },

  patchStyle(lib: Library, cid: string, sid: string, p: { name?: string; ratio?: string; activeTemplate?: string; pasteMode?: Style['pasteMode'] }) {
    const c = findCat(lib, cid)
    const s = c.styles.find((x) => x.id === sid)
    if (!s) throw new HttpError(404, '款式不存在，可能已被删除')
    if (p.name !== undefined) {
      const n = p.name.trim()
      if (n.length > 20) throw new HttpError(400, '款式名称不能超过 20 个字')
      if (!n && c.styles.length > 1) throw new HttpError(400, '有多个款式时，每个款式都要有名字')
      if (c.styles.some((x) => x.id !== sid && x.name === n)) throw new HttpError(400, `「${c.name}」已经有叫「${n}」的款式了`)
      s.name = n
    }
    if (p.ratio !== undefined) s.ratio = checkRatio(p.ratio)
    if (p.activeTemplate !== undefined) {
      if (p.activeTemplate !== 'default' && !s.templates.some((t) => t.id === p.activeTemplate)) throw new HttpError(400, '要使用的模版不存在')
      s.activeTemplate = p.activeTemplate
    }
    if (p.pasteMode !== undefined) s.pasteMode = p.pasteMode
    return s
  },

  deleteStyle(lib: Library, cid: string, sid: string): void {
    const c = findCat(lib, cid)
    if (!c.styles.some((s) => s.id === sid)) throw new HttpError(404, '款式不存在，可能已被删除')
    if (c.styles.length <= 1) throw new HttpError(400, '每个品类至少要保留一个款式')
    c.styles = c.styles.filter((s) => s.id !== sid)
  },

  setWhite(lib: Library, cid: string, sid: string, hash: string | null, shape?: WhiteShapeRecord): void {
    const c = findCat(lib, cid)
    const s = c.styles.find((x) => x.id === sid)
    if (!s) throw new HttpError(404, '款式不存在，可能已被删除')
    s.whiteImage = hash
    if (hash && shape) lib.whiteChecks[hash] = shape
  },

  addTemplate(lib: Library, cid: string, sid: string, name: string, prompt: string) {
    const s = findStyle(lib, cid, sid)
    const n = name.trim() || `自定义 ${s.templates.length + 1}`
    if (n.length > 30) throw new HttpError(400, '模版名称不能超过 30 个字')
    const t = { id: newTemplateId(), name: n, prompt, image: null, canvasRatio: null }
    s.templates.push(t)
    return t
  },

  patchTemplate(lib: Library, cid: string, sid: string, tid: string, p: { name?: string; prompt?: string; canvasRatio?: string | null }) {
    const t = findTemplate(lib, cid, sid, tid)
    if (p.name !== undefined) {
      const n = p.name.trim()
      if (!n || n.length > 30) throw new HttpError(400, '模版名称要 1～30 个字')
      t.name = n
    }
    if (p.prompt !== undefined) t.prompt = p.prompt
    if (p.canvasRatio !== undefined) t.canvasRatio = p.canvasRatio?.trim() ? checkRatio(p.canvasRatio) : null
    return t
  },

  deleteTemplate(lib: Library, cid: string, sid: string, tid: string): void {
    const s = findStyle(lib, cid, sid)
    findTemplate(lib, cid, sid, tid)
    s.templates = s.templates.filter((t) => t.id !== tid)
    if (s.activeTemplate === tid) s.activeTemplate = 'default'
  },

  setTemplateImage(lib: Library, cid: string, sid: string, tid: string, hash: string | null): void {
    findTemplate(lib, cid, sid, tid).image = hash
  },
}
