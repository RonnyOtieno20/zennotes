import {
  createDiagnosticId,
  isUtf16Boundary,
  isValidProseSegment,
  mapProviderUtf16Range,
  throwIfAborted,
  type GrammarProvider
} from '../provider'
import type {
  GrammarCategory,
  GrammarCheckRequest,
  GrammarDiagnostic,
  GrammarDiagnosticContext,
  GrammarReplacement,
  ProseSegment
} from '../types'

export const LANGUAGE_TOOL_PROVIDER_ID = 'languagetool'

export interface LanguageToolCheckRequest {
  text: string
  language: string
  enabledCategories?: readonly string[]
  enabledRules?: readonly string[]
  disabledRules?: readonly string[]
}

export interface LanguageToolTransport {
  check(request: LanguageToolCheckRequest, signal: AbortSignal): Promise<unknown>
}

export interface LanguageToolProviderOptions {
  enabledCategories?: readonly string[]
  enabledRules?: readonly string[]
  disabledRules?: readonly string[]
  /** Provider-neutral categories kept after normalization. */
  visibleCategories?: readonly GrammarCategory[]
  /** Exact source words or phrases suppressed locally and never sent as configuration. */
  customDictionary?: readonly string[]
}

export interface LanguageToolNormalizationContext {
  segment: ProseSegment
  generation: number
}

export class LanguageToolResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LanguageToolResponseError'
  }
}

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized ? normalized : null
}

function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) ? (value as number) : null
}

function normalizeCategory(match: UnknownRecord, rule: UnknownRecord): GrammarCategory {
  const category = asRecord(rule.category)
  const type = asRecord(match.type)
  const values = [rule.issueType, category?.id, category?.name, type?.typeName]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase()

  if (/punct|typograph|whitespace/.test(values)) return 'punctuation'
  if (/misspell|spelling|\btypos?\b/.test(values)) return 'spelling'
  if (/grammar/.test(values)) return 'grammar'
  if (/style|register|redundan|locale|inconsisten/.test(values)) return 'style'
  return 'other'
}

function normalizeReplacements(value: unknown): GrammarReplacement[] {
  if (!Array.isArray(value)) return []

  const replacements: GrammarReplacement[] = []
  for (const candidate of value) {
    const record = asRecord(candidate)
    if (!record || typeof record.value !== 'string') continue
    const description = nonEmptyString(record.shortDescription ?? record.description)
    replacements.push({
      value: record.value,
      ...(description ? { description } : {})
    })
  }
  return replacements
}

function normalizeContext(value: unknown): GrammarDiagnosticContext | undefined {
  const record = asRecord(value)
  if (!record || typeof record.text !== 'string') return undefined

  const offset = integer(record.offset)
  const length = integer(record.length)
  if (
    offset === null ||
    length === null ||
    length < 0 ||
    !isUtf16Boundary(record.text, offset) ||
    !isUtf16Boundary(record.text, offset + length)
  ) {
    return { text: record.text }
  }

  return { text: record.text, range: { from: offset, to: offset + length } }
}

function normalizeDocsUrl(rule: UnknownRecord): string | undefined {
  if (!Array.isArray(rule.urls)) return undefined

  for (const candidate of rule.urls) {
    const value = nonEmptyString(asRecord(candidate)?.value)
    if (!value) continue
    try {
      const url = new URL(value)
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString()
    } catch {
      // Ignore malformed or relative provider URLs.
    }
  }
  return undefined
}

