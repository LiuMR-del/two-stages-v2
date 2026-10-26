import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [path.join(root, 'server', 'src', 'index.ts')],
  outfile: path.join(root, 'dist', 'server.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['sharp'],
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
})
