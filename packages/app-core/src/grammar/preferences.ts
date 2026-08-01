import { DEFAULT_LANGUAGE_TOOL_ENDPOINT } from './providers/bridge-transport'
import type { GrammarCategory } from './types'

export const GRAMMAR_DEBOUNCE_MIN_MS = 250
export const GRAMMAR_DEBOUNCE_MAX_MS = 5_000
export const GRAMMAR_CATEGORIES: readonly GrammarCategory[] = [
  'spelling',
  'grammar',
  'punctuation',
  'style',
  'other'
]

export interface GrammarPreferences {
  provider: 'languagetool'
  endpoint: string
  language: string
  automaticChecks: boolean
  debounceMs: number
  checkHeadings: boolean
  checkLists: boolean
  checkBlockquotes: boolean
  checkTables: boolean
  checkLinkLabels: boolean
  enabledCategories: readonly GrammarCategory[]
  ignoredRules: readonly string[]
  customDictionary: readonly string[]
  showUnderlines: boolean
  diagnosticLogging: boolean
}

export type GrammarPreferencesPatch = Partial<GrammarPreferences>

export const DEFAULT_GRAMMAR_PREFERENCES: GrammarPreferences = {
  provider: 'languagetool',
  endpoint: DEFAULT_LANGUAGE_TOOL_ENDPOINT,
  language: 'en-US',
  automaticChecks: true,
  debounceMs: 750,
  checkHeadings: true,
  checkLists: true,
  checkBlockquotes: true,
  checkTables: true,
  checkLinkLabels: true,
  enabledCategories: GRAMMAR_CATEGORIES,
  ignoredRules: [],
  customDictionary: [],
  showUnderlines: true,
  diagnosticLogging: false
}

export interface GrammarEndpointClassification {
  scope: 'local' | 'remote' | 'invalid'
  label: 'Local' | 'Remote' | 'Invalid'
  message: string
}

const LANGUAGE_PATTERN = /^(?:auto|[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*)$/
const RULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  if (normalized === 'localhost' || normalized === '[::1]') return true
  const octets = normalized.split('.')
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  )
}

export function classifyGrammarEndpoint(endpoint: string): GrammarEndpointClassification {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return {
      scope: 'invalid',
      label: 'Invalid',
      message: 'Enter a valid LanguageTool URL.'
    }
  }

  if (url.username || url.password || url.search) {
    return {
      scope: 'invalid',
      label: 'Invalid',
      message: 'Credentials and query parameters are not allowed in the endpoint.'
    }
  }
  if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) {
    return {
      scope: 'local',
      label: 'Local',
      message: 'Note text stays on this device.'
    }
  }
  if (url.protocol === 'https:') {
    return {
      scope: 'remote',
      label: 'Remote',
      message: 'Note text is sent to this service.'
    }
  }
  return {
    scope: 'invalid',
    label: 'Invalid',
    message: 'Use HTTPS, or HTTP only with a loopback address.'
  }
}

function uniqueStrings(
  value: unknown,
  options: { limit: number; validate?: (value: string) => boolean }
): string[] {
  if (!Array.isArray(value)) return []
  const unique = new Map<string, string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const normalized = item.trim()
    if (!normalized || options.validate?.(normalized) === false) continue
    const key = normalized.toLocaleLowerCase()
    if (!unique.has(key)) unique.set(key, normalized)
    if (unique.size >= options.limit) break
  }
  return [...unique.values()]
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export function normalizeGrammarPreferences(
  value: unknown,
  fallback: GrammarPreferences = DEFAULT_GRAMMAR_PREFERENCES
): GrammarPreferences {
  const candidate = value && typeof value === 'object' ? (value as Partial<GrammarPreferences>) : {}
  const endpoint =
    typeof candidate.endpoint === 'string' && candidate.endpoint.trim().length <= 2048
      ? candidate.endpoint.trim()
      : fallback.endpoint
  const language =
    typeof candidate.language === 'string' && LANGUAGE_PATTERN.test(candidate.language.trim())
      ? candidate.language.trim()
      : fallback.language
  const enabledCategories = Array.isArray(candidate.enabledCategories)
    ? GRAMMAR_CATEGORIES.filter((category) => candidate.enabledCategories!.includes(category))
    : [...fallback.enabledCategories]
  const debounce =
    typeof candidate.debounceMs === 'number' && Number.isFinite(candidate.debounceMs)
      ? Math.round(candidate.debounceMs)
      : fallback.debounceMs

  return {
    provider: 'languagetool',
    endpoint: endpoint || fallback.endpoint,
    language,
    automaticChecks: booleanOr(candidate.automaticChecks, fallback.automaticChecks),
    debounceMs: Math.min(GRAMMAR_DEBOUNCE_MAX_MS, Math.max(GRAMMAR_DEBOUNCE_MIN_MS, debounce)),
    checkHeadings: booleanOr(candidate.checkHeadings, fallback.checkHeadings),
    checkLists: booleanOr(candidate.checkLists, fallback.checkLists),
    checkBlockquotes: booleanOr(candidate.checkBlockquotes, fallback.checkBlockquotes),
    checkTables: booleanOr(candidate.checkTables, fallback.checkTables),
    checkLinkLabels: booleanOr(candidate.checkLinkLabels, fallback.checkLinkLabels),
    enabledCategories,
    ignoredRules: uniqueStrings(candidate.ignoredRules, {
      limit: 500,
      validate: (item) => RULE_ID_PATTERN.test(item)
    }),
    customDictionary: uniqueStrings(candidate.customDictionary, { limit: 2_000 }),
    showUnderlines: booleanOr(candidate.showUnderlines, fallback.showUnderlines),
    diagnosticLogging: booleanOr(candidate.diagnosticLogging, fallback.diagnosticLogging)
  }
}

export function grammarProviderConfigKey(preferences: GrammarPreferences): string {
  return JSON.stringify([
    preferences.provider,
    preferences.endpoint,
    preferences.language,
    preferences.enabledCategories,
    preferences.ignoredRules,
    preferences.customDictionary
  ])
}
