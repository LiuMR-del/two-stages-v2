import type { NextFunction, Request, Response } from 'express'
import type { z } from 'zod'
import { log } from '../util/log'

import { HttpError } from '../util/errors'

export { HttpError }

export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body ?? {})
  if (!r.success) {
    const detail = r.error.issues.map((i) => `${i.path.join('.') || '参数'}：${i.message}`).join('；')
    throw new HttpError(400, `参数不正确（${detail}）`)
  }
  return r.data
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message })
    return
  }
  const e = err as { type?: string; status?: number; code?: string; message?: string }
  if (e?.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: '文件太大，单个文件不能超过 50MB' })
    return
  }
  if (e?.type === 'entity.parse.failed') {
    res.status(400).json({ error: '请求内容不是合法的 JSON' })
    return
  }
  log.error(`接口出错：${e?.message ?? String(err)}`)
  res.status(500).json({ error: `服务内部错误：${e?.message ?? String(err)}` })
}
