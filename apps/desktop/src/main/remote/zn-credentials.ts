/**
 * zn's server-token store: credentials.toml beside config.toml (#830).
 *
 * The Go zn owns the format (ZenNotes/tui, internal/config/workspaces.go): a
 * private file with one `[tokens]` table keyed by the server URL trimmed,
 * without trailing slashes, and lowercased. `zn connect` writes it, both MCP
 * servers read it when they follow the app to a server, and Settings → MCP
 * writes the app's own token there when the user asks. Every writer keeps
 * zn's rules: the other tokens survive, the file stays private, and a file
 * that cannot be read as that format is never replaced, because the tokens in
 * it would be lost.
 *
 * Plain Node on purpose: the bundled MCP server imports this, and it runs
 * without Electron.
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'

const HEADER = '# Server tokens for zn, keyed by URL. Keep this file private.\n'

export function credentialsPath(configDir: string): string {
  return path.join(configDir, 'credentials.toml')
}

/** zn's key for a server: the URL trimmed, without trailing slashes, lowercased. */
export function serverTokenKey(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').toLowerCase()
}

/** The file exists but is not zn's format, so nothing may overwrite it. The
 *  message never quotes the file: any line of it can be a token. */
export class UnreadableCredentialsError extends Error {
  constructor(filePath: string, reason: string) {
    super(`${filePath} ${reason} Fix or move it, then try again.`)
    this.name = 'UnreadableCredentialsError'
  }
}

interface CredentialsFile {
  /** Everything the file holds, so a rewrite keeps keys a later zn may add. */
  document: Record<string, unknown>
  tokens: Record<string, string>
}

async function readCredentialsFile(configDir: string): Promise<CredentialsFile> {
  const filePath = credentialsPath(configDir)
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { document: {}, tokens: {} }
    throw new UnreadableCredentialsError(filePath, 'could not be read.')
  }
  let document: Record<string, unknown>
  try {
    document = parseToml(raw) as Record<string, unknown>
  } catch {
    throw new UnreadableCredentialsError(filePath, 'is not valid TOML.')
  }
  const table = document.tokens ?? {}
  if (typeof table !== 'object' || table === null || Array.isArray(table)) {
    throw new UnreadableCredentialsError(filePath, 'has no [tokens] table.')
  }
  const tokens: Record<string, string> = {}
  for (const [key, value] of Object.entries(table)) {
    // zn decodes the table as strings and refuses the file otherwise.
    if (typeof value !== 'string') {
      throw new UnreadableCredentialsError(filePath, 'holds a token that is not a string.')
    }
    tokens[key] = value
  }
  return { document, tokens }
}

/** What the file says about one server, for a caller that must not guess. */
export type SavedServerToken =
  | { kind: 'none' }
  | { kind: 'saved'; token: string }
  | { kind: 'unreadable'; message: string }

export async function inspectSavedServerToken(
  configDir: string,
  baseUrl: string
): Promise<SavedServerToken> {
  try {
    const token = (await readCredentialsFile(configDir)).tokens[serverTokenKey(baseUrl)]?.trim()
    return token ? { kind: 'saved', token } : { kind: 'none' }
  } catch (err) {
    if (err instanceof UnreadableCredentialsError) return { kind: 'unreadable', message: err.message }
    throw err
  }
}

/** The token saved for a server, or null. A file that cannot be read holds
 *  none, as it does for zn. */
export async function readSavedServerToken(
  configDir: string,
  baseUrl: string
): Promise<string | null> {
  try {
    const saved = await inspectSavedServerToken(configDir, baseUrl)
    return saved.kind === 'saved' ? saved.token : null
  } catch {
    return null
  }
}

/**
 * Saves one server's token, or with null removes it, keeping every other
 * token. The new file is written privately beside the old one and renamed
 * over it, so a reader never sees half a file and the result is 0600 whatever
 * the old file's mode was. Throws UnreadableCredentialsError rather than
 * replace a file it could not read.
 */
export async function writeSavedServerToken(
  configDir: string,
  baseUrl: string,
  token: string | null
): Promise<void> {
  const { document, tokens } = await readCredentialsFile(configDir)
  const key = serverTokenKey(baseUrl)
  if (token === null) {
    if (!(key in tokens)) return
    delete tokens[key]
  } else {
    tokens[key] = token.trim()
  }
  const body = stringifyToml({ ...document, tokens })
  const target = credentialsPath(configDir)
  await fs.mkdir(configDir, { recursive: true })
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${HEADER}${body.endsWith('\n') ? body : `${body}\n`}`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(temporary, target)
  } catch (err) {
    await fs.rm(temporary, { force: true })
    throw err
  }
  await fs.chmod(target, 0o600).catch(() => {})
}
