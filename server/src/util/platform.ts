import { execFile, spawn } from 'node:child_process'
import { log } from './log'

function launch(cmd: string, args: string[]): void {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', (e) => log.warn(`无法执行 ${cmd}：${e.message}`))
    child.unref()
  } catch (e) {
    log.warn(`无法执行 ${cmd}：${(e as Error).message}`)
  }
}

export function openFolder(dir: string): void {
  if (process.platform === 'darwin') launch('open', [dir])
  else if (process.platform === 'win32') launch('explorer.exe', [dir])
  else launch('xdg-open', [dir])
}

export function openBrowser(url: string): void {
  if (process.platform === 'darwin') launch('open', [url])
  else if (process.platform === 'win32') launch('cmd', ['/c', 'start', '""', url])
  else launch('xdg-open', [url])
}

const MAC_CLIPBOARD_FILES = `ObjC.import('AppKit')
const opts = $.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), $.NSPasteboardURLReadingFileURLsOnlyKey)
const urls = $.NSPasteboard.generalPasteboard.readObjectsForClassesOptions($.NSArray.arrayWithObject($.NSURL), opts)
const out = []
if (urls) for (let i = 0; i < urls.count; i++) out.push(urls.objectAtIndex(i).path.js)
JSON.stringify(out)`

const WIN_CLIPBOARD_FILES =
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }'

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })
}

/**
 * 在访达/资源管理器里复制的文件，浏览器粘贴时只拿得到文件图标，拿不到文件本身；
 * 服务就跑在这台电脑上，直接读系统剪贴板里的文件路径。不支持的系统返回 null。
 */
export async function readClipboardFiles(): Promise<string[] | null> {
  if (process.platform === 'darwin') {
    const out = await run('osascript', ['-l', 'JavaScript', '-e', MAC_CLIPBOARD_FILES])
    return JSON.parse(out.trim() || '[]') as string[]
  }
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', ['-NoProfile', '-STA', '-Command', WIN_CLIPBOARD_FILES])
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  }
  return null
}
