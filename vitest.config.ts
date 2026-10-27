import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  // 前端组件测试用服务端渲染，不需要浏览器
  plugins: [vue()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: true,
    env: {
      TS_RETRY_SCALE: '0.001',
    },
  },
})
