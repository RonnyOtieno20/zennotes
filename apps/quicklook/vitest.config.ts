import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      { find: '@renderer', replacement: resolve(__dirname, '../../packages/app-core/src') },
      { find: '@shared', replacement: resolve(__dirname, '../../packages/shared-domain/src') },
      { find: '@bridge-contract', replacement: resolve(__dirname, '../../packages/bridge-contract/src') }
    ]
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
