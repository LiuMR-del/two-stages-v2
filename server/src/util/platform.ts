import { spawn } from 'node:child_process'
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
