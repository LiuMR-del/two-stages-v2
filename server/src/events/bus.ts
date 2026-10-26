import { EventEmitter } from 'node:events'

export type ToastLevel = 'info' | 'warn' | 'error'

export type BusEvents = {
  job: { job: unknown }
  'job-removed': { id: string }
  queue: unknown
  library: { library: unknown; checks: unknown }
  toast: { level: ToastLevel; message: string }
  settings: { settings: unknown }
}

export type BusEventName = keyof BusEvents

export class Bus {
  private ee = new EventEmitter()

  constructor() {
    this.ee.setMaxListeners(0)
  }

  emit<K extends BusEventName>(name: K, payload: BusEvents[K]): void {
    this.ee.emit(name, payload)
  }

  on<K extends BusEventName>(name: K, fn: (payload: BusEvents[K]) => void): () => void {
    this.ee.on(name, fn)
    return () => this.ee.off(name, fn)
  }

  onAny(fn: (name: BusEventName, payload: unknown) => void): () => void {
    const names: BusEventName[] = ['job', 'job-removed', 'queue', 'library', 'toast', 'settings']
    const offs = names.map((n) => this.on(n, (p) => fn(n, p)))
    return () => offs.forEach((off) => off())
  }

  toast(level: ToastLevel, message: string): void {
    this.emit('toast', { level, message })
  }
}
