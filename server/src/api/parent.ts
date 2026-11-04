import type { Router, Request } from 'express'
import { z } from 'zod'
import type { AppContext } from '../context'
import { HttpError, parseBody } from './util'
import { upload } from './library'
import { currentStore, maskSettings, MAX_RECENT_URLS, SettingsError, storeById, StoreCreateSchema, StorePatchSchema, type Store } from '../store/settings'
import { FeishuAuthError, FeishuError } from '../parent/feishu'
import { parseSpapiCredentials } from '../parent/credentials'
import { log } from '../util/log'
import type { StoreSnapshot } from '../parent/storeIndex'

/** 快照给界面看的概况 */
function summary(snap: StoreSnapshot | null) {
  if (!snap) return null
  const parents = snap.items.filter((x) => x.kind === 'parent')
  const types = new Map<string, number>()
  for (const x of parents) if (x.productType) types.set(x.productType, (types.get(x.productType) ?? 0) + 1)
  return {
    scannedAt: snap.scannedAt,
    items: snap.items.length,
    parents: parents.length,
    themed: parents.filter((x) => x.theme).length,
    truncated: snap.truncated,
    productTypes: [...types].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count })),
  }
}

/** 店铺设置的内容错误（缩写重了、删当前店铺）转成 400 */
async function settle<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof SettingsError) throw new HttpError(400, e.message)
    throw e
  }
}

/**
 * 父体匹配的设置接口：店铺档案的增删改、按店铺读表试试（飞书应用身份）、按店铺导入和测试 SP-API 凭证。
 * 对飞书和 SP-API 都只读。
 */
