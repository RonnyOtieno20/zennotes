import { describe, expect, it, vi } from 'vitest'
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
    expect(check).toHaveBeenCalledTimes(2)
    expect(check).toHaveBeenNthCalledWith(
      1,
      {
        text: 'One two',
        language: 'en-US',
        enabledCategories: ['GRAMMAR'],
        enabledRules: ['RULE_A'],
        disabledRules: ['RULE_B']
      },
      signal
    )
    expect(check).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: 'Bad', language: 'en-US' }),
      signal
    )
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
