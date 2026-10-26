// 同时启动后端（tsx watch）和前端（vite），不依赖 shell，Mac / Windows 通用
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bin = (...p) => path.join(root, 'node_modules', ...p)

const env = { ...process.env, TS_NO_BROWSER: '1', TS_NO_AUTOEXIT: '1' }
const children = [
  spawn(process.execPath, [bin('tsx', 'dist', 'cli.mjs'), 'watch', path.join(root, 'server', 'src', 'index.ts')], { cwd: root, env, stdio: 'inherit' }),
  spawn(process.execPath, [bin('vite', 'bin', 'vite.js'), ...(process.env.TS_NO_BROWSER ? [] : ['--open'])], { cwd: root, env: process.env, stdio: 'inherit' }),
]

const stop = () => {
  for (const c of children) c.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
for (const c of children) c.on('exit', (code) => code && stop())