export function registerParent(r: Router, ctx: AppContext): void {
  const { settings } = ctx
  const p = ctx.parent
  const storeOf = (req: Request): Store => {
    const st = storeById(settings.get(), String(req.params.id))
    if (!st) throw new HttpError(404, '没有这个店铺')
    return st
  }

  r.post('/stores', async (req, res) => {
    const c = parseBody(StoreCreateSchema, req.body)
    const { settings: next, id } = await settle(() => settings.addStore(c))
    ctx.onSettingsSaved()
    log.info(`新增店铺「${c.name}」（${c.abbr}）`)
    res.json({ id, settings: maskSettings(next) })
  })

  r.patch('/stores/:id', async (req, res) => {
    const st = storeOf(req)
    const patch = parseBody(StorePatchSchema, req.body)
    const next = await settle(() => settings.updateStore(st.id, patch))
    ctx.onSettingsSaved()
    res.json(maskSettings(next))
  })

  r.delete('/stores/:id', async (req, res) => {
    const st = storeOf(req)
    const next = await settle(() => settings.removeStore(st.id))
    p.spapis.drop(st.id)
    p.index.clear(st.id)
    ctx.onSettingsSaved()
    log.info(`删除店铺「${st.name}」`)
    res.json(maskSettings(next))
  })

  /** 读一次这个店铺的父体表：表格名、所有标签页和每页的父体数量；顺便记进「用过的链接」和模版库下拉用的标签页 */
  r.post('/stores/:id/feishu/test', async (req, res) => {
    const st = storeOf(req)
    const b = parseBody(z.object({ url: z.string().optional() }), req.body ?? {})
    const url = (b.url ?? st.feishu.sheetUrl).trim()
    if (!url) throw new HttpError(400, '先填父体表链接')
    try {
      const info = await p.sheets.info(url, true)
      const tabs: { title: string; count: number; header: boolean; error?: string }[] = []
      for (const t of info.tabs) {
        try {
          const r2 = await p.sheets.rows(url, t.title, true, info)
          tabs.push({ title: t.title, count: r2?.rows?.length ?? 0, header: !!r2?.rows })
        } catch (e) {
          if (e instanceof FeishuAuthError) throw e
          tabs.push({ title: t.title, count: 0, header: false, error: (e as Error).message })
        }
      }
      await settle(() => settings.updateStoreRaw(st.id, (s2) => {
        s2.feishu.tabs = info.tabs.map((t) => t.title)
        s2.feishu.recentUrls = [{ url, title: info.title, usedAt: new Date().toISOString() }, ...s2.feishu.recentUrls.filter((x) => x.url !== url)].slice(0, MAX_RECENT_URLS)
      }))
      ctx.onSettingsSaved()
      res.json({ ok: true, title: info.title, tabs })
    } catch (e) {
      if (e instanceof FeishuAuthError) return void res.json({ ok: false, auth: true, message: e.message })
      if (e instanceof FeishuError) return void res.json({ ok: false, message: e.message.startsWith('这个链接') ? e.message : `这个链接读不了：${e.message}` })
      throw e
    }
  })

  /** 上传 RTF（或粘贴文字），取出店铺 ID、Client ID、Client Secret、Refresh Token，只写进这个店铺；不回显明文 */
  r.post('/stores/:id/spapi/import', upload.single('file'), async (req: Request, res) => {
    const st = storeOf(req)
    const f = req.file
    let text: string
    if (f) {
      // RTF 是纯 ASCII（中文写成 \'xx），按 latin1 读不会改字节
      text = f.buffer.subarray(0, 5).toString('latin1') === '{\\rtf' ? f.buffer.toString('latin1') : f.buffer.toString('utf8')
    } else {
      text = parseBody(z.object({ text: z.string().max(100_000) }), req.body).text
    }
    const c = parseSpapiCredentials(text)
    const found = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, !!v])) as Record<keyof typeof c, boolean>
    if (!Object.values(found).some(Boolean)) throw new HttpError(400, '没在文件里找到 SP-API 凭证（店铺 ID、Client ID、Client Secret、Refresh Token）')
    const patch = Object.fromEntries(Object.entries(c).filter(([, v]) => v)) as Record<string, string>
    await settle(() => settings.updateStore(st.id, { spapi: patch }))
    ctx.onSettingsSaved()
    log.info(`「${st.name}」导入 SP-API 凭证：${Object.entries(found).filter(([, v]) => v).map(([k]) => k).join('、')}`)
    res.json({ found, settings: maskSettings(settings.get()) })
  })

  /** 手动选父体时搜索用（当前店铺的父体表）：给了 tab 就返回这一页，不给就返回所有页 */
  r.get('/parent/rows', async (req, res) => {
    const url = currentStore(settings.get()).feishu.sheetUrl
    if (!url) throw new HttpError(400, '先在设置里给当前店铺填父体表链接')
    const tab = typeof req.query.tab === 'string' ? req.query.tab : ''
    try {
      const info = await p.sheets.info(url)
      const tabs = tab ? info.tabs.filter((t) => t.title === tab) : info.tabs
      const out: { tab: string; sku: string; asin: string; theme: string }[] = []
      const failed: { tab: string; message: string }[] = []
      for (const t of tabs) {
        try {
          const r2 = await p.sheets.rows(url, t.title, false, info)
          for (const row of r2?.rows ?? []) out.push({ tab: t.title, sku: row.sku, asin: row.asin, theme: row.theme })
        } catch (e) {
          failed.push({ tab: t.title, message: (e as Error).message })
        }
      }
      res.json({ title: info.title, rows: out, failed })
    } catch (e) {
      if (e instanceof FeishuError || e instanceof FeishuAuthError) throw new HttpError(502, e.message)
      throw e
    }
  })

  /** 店铺商品快照的情况（只看缓存，不发请求） */
  r.get('/stores/:id/scan', (req, res) => {
    const st = storeOf(req)
    res.json({ scanning: p.index.scanning(st.id), snapshot: summary(p.index.peek(st.id)) })
  })

  /** 重新扫描店铺商品（不管缓存）：只读，按创建日期分段翻完 */
  r.post('/stores/:id/scan', async (req, res) => {
    const st = storeOf(req)
    try {
      const snap = await p.index.get(st.id, { force: true })
      res.json({ ok: true, snapshot: summary(snap) })
    } catch (e) {
      res.json({ ok: false, message: `扫描失败：${(e as Error).message}` })
    }
  })

  r.post('/stores/:id/spapi/test', async (req, res) => {
    const st = storeOf(req)
    res.json(await p.spapis.for(st.id).test())
  })
}
