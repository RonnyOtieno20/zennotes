// Agent edit records on disk: `.zennotes/agent-edits/<note>.json`, one per
// note an assistant changed through MCP and nobody has reviewed yet (see
// @shared/agent-edits and docs/ideas/agent-edit-review.md). The MCP server
// writes them and the app reviews them, and the MCP server cannot import
// vault.ts (it pulls in Electron), so this stays free of Electron like
// note-sidecars.ts.
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  AGENT_EDITS_DIR,
  AGENT_EDITS_SUFFIX,
  latestAgentEdit,
  parseAgentEditRecord,
  serializeAgentEditRecord,
  type AgentEditRecord
} from '@shared/agent-edits'
import type { AgentEditSummary } from '@shared/ipc'
import { renameWithRetry } from './atomic-write'

const INTERNAL_VAULT_DIR = '.zennotes'

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/')
}

export function agentEditsRoot(root: string): string {
  return path.join(root, INTERNAL_VAULT_DIR, AGENT_EDITS_DIR)
}

/** The record file for a vault-relative note path, refusing any escape. */
export function agentEditPath(root: string, rel: string): string {
  const base = path.resolve(agentEditsRoot(root))
  const abs = path.resolve(base, `${toPosix(rel)}${AGENT_EDITS_SUFFIX}`)
  if (!abs.startsWith(base + path.sep)) throw new Error(`Path escapes the vault: ${rel}`)
  return abs
}

/** The note's record, or null when there is none or it is not readable. */
export async function readAgentEditRecord(root: string, rel: string): Promise<AgentEditRecord | null> {
  try {
    return parseAgentEditRecord(JSON.parse(await fs.readFile(agentEditPath(root, rel), 'utf8')))
  } catch {
    return null
  }
}

/** Write the record (temp file, fsync, rename), or remove it for `null`. */
export async function writeAgentEditRecord(
  root: string,
  rel: string,
  record: AgentEditRecord | null
): Promise<void> {
  const file = agentEditPath(root, rel)
  if (record === null) {
    await removeAgentEditFile(root, file)
    return
  }
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await fs.open(temporary, 'wx')
    try {
      await handle.writeFile(serializeAgentEditRecord(record))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await renameWithRetry(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

/** The folder holding the records of every note under `folderRel`, for
 *  moving or deleting a whole folder with its notes. */
export function agentEditFolderPath(root: string, folderRel: string): string {
  const base = path.resolve(agentEditsRoot(root))
  const abs = path.resolve(base, toPosix(folderRel))
  if (!abs.startsWith(base + path.sep)) throw new Error(`Path escapes the vault: ${folderRel}`)
  return abs
}

/** Remove a note's record, or with `directory` every record under a folder:
 *  a deleted note has nothing left to review. */
export async function removeAgentEditRecord(
  root: string,
  rel: string,
  directory = false
): Promise<void> {
  if (!directory) {
    await removeAgentEditFile(root, agentEditPath(root, rel))
    return
  }
  const folder = agentEditFolderPath(root, rel)
  await fs.rm(folder, { recursive: true, force: true })
  await pruneEmptyDirs(root, path.dirname(folder))
}

async function removeAgentEditFile(root: string, file: string): Promise<void> {
  await fs.rm(file, { force: true })
  await pruneEmptyDirs(root, path.dirname(file))
}

/** Leave no empty folders behind, agent-edits itself included: a vault whose
 *  changes have all been reviewed carries no trace of them. */
async function pruneEmptyDirs(root: string, from: string): Promise<void> {
  const stop = path.resolve(agentEditsRoot(root))
  for (let dir = path.resolve(from); dir === stop || dir.startsWith(stop + path.sep); dir = path.dirname(dir)) {
    try {
      await fs.rmdir(dir)
    } catch {
      break
    }
  }
}

/** Every record in the vault, newest edit first. Unreadable files are skipped. */
export async function listAgentEditRecords(root: string): Promise<AgentEditSummary[]> {
  const base = agentEditsRoot(root)
  const found: AgentEditSummary[] = []
  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(AGENT_EDITS_SUFFIX)) continue
      const notePath = toPosix(path.relative(base, abs)).slice(0, -AGENT_EDITS_SUFFIX.length)
      let record: AgentEditRecord | null = null
      try {
        record = parseAgentEditRecord(JSON.parse(await fs.readFile(abs, 'utf8')))
      } catch {
        record = null
      }
      if (!record) continue
      const latest = latestAgentEdit(record)
      found.push({
        notePath,
        agent: latest?.agent ?? 'Assistant',
        at: latest?.at ?? 0,
        edits: record.edits.length
      })
    }
  }
  await walk(base)
  return found.sort((a, b) => b.at - a.at)
}
