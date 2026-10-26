import fs from 'node:fs'
import path from 'node:path'
import { localDay } from './ids'

type Level = 'info' | 'warn' | 'error'

const KEEP_DAYS = 14
let logsDir: string | null = null
let quiet = false
const secrets = new Set<string>()

export function initLog(dir: string, opts: { quiet?: boolean } = {}): void {
  logsDir = dir
  quiet = !!opts.quiet
  fs.mkdirSync(dir, { recursive: true })
  pruneOldLogs()
}

export function registerSecret(s: string | undefined | null): void {
  if (s && s.length >= 6) secrets.add(s)
}

export function redact(text: string): string {
  let out = text
  for (const s of secrets) out = out.split(s).join('***')
  out = out.replace(/Bearer\s+[^\s"',]+/gi, 'Bearer ***')
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
  out = out.replace(/data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+/g, '<base64 已省略>')
  out = out.replace(/[A-Za-z0-9+/]{200,}={0,2}/g, '<base64 已省略>')
  return out
}

function pruneOldLogs(): void {
  if (!logsDir) return
  const cutoff = Date.now() - KEEP_DAYS * 86400_000
  for (const name of fs.readdirSync(logsDir)) {
    const m = /^(\d{4}-\d{2}-\d{2})\.log$/.exec(name)
    if (!m) continue
    if (new Date(m[1] + 'T00:00:00').getTime() < cutoff) {
      fs.rmSync(path.join(logsDir, name), { force: true })
    }
  }
}

function write(level: Level, msg: string): void {
  const now = new Date()
  const line = `${now.toISOString()} [${level === 'info' ? '信息' : level === 'warn' ? '警告' : '错误'}] ${redact(msg)}`
  if (!quiet) {
    if (level === 'error') console.error(line)
    else console.log(line)
  }
  if (logsDir) {
    try {
      fs.appendFileSync(path.join(logsDir, `${localDay(now)}.log`), line + '\n')
    } catch {
      // 日志写失败不能影响主流程
    }
  }
}

export const log = {
  info: (msg: string) => write('info', msg),
  warn: (msg: string) => write('warn', msg),
  error: (msg: string) => write('error', msg),
}
