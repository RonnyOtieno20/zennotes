import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendToNote, insertAtLine, prependToNote, replaceInNote, writeNote } from './vault-ops'

// The edits an assistant makes through MCP used to write the file and check
// afterwards that it was a note, so `write_note` on `.zennotes/...` created
// the file and only then failed. These pin the order: nothing outside the note
// folders is written, and a real note still is.

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'zennotes-mcp-write-guard-'))
  await mkdir(path.join(root, 'inbox'), { recursive: true })
  await mkdir(path.join(root, '.zennotes', 'comments', 'inbox'), { recursive: true })
  await writeFile(path.join(root, 'inbox', 'Plan.md'), '# Plan\n')
  await writeFile(path.join(root, '.zennotes', 'comments', 'inbox', 'Plan.md.comments.json'), '[]\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const exists = (rel: string): Promise<boolean> =>
  stat(path.join(root, rel)).then(
    () => true,
    () => false
  )

describe('MCP edits outside the note folders', () => {
  it('write_note refuses a .zennotes path before creating the file', async () => {
    const forged = '.zennotes/agent-edits/inbox/Plan.md.json'
    await expect(writeNote(root, forged, '{}')).rejects.toThrow(/Note not in a known folder/)
    expect(await exists(forged)).toBe(false)
    expect(await readdir(path.join(root, '.zennotes'))).toEqual(['comments'])
  })

  it('the other edits refuse an internal file and leave it as it was', async () => {
    const comments = '.zennotes/comments/inbox/Plan.md.comments.json'
    await expect(appendToNote(root, comments, 'x')).rejects.toThrow(/Note not in a known folder/)
    await expect(prependToNote(root, comments, 'x')).rejects.toThrow(/Note not in a known folder/)
    await expect(insertAtLine(root, comments, 0, 'x')).rejects.toThrow(/Note not in a known folder/)
    await expect(replaceInNote(root, comments, '[]', 'x')).rejects.toThrow(/Note not in a known folder/)
    expect(await readFile(path.join(root, comments), 'utf8')).toBe('[]\n')
  })

  it('still writes a note, new or existing', async () => {
    await writeNote(root, 'inbox/New.md', '# New\n')
    expect(await exists('inbox/New.md')).toBe(true)
    await appendToNote(root, 'inbox/Plan.md', 'More.')
    expect(await readFile(path.join(root, 'inbox', 'Plan.md'), 'utf8')).toContain('More.')
  })
})
