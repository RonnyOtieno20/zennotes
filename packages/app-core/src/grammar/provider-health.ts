import type { ZenBridge } from '@bridge-contract/bridge'
import { classifyGrammarEndpoint, type GrammarPreferences } from './preferences'
import { BridgeLanguageToolTransport } from './providers/bridge-transport'

export interface GrammarProviderHealth {
  reachable: true
  latencyMs: number
}

/** Probe the configured provider with a fixed sentence. No note text is used. */
export async function probeGrammarProvider(
  preferences: GrammarPreferences,
  bridge: Pick<ZenBridge, 'getCapabilities' | 'grammarCheck' | 'grammarCancel'>,
  signal: AbortSignal
): Promise<GrammarProviderHealth> {
  const classification = classifyGrammarEndpoint(preferences.endpoint)
  if (classification.scope === 'invalid') throw new Error(classification.message)

  const started = performance.now()
  const transport = new BridgeLanguageToolTransport({
    bridge,
    endpoint: preferences.endpoint
  })
  await transport.check(
    {
      text: 'ZenNotes grammar connection test.',
      language: preferences.language
    },
    signal
  )
  return { reachable: true, latencyMs: Math.max(0, Math.round(performance.now() - started)) }
}
