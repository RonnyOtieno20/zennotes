import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBackend } from '../backend'
import type { ParsedArgs } from '../args'
import { cmdTaskList } from './tasks'

function makeArgs(flags: Array<[string, string]> = []): ParsedArgs {
  const map = new Map<string, string[]>()
  for (const [k, v] of flags) map.set(k, [...(map.get(k) ?? []), v])
  return { positionals: [], flags: map }
}

let tmpDir: string
let root: string
let out: string[]

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-task-cli-'))
  root = path.join(tmpDir, 'vault')
  for (const d of ['inbox', 'quick', 'archive', 'trash']) {
    await fsp.mkdir(path.join(root, d), { recursive: true })
  }
  await fsp.writeFile(
    path.join(root, 'inbox', 'todo.md'),
    '- [ ] Buy milk\n- [-] Cancelled plan\n- [x] Done thing\n'
  )
})

afterAll(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  out = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk))
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

const backend = (): ReturnType<typeof createBackend> => createBackend({ kind: 'local', root })
const listed = (): string[] =>
  (JSON.parse(out.join('')) as Array<{ content: string }>).map((t) => t.content)

describe('zn task list', () => {
  it('leaves `[-]` cancelled tasks out of the open list (#450, #476)', async () => {
    await cmdTaskList(backend(), makeArgs([['json', 'true']]))
    expect(listed()).toEqual(['Buy milk'])
  })

  it('leaves cancelled tasks out of --unchecked', async () => {
    await cmdTaskList(backend(), makeArgs([['unchecked', 'true'], ['json', 'true']]))
    expect(listed()).toEqual(['Buy milk'])
  })

  it('still lists cancelled tasks with --all', async () => {
    await cmdTaskList(backend(), makeArgs([['all', 'true'], ['json', 'true']]))
    expect(listed()).toContain('Cancelled plan')
  })
})
