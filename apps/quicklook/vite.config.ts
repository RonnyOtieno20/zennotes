import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { zenNotesAssets } from '../../packages/app-core/build/vite.mjs'

/**
 * Typst math needs a 28 MB WebAssembly compiler and its own fonts, and it only
 * runs for someone who picked Typst as their math renderer. The preview always
 * typesets with KaTeX, so those asset URLs resolve to nothing here.
 */
function withoutTypstAssets(): Plugin {
  const empty = '\0zennotes-quicklook:empty-url'
  return {
    name: 'zennotes-quicklook-without-typst',
    enforce: 'pre',
    resolveId(id) {
      if (/^@myriaddreamin\/typst-ts-(web-compiler|renderer)\/wasm\?url$/.test(id)) return empty
      if (/\/typst-fonts\/[^/]+\.otf\?url$/.test(id)) return empty
      return null
    },
    load(id) {
      return id === empty ? 'export default ""' : null
    }
  }
}

// The Swift extension serves one generated page that loads quicklook.js and
// quicklook.css from its bundle; lazy chunks load relative to the entry.
export default defineConfig({
  root: __dirname,
  base: './',
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      // Any Markdown file can be previewed, including one that came from
      // somewhere else, so the plot renderers that evaluate expressions stay
      // out, as on public shares.
      { find: /^(jsxgraph|function-plot|@myriaddreamin\/typst\.ts)$/, replacement: resolve(__dirname, 'src/unavailable.ts') },
      { find: '@renderer', replacement: resolve(__dirname, '../../packages/app-core/src') },
      { find: '@shared', replacement: resolve(__dirname, '../../packages/shared-domain/src') },
      { find: '@bridge-contract', replacement: resolve(__dirname, '../../packages/bridge-contract/src') }
    ]
  },
  plugins: [react(), zenNotesAssets({ harper: false, excalidraw: false }), withoutTypstAssets()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 3500,
    sourcemap: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(__dirname, 'src/main.tsx'),
      output: {
        entryFileNames: 'quicklook.js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (info) =>
          info.name?.endsWith('.css') ? 'quicklook.css' : 'assets/[name]-[hash][extname]'
      }
    }
  }
})
