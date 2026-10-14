import { describe, expect, it, vi } from 'vitest'
import { GRAMMAR_MAX_TEXT_BYTES } from '@bridge-contract/grammar'
import type { ProseSegment } from '../types'
import {
  LanguageToolProvider,
  LanguageToolResponseError,
  normalizeLanguageToolResponse,
  type LanguageToolTransport
} from './languagetool'

function segment(
  text = 'One two',
  sourceMap: readonly (number | null)[] = [5, 6, 7, 8, 20, 21, 22, 23],
  sourceRange = { from: 5, to: 23 }
): ProseSegment {
  return { id: 'paragraph-1', text, sourceRange, sourceMap }
}

/** A segment whose source map is the identity over its own length, for batch-size tests. */
function segmentFor(id: string, text: string): ProseSegment {
  return {
    id,
    text,
    sourceRange: { from: 0, to: text.length },
    sourceMap: Array.from({ length: text.length + 1 }, (_, index) => index)
  }
}

function responseWith(match: Record<string, unknown>): unknown {
  return { matches: [match] }
}

const grammarMatch = {
  message: 'Possible agreement error.',
  shortMessage: 'Agreement',
  offset: 4,
  length: 3,
  replacements: [
    { value: 'three', shortDescription: 'Use a number word' },
    { value: 'second' },
    { nope: true }
  ],
  context: { text: 'One two today', offset: 4, length: 3 },
  rule: {
    id: 'AGREEMENT_SENT_START',
    issueType: 'grammar',
    category: { id: 'GRAMMAR', name: 'Grammar' },
    urls: [{ value: 'javascript:alert(1)' }, { value: 'https://example.test/rules/agreement' }]
  }
}

describe('LanguageTool response normalization', () => {
  it('normalizes a match into provider-neutral diagnostics and maps its UTF-16 range', () => {
    const [diagnostic] = normalizeLanguageToolResponse(responseWith(grammarMatch), {
      segment: segment(),
      generation: 7
    })

    expect(diagnostic).toEqual({
      id: expect.stringMatching(/^grammar-languagetool-[0-9a-f]{16}$/),
      provider: 'languagetool',
      ruleId: 'AGREEMENT_SENT_START',
      category: 'grammar',
      message: 'Possible agreement error.',
      shortMessage: 'Agreement',
      range: { from: 20, to: 23 },
      original: 'two',
      replacements: [{ value: 'three', description: 'Use a number word' }, { value: 'second' }],
      severity: 'warning',
      generation: 7,
      segmentId: 'paragraph-1',
      context: { text: 'One two today', range: { from: 4, to: 7 } },
      docsUrl: 'https://example.test/rules/agreement'
    })
  })

  it('keeps IDs stable across generations and source shifts for the same segment issue', () => {
    const first = normalizeLanguageToolResponse(responseWith(grammarMatch), {
      segment: segment(),
      generation: 1
    })[0]
    const shifted = normalizeLanguageToolResponse(responseWith(grammarMatch), {
      segment: segment('One two', [50, 51, 52, 53, 70, 71, 72, 73], {
        from: 50,
        to: 73
      }),
      generation: 2
    })[0]

    expect(shifted.id).toBe(first.id)
    expect(shifted.range).toEqual({ from: 70, to: 73 })
    expect(shifted.generation).toBe(2)
  })

  it.each([
    ['misspelling', 'spelling', 'warning'],
    ['typographical', 'punctuation', 'warning'],
    ['style', 'style', 'info'],
    ['semantic', 'other', 'warning']
  ] as const)('maps %s issues to %s with %s severity', (issueType, category, severity) => {
    const [diagnostic] = normalizeLanguageToolResponse(
      responseWith({
        ...grammarMatch,
        rule: {
          ...grammarMatch.rule,
          issueType,
          category: { id: 'MISC', name: 'Miscellaneous' }
        }
      }),
      { segment: segment(), generation: 1 }
    )

    expect(diagnostic.category).toBe(category)
    expect(diagnostic.severity).toBe(severity)
  })

  it('drops malformed matches and provider ranges with unmapped or mid-surrogate boundaries', () => {
    const text = 'A😀 bad'
    const mapped: (number | null)[] = Array.from(
      { length: text.length + 1 },
      (_, index) => index + 10
    )
    mapped[3] = null
    const prose = segment(text, mapped, { from: 10, to: 18 })
    const valid = {
      ...grammarMatch,
      offset: 4,
      length: 3,
      rule: { ...grammarMatch.rule, id: 'VALID' }
    }

    const diagnostics = normalizeLanguageToolResponse(
      {
        matches: [
          null,
          { ...grammarMatch, rule: {} },
          { ...grammarMatch, offset: 2, length: 1 },
          { ...grammarMatch, offset: 3, length: 1 },
          valid
        ]
      },
      { segment: prose, generation: 3 }
    )

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0].ruleId).toBe('VALID')
    expect(diagnostics[0].original).toBe('bad')
  })

  it('preserves context text but omits an invalid context range', () => {
    const [diagnostic] = normalizeLanguageToolResponse(
      responseWith({
        ...grammarMatch,
        context: { text: '😀 example', offset: 1, length: 1 }
      }),
      { segment: segment(), generation: 1 }
    )

    expect(diagnostic.context).toEqual({ text: '😀 example' })
  })

  it('rejects malformed response envelopes and invalid segment maps', () => {
    expect(() =>
      normalizeLanguageToolResponse({ matches: null }, { segment: segment(), generation: 1 })
    ).toThrow(LanguageToolResponseError)
    expect(() =>
      normalizeLanguageToolResponse(
        { matches: [] },
        { segment: segment('bad', [1, 2], { from: 1, to: 4 }), generation: 1 }
      )
    ).toThrow('Invalid prose segment mapping')
  })
})

