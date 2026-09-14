import type { GrammarCheckRequest, GrammarDiagnostic, ProseSegment, SourceRange } from './types'

export interface GrammarProvider {
  readonly id: string
  check(request: GrammarCheckRequest): Promise<readonly GrammarDiagnostic[]>
}

export interface DiagnosticIdentity {
  provider: string
  segmentId: string
  ruleId: string
  offset: number
  length: number
  original: string
}

/**
 * Build an identity that stays stable across repeated checks and generations.
 * Document positions are intentionally absent: inserting text before an unchanged
 * segment should not make all of that segment's issues look new.
 */
export function createDiagnosticId(identity: DiagnosticIdentity): string {
  const value = JSON.stringify([
    identity.provider,
    identity.segmentId,
    identity.ruleId,
    identity.offset,
    identity.length,
    identity.original
  ])
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn

  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = (hash * prime) & mask
  }

  return `grammar-${identity.provider}-${hash.toString(16).padStart(16, '0')}`
}

export function isUtf16Boundary(text: string, offset: number): boolean {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return false
  if (offset === 0 || offset === text.length) return true

  const previous = text.charCodeAt(offset - 1)
  const current = text.charCodeAt(offset)
  const splitsSurrogatePair =
    previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff
  return !splitsSurrogatePair
}

export function isValidProseSegment(segment: ProseSegment): boolean {
  const { insertionMap, sourceRange, sourceMap, text } = segment
  if (
    !segment.id ||
    !Number.isInteger(sourceRange.from) ||
    !Number.isInteger(sourceRange.to) ||
    sourceRange.from < 0 ||
    sourceRange.to < sourceRange.from ||
    sourceMap.length !== text.length + 1 ||
    (insertionMap !== undefined && insertionMap.length !== text.length + 1)
  ) {
    return false
  }

  let previous = sourceRange.from - 1
  for (let index = 0; index < sourceMap.length; index += 1) {
    const position = sourceMap[index]
    if (position === null) continue
    if (
      !Number.isInteger(position) ||
      position < sourceRange.from ||
      position > sourceRange.to ||
      (index < text.length && position === sourceRange.to) ||
      position <= previous
    ) {
      return false
    }
    previous = position
  }

  if (
    insertionMap?.some(
      (position) =>
        position !== null &&
        (!Number.isInteger(position) || position < sourceRange.from || position > sourceRange.to)
    )
  ) {
    return false
  }

  return true
}

/** Map a provider UTF-16 range through the segment's explicit per-code-unit map. */
export function mapProviderUtf16Range(
  segment: ProseSegment,
  offset: number,
  length: number
): SourceRange | null {
  if (
    !isValidProseSegment(segment) ||
    !Number.isInteger(length) ||
    length < 0 ||
    !isUtf16Boundary(segment.text, offset)
  ) {
    return null
  }

  const end = offset + length
  if (!Number.isSafeInteger(end) || !isUtf16Boundary(segment.text, end)) return null

  if (length === 0) {
    const insertion = segment.insertionMap?.[offset]
    return insertion === null || insertion === undefined ? null : { from: insertion, to: insertion }
  }

  let previousSourceUnit: number | undefined
  for (let index = offset; index < end; index += 1) {
    const sourceUnit = segment.sourceMap[index]
    if (sourceUnit === null || sourceUnit === undefined) return null
    if (previousSourceUnit !== undefined && sourceUnit !== previousSourceUnit + 1) return null
    previousSourceUnit = sourceUnit
  }
  const from = segment.sourceMap[offset]
  const lastSourceUnit = previousSourceUnit
  if (from === null || from === undefined || lastSourceUnit === undefined) return null
  const to = lastSourceUnit + 1
  if (to <= from || to > segment.sourceRange.to) return null

  return { from, to }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  if (signal.reason !== undefined) throw signal.reason
  throw new DOMException('The grammar check was aborted', 'AbortError')
}
