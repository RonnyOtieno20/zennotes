import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwind from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import { realpathSync } from 'node:fs'
import preset from '../../../packages/app-core/build/tailwind-preset.cjs'
import { zenNotesAssets } from '../../../packages/app-core/build/vite.mjs'
const root = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(root, '../../..')
export default defineConfig({
  root,
  plugins: zenNotesAssets({ harper: false, excalidraw: false }),
  resolve: { alias: {
    '@shared': path.join(repo, 'packages/shared-domain/src'),
    '@bridge-contract': path.join(repo, 'packages/bridge-contract/src')
  } },
  css: { postcss: { plugins: [tailwind({
    presets: [preset],
    content: [path.join(root, '*.{html,ts}'), path.join(repo, 'packages/app-core/src/**/*.{ts,tsx}')]
  }), autoprefixer()] } },
  server: { host: '127.0.0.1', port: 5186, strictPort: true, fs: { allow: [repo, realpathSync(path.join(repo, 'node_modules'))] } }
})
