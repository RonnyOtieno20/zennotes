/**
 * The anonymous usage count (Adib, 2026-10-12: on by default, a switch in
 * Settings > About, no identifier). Once per fresh install and once per
 * update, the renderer asks for one message to zennotes.org: the event, the
 * version, the operating system, the architecture and how the copy was
 * installed. Nothing else: no identifier, nothing about notes, vaults or the
 * account, a bare user agent. The server keeps daily totals only.
 *
 * The renderer decides when (lib/whats-new.ts, after the version it recorded)
 * and whether (the setting); this side decides what, and refuses anything
 * that is not a real install of a release: a development build, a test run,
 * an event it does not know.
 */
import { app, net } from 'electron'
import { currentLinuxFormat, type LinuxPackageFormat } from './updater'

export const USAGE_COUNT_URL = 'https://zennotes.org/api/v1/app/usage'

export type UsageCountEvent = 'install' | 'update'
export type UsageInstallKind =
  | 'dmg'
  | 'mas'
  | 'nsis'
  | 'portable'
  | 'store'
  | 'appimage'
  | 'deb'
  | 'rpm'
  | 'pacman'
  | 'managed'
  | 'unknown'

export interface UsageCount {
  event: UsageCountEvent
  version: string
  platform: 'macos' | 'windows' | 'linux'
  arch: 'x64' | 'arm64'
  install: UsageInstallKind
}

/** How this copy was installed, in the server's vocabulary. */
export function usageInstallKind(input: {
  platform: NodeJS.Platform
  mas: boolean
  windowsStore: boolean
  portableExecutableDir: string | undefined
  linuxFormat: () => LinuxPackageFormat
}): UsageInstallKind {
  switch (input.platform) {
    case 'darwin':
      return input.mas ? 'mas' : 'dmg'
    case 'win32':
      if (input.windowsStore) return 'store'
      return input.portableExecutableDir ? 'portable' : 'nsis'
    case 'linux':
      return input.linuxFormat()
    default:
      return 'unknown'
  }
}

/** The message, or null for a copy that is not counted: a development build,
 *  a test run (ZEN_PERF, CI), or anything the server would refuse. */
export function usageCountBody(input: {
  event: unknown
  version: string
  platform: NodeJS.Platform
  arch: string
  install: UsageInstallKind
  isPackaged: boolean
  env: NodeJS.ProcessEnv
}): UsageCount | null {
  const { event, version, arch, install } = input
  if (event !== 'install' && event !== 'update') return null
  if (!input.isPackaged || input.env.ZEN_PERF === '1' || input.env.CI) return null
  const platform = (
    { darwin: 'macos', win32: 'windows', linux: 'linux' } as Partial<Record<NodeJS.Platform, UsageCount['platform']>>
  )[input.platform]
  if (!platform) return null
  if (arch !== 'x64' && arch !== 'arm64') return null
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version)) return null
  return { event, version, platform, arch, install }
}

type Fetch = (url: string, init: RequestInit) => Promise<unknown>

/** The whole request: no cookies (the app's session may hold zennotes.org
 *  ones from a Cloud page), a bare user agent, and an Accept-Language that
 *  names no language (Chromium otherwise adds the system's, e.g. en-US). On
 *  the wire everything but the five fields is the same for every copy. */
export const USAGE_COUNT_REQUEST = (body: UsageCount): RequestInit => ({
  method: 'POST',
  credentials: 'omit',
  cache: 'no-store',
  headers: { 'content-type': 'application/json', 'user-agent': 'ZenNotes', 'accept-language': '*' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(10_000)
})

/** A sender that sends each event at most once per run of the app, whatever
 *  the renderer asks: a renderer bug must not turn the count into a stream. */
export function createUsageCounter(deps: {
  fetch: Fetch
  body: (event: unknown) => UsageCount | null
}): (event: unknown) => Promise<void> {
  const sent = new Set<UsageCountEvent>()
  return async (event) => {
    const body = deps.body(event)
    if (!body || sent.has(body.event)) return
    sent.add(body.event)
    try {
      await deps.fetch(USAGE_COUNT_URL, USAGE_COUNT_REQUEST(body))
    } catch {
      // A count that cannot be sent is dropped: it is a tally, not a record.
    }
  }
}

export const sendUsageCount = createUsageCounter({
  fetch: (url, init) => net.fetch(url, init),
  body: (event) =>
    usageCountBody({
      event,
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      install: usageInstallKind({
        platform: process.platform,
        mas: Boolean(process.mas),
        windowsStore: Boolean(process.windowsStore),
        portableExecutableDir: process.env.PORTABLE_EXECUTABLE_DIR,
        linuxFormat: () => currentLinuxFormat()
      }),
      isPackaged: app.isPackaged,
      env: process.env
    })
})
