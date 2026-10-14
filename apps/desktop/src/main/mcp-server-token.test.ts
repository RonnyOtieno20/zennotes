import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  followAppServerToken,
  getServerTokenState,
  removeServerToken,
  shareServerToken,
  type ServerTokenPaths
} from './mcp-server-token'
import { credentialsPath, readSavedServerToken, writeSavedServerToken } from './remote/zn-credentials'

let root: string
let paths: ServerTokenPaths

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-share-'))
  paths = {
    configDir: path.join(root, 'config'),
    receiptsPath: path.join(root, 'userData', 'mcp', 'shared-server-tokens.json')
  }
})

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

const SERVER = 'http://192.168.1.10:7878'
const app = (token: string | null = 'app-token') => ({ baseUrl: SERVER, token })
const saved = () => readSavedServerToken(paths.configDir, SERVER)

describe('the state Settings shows, never the token', () => {
  it('has nothing to share for a local vault or a server without a token', async () => {
    expect(await getServerTokenState(null, paths)).toEqual({ kind: 'none', reason: 'local' })
    expect(await getServerTokenState(app(null), paths)).toEqual({ kind: 'none', reason: 'no-token' })
  })

  it('reports missing, shared, different and unreadable, by URL and file only', async () => {
    const where = { serverUrl: SERVER, credentialsPath: credentialsPath(paths.configDir) }
    expect(await getServerTokenState(app(), paths)).toEqual({ kind: 'missing', ...where })
    await writeSavedServerToken(paths.configDir, SERVER, 'app-token')
    expect(await getServerTokenState(app(), paths)).toEqual({ kind: 'shared', ...where })
    await writeSavedServerToken(paths.configDir, SERVER, 'from-zn-connect')
    const different = await getServerTokenState(app(), paths)
    expect(different).toEqual({ kind: 'different', ...where })
    expect(JSON.stringify(different)).not.toMatch(/app-token|from-zn-connect/)
    await fsp.writeFile(credentialsPath(paths.configDir), '[tokens\n')
    expect(await getServerTokenState(app(), paths)).toMatchObject({ kind: 'unreadable', ...where })
  })

  it('names the server the way the MCP servers will look it up', async () => {
    const state = await getServerTokenState({ baseUrl: '192.168.1.10:7878/', token: 't' }, paths)
    expect(state).toMatchObject({ kind: 'missing', serverUrl: SERVER })
  })
})

describe('sharing and removing', () => {
  it('shares the app token, and Replace overwrites a different one', async () => {
    expect(await shareServerToken(app(), paths)).toMatchObject({ kind: 'shared' })
    expect(await saved()).toBe('app-token')
    await writeSavedServerToken(paths.configDir, SERVER, 'from-zn-connect')
    expect(await shareServerToken(app(), paths)).toMatchObject({ kind: 'shared' })
    expect(await saved()).toBe('app-token')
  })

  it('does nothing without a server token to share', async () => {
    expect(await shareServerToken(app(null), paths)).toEqual({ kind: 'none', reason: 'no-token' })
    expect(await shareServerToken(null, paths)).toEqual({ kind: 'none', reason: 'local' })
    await expect(fsp.access(credentialsPath(paths.configDir))).rejects.toThrow()
  })

  it('removes only the app token, never a different one the user saved', async () => {
    await writeSavedServerToken(paths.configDir, SERVER, 'from-zn-connect')
    expect(await removeServerToken(app(), paths)).toMatchObject({ kind: 'different' })
    expect(await saved()).toBe('from-zn-connect')
    await shareServerToken(app(), paths)
    expect(await removeServerToken(app(), paths)).toMatchObject({ kind: 'missing' })
    expect(await saved()).toBeNull()
  })

  it('refuses to write over a file it cannot read', async () => {
    await fsp.mkdir(paths.configDir, { recursive: true })
    await fsp.writeFile(credentialsPath(paths.configDir), '[tokens\n')
    await expect(shareServerToken(app(), paths)).rejects.toThrow(/Fix or move it/)
    expect(await fsp.readFile(credentialsPath(paths.configDir), 'utf8')).toBe('[tokens\n')
  })
})

describe('a shared token follows the app', () => {
  it('takes the new token when the server token changes in the app', async () => {
    await shareServerToken(app('old'), paths)
    await followAppServerToken(SERVER, 'old', 'new', paths)
    expect(await saved()).toBe('new')
  })

  it('goes when the server is forgotten in the app', async () => {
    await shareServerToken(app('old'), paths)
    await followAppServerToken(`${SERVER}/`, 'old', null, paths)
    expect(await saved()).toBeNull()
    // The receipt went with it: a later zn connect is the user's own.
    await writeSavedServerToken(paths.configDir, SERVER, 'old')
    await followAppServerToken(SERVER, 'old', null, paths)
    expect(await saved()).toBe('old')
  })

  it('leaves a token it never shared, even one equal to the app token', async () => {
    await writeSavedServerToken(paths.configDir, SERVER, 'app-token')
    await followAppServerToken(SERVER, 'app-token', null, paths)
    expect(await saved()).toBe('app-token')
  })

  it('stops claiming a shared token the user has since replaced', async () => {
    await shareServerToken(app('old'), paths)
    await writeSavedServerToken(paths.configDir, SERVER, 'theirs')
    await followAppServerToken(SERVER, 'old', 'new', paths)
    expect(await saved()).toBe('theirs')
    // No receipt any more, so not even a matching token is touched later.
    await writeSavedServerToken(paths.configDir, SERVER, 'new')
    await followAppServerToken(SERVER, 'new', null, paths)
    expect(await saved()).toBe('new')
  })

  it('ignores a re-save of the same token, and leaves an unreadable file alone', async () => {
    await shareServerToken(app('same'), paths)
    await followAppServerToken(SERVER, 'same', 'same', paths)
    expect(await saved()).toBe('same')
    await fsp.writeFile(credentialsPath(paths.configDir), '[tokens\n')
    await followAppServerToken(SERVER, 'same', 'next', paths)
    expect(await fsp.readFile(credentialsPath(paths.configDir), 'utf8')).toBe('[tokens\n')
  })
})
