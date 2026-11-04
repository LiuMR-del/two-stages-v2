import type { Router } from 'express'
import { z } from 'zod'
import type { AppContext } from '../context'
import { maskSettings, SettingsError, SettingsPatchSchema } from '../store/settings'
import { HttpError, parseBody } from './util'
import { pingChat, pingModels } from '../ai/chatClient'
import { AiError, ERROR_LABEL } from '../ai/errors'

const TEST_TIMEOUT_MS = 10_000

export function registerSettings(r: Router, ctx: AppContext): void {
  r.get('/settings', (_req, res) => {
    res.json(maskSettings(ctx.settings.get()))
  })

  r.put('/settings', async (req, res) => {
    const patch = parseBody(SettingsPatchSchema, req.body)
    const next = await ctx.settings.update(patch).catch((e) => {
      throw e instanceof SettingsError ? new HttpError(400, e.message) : e
    })
    ctx.onSettingsSaved()
    res.json(maskSettings(next))
  })

  r.post('/settings/test', async (req, res) => {
    const { kind } = parseBody(z.object({ kind: z.enum(['image', 'analysis']) }), req.body)
    const s = ctx.settings.get()
    const api = kind === 'image' ? s.image : s.analysis
    if (!api.baseUrl || !api.apiKey) {
      res.json({ ok: false, message: '请先填写地址和 Key' })
      return
    }
    try {
      if (kind === 'analysis') {
        const model = await pingChat(s.analysis, TEST_TIMEOUT_MS)
        res.json({ ok: true, message: `连接成功，模型：${model}` })
      } else {
        const n = await pingModels(s.image, TEST_TIMEOUT_MS)
        res.json({ ok: true, message: n === null ? '连接成功' : `连接成功，可用模型 ${n} 个` })
      }
    } catch (e) {
      if (e instanceof AiError) {
        const msg = e.message === '请求超时' ? '连接超时（10 秒），请检查地址是否正确' : `${ERROR_LABEL[e.type]}：${e.message}`
        res.json({ ok: false, message: `连接失败：${msg}` })
      } else {
        res.json({ ok: false, message: `连接失败：${(e as Error).message}` })
      }
    }
  })
}
