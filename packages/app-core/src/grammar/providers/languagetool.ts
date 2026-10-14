import { GRAMMAR_MAX_TEXT_BYTES, utf8ByteLength } from '@bridge-contract/grammar'
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

  return normalizeMatchList(responseMatches(response), context)
}

function normalizeMatchList(
  matches: readonly unknown[],
  context: LanguageToolNormalizationContext
): GrammarDiagnostic[] {
  const diagnostics: GrammarDiagnostic[] = []
  for (const match of matches) {
    const diagnostic = normalizeMatch(match, context)
    if (diagnostic) diagnostics.push(diagnostic)
  }
  return diagnostics
}

function responseMatches(response: unknown): unknown[] {
  const body = asRecord(response)
  if (!body || !Array.isArray(body.matches)) {
    throw new LanguageToolResponseError('LanguageTool response must contain a matches array')
  }
  return body.matches
}

/** A blank line keeps LanguageTool from treating neighbouring segments as one sentence. */
const BATCH_SEPARATOR = '\n\n'
const BATCH_SEPARATOR_BYTES = utf8ByteLength(BATCH_SEPARATOR)

interface LanguageToolBatchSegment {
  segment: ProseSegment
  /** UTF-16 offset of the segment's first code unit inside the batch text. */
  start: number
}

interface LanguageToolBatch {
  text: string
  bytes: number
  segments: LanguageToolBatchSegment[]
}

/**
 * Pack non-empty segments, in order, into as few request texts as the byte limit allows. A segment
 * that is over the limit on its own is left out: the desktop transport would reject the request,
 * and with it the check of every other segment.
 */
function batchSegments(segments: readonly ProseSegment[]): LanguageToolBatch[] {
  const batches: LanguageToolBatch[] = []
  let current: LanguageToolBatch | null = null

  for (const segment of segments) {
    if (!isValidProseSegment(segment)) {
      throw new TypeError(`Invalid prose segment mapping for ${segment.id || '<unknown>'}`)
    }
    if (!segment.text) continue
    const bytes = utf8ByteLength(segment.text)
    if (bytes > GRAMMAR_MAX_TEXT_BYTES) continue
    if (current && current.bytes + BATCH_SEPARATOR_BYTES + bytes <= GRAMMAR_MAX_TEXT_BYTES) {
      current.text += BATCH_SEPARATOR
      current.bytes += BATCH_SEPARATOR_BYTES
    } else {
      current = { text: '', bytes: 0, segments: [] }
      batches.push(current)
    }
    current.segments.push({ segment, start: current.text.length })
    current.text += segment.text
    current.bytes += bytes
  }
  return batches
}

/**
 * Give each segment the matches that lie wholly inside it, rebased to segment-relative offsets.
 * Matches that straddle a separator are dropped because they cannot be attributed to one segment.
 */
function splitBatchMatches(batch: LanguageToolBatch, matches: readonly unknown[]): unknown[][] {
  const perSegment: unknown[][] = batch.segments.map(() => [])
  for (const match of matches) {
    const record = asRecord(match)
    const offset = integer(record?.offset)
    const length = integer(record?.length)
    if (!record || offset === null || length === null || length < 0) continue

    const index = batch.segments.findIndex(
      ({ segment, start }) => offset >= start && offset + length <= start + segment.text.length
    )
    if (index !== -1) {
      perSegment[index].push({ ...record, offset: offset - batch.segments[index].start })
    }
  }
  return perSegment
}

export class LanguageToolProvider implements GrammarProvider {
  readonly id = LANGUAGE_TOOL_PROVIDER_ID

  constructor(
    private readonly transport: LanguageToolTransport,
    private readonly options: LanguageToolProviderOptions = {}
  ) {}

  async check(request: GrammarCheckRequest): Promise<readonly GrammarDiagnostic[]> {
    const diagnostics: GrammarDiagnostic[] = []

    for (const batch of batchSegments(request.segments)) {
      throwIfAborted(request.signal)
      const response = await this.transport.check(
        {
          text: batch.text,
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

      const matchesBySegment = splitBatchMatches(batch, responseMatches(response))
      batch.segments.forEach(({ segment }, index) => {
        diagnostics.push(
          ...normalizeMatchList(matchesBySegment[index], {
            segment,
            generation: request.generation
          })
        )
      })
    }

    return diagnostics
  }
}
