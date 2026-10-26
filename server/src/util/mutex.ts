export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(() => fn())
    this.tail = result.catch(() => undefined)
    return result
  }
}

export class KeyedMutex {
  private locks = new Map<string, Mutex>()

  run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    let m = this.locks.get(key)
    if (!m) {
      m = new Mutex()
      this.locks.set(key, m)
    }
    return m.run(fn)
  }
}
