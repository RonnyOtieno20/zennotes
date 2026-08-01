import { describe, expect, it, vi } from 'vitest'
import type { ZenBridge } from '@bridge-contract/bridge'
import type { GrammarCheckResponse } from '@bridge-contract/grammar'
import {
  BridgeLanguageToolTransport,
  DEFAULT_LANGUAGE_TOOL_ENDPOINT,
  GrammarTransportUnavailableError
} from './bridge-transport'

function bridge(
  overrides: Partial<Pick<ZenBridge, 'getCapabilities' | 'grammarCheck' | 'grammarCancel'>> = {}
): Pick<ZenBridge, 'getCapabilities' | 'grammarCheck' | 'grammarCancel'> {
  return {
    getCapabilities: () =>
      ({ supportsGrammarProviderTransport: true }) as ReturnType<ZenBridge['getCapabilities']>,
    grammarCheck: vi.fn(async (request) => ({ requestId: request.requestId, response: { matches: [] } })),
    grammarCancel: vi.fn(async (request) => ({ requestId: request.requestId, cancelled: true })),
    ...overrides
  }
}

describe('BridgeLanguageToolTransport', () => {
  it('forwards provider options through the host bridge without exposing a web fetch', async () => {
    const host = bridge()
    const transport = new BridgeLanguageToolTransport({
      bridge: host,
      timeoutMs: 5_000,
      createRequestId: () => 'grammar-request-1'
    })

    await expect(
      transport.check(
        {
          text: 'This are wrong.',
          language: 'en-US',
          enabledCategories: ['GRAMMAR'],
          disabledRules: ['RULE_A']
        },
        new AbortController().signal
      )
    ).resolves.toEqual({ matches: [] })

    expect(host.grammarCheck).toHaveBeenCalledWith({
      requestId: 'grammar-request-1',
      endpoint: DEFAULT_LANGUAGE_TOOL_ENDPOINT,
      text: 'This are wrong.',
      language: 'en-US',
      timeoutMs: 5_000,
      enabledCategories: ['GRAMMAR'],
      disabledRules: ['RULE_A']
    })
  })

  it('cancels the matching host request and preserves the AbortSignal reason', async () => {
    const controller = new AbortController()
    let rejectCheck!: (error: unknown) => void
    const host = bridge({
      grammarCheck: vi.fn(
        () => new Promise<GrammarCheckResponse>((_resolve, reject) => (rejectCheck = reject))
      )
    })
    const transport = new BridgeLanguageToolTransport({
      bridge: host,
      createRequestId: () => 'grammar-request-2'
    })
    const checking = transport.check(
      { text: 'Text', language: 'en-US' },
      controller.signal
    )
    const reason = new Error('superseded')

    controller.abort(reason)
    rejectCheck(new Error('IPC request failed'))

    await expect(checking).rejects.toBe(reason)
    expect(host.grammarCancel).toHaveBeenCalledWith({ requestId: 'grammar-request-2' })
  })

  it('fails closed when the runtime does not expose grammar transport', async () => {
    const host = bridge({
      getCapabilities: () =>
        ({ supportsGrammarProviderTransport: false }) as ReturnType<ZenBridge['getCapabilities']>,
      grammarCheck: undefined,
      grammarCancel: undefined
    })
    const transport = new BridgeLanguageToolTransport({ bridge: host })

    await expect(
      transport.check({ text: 'Text', language: 'en-US' }, new AbortController().signal)
    ).rejects.toBeInstanceOf(GrammarTransportUnavailableError)
  })

  it('rejects mismatched host responses', async () => {
    const host = bridge({
      grammarCheck: vi.fn(async () => ({ requestId: 'wrong-request', response: { matches: [] } }))
    })
    const transport = new BridgeLanguageToolTransport({
      bridge: host,
      createRequestId: () => 'expected-request'
    })

    await expect(
      transport.check({ text: 'Text', language: 'en-US' }, new AbortController().signal)
    ).rejects.toThrow('mismatched request ID')
  })
})
