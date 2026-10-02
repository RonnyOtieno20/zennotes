import { app, BrowserWindow, net } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { IPC, type CliUpdateCheckRequest, type CliUpdateState } from '@shared/ipc'
import { findManagedCliBinary, terminalBundleDir } from './cli-install'
import {
  extractBinary,
  RELEASE_KEYS,
  runCliUpdate,
  type CliUpdateOutcome,
  type ReleaseKey,
} from './cli-update-core'
import { readActiveTerminalRuntime } from './terminal-runtime'
import { loadConfig, updateConfig } from './vault'

const LATEST_MANIFEST_URL =
  'https://github.com/ZenNotes/tui/releases/latest/download/terminal-release.json'
const FIRST_CHECK_DELAY_MS = 90_000
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

const supported = process.platform === 'darwin' || process.platform === 'linux'
// A development or perf run can point the check at a served manifest signed
// by a throwaway key, the same gate the app updater uses for its test feed.
// Whoever can set these variables can already write the managed CLI folder,
// so they open nothing new.
const overridesAllowed = !app.isPackaged || process.env.ZEN_PERF === '1'
const manifestOverride = overridesAllowed
  ? process.env.ZENNOTES_CLI_UPDATE_MANIFEST_URL?.trim() || null
  : null

let state: CliUpdateState = {
  supported,
  autoUpdate: true,
  phase: supported ? 'idle' : 'not-installed',
  installedVersion: null,
  bundledVersion: null,
  availableVersion: null,
  lastCheckedAt: null,
  message: null,
}
let inFlight: Promise<CliUpdateState> | null = null
let scheduled = false

function trustedKeys(): readonly ReleaseKey[] {
  const extra = overridesAllowed ? process.env.ZENNOTES_CLI_UPDATE_TRUSTED_KEY?.trim() : undefined
  if (!extra) return RELEASE_KEYS
  const split = extra.indexOf(':')
  if (split <= 0) return RELEASE_KEYS
  return [...RELEASE_KEYS, { id: extra.slice(0, split), publicKey: extra.slice(split + 1) }]
}

