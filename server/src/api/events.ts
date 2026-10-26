import type { Router } from 'express'
import type { AppContext } from '../context'

const PING_MS = 20_000

export function registerEvents(r: Router, ctx: AppContext): void {
  r.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(': connected\n\n')
    ctx.sse.clients++
    const off = ctx.bus.onAny((name, payload) => {
      if (name === 'settings') return
      res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)
    })
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS)
    req.on('close', () => {
      clearInterval(ping)
      off()
      ctx.sse.clients--
    })
  })
}
