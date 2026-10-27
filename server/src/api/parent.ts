import type { Router, Request } from 'express'
import { z } from 'zod'
import type { AppContext } from '../context'
import { HttpError, parseBody } from './util'
import { upload } from './library'
import { maskSettings, MAX_RECENT_URLS } from '../store/settings'
import { FeishuAuthError, FeishuError } from '../parent/feishu'
import { parseSpapiCredentials } from '../parent/credentials'
import { log } from '../util/log'

/** 父体匹配的设置接口：读表试试（飞书应用身份）、SP-API 凭证导入和测试。对飞书和 SP-API 都只读 */
export function registerParent(r: Router, ctx: AppContext): void {
  const { settings } = ctx
  const p = ctx.parent

  /** 读一次链接：表格名、所有标签页和每页的父体数量；顺便记进「用过的链接」和模版库下拉用的标签页 */
  r.post('/settings/parent/test', async (req, res) => {
    const b = parseBody(z.object({ url: z.string().optional() }), req.body ?? {})
    const url = (b.url ?? settings.get().parent.sheetUrl).trim()
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
      await settings.updateParent((pp) => {
        pp.tabs = info.tabs.map((t) => t.title)
        pp.recentUrls = [{ url, title: info.title, usedAt: new Date().toISOString() }, ...pp.recentUrls.filter((x) => x.url !== url)].slice(0, MAX_RECENT_URLS)
      })
      ctx.onSettingsSaved()
      res.json({ ok: true, title: info.title, tabs })
    } catch (e) {
      if (e instanceof FeishuAuthError) return void res.json({ ok: false, auth: true, message: e.message })
      if (e instanceof FeishuError) return void res.json({ ok: false, message: e.message.startsWith('这个链接') ? e.message : `这个链接读不了：${e.message}` })
      throw e
    }
  })

  /** 上传 RTF（或粘贴文字），取出店铺 ID、Client ID、Client Secret、Refresh Token；不回显明文 */
  r.post('/settings/spapi/import', upload.single('file'), async (req: Request, res) => {
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
    await settings.update({ parent: { spapi: patch } })
    ctx.onSettingsSaved()
    log.info(`导入 SP-API 凭证：${Object.entries(found).filter(([, v]) => v).map(([k]) => k).join('、')}`)
    res.json({ found, settings: maskSettings(settings.get()) })
  })

  r.post('/settings/spapi/test', async (_req, res) => {
    res.json(await p.spapi.test())
  })
}
