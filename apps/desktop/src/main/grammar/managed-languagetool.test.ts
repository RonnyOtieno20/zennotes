import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MANAGED_LANGUAGE_TOOL_IDLE_MS,
  ManagedLanguageToolLifecycle,
  isManagedLanguageToolUrl
} from './managed-languagetool'

afterEach(() => {
  vi.useRealTimers()
})

describe('isManagedLanguageToolUrl', () => {
  it('matches only the Grammar Edition localhost service on Linux', () => {
    expect(
      isManagedLanguageToolUrl(
        new URL('http://127.0.0.1:8081/v2/check'),
        'linux'
      )
    ).toBe(true)
    expect(
      isManagedLanguageToolUrl(
        new URL('http://localhost:8081/v2/check'),
        'linux'
      )
    ).toBe(true)
    expect(
      isManagedLanguageToolUrl(
        new URL('https://grammar.example/v2/check'),
        'linux'
      )
    ).toBe(false)
    expect(
      isManagedLanguageToolUrl(
        new URL('http://127.0.0.1:8082/v2/check'),
        'linux'
      )
    ).toBe(false)
    expect(
      isManagedLanguageToolUrl(
        new URL('http://127.0.0.1:8081/v2/check'),
        'darwin'
      )
    ).toBe(false)
  })
})

describe('ManagedLanguageToolLifecycle', () => {
  it('starts on the first managed request and stops after the idle timeout', async () => {
    vi.useFakeTimers()
    const runServiceCommand = vi.fn(async () => undefined)
    const lifecycle = new ManagedLanguageToolLifecycle({
      platform: 'linux',
      runServiceCommand,
      probeReady: async () => true
    })
    const endpoint = new URL('http://127.0.0.1:8081/v2/check')

    await expect(lifecycle.beginRequest(endpoint, 7)).resolves.toBe(true)
    lifecycle.endRequest()
    expect(runServiceCommand).toHaveBeenCalledTimes(1)
    expect(runServiceCommand).toHaveBeenCalledWith('start')

    await lifecycle.beginRequest(endpoint, 7)
    lifecycle.endRequest()
    expect(runServiceCommand).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(MANAGED_LANGUAGE_TOOL_IDLE_MS - 1)
    expect(runServiceCommand).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(runServiceCommand).toHaveBeenLastCalledWith('stop')
  })

  it('stops immediately only after the final enabled renderer disables grammar', async () => {
    const runServiceCommand = vi.fn(async () => undefined)
    const lifecycle = new ManagedLanguageToolLifecycle({
      platform: 'linux',
      runServiceCommand,
      probeReady: async () => true
    })

    await lifecycle.setOwnerEnabled(1, true)
    await lifecycle.setOwnerEnabled(2, true)
    await lifecycle.setOwnerEnabled(1, false)
    expect(runServiceCommand).not.toHaveBeenCalled()
    await lifecycle.setOwnerEnabled(2, false)
    expect(runServiceCommand).toHaveBeenCalledWith('stop')
  })

  it('does not manage custom or remote endpoints', async () => {
    const runServiceCommand = vi.fn(async () => undefined)
    const lifecycle = new ManagedLanguageToolLifecycle({
      platform: 'linux',
      runServiceCommand,
      probeReady: async () => true
    })

    await expect(
      lifecycle.beginRequest(new URL('https://grammar.example/v2/check'), 1)
    ).resolves.toBe(false)
    expect(runServiceCommand).not.toHaveBeenCalled()
  })
})
