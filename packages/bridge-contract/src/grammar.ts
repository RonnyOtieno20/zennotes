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
