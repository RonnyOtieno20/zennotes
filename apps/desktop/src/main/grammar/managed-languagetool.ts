import { execFile } from 'node:child_process'

export const MANAGED_LANGUAGE_TOOL_IDLE_MS = 5 * 60_000
export const MANAGED_LANGUAGE_TOOL_SERVICE = 'zennotes-languagetool.service'

const MANAGED_LANGUAGE_TOOL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const MANAGED_LANGUAGE_TOOL_PORT = '8081'
const MANAGED_LANGUAGE_TOOL_CHECK_PATH = '/v2/check'
const MANAGED_LANGUAGE_TOOL_HEALTH_URL = 'http://127.0.0.1:8081/v2/languages'
const READINESS_ATTEMPTS = 40
const READINESS_INTERVAL_MS = 250

type ServiceAction = 'start' | 'stop'

export interface ManagedLanguageToolOptions {
  platform?: NodeJS.Platform
  idleMs?: number
  runServiceCommand?: (action: ServiceAction) => Promise<void>
  probeReady?: () => Promise<boolean>
}

function runSystemctl(action: ServiceAction): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/systemctl',
      ['--user', action, MANAGED_LANGUAGE_TOOL_SERVICE],
      { timeout: 15_000 },
      (error) => (error ? reject(error) : resolve())
    )
  })
}

async function probeManagedLanguageTool(): Promise<boolean> {
  try {
    const response = await fetch(MANAGED_LANGUAGE_TOOL_HEALTH_URL, {
      signal: AbortSignal.timeout(1_000)
    })
    await response.body?.cancel()
    return response.ok
  } catch {
    return false
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isManagedLanguageToolUrl(
  url: URL,
  platform: NodeJS.Platform
): boolean {
  return (
    platform === 'linux' &&
    url.protocol === 'http:' &&
    MANAGED_LANGUAGE_TOOL_HOSTS.has(url.hostname.toLowerCase()) &&
    url.port === MANAGED_LANGUAGE_TOOL_PORT &&
    url.pathname === MANAGED_LANGUAGE_TOOL_CHECK_PATH
  )
}

/** Controls only the Grammar Edition's local systemd service. */
export class ManagedLanguageToolLifecycle {
  private readonly platform: NodeJS.Platform
  private readonly idleMs: number
  private readonly runServiceCommand: (action: ServiceAction) => Promise<void>
  private readonly probeReady: () => Promise<boolean>
  private readonly enabledOwners = new Set<number>()
  private activeRequests = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null

  constructor(options: ManagedLanguageToolOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.idleMs = options.idleMs ?? MANAGED_LANGUAGE_TOOL_IDLE_MS
    this.runServiceCommand = options.runServiceCommand ?? runSystemctl
    this.probeReady = options.probeReady ?? probeManagedLanguageTool
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === null) return
    clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private scheduleIdleStop(): void {
    this.clearIdleTimer()
    if (this.activeRequests > 0) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      void this.stop(false).catch((error) =>
        console.error('Failed to stop idle LanguageTool service', error)
      )
    }, this.idleMs)
    this.idleTimer.unref?.()
  }

  private async ensureRunning(): Promise<void> {
    if (this.stopPromise) await this.stopPromise
    if (this.running) return
    if (!this.startPromise) {
      this.startPromise = (async () => {
        await this.runServiceCommand('start')
        for (let attempt = 0; attempt < READINESS_ATTEMPTS; attempt += 1) {
          if (await this.probeReady()) {
            this.running = true
            return
          }
          await delay(READINESS_INTERVAL_MS)
        }
        throw new Error('Managed LanguageTool did not become ready')
      })().finally(() => {
        this.startPromise = null
      })
    }
    await this.startPromise
  }

  private async stop(force: boolean): Promise<void> {
    this.clearIdleTimer()
    if (!force && this.activeRequests > 0) return
    if (this.startPromise) {
      try {
        await this.startPromise
      } catch {
        // A failed start still gets a best-effort stop below.
      }
    }
    if (!this.stopPromise) {
      this.stopPromise = this.runServiceCommand('stop').finally(() => {
        this.running = false
        this.stopPromise = null
      })
    }
    await this.stopPromise
  }

  async beginRequest(url: URL, ownerId: number): Promise<boolean> {
    if (!isManagedLanguageToolUrl(url, this.platform)) return false
    this.enabledOwners.add(ownerId)
    this.activeRequests += 1
    this.clearIdleTimer()
    try {
      await this.ensureRunning()
      return true
    } catch (error) {
      this.activeRequests = Math.max(0, this.activeRequests - 1)
      this.scheduleIdleStop()
      throw error
    }
  }

  endRequest(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1)
    this.scheduleIdleStop()
  }

  async setOwnerEnabled(ownerId: number, enabled: boolean): Promise<void> {
    if (enabled) {
      this.enabledOwners.add(ownerId)
      return
    }
    this.enabledOwners.delete(ownerId)
    if (this.enabledOwners.size === 0) await this.stop(true)
  }

  async removeOwner(ownerId: number): Promise<void> {
    this.enabledOwners.delete(ownerId)
    if (this.enabledOwners.size === 0) await this.stop(true)
  }

  async shutdown(): Promise<void> {
    this.enabledOwners.clear()
    await this.stop(true)
  }
}
