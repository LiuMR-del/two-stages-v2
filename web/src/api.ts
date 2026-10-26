export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

async function handle<T>(r: Response): Promise<T> {
  const text = await r.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!r.ok) throw new ApiError(r.status, body?.error ?? `请求失败（HTTP ${r.status}）`)
  return body as T
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response
  try {
    r = await fetch('/api' + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, '连不上本机服务，请确认启动窗口还开着')
  }
  return handle<T>(r)
}

export const api = {
  get: <T = any>(p: string) => call<T>('GET', p),
  post: <T = any>(p: string, b: unknown = {}) => call<T>('POST', p, b),
  put: <T = any>(p: string, b: unknown = {}) => call<T>('PUT', p, b),
  patch: <T = any>(p: string, b: unknown = {}) => call<T>('PATCH', p, b),
  del: <T = any>(p: string) => call<T>('DELETE', p),
  async upload<T = any>(method: 'PUT' | 'POST', p: string, field: string, files: File[] | File, onProgress?: (ratio: number) => void): Promise<T> {
    const list = Array.isArray(files) ? files : [files]
    const form = new FormData()
    for (const f of list) form.append(field, f, f.name)
    if (!onProgress) {
      let r: Response
      try {
        r = await fetch('/api' + p, { method, body: form })
      } catch {
        throw new ApiError(0, '连不上本机服务，请确认启动窗口还开着')
      }
      return handle<T>(r)
    }
    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open(method, '/api' + p)
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
      xhr.onload = () => {
        handle<T>(new Response(xhr.responseText, { status: xhr.status })).then(resolve, reject)
      }
      xhr.onerror = () => reject(new ApiError(0, '连不上本机服务，请确认启动窗口还开着'))
      xhr.send(form)
    })
  },
}

export const imageUrl = (hash: string, thumb = true) => `/api/library/images/${hash}${thumb ? '?size=thumb' : ''}`
