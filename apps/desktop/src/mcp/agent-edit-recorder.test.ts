import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentEditBaseline } from '@shared/agent-edits'
import { createBackend, type VaultBackend } from '../cli/backend'
import { readAgentEditRecord } from '../main/agent-edit-files'
import { callTool } from './server'

// Agent edit records written by the MCP tools (docs/ideas/agent-edit-review.md),
// run against a real folder through the local backend, so the record the app
// reviews is exactly what these write.

let root: string
let configDir: string
let backend: VaultBackend
const NOTE = 'inbox/Plan.md'
const previousConfigDir = process.env.ZENNOTES_CONFIG_DIR

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'zennotes-agent-edits-'))
  configDir = await mkdtemp(path.join(os.tmpdir(), 'zennotes-agent-edits-config-'))
  process.env.ZENNOTES_CONFIG_DIR = configDir
  await mkdir(path.join(root, 'inbox'), { recursive: true })
  await writeFile(path.join(root, NOTE), '# Plan\n\n- [ ] Ship the beta\nThe migration runs at night.\n')
  backend = createBackend({ kind: 'local', root })
})

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.ZENNOTES_CONFIG_DIR
  else process.env.ZENNOTES_CONFIG_DIR = previousConfigDir
  await rm(root, { recursive: true, force: true })
  await rm(configDir, { recursive: true, force: true })
})

const noteText = () => readFile(path.join(root, NOTE), 'utf8')

describe('recording assistant edits', () => {
  it('keeps the note from before an edit, and the note after it', async () => {
    const original = await noteText()
    await callTool('replace_in_note', { path: NOTE, find: 'at night', replace: 'on Sunday' }, backend)
    const record = await readAgentEditRecord(root, NOTE)
    expect(record).not.toBeNull()
    expect(record!.before).toBe(original)
    expect(record!.after).toBe(await noteText())
    expect(record!.edits.map((e) => [e.agent, e.tool])).toEqual([['Assistant', 'replace_in_note']])
    expect(agentEditBaseline(record!, await noteText())).toBe(original)
  })

  it('stacks every edit of a session onto one record', async () => {
    const original = await noteText()
    await callTool('append_to_note', { path: NOTE, text: 'A new line.' }, backend)
    await callTool('prepend_to_note', { path: NOTE, text: 'Top.' }, backend)
    await callTool('insert_at_line', { path: NOTE, lineNumber: 2, text: 'Inserted.' }, backend)
    await callTool('write_note', { path: NOTE, body: `${await noteText()}Written.\n` }, backend)
    const record = await readAgentEditRecord(root, NOTE)
    expect(record!.before).toBe(original)
    expect(record!.after).toBe(await noteText())
    expect(record!.edits.map((e) => e.tool)).toEqual([
      'append_to_note',
      'prepend_to_note',
      'insert_at_line',
      'write_note'
    ])
  })

  it('records a task toggled through its id', async () => {
    const original = await noteText()
    await callTool('toggle_task', { id: `${NOTE}#0` }, backend)
    expect(await noteText()).toContain('- [x] Ship the beta')
    const record = await readAgentEditRecord(root, NOTE)
    expect(record!.before).toBe(original)
    expect(record!.edits.map((e) => e.tool)).toEqual(['toggle_task'])
  })

  it('leaves no record when nothing changed', async () => {
    const result = (await callTool(
      'replace_in_note',
      { path: NOTE, find: 'nowhere in the note', replace: 'x' },
      backend
    )) as { replacements: number }
    expect(result.replacements).toBe(0)
    expect(await readAgentEditRecord(root, NOTE)).toBeNull()
    await expect(stat(path.join(root, '.zennotes', 'agent-edits'))).rejects.toThrow()
  })

  it('keeps an earlier record as it was when a later edit changes nothing', async () => {
    await callTool('append_to_note', { path: NOTE, text: 'First.' }, backend)
    const before = await readAgentEditRecord(root, NOTE)
    await callTool('replace_in_note', { path: NOTE, find: 'nowhere', replace: 'x' }, backend)
    expect(await readAgentEditRecord(root, NOTE)).toEqual(before)
  })

  it('records nothing for tools that only read', async () => {
    await callTool('read_note', { path: NOTE }, backend)
    await callTool('list_notes', {}, backend)
    expect(await readAgentEditRecord(root, NOTE)).toBeNull()
  })

  it('records nothing when Review agent edits is off', async () => {
    await writeFile(path.join(configDir, 'config.toml'), '[mcp]\nreview_agent_edits = false\n')
    await callTool('append_to_note', { path: NOTE, text: 'Unrecorded.' }, backend)
    expect(await noteText()).toContain('Unrecorded.')
    expect(await readAgentEditRecord(root, NOTE)).toBeNull()
  })

  it('takes concurrent edits to one note in turn, losing none', async () => {
    await Promise.all(
      ['one', 'two', 'three'].map((word) => callTool('append_to_note', { path: NOTE, text: word }, backend))
    )
    const record = await readAgentEditRecord(root, NOTE)
    expect(record!.edits).toHaveLength(3)
    expect(record!.after).toBe(await noteText())
  })
})

describe('writes into .zennotes', () => {
  it('are refused before a byte lands, so an assistant cannot plant a record', async () => {
    const forged = '.zennotes/agent-edits/inbox/Plan.md.json'
    await expect(callTool('write_note', { path: forged, body: '{}' }, backend)).rejects.toThrow(
      /Note not in a known folder/
    )
    await expect(stat(path.join(root, forged))).rejects.toThrow()
    const comments = '.zennotes/comments/inbox/Plan.md.comments.json'
    await expect(callTool('append_to_note', { path: comments, text: 'x' }, backend)).rejects.toThrow(
      /Note not in a known folder/
    )
  })
})
