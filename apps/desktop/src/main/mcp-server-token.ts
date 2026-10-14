/**
 * Settings → MCP → Server token (#830): on request, hand the app's token for
 * the ZenNotes Server it is connected to over to zn and the MCP servers.
 *
 * The app keeps server tokens in the OS secret store, which an assistant's
 * MCP process cannot read, so until now the only way to give it one was
 * `zn connect <url> --no-default` in a terminal, typing the token a second
 * time. Sharing writes the entry `zn connect` would, in the same file. It is
 * opt-in because it moves the token out of the secret store into a file any
 * program running as the user can read.
 *
 * Everything works from the main process's own config: the renderer names no
 * server and never sees a token, only which state the file is in. The app
 * keeps receipts of what it wrote, so it only ever updates or removes a token
 * it put there itself: forgetting a server in the app takes its shared token
 * with it, and a token saved with `zn connect` is left alone.
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { McpServerTokenState } from '@shared/mcp-clients'
import { normalizeBaseUrl } from './remote/connection'
import {
  credentialsPath,
  inspectSavedServerToken,
  serverTokenKey,
  writeSavedServerToken
} from './remote/zn-credentials'

/** The server the app is set to (what both MCP servers follow), and the
 *  token the app connects to it with. */
export interface ServerTokenTarget {
  baseUrl: string
  token: string | null
}

export interface ServerTokenPaths {
  /** Where config.toml and zn's credentials.toml live. */
  configDir: string
  /** The app's record of the servers whose token it shared. */
  receiptsPath: string
}

async function readReceipts(file: string): Promise<Set<string>> {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8')) as {
      schemaVersion?: unknown
      servers?: unknown
    }
    if (data.schemaVersion !== 1 || !Array.isArray(data.servers)) return new Set()
    return new Set(data.servers.filter((key): key is string => typeof key === 'string'))
  } catch {
    return new Set()
  }
}

async function recordShare(paths: ServerTokenPaths, key: string, shared: boolean): Promise<void> {
  const receipts = await readReceipts(paths.receiptsPath)
  if (receipts.has(key) === shared) return
  if (shared) receipts.add(key)
  else receipts.delete(key)
  await fs.mkdir(path.dirname(paths.receiptsPath), { recursive: true })
  const temporary = `${paths.receiptsPath}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(
      temporary,
      JSON.stringify({ schemaVersion: 1, servers: [...receipts].sort() })
    )
    await fs.rename(temporary, paths.receiptsPath)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

export async function getServerTokenState(
  target: ServerTokenTarget | null,
  paths: ServerTokenPaths
): Promise<McpServerTokenState> {
  if (!target) return { kind: 'none', reason: 'local' }
  if (!target.token) return { kind: 'none', reason: 'no-token' }
  const serverUrl = normalizeBaseUrl(target.baseUrl)
  const where = { serverUrl, credentialsPath: credentialsPath(paths.configDir) }
  const saved = await inspectSavedServerToken(paths.configDir, serverUrl)
  if (saved.kind === 'unreadable') return { kind: 'unreadable', ...where, message: saved.message }
  if (saved.kind === 'none') return { kind: 'missing', ...where }
  return saved.token === target.token ? { kind: 'shared', ...where } : { kind: 'different', ...where }
}

/** Saves the app's token for its server where zn and both MCP servers look,
 *  replacing another token saved for the same server. */
export async function shareServerToken(
  target: ServerTokenTarget | null,
  paths: ServerTokenPaths
): Promise<McpServerTokenState> {
  if (target?.token) {
    const serverUrl = normalizeBaseUrl(target.baseUrl)
    await writeSavedServerToken(paths.configDir, serverUrl, target.token)
    await recordShare(paths, serverTokenKey(serverUrl), true)
  }
  return await getServerTokenState(target, paths)
}

/** Removes the saved token, but only while it is the app's: a different one
 *  for the same server was saved by the user and is theirs to remove. */
export async function removeServerToken(
  target: ServerTokenTarget | null,
  paths: ServerTokenPaths
): Promise<McpServerTokenState> {
  const state = await getServerTokenState(target, paths)
  if (state.kind === 'shared') {
    await writeSavedServerToken(paths.configDir, state.serverUrl, null)
    await recordShare(paths, serverTokenKey(state.serverUrl), false)
  }
  return await getServerTokenState(target, paths)
}

/**
 * Keeps a shared token in step with the app's: `next` is the server's new
 * token in the app, or null once the app has none for it (the token was
 * cleared, or the server forgotten). Only a token the app shared, and that
 * the file still holds unchanged, is replaced or removed. Anything else there
 * now was put by the user, so the app stops claiming it; a file that cannot
 * be read is left for the user to fix.
 */
export async function followAppServerToken(
  baseUrl: string,
  previous: string | null,
  next: string | null,
  paths: ServerTokenPaths
): Promise<void> {
  if (!previous || previous === next) return
  const serverUrl = normalizeBaseUrl(baseUrl)
  const key = serverTokenKey(serverUrl)
  if (!(await readReceipts(paths.receiptsPath)).has(key)) return
  const saved = await inspectSavedServerToken(paths.configDir, serverUrl)
  if (saved.kind === 'unreadable') return
  if (saved.kind === 'none' || saved.token !== previous) {
    await recordShare(paths, key, false)
    return
  }
  await writeSavedServerToken(paths.configDir, serverUrl, next)
  if (next === null) await recordShare(paths, key, false)
}
