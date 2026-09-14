import type { ZenBridge } from '@bridge-contract/bridge'
import type { GrammarCheckResponse } from '@bridge-contract/grammar'
import { throwIfAborted } from '../provider'
import type { LanguageToolCheckRequest, LanguageToolTransport } from './languagetool'

export const DEFAULT_LANGUAGE_TOOL_ENDPOINT = 'http://127.0.0.1:8081/v2'

export interface BridgeLanguageToolTransportOptions {
  bridge: Pick<ZenBridge, 'getCapabilities' | 'grammarCheck' | 'grammarCancel'>
  endpoint?: string
  timeoutMs?: number
  createRequestId?: () => string
}

export class GrammarTransportUnavailableError extends Error {
  constructor() {
    super('Grammar provider transport is unavailable in this runtime')
    this.name = 'GrammarTransportUnavailableError'
  }
}

function defaultRequestId(): string {
  return globalThis.crypto.randomUUID()
}

/** Renderer adapter for the host-mediated LanguageTool transport. */
export class BridgeLanguageToolTransport implements LanguageToolTransport {
  private readonly bridge: BridgeLanguageToolTransportOptions['bridge']
  private readonly endpoint: string
  private readonly timeoutMs: number | undefined
  private readonly createRequestId: () => string

  constructor(options: BridgeLanguageToolTransportOptions) {
    this.bridge = options.bridge
    this.endpoint = options.endpoint ?? DEFAULT_LANGUAGE_TOOL_ENDPOINT
    this.timeoutMs = options.timeoutMs
    this.createRequestId = options.createRequestId ?? defaultRequestId
  }

  async check(request: LanguageToolCheckRequest, signal: AbortSignal): Promise<unknown> {
    const { grammarCheck, grammarCancel } = this.bridge
    if (
      !this.bridge.getCapabilities().supportsGrammarProviderTransport ||
      typeof grammarCheck !== 'function' ||
      typeof grammarCancel !== 'function'
    ) {
      throw new GrammarTransportUnavailableError()
    }

    throwIfAborted(signal)
    const requestId = this.createRequestId()
    let started = false
    const cancel = () => {
      if (!started) return
      void grammarCancel.call(this.bridge, { requestId }).catch(() => undefined)
    }
    signal.addEventListener('abort', cancel, { once: true })

    try {
      started = true
      let response: GrammarCheckResponse
      try {
        response = await grammarCheck.call(this.bridge, {
          requestId,
          endpoint: this.endpoint,
          text: request.text,
          language: request.language,
          ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
          ...(request.enabledCategories
            ? { enabledCategories: request.enabledCategories }
            : {}),
          ...(request.enabledRules ? { enabledRules: request.enabledRules } : {}),
          ...(request.disabledRules ? { disabledRules: request.disabledRules } : {})
        })
      } catch (error) {
        if (signal.aborted) throwIfAborted(signal)
        throw error
      }
      throwIfAborted(signal)
      if (response.requestId !== requestId) {
        throw new Error('Grammar provider returned a mismatched request ID')
      }
      return response.response
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }
}