describe('LanguageToolProvider', () => {
  it('checks prose segments in order and forwards provider options and AbortSignal', async () => {
    const signal = new AbortController().signal
    const check = vi.fn(async () => ({ matches: [] }))
    const transport: LanguageToolTransport = { check }
    const provider = new LanguageToolProvider(transport, {
      enabledCategories: ['GRAMMAR'],
      enabledRules: ['RULE_A'],
      disabledRules: ['RULE_B']
    })

    const result = await provider.check({
      segments: [segment(), segment('Bad', [30, 31, 32, 33], { from: 30, to: 33 })],
      generation: 4,
      language: 'en-US',
      signal
    })

    expect(result).toEqual([])
    expect(check).toHaveBeenCalledTimes(1)
    expect(check).toHaveBeenCalledWith(
      {
        text: 'One two\n\nBad',
        language: 'en-US',
        enabledCategories: ['GRAMMAR'],
        enabledRules: ['RULE_A'],
        disabledRules: ['RULE_B']
      },
      signal
    )
  })

  it('batches segments into one request and maps each match back to its own segment', async () => {
    const check = vi.fn<LanguageToolTransport['check']>(async () => ({
      matches: [
        { ...grammarMatch, context: undefined, offset: 0, length: 3 },
        { ...grammarMatch, context: undefined, offset: 9, length: 3 }
      ]
    }))
    const provider = new LanguageToolProvider({ check })
    const second = {
      ...segment('Bad', [30, 31, 32, 33], { from: 30, to: 33 }),
      id: 'paragraph-2'
    }

    const result = await provider.check({
      segments: [segment(), second],
      generation: 1,
      language: 'en-US',
      signal: new AbortController().signal
    })

    expect(check).toHaveBeenCalledTimes(1)
    expect(
      result.map((diagnostic) => [diagnostic.segmentId, diagnostic.range, diagnostic.original])
    ).toEqual([
      ['paragraph-1', { from: 5, to: 8 }, 'One'],
      ['paragraph-2', { from: 30, to: 33 }, 'Bad']
    ])
  })

  it('drops matches that cross a segment boundary or sit in the separator', async () => {
    const check = vi.fn<LanguageToolTransport['check']>(async () => ({
      matches: [
        { ...grammarMatch, context: undefined, offset: 6, length: 4 },
        { ...grammarMatch, context: undefined, offset: 7, length: 2 },
        { ...grammarMatch, context: undefined, offset: 9, length: 3 }
      ]
    }))
    const provider = new LanguageToolProvider({ check })
    const second = { ...segment('Bad', [30, 31, 32, 33], { from: 30, to: 33 }), id: 'paragraph-2' }

    const result = await provider.check({
      segments: [segment(), second],
      generation: 1,
      language: 'en-US',
      signal: new AbortController().signal
    })

    expect(result.map((diagnostic) => diagnostic.segmentId)).toEqual(['paragraph-2'])
  })

  it('maps UTF-16 offsets across multi-byte characters in a batch', async () => {
    // Response offsets index the batch text 'Café\n\né 😀x' in UTF-16 units.
    const check = vi.fn<LanguageToolTransport['check']>(async () => ({
      matches: [
        { ...grammarMatch, context: undefined, offset: 3, length: 1 },
        { ...grammarMatch, context: undefined, offset: 8, length: 2 },
        { ...grammarMatch, context: undefined, offset: 10, length: 1 }
      ]
    }))
    const provider = new LanguageToolProvider({ check })
    const first = segment('Café', [5, 6, 7, 8, 9], { from: 5, to: 9 })
    const second = {
      ...segment('é 😀x', [30, 31, 32, 33, 34, 35], { from: 30, to: 35 }),
      id: 'paragraph-2'
    }

    const result = await provider.check({
      segments: [first, second],
      generation: 1,
      language: 'en-US',
      signal: new AbortController().signal
    })

    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Café\n\né 😀x' }),
      expect.any(AbortSignal)
    )
    expect(
      result.map((diagnostic) => [diagnostic.segmentId, diagnostic.range, diagnostic.original])
    ).toEqual([
      ['paragraph-1', { from: 8, to: 9 }, 'é'],
      ['paragraph-2', { from: 32, to: 34 }, '😀'],
      ['paragraph-2', { from: 34, to: 35 }, 'x']
    ])
  })

  it('packs segments by UTF-8 bytes, not UTF-16 units, against the request limit', async () => {
    const check = vi.fn<LanguageToolTransport['check']>(async () => ({ matches: [] }))
    const provider = new LanguageToolProvider({ check })
    // 1 200 UTF-8 bytes but only 600 UTF-16 units: a length-based packer would fit both in one request.
    const accented = 'é'.repeat(600)

    await provider.check({
      segments: [
        segmentFor('paragraph-1', 'x'.repeat(GRAMMAR_MAX_TEXT_BYTES - 1000)),
        segmentFor('paragraph-2', accented)
      ],
      generation: 1,
      language: 'en-US',
      signal: new AbortController().signal
    })

    expect(check).toHaveBeenCalledTimes(2)
    for (const [request] of check.mock.calls) {
      expect(new TextEncoder().encode(request.text).length).toBeLessThanOrEqual(
        GRAMMAR_MAX_TEXT_BYTES
      )
    }
  })

  it('leaves out a segment over the request limit and still checks the others', async () => {
    const check = vi.fn<LanguageToolTransport['check']>(async () => ({ matches: [] }))
    const provider = new LanguageToolProvider({ check })

    await provider.check({
      segments: [
        segmentFor('paragraph-1', 'é'.repeat(GRAMMAR_MAX_TEXT_BYTES / 2 + 1)),
        segmentFor('paragraph-2', 'Fine.')
      ],
      generation: 1,
      language: 'en-US',
      signal: new AbortController().signal
    })

    expect(check).toHaveBeenCalledOnce()
    expect(check.mock.calls[0][0].text).toBe('Fine.')
  })

  it('stops between batches when the signal is aborted', async () => {
    const controller = new AbortController()
    const reason = new Error('superseded')
    const check = vi.fn<LanguageToolTransport['check']>(async () => {
      controller.abort(reason)
      return { matches: [] }
    })
    const provider = new LanguageToolProvider({ check })

    await expect(
      provider.check({
        segments: [
          segmentFor('paragraph-1', 'x'.repeat(GRAMMAR_MAX_TEXT_BYTES)),
          segmentFor('paragraph-2', 'Bad')
        ],
        generation: 1,
        language: 'en-US',
        signal: controller.signal
      })
    ).rejects.toBe(reason)
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('stops before another segment when the signal is aborted', async () => {
    const controller = new AbortController()
    const reason = new Error('superseded')
    const check = vi.fn(async () => {
      controller.abort(reason)
      return { matches: [] }
    })
    const provider = new LanguageToolProvider({ check })

    await expect(
      provider.check({
        segments: [segment(), segment()],
        generation: 1,
        language: 'en-US',
        signal: controller.signal
      })
    ).rejects.toBe(reason)
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('filters disabled categories, ignored rules, and custom dictionary entries locally', async () => {
    const check = vi.fn(async () => ({
      matches: [
        grammarMatch,
        {
          ...grammarMatch,
          message: 'Possible spelling mistake.',
          offset: 0,
          length: 3,
          rule: {
            ...grammarMatch.rule,
            id: 'SPELLING_RULE',
            issueType: 'misspelling',
            category: { id: 'TYPOS', name: 'Possible Typo' }
          }
        },
        {
          ...grammarMatch,
          rule: {
            ...grammarMatch.rule,
            id: 'STYLE_RULE',
            issueType: 'style',
            category: { id: 'STYLE', name: 'Style' }
          }
        }
      ]
    }))
    const provider = new LanguageToolProvider(
      { check },
      {
        visibleCategories: ['grammar', 'spelling'],
        disabledRules: ['AGREEMENT_SENT_START'],
        customDictionary: ['one']
      }
    )

    await expect(
      provider.check({
        segments: [segment()],
        generation: 1,
        language: 'en-US',
        signal: new AbortController().signal
      })
    ).resolves.toEqual([])
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ disabledRules: ['AGREEMENT_SENT_START'] }),
      expect.any(AbortSignal)
    )
  })

  it('does not call transport for an already-aborted or empty request', async () => {
    const check = vi.fn(async () => ({ matches: [] }))
    const provider = new LanguageToolProvider({ check })
    const aborted = new AbortController()
    aborted.abort()

    await expect(
      provider.check({
        segments: [segment()],
        generation: 1,
        language: 'en-US',
        signal: aborted.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' })

    await expect(
      provider.check({
        segments: [],
        generation: 1,
        language: 'en-US',
        signal: new AbortController().signal
      })
    ).resolves.toEqual([])
    expect(check).not.toHaveBeenCalled()
  })
})
