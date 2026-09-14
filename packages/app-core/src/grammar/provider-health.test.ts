import { describe, expect, it, vi } from 'vitest'
import type { ZenBridge } from '@bridge-contract/bridge'
import { DEFAULT_GRAMMAR_PREFERENCES } from './preferences'
import { probeGrammarProvider } from './provider-health'

function bridge(): Pick<ZenBridge, 'getCapabilities' | 'grammarCheck' | 'grammarCancel'> {
  return {
    getCapabilities: () =>
      ({ supportsGrammarProviderTransport: true }) as ReturnType<ZenBridge['getCapabilities']>,
    grammarCheck: vi.fn(async (request) => ({
      requestId: request.requestId,
      response: { matches: [] }
    })),
    grammarCancel: vi.fn(async (request) => ({ requestId: request.requestId, cancelled: true }))
  }
}

describe('probeGrammarProvider', () => {
  it('uses a fixed disclosure-safe sentence instead of note content', async () => {
    const zen = bridge()
    await expect(
      probeGrammarProvider(DEFAULT_GRAMMAR_PREFERENCES, zen, new AbortController().signal)
    ).resolves.toMatchObject({ reachable: true })
    expect(zen.grammarCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'http://127.0.0.1:8081/v2',
        text: 'ZenNotes grammar connection test.',
        language: 'en-US'
      })
    )
  })

  it('rejects unsafe remote HTTP before calling the bridge', async () => {
    const zen = bridge()
    await expect(
      probeGrammarProvider(
        { ...DEFAULT_GRAMMAR_PREFERENCES, endpoint: 'http://grammar.example.test/v2' },
        zen,
        new AbortController().signal
      )
    ).rejects.toThrow('HTTPS')
    expect(zen.grammarCheck).not.toHaveBeenCalled()
  })
})
