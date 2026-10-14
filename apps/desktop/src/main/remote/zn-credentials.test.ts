import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  credentialsPath,
  inspectSavedServerToken,
  readSavedServerToken,
  serverTokenKey,
  UnreadableCredentialsError,
  writeSavedServerToken
} from './zn-credentials'

let configDir: string

beforeEach(async () => {
  configDir = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-creds-')), 'zennotes')
})

afterEach(async () => {
  await fsp.rm(path.dirname(configDir), { recursive: true, force: true })
})

/** The file exactly as `zn connect` writes it (BurntSushi/toml indents the
 *  table's quoted keys). */
async function writeAsZn(tokens: Record<string, string>): Promise<void> {
  await fsp.mkdir(configDir, { recursive: true })
  const lines = Object.entries(tokens).map(([url, token]) => `  "${url}" = "${token}"`)
  await fsp.writeFile(
    credentialsPath(configDir),
    ['# Server tokens for zn, keyed by URL. Keep this file private.', '[tokens]', ...lines, ''].join('\n'),
    { mode: 0o600 }
  )
}

describe('serverTokenKey', () => {
  it('keys a server the way zn does: trimmed, no trailing slashes, lowercased', () => {
    expect(serverTokenKey('  https://Notes.Example.com/Zen//  ')).toBe('https://notes.example.com/zen')
    expect(serverTokenKey('http://127.0.0.1:7878')).toBe('http://127.0.0.1:7878')
  })
})

describe('reading', () => {
  it('finds the token zn saved, however the URL is spelled', async () => {
    await writeAsZn({ 'https://notes.example.com/zen': 'saved' })
    expect(await readSavedServerToken(configDir, 'https://Notes.Example.com/Zen/')).toBe('saved')
    expect(await readSavedServerToken(configDir, 'https://notes.example.com')).toBeNull()
  })

  it('has no token without a file, and none in a file zn could not read either', async () => {
    expect(await readSavedServerToken(configDir, 'http://x:1')).toBeNull()
    await fsp.mkdir(configDir, { recursive: true })
    await fsp.writeFile(credentialsPath(configDir), '[tokens\n')
    expect(await readSavedServerToken(configDir, 'http://x:1')).toBeNull()
    expect((await inspectSavedServerToken(configDir, 'http://x:1')).kind).toBe('unreadable')
  })
})

describe('writing', () => {
  it('creates a private file zn can read, with zn header and table', async () => {
    await writeSavedServerToken(configDir, 'http://127.0.0.1:7878/', 'tok')
    const raw = await fsp.readFile(credentialsPath(configDir), 'utf8')
    expect(raw).toBe(
      '# Server tokens for zn, keyed by URL. Keep this file private.\n[tokens]\n"http://127.0.0.1:7878" = "tok"\n'
    )
    if (process.platform !== 'win32') {
      expect((await fsp.stat(credentialsPath(configDir))).mode & 0o777).toBe(0o600)
    }
  })

  it('keeps every other token, and the file private even if it was not', async () => {
    await writeAsZn({ 'https://a.example.com': 'a', 'https://b.example.com': 'b' })
    await fsp.chmod(credentialsPath(configDir), 0o644)
    await writeSavedServerToken(configDir, 'https://b.example.com', 'b2')
    await writeSavedServerToken(configDir, 'https://c.example.com', 'c')
    expect(await readSavedServerToken(configDir, 'https://a.example.com')).toBe('a')
    expect(await readSavedServerToken(configDir, 'https://b.example.com')).toBe('b2')
    expect(await readSavedServerToken(configDir, 'https://c.example.com')).toBe('c')
    if (process.platform !== 'win32') {
      expect((await fsp.stat(credentialsPath(configDir))).mode & 0o777).toBe(0o600)
    }
  })

  it('removes one server, and creates nothing to remove a token that is not there', async () => {
    await writeSavedServerToken(configDir, 'http://gone:1', null)
    await expect(fsp.access(credentialsPath(configDir))).rejects.toThrow()
    await writeAsZn({ 'https://a.example.com': 'a', 'https://b.example.com': 'b' })
    await writeSavedServerToken(configDir, 'https://A.example.com/', null)
    expect(await readSavedServerToken(configDir, 'https://a.example.com')).toBeNull()
    expect(await readSavedServerToken(configDir, 'https://b.example.com')).toBe('b')
  })

  it('round-trips a token with quotes and backslashes, and keeps keys a later zn may add', async () => {
    await fsp.mkdir(configDir, { recursive: true })
    await fsp.writeFile(credentialsPath(configDir), 'version = 2\n[tokens]\n')
    const odd = 'a"b\\c\'d'
    await writeSavedServerToken(configDir, 'http://x:1', odd)
    expect(await readSavedServerToken(configDir, 'http://x:1')).toBe(odd)
    expect(await fsp.readFile(credentialsPath(configDir), 'utf8')).toContain('version = 2')
  })

  it('never replaces a file it cannot read, and never quotes it in the error', async () => {
    await fsp.mkdir(configDir, { recursive: true })
    for (const broken of [
      '"http://x:1" = "secret-in-a-broken-line\n',
      'tokens = "secret-not-a-table"\n',
      '[tokens]\n"http://x:1" = 42\n'
    ]) {
      await fsp.writeFile(credentialsPath(configDir), broken)
      const error = await writeSavedServerToken(configDir, 'http://y:2', 'new').catch((e: unknown) => e)
      expect(error).toBeInstanceOf(UnreadableCredentialsError)
      expect(String((error as Error).message)).not.toContain('secret')
      expect(await fsp.readFile(credentialsPath(configDir), 'utf8')).toBe(broken)
    }
  })
})
