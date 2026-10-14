/**
 * Wire contract for grammar-provider requests that cross the host bridge.
 *
 * Note text is intentionally the only provider payload accepted here. Provider
 * credentials are not part of this contract and must never cross this bridge.
 */
export interface GrammarCheckRequest {
  requestId: string
  endpoint: string
  text: string
  language: string
  timeoutMs?: number
  enabledCategories?: readonly string[]
  enabledRules?: readonly string[]
  disabledRules?: readonly string[]
}

export interface GrammarLanguageToolReplacement {
  value: string
  shortDescription?: string
}

export interface GrammarLanguageToolContext {
  text: string
  offset: number
  length: number
}

export interface GrammarLanguageToolRuleUrl {
  value: string
}

export interface GrammarLanguageToolRule {
  id: string
  description: string
  issueType?: string
  category?: {
    id: string
    name: string
  }
  urls?: GrammarLanguageToolRuleUrl[]
}

export interface GrammarLanguageToolMatch {
  message: string
  shortMessage?: string
  replacements: GrammarLanguageToolReplacement[]
  offset: number
  length: number
  context: GrammarLanguageToolContext
  sentence?: string
  type?: { typeName?: string }
  rule: GrammarLanguageToolRule
}

export interface GrammarLanguageToolResponse {
  software?: {
    name?: string
    version?: string
    buildDate?: string
    apiVersion?: number
    premium?: boolean
    premiumHint?: string
    status?: string
  }
  language?: {
    name?: string
    code?: string
    detectedLanguage?: {
      name?: string
      code?: string
      confidence?: number
      source?: string
    }
  }
  matches: GrammarLanguageToolMatch[]
  warnings?: {
    incompleteResults?: boolean
  }
}

export interface GrammarCheckResponse {
  requestId: string
  response: GrammarLanguageToolResponse
}

export interface GrammarCancelRequest {
  requestId: string
}

export interface GrammarCancelResponse {
  requestId: string
  cancelled: boolean
}

/** Largest note text, in UTF-8 bytes, accepted for one LanguageTool request. */
export const GRAMMAR_MAX_TEXT_BYTES = 100_000

/** UTF-8 byte length of `text`, matching TextEncoder without allocating an encoded copy. */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
  }
  return bytes
}

/** Whether `hostname` names the local machine: localhost, IPv6 `[::1]`, or any IPv4 `127.x.x.x`. */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  if (normalized === 'localhost' || normalized === '[::1]') return true
  const octets = normalized.split('.')
  if (octets.length !== 4 || octets[0] !== '127') return false
  return octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
}
