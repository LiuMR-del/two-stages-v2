type Handlers = {
  onEvent: (name: string, data: any) => void
  /** 首次连上和断线重连后都会调用：拉一次全量 */
  onOpen: () => void
  onStatus?: (connected: boolean) => void
}

const EVENTS = ['job', 'job-removed', 'queue', 'library', 'toast']

export function connectEvents(h: Handlers): () => void {
  let es: EventSource | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const open = () => {
    if (closed) return
    es = new EventSource('/api/events')
    es.onopen = () => {
      h.onStatus?.(true)
      h.onOpen()
    }
    es.onerror = () => {
      h.onStatus?.(false)
      es?.close()
      es = null
      if (!closed) retry = setTimeout(open, 2000)
    }
    for (const name of EVENTS) {
      es.addEventListener(name, (e) => {
        try {
          h.onEvent(name, JSON.parse((e as MessageEvent).data))
        } catch {
          // 坏数据直接丢掉，等下次全量
        }
      })
    }
  }
  open()
  return () => {
    closed = true
    if (retry) clearTimeout(retry)
    es?.close()
  }
}
