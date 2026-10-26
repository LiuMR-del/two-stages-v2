import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

export function tmpDir(prefix = 'ts-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

export async function png(w: number, h: number, rgb = { r: 200, g: 60, b: 60 }): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: rgb } }).png().toBuffer()
}

export async function jpeg(w: number, h: number, rgb = { r: 60, g: 120, b: 200 }): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: rgb } }).jpeg().toBuffer()
}

/** 噪点图：PNG 压不下去，用来测按字节压缩 */
export async function noisyPng(w: number, h: number): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3)
  let x = 12345
  for (let i = 0; i < raw.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    raw[i] = x >> 16
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer()
}

export async function size(buf: Buffer): Promise<[number, number]> {
  const m = await sharp(buf).metadata()
  return [m.width!, m.height!]
}

export async function waitFor<T>(fn: () => T | Promise<T>, opts: { timeout?: number; interval?: number; label?: string } = {}): Promise<NonNullable<T>> {
  const timeout = opts.timeout ?? 20_000
  const start = Date.now()
  let last: unknown
  for (;;) {
    try {
      const v = await fn()
      if (v) return v as NonNullable<T>
    } catch (e) {
      last = e
    }
    if (Date.now() - start > timeout) {
      throw new Error(`等待超时：${opts.label ?? ''} ${last ? String(last) : ''}`)
    }
    await new Promise((r) => setTimeout(r, opts.interval ?? 50))
  }
}
