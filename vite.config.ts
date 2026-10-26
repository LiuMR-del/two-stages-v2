import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: path.join(root, 'web'),
  base: './',
  plugins: [vue()],
  build: {
    outDir: path.join(root, 'dist', 'web'),
    emptyOutDir: true,
  },
  server: {
    port: 5311,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.TS_PORT || 3311}`,
        changeOrigin: false,
      },
    },
  },
})
