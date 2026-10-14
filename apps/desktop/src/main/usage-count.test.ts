import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getVersion: () => '2.68.0', isPackaged: true }, net: { fetch: vi.fn() } }))
vi.mock('./updater', () => ({ currentLinuxFormat: () => 'appimage' }))

import { createUsageCounter, USAGE_COUNT_URL, usageCountBody, usageInstallKind, type UsageCount } from './usage-count'

const base = {
  event: 'update' as unknown,
  version: '2.68.0',
  platform: 'darwin' as NodeJS.Platform,
  arch: 'arm64',
  install: 'dmg' as const,
  isPackaged: true,
  env: {} as NodeJS.ProcessEnv
}

describe('usageInstallKind', () => {
  const kind = (platform: NodeJS.Platform, extra: Partial<Parameters<typeof usageInstallKind>[0]> = {}) =>
    usageInstallKind({
      platform,
      mas: false,
      windowsStore: false,
      portableExecutableDir: undefined,
      linuxFormat: () => 'pacman',
      ...extra
    })

  it('names each install the way the server expects', () => {
    expect(kind('darwin')).toBe('dmg')
    expect(kind('darwin', { mas: true })).toBe('mas')
    expect(kind('win32')).toBe('nsis')
    expect(kind('win32', { portableExecutableDir: 'C:\\\\Tools' })).toBe('portable')
    expect(kind('win32', { windowsStore: true })).toBe('store')
    expect(kind('linux')).toBe('pacman')
    expect(kind('freebsd')).toBe('unknown')
  })
})

describe('usageCountBody', () => {
  it('carries the event, version, OS, architecture and install kind, and nothing else', () => {
    expect(usageCountBody(base)).toEqual({
      event: 'update',
      version: '2.68.0',
      platform: 'macos',
      arch: 'arm64',
      install: 'dmg'
    })
    expect(usageCountBody({ ...base, platform: 'win32', arch: 'x64', install: 'nsis' })?.platform).toBe('windows')
  })

  it('counts no development build, test run or CI run', () => {
    expect(usageCountBody({ ...base, isPackaged: false })).toBeNull()
    expect(usageCountBody({ ...base, env: { ZEN_PERF: '1' } })).toBeNull()
    expect(usageCountBody({ ...base, env: { CI: 'true' } })).toBeNull()
  })

  it('refuses what the server would refuse', () => {
    expect(usageCountBody({ ...base, event: 'launch' })).toBeNull()
    expect(usageCountBody({ ...base, arch: 'ia32' })).toBeNull()
    expect(usageCountBody({ ...base, platform: 'freebsd' })).toBeNull()
    expect(usageCountBody({ ...base, version: '2.68.0-beta.1' })).toBeNull()
  })
})

describe('createUsageCounter', () => {
  const body = (event: unknown): UsageCount | null => usageCountBody({ ...base, event })

  it('sends one POST with the JSON body and a bare user agent', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true })
    await createUsageCounter({ fetch, body })('update')
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe(USAGE_COUNT_URL)
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('omit')
    expect(init.headers['user-agent']).toBe('ZenNotes')
    expect(init.headers['accept-language']).toBe('*')
    expect(JSON.parse(init.body)).toEqual({ event: 'update', version: '2.68.0', platform: 'macos', arch: 'arm64', install: 'dmg' })
  })

  it('sends each event at most once per run, whatever the renderer asks', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true })
    const send = createUsageCounter({ fetch, body })
    await send('update')
    await send('update')
    await send('install')
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(init.body).event)).toEqual(['update', 'install'])
  })

  it('sends nothing for a refused event, and drops a failed send quietly', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('offline'))
    const send = createUsageCounter({ fetch, body })
    await send('launch')
    expect(fetch).not.toHaveBeenCalled()
    await expect(send('update')).resolves.toBeUndefined()
  })
})
