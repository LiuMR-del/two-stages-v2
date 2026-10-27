import http from 'node:http'
import { randomBytes } from 'node:crypto'
import type { SettingsStore } from '../store/settings'
import { authorizeUrl, exchangeCode } from './feishu'
import { log } from '../util/log'
import { HttpError } from '../util/errors'

/**
 * 在已登录的飞书 App 里打开授权页（AppLink「在飞书内打开网页」），点一下「授权」就行，不用在浏览器里扫码登录。
 * 2026-10-27 用户选的方式；打不开时界面上还有浏览器打开的链接。
 */
export function appLinkFor(url: string): string {
  return `https://applink.feishu.cn/client/web_url/open?${new URLSearchParams({ mode: 'window', url })}`
}

/** lark-mcp 在应用后台登记的回调地址（2026-10-27 用户确认后台有这一条），授权时临时借用 */
export const LARK_REDIRECT = 'http://localhost:3000/callback'
const LARK_PORT = 3000
/** 授权页打开后这么久没回调就作废，临时端口也关掉 */
const WAIT_MS = 10 * 60_000

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font:16px -apple-system,'PingFang SC',sans-serif;padding:48px;color:#333"><h3>${esc(title)}</h3><p>${esc(text)}</p></body>`

/** 飞书 OAuth：发授权页地址、接回调、换 token。state 只在内存里，一次有效 */
export class FeishuOAuth {
  private states = new Map<string, { redirectUri: string; expires: number }>()
  private temp: http.Server[] = []
  private tempTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private settings: SettingsStore,
    private onAuthorized: () => void,
  ) {}

  /** selfBase：本服务的地址（如 http://127.0.0.1:3451），回调进本服务时用 */
  async start(selfBase: string): Promise<{ url: string; appUrl: string; redirectUri: string }> {
    const f = this.settings.get().parent.feishu
    if (!f.appId || !f.appSecret) throw new HttpError(400, '先填飞书应用的 App ID 和 App Secret')
    const redirectUri = f.redirect === 'lark3000' ? LARK_REDIRECT : `${selfBase}/api/feishu/callback`
    if (f.redirect === 'lark3000') await this.listenLark()
    const state = randomBytes(16).toString('hex')
    const now = Date.now()
    for (const [k, v] of this.states) if (v.expires < now) this.states.delete(k)
    this.states.set(state, { redirectUri, expires: now + WAIT_MS })
    const url = authorizeUrl(f, redirectUri, state)
    return { url, appUrl: appLinkFor(url), redirectUri }
  }

  /** 回调：返回给浏览器的页面 */
  async callback(q: Record<string, unknown>): Promise<{ status: number; html: string }> {
    const state = String(q.state ?? '')
    const entry = this.states.get(state)
    if (!entry || entry.expires < Date.now()) return { status: 400, html: page('授权没有完成', '这个授权链接已经失效，请回到工具的设置里重新点「授权飞书」。') }
    if (q.error || !q.code) {
      this.states.delete(state)
      return { status: 400, html: page('授权没有完成', `飞书没有给出授权（${String(q.error ?? '缺少 code')}），请回到设置里重新授权。`) }
    }
    this.states.delete(state)
    try {
      const user = await exchangeCode(this.settings, String(q.code), entry.redirectUri)
      log.info(`飞书授权成功${user ? `（${user}）` : ''}`)
      this.onAuthorized()
      return { status: 200, html: page('授权成功，可以关闭这个页面', `已用${user ? `「${user}」的` : '你的'}飞书账号授权，回到工具里就能读父体表了。`) }
    } catch (e) {
      log.warn(`飞书授权换 token 失败：${(e as Error).message}`)
      return { status: 500, html: page('授权没有完成', `换 token 失败：${(e as Error).message}。请回到设置里重新授权。`) }
    }
  }

  /** 临时在 3000 端口接收一次回调；localhost 可能解析成 127.0.0.1 或 ::1，两个都听 */
  private async listenLark(): Promise<void> {
    if (this.temp.length) {
      this.armTimer()
      return
    }
    const handler: http.RequestListener = (req, res) => {
      const u = new URL(req.url ?? '/', LARK_REDIRECT)
      if (u.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      void this.callback(Object.fromEntries(u.searchParams)).then((r) => {
        res.writeHead(r.status, { 'Content-Type': 'text/html; charset=utf-8' }).end(r.html)
        if (r.status === 200) this.closeLark()
      })
    }
    const listen = (host: string) =>
      new Promise<http.Server | null>((resolve, reject) => {
        const s = http.createServer(handler)
        // 本机没有 IPv6 才忽略 ::1；被占用（如 lark-mcp 按 localhost 只听了 ::1）要报出来，否则回调会落到别的程序上
        s.once('error', (e: NodeJS.ErrnoException) => (host === '::1' && (e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT') ? resolve(null) : reject(e)))
        s.listen(LARK_PORT, host, () => resolve(s))
      })
    const opened: http.Server[] = []
    try {
      opened.push((await listen('127.0.0.1'))!)
      const v6 = await listen('::1')
      if (v6) opened.push(v6)
      this.temp = opened
    } catch (e) {
      for (const s of opened) s.close()
      const code = (e as NodeJS.ErrnoException).code
      throw new HttpError(409, code === 'EADDRINUSE' ? '3000 端口被占用（可能 lark-mcp 正在登录），关掉它后再点「授权飞书」' : `3000 端口打不开：${(e as Error).message}`)
    }
    this.armTimer()
  }

  private armTimer(): void {
    if (this.tempTimer) clearTimeout(this.tempTimer)
    this.tempTimer = setTimeout(() => this.closeLark(), WAIT_MS)
  }

  closeLark(): void {
    if (this.tempTimer) clearTimeout(this.tempTimer)
    this.tempTimer = null
    for (const s of this.temp) {
      s.closeAllConnections?.()
      s.close()
    }
    this.temp = []
  }
}
