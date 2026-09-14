import { describe, expect, it } from 'vitest'
import {
  createDiagnosticId,
  isUtf16Boundary,
  isValidProseSegment,
  mapProviderUtf16Range
} from './provider'
import type { ProseSegment } from './types'

function contiguousSegment(text: string, from = 10): ProseSegment {
  return {
    id: 'paragraph-1',
    text,
    sourceRange: { from, to: from + text.length },
    sourceMap: Array.from({ length: text.length + 1 }, (_, index) => from + index)
  }
}

describe('provider offset mapping', () => {
  it('maps through explicit source boundaries rather than assuming a contiguous segment', () => {
    const segment: ProseSegment = {
      id: 'link-label-and-tail',
      text: 'One two',
      sourceRange: { from: 5, to: 23 },
      sourceMap: [5, 6, 7, 8, 20, 21, 22, 23]
    }

    expect(mapProviderUtf16Range(segment, 4, 3)).toEqual({ from: 20, to: 23 })
    expect(mapProviderUtf16Range(segment, 0, 7)).toBeNull()
  })

  it('does not absorb Markdown markers after the final provider character', () => {
    const segment: ProseSegment = {
      id: 'strong-text',
      text: 'bold',
      sourceRange: { from: 2, to: 10 },
      sourceMap: [4, 5, 6, 7, 8]
    }

    expect(mapProviderUtf16Range(segment, 0, 4)).toEqual({ from: 4, to: 8 })
  })

  it('rejects offsets that split an astral character even if the map has an entry there', () => {
    const segment = contiguousSegment('A😀 error')

    expect(isUtf16Boundary(segment.text, 2)).toBe(false)
    expect(mapProviderUtf16Range(segment, 2, 1)).toBeNull()
    expect(mapProviderUtf16Range(segment, 1, 2)).toEqual({ from: 11, to: 13 })
  })

  it('rejects unmapped boundaries and malformed maps', () => {
    const segment = contiguousSegment('bad')
    const withGap: ProseSegment = { ...segment, sourceMap: [10, null, 12, 13] }
    const tooShort: ProseSegment = { ...segment, sourceMap: [10, 11, 12] }

    expect(mapProviderUtf16Range(withGap, 1, 1)).toBeNull()
    expect(isValidProseSegment(tooShort)).toBe(false)
    expect(mapProviderUtf16Range(tooShort, 0, 3)).toBeNull()
  })

  it('maps zero-length diagnostics only at an explicitly safe insertion boundary', () => {
    const segment = contiguousSegment('word')
    const insertionMap = [10, null, null, null, 14]

    expect(mapProviderUtf16Range(segment, 4, 0)).toBeNull()
    expect(mapProviderUtf16Range({ ...segment, insertionMap }, 4, 0)).toEqual({
      from: 14,
      to: 14
    })
    expect(mapProviderUtf16Range({ ...segment, insertionMap }, 1, 0)).toBeNull()
  })
})

describe('diagnostic identity', () => {
  it('is deterministic and excludes check generation and document position', () => {
    const identity = {
      provider: 'languagetool',
      segmentId: 'paragraph-1',
      ruleId: 'RULE_1',
      offset: 4,
      length: 3,
      original: 'bad'
    }

    expect(createDiagnosticId(identity)).toBe(createDiagnosticId({ ...identity }))
    expect(createDiagnosticId({ ...identity, offset: 5 })).not.toBe(createDiagnosticId(identity))
    expect(createDiagnosticId(identity)).toMatch(/^grammar-languagetool-[0-9a-f]{16}$/)
  })
})
