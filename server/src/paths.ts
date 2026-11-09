import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const PACKAGE_NAME = 'two-stages'

export type Paths = {
  toolDir: string
  libraryDir: string
  libraryImagesDir: string
  libraryThumbsDir: string
  libraryBackupsDir: string
  libraryFile: string
  librarySeedFile: string
  dataDir: string
  jobsDir: string
  logsDir: string
  settingsFile: string
  serverFile: string
  webDir: string
}

function isToolDir(dir: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    return pkg?.name === PACKAGE_NAME
  } catch {
    return false
  }
}

function walkUp(start: string): string | null {
  let dir = path.resolve(start)
  for (;;) {
    if (isToolDir(dir)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function findToolDir(): string {
  if (process.env.TS_TOOL_DIR) return path.resolve(process.env.TS_TOOL_DIR)
  const starts = [process.argv[1] ? path.dirname(process.argv[1]) : null, process.cwd()]
  for (const s of starts) {
    if (!s) continue
    const found = walkUp(s)
    if (found) return found
  }
  return process.cwd()
}

export function resolvePaths(overrides: Partial<{ toolDir: string; libraryDir: string; dataDir: string }> = {}): Paths {
  const toolDir = overrides.toolDir ?? findToolDir()
  const libraryDir = path.resolve(overrides.libraryDir ?? process.env.TS_LIBRARY_DIR ?? path.join(toolDir, 'library'))
  const dataDir = path.resolve(overrides.dataDir ?? process.env.TS_DATA_DIR ?? path.join(toolDir, 'data'))
  return {
    toolDir,
    libraryDir,
    libraryImagesDir: path.join(libraryDir, 'images'),
    libraryThumbsDir: path.join(libraryDir, 'images', 'thumbs'),
    libraryBackupsDir: path.join(libraryDir, 'backups'),
    libraryFile: path.join(libraryDir, 'library.json'),
    librarySeedFile: path.join(libraryDir, 'seed.json'),
    dataDir,
    jobsDir: path.join(dataDir, 'jobs'),
    logsDir: path.join(dataDir, 'logs'),
    settingsFile: path.join(dataDir, 'settings.json'),
    serverFile: path.join(dataDir, 'server.json'),
    webDir: path.join(toolDir, 'dist', 'web'),
  }
}

export function ensureDirs(p: Paths): void {
  for (const d of [p.libraryDir, p.libraryImagesDir, p.libraryThumbsDir, p.dataDir, p.jobsDir, p.logsDir]) {
    fs.mkdirSync(d, { recursive: true })
  }
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}
