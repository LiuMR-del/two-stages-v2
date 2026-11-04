import type { Router } from 'express'
import { z } from 'zod'
import type { AppContext } from '../context'
import { HttpError, parseBody } from './util'
import { currentStore, storeById } from '../store/settings'
import { DEFAULT_MARK } from '../pipeline/output'

/**
 * 当前这一批（多店铺方案第五节）：属于哪个店铺、专属号是多少；「改专属号」。
 * 「这一批」= 开着的批次文件夹；今天的批次还没开（或者换了一天）时，用队列里最后一张图的文件夹。
 */
export function registerBatch(r: Router, ctx: AppContext): void {
  const folderNow = (): string | null => ctx.batch.open() ?? ctx.jobs.list().at(-1)?.outputFolder ?? null

  r.get('/batch', (_req, res) => {
    const s = ctx.settings.get()
    const folder = folderNow()
    const meta = folder ? ctx.batch.meta(folder) : null
    const store = (meta ? storeById(s, meta.storeId) : null) ?? currentStore(s)
    res.json({ folder, storeId: store.id, storeName: store.name, abbr: store.abbr, mark: meta?.mark ?? DEFAULT_MARK, queued: ctx.jobs.list().length })
  })

  /** apply = false 只出预览；有冲突时不改 */
  r.post('/batch/mark', async (req, res) => {
    const b = parseBody(z.object({ mark: z.string().trim().regex(/^[A-Za-z0-9]{1,10}$/, '专属号只能用 1～10 个字母或数字'), apply: z.boolean().default(false) }), req.body)
    const folder = folderNow()
    if (!folder) throw new HttpError(400, '现在没有正在进行的一批，加图之后再改专属号')
    const meta = ctx.batch.meta(folder)
    const store = storeById(ctx.settings.get(), meta.storeId)
    // 先强制重扫店铺，查新 SKU 在店里有没有重名；没填凭证时只查本地，界面上写明
    let storeSkus = new Set<string>()
    // ok = 查过店铺；noCredentials = 没填凭证，只查了本地；truncated = 店铺商品没扫全，不让改
    let storeCheck: 'ok' | 'noCredentials' | 'truncated' = 'noCredentials'
    if (store?.spapi.refreshToken && store.spapi.sellerId) {
      try {
        const snap = await ctx.parent.index.get(store.id, { force: true })
        storeSkus = new Set(snap.items.map((x) => x.sku.toLowerCase()))
        storeCheck = snap.truncated ? 'truncated' : 'ok'
      } catch (e) {
        throw new HttpError(502, `查不了「${store.name}」店铺里有没有重名的 SKU，先不改。检查网络或店铺凭证后再试：${(e as Error).message}`)
      }
    }
    if (b.apply && storeCheck === 'truncated') throw new HttpError(409, `「${store?.name}」店铺商品没扫全，没法确认新 SKU 在店里有没有重名，先不改`)
    const plan = await ctx.scheduler.changeBatchMark(folder, b.mark, { apply: b.apply, storeSkus })
    res.json({ ...plan, storeCheck, storeName: store?.name ?? null })
  })
}