function normalizeMatch(
  value: unknown,
  { segment, generation }: LanguageToolNormalizationContext
): GrammarDiagnostic | null {
  const match = asRecord(value)
  if (!match) return null

  const rule = asRecord(match.rule)
  const message = nonEmptyString(match.message)
  const ruleId = nonEmptyString(rule?.id)
  const offset = integer(match.offset)
  const length = integer(match.length)
  if (!rule || !message || !ruleId || offset === null || length === null || length < 0) return null

  const range = mapProviderUtf16Range(segment, offset, length)
  if (!range) return null

  const category = normalizeCategory(match, rule)
  const original = segment.text.slice(offset, offset + length)
  const shortMessage = nonEmptyString(match.shortMessage)
  const context = normalizeContext(match.context)
  const docsUrl = normalizeDocsUrl(rule)

  return {
    id: createDiagnosticId({
      provider: LANGUAGE_TOOL_PROVIDER_ID,
      segmentId: segment.id,
      ruleId,
      offset,
      length,
      original
    }),
    provider: LANGUAGE_TOOL_PROVIDER_ID,
    ruleId,
    category,
    message,
    ...(shortMessage ? { shortMessage } : {}),
    range,
    original,
    replacements: normalizeReplacements(match.replacements),
    severity: category === 'style' ? 'info' : 'warning',
    generation,
    segmentId: segment.id,
    ...(context ? { context } : {}),
    ...(docsUrl ? { docsUrl } : {})
  }
}

export function normalizeLanguageToolResponse(
  response: unknown,
  context: LanguageToolNormalizationContext
): GrammarDiagnostic[] {
  if (!isValidProseSegment(context.segment)) {
    throw new TypeError(`Invalid prose segment mapping for ${context.segment.id || '<unknown>'}`)
  }
  if (!Number.isSafeInteger(context.generation) || context.generation < 0) {
    throw new TypeError('Grammar check generation must be a non-negative safe integer')
  }

  const body = asRecord(response)
  if (!body || !Array.isArray(body.matches)) {
    throw new LanguageToolResponseError('LanguageTool response must contain a matches array')
  }

  const diagnostics: GrammarDiagnostic[] = []
  for (const match of body.matches) {
    const diagnostic = normalizeMatch(match, context)
    if (diagnostic) diagnostics.push(diagnostic)
  }
  return diagnostics
}

export class LanguageToolProvider implements GrammarProvider {
  readonly id = LANGUAGE_TOOL_PROVIDER_ID
  private readonly visibleCategories: ReadonlySet<GrammarCategory> | null
  private readonly disabledRules: ReadonlySet<string>
  private readonly customDictionary: ReadonlySet<string>

  constructor(
    private readonly transport: LanguageToolTransport,
    private readonly options: LanguageToolProviderOptions = {}
  ) {
    this.visibleCategories = options.visibleCategories ? new Set(options.visibleCategories) : null
    this.disabledRules = new Set(options.disabledRules ?? [])
    this.customDictionary = new Set(
      (options.customDictionary ?? []).map((entry) => entry.trim().toLocaleLowerCase())
    )
  }

  private keepsDiagnostic(diagnostic: GrammarDiagnostic): boolean {
    if (this.visibleCategories && !this.visibleCategories.has(diagnostic.category)) return false
    if (this.disabledRules.has(diagnostic.ruleId)) return false
    return !this.customDictionary.has(diagnostic.original.trim().toLocaleLowerCase())
  }

  async check(request: GrammarCheckRequest): Promise<readonly GrammarDiagnostic[]> {
    const diagnostics: GrammarDiagnostic[] = []

    for (const segment of request.segments) {
      throwIfAborted(request.signal)
      if (!isValidProseSegment(segment)) {
        throw new TypeError(`Invalid prose segment mapping for ${segment.id || '<unknown>'}`)
      }

      const response = await this.transport.check(
        {
          text: segment.text,
          language: request.language,
          ...(this.options.enabledCategories
            ? { enabledCategories: this.options.enabledCategories }
            : {}),
          ...(this.options.enabledRules ? { enabledRules: this.options.enabledRules } : {}),
          ...(this.options.disabledRules ? { disabledRules: this.options.disabledRules } : {})
        },
        request.signal
      )
      throwIfAborted(request.signal)
      diagnostics.push(
        ...normalizeLanguageToolResponse(response, {
          segment,
          generation: request.generation
        }).filter((diagnostic) => this.keepsDiagnostic(diagnostic))
      )
    }

    return diagnostics
  }
}
