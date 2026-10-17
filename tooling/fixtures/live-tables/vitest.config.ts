import { realpathSync } from 'node:fs'
import path from 'node:path'
import { mergeConfig } from 'vitest/config'
import base from '../../../packages/app-core/vitest.config'

// Worktrees may reuse the parent checkout's node_modules. Math/slash-command
// tests load WASM from that resolved directory; Vite must explicitly allow it.
const repo = path.resolve(__dirname, '../../..')
export default mergeConfig(base, {
  server: { fs: { allow: [repo, realpathSync(path.join(repo, 'node_modules'))] } }
})
