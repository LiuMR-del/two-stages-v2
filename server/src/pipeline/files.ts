import fsp from 'node:fs/promises'
import path from 'node:path'
import { thumb } from '../image/process'
import { writeFileAtomic } from '../store/atomic'
import type { ImageInput } from '../ai/imageClient'

export const JOB_FILES = { pattern: 'pattern.png', main: 'main.png', blank: 'blank.png', face: 'face.png' } as const
export type JobFileKind = 'source' | keyof typeof JOB_FILES

const MIME_BY_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

export function mimeOf(file: string): string {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] ?? 'image/png'
}

export async function readInput(file: string, name: string): Promise<ImageInput> {
  return { buffer: await fsp.readFile(file), mime: mimeOf(file), filename: name + path.extname(file) }
}

/** 写任务目录里的产出和它的缩略图 */
export async function writeJobImage(dir: string, kind: JobFileKind, file: string, buf: Buffer): Promise<void> {
  await writeFileAtomic(path.join(dir, file), buf)
  await writeFileAtomic(path.join(dir, 'thumbs', `${kind}.webp`), await thumb(buf))
}

export async function removeJobImage(dir: string, kind: keyof typeof JOB_FILES): Promise<void> {
  await fsp.rm(path.join(dir, JOB_FILES[kind]), { force: true })
  await fsp.rm(path.join(dir, 'thumbs', `${kind}.webp`), { force: true })
}
