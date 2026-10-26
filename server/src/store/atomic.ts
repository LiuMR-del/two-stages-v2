import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      // Windows 上目标文件被杀毒软件或索引服务短暂占用时会报这两种错
      if ((code === 'EPERM' || code === 'EBUSY') && i < 5) {
        await sleep(50)
        continue
      }
      throw e
    }
  }
}

export async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`
  const fh = await fsp.open(tmp, 'w')
  try {
    await fh.writeFile(data)
    await fh.sync()
  } finally {
    await fh.close()
  }
  try {
    await renameWithRetry(tmp, file)
  } catch (e) {
    await fsp.rm(tmp, { force: true })
    throw e
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(value, null, 2))
}

export function readJsonSync<T = unknown>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}