async function fetchBytes(
  url: string,
  { maxBytes, timeoutMs }: { maxBytes: number; timeoutMs: number },
): Promise<Buffer | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // net.fetch goes through Chromium's network stack, so the system proxy
    // and certificate settings that let the app updater reach GitHub apply.
    const response = await net.fetch(url, {
      signal: controller.signal,
      headers: { 'Cache-Control': 'no-cache' },
    })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${url}`)
    if (Number(response.headers.get('content-length')) > maxBytes)
      throw new Error(`${url} is larger than expected.`)
    const chunks: Buffer[] = []
    let total = 0
    const reader = response.body?.getReader()
    if (!reader) return Buffer.alloc(0)
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        controller.abort()
        throw new Error(`${url} is larger than expected.`)
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
  } finally {
    clearTimeout(timer)
  }
}

async function readBundledVersion(): Promise<string | null> {
  try {
    const manifest = JSON.parse(
      await fs.readFile(path.join(terminalBundleDir(), 'manifest.json'), 'utf8'),
    )
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

async function refreshVersions(): Promise<void> {
  const [active, bundledVersion, config] = await Promise.all([
    readActiveTerminalRuntime(app.getPath('userData')),
    readBundledVersion(),
    loadConfig(),
  ])
  state = {
    ...state,
    autoUpdate: config.cliAutoUpdate,
    installedVersion: active?.version ?? null,
    bundledVersion,
  }
}

function describe(outcome: CliUpdateOutcome): Partial<CliUpdateState> {
  switch (outcome.kind) {
    case 'not-installed':
      return {
        phase: 'not-installed',
        availableVersion: null,
        message: 'ZenNotes has not set up its zn yet. Open this page again in a moment.',
      }
    case 'no-release-info':
      return { phase: 'up-to-date', availableVersion: null, message: 'No newer zn release found.' }
    case 'up-to-date':
      return {
        phase: 'up-to-date',
        availableVersion: null,
        message: `zn ${outcome.installed} is the latest release.`,
      }
    case 'incompatible':
      return {
        phase: 'incompatible',
        availableVersion: outcome.latest,
        message: `zn ${outcome.latest} needs a newer version of ZenNotes. Update ZenNotes to get it.`,
      }
    case 'available':
      return {
        phase: 'available',
        availableVersion: outcome.latest,
        message: `zn ${outcome.latest} is available.`,
      }
    case 'updated':
      return {
        phase: 'updated',
        availableVersion: outcome.to,
        message: `Updated zn from ${outcome.from} to ${outcome.to}.`,
      }
  }
}

function humanize(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK|ERR_CONNECTION|ENOTFOUND|aborted/i.test(text))
    return 'Could not reach GitHub to check for zn updates. Try again when you are online.'
  return text
}

// Settings may be open before a scheduled check starts or after it ends;
// every change reaches it here rather than on its next open.
function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.CLI_UPDATE_ON_STATE, { ...state })
  }
}

export async function getCliUpdateState(): Promise<CliUpdateState> {
  if (supported) await refreshVersions()
  return { ...state }
}

/**
 * One check, shared by the schedule and Settings: a second caller while one
 * runs gets the same result instead of a second download.
 */
export function checkForCliUpdate(request: CliUpdateCheckRequest): Promise<CliUpdateState> {
  if (!supported) return Promise.resolve({ ...state })
  if (inFlight) return inFlight
  state = { ...state, phase: 'checking', message: 'Checking for zn updates…' }
  broadcast()
  inFlight = (async () => {
    try {
      const outcome = await runCliUpdate(
        {
          userData: app.getPath('userData'),
          platform: process.platform,
          arch: process.arch,
          manifestUrl: manifestOverride ?? LATEST_MANIFEST_URL,
          signatureUrl: `${manifestOverride ?? LATEST_MANIFEST_URL}.sig`,
          keys: trustedKeys(),
          fetchBytes,
          extractBinary,
        },
        { install: request.install === true },
      )
      state = { ...state, ...describe(outcome), lastCheckedAt: Date.now() }
    } catch (error) {
      state = { ...state, phase: 'error', message: humanize(error), lastCheckedAt: Date.now() }
    }
    await refreshVersions().catch(() => {})
    broadcast()
    return { ...state }
  })().finally(() => {
    inFlight = null
  })
  return inFlight
}

export async function setCliAutoUpdate(enabled: boolean): Promise<CliUpdateState> {
  await updateConfig((config) => ({ ...config, cliAutoUpdate: enabled === true }))
  const next = await getCliUpdateState()
  broadcast()
  return next
}

/**
 * Checks shortly after launch and then daily. Packaged builds only, unless a
 * test manifest is configured, so development and perf runs stay off the
 * network.
 */
export function scheduleCliUpdateChecks(): void {
  if (scheduled || !supported) return
  if (!manifestOverride && (!app.isPackaged || process.env.ZEN_PERF === '1')) return
  scheduled = true
  const delay = Number(process.env.ZENNOTES_CLI_UPDATE_FIRST_CHECK_MS)
  const run = async (): Promise<void> => {
    // Only a zn that ZenNotes put on PATH runs this copy (MCP setups use it
    // under the same condition). Without one there is nothing to keep
    // current, and no reason to download every release for someone who
    // never uses the CLI or uses Homebrew's.
    if (!(await findManagedCliBinary().catch(() => null))) return
    const { cliAutoUpdate } = await loadConfig()
    await checkForCliUpdate({ install: cliAutoUpdate })
  }
  setTimeout(
    () => {
      void run()
      setInterval(() => void run(), CHECK_INTERVAL_MS)
    },
    overridesAllowed && Number.isFinite(delay) && delay >= 0 ? delay : FIRST_CHECK_DELAY_MS,
  )
}
