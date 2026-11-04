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
/** 改专属号时同时查几个 SKU（getListingsItem 限速每秒 5 次，429 会自动等） */
const MARK_CHECK_CONCURRENCY = 4

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
    // 新 SKU 逐个到店铺里查有没有重名（2026-11-04 用户反馈预览太慢：原来强制重扫整个店铺，焕捷要 40 秒）；
    // 一批几十个 SKU，几个同时查，几秒就好，而且查的是店里这一刻的情况。没填凭证时只查本地，界面上写明
    const storeSkus = new Set<string>()
    let checked: Set<string> | undefined
    // ok = 查过店铺；noCredentials = 没填凭证，只查了本地
    let storeCheck: 'ok' | 'noCredentials' | 'truncated' = 'noCredentials'
    if (store?.spapi.refreshToken && store.spapi.sellerId) {
      const nexts = ctx.scheduler.markTargets(folder, b.mark)
      const client = ctx.parent.spapis.for(store.id)
      try {
        let i = 0
        const worker = async () => {
          while (i < nexts.length) {
            const sku = nexts[i++]!
            if (await client.exists(sku)) storeSkus.add(sku.toLowerCase())
          }
        }
        await Promise.all(Array.from({ length: Math.min(MARK_CHECK_CONCURRENCY, nexts.length) }, worker))
      } catch (e) {
        throw new HttpError(502, `查不了「${store.name}」店铺里有没有重名的 SKU，先不改。检查网络或店铺凭证后再试：${(e as Error).message}`)
      }
      checked = new Set(nexts.map((x) => x.toLowerCase()))
      storeCheck = 'ok'
    }
    const plan = await ctx.scheduler.changeBatchMark(folder, b.mark, { apply: b.apply, storeSkus, checked })
    res.json({ ...plan, storeCheck, storeName: store?.name ?? null })
  })
}
