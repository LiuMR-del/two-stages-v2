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
    // 只在输出文件夹里改（2026-11-04 用户要求「直接在文件夹里面改就行」）：不去店铺查重，
    // 只查本地——文件夹里已有的、今天发过的号、队列里别的图、批内重名，都是毫秒级
    const plan = await ctx.scheduler.changeBatchMark(folder, b.mark, { apply: b.apply, storeSkus: new Set() })
    res.json(plan)
  })
}
