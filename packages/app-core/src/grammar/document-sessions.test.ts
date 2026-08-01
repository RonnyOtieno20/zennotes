import { describe, expect, it, vi } from 'vitest'
import type { GrammarProvider } from './provider'
import {
  GrammarDocumentSessionRegistry,
  createGrammarDocumentId,
  type GrammarApplyValidationInput,
  type GrammarDocumentKey,
  type GrammarDocumentSession
} from './document-sessions'
import type { GrammarCheckRequest, GrammarDiagnostic, ProseSegment } from './types'

const NOTE: GrammarDocumentKey = {
  vaultId: '/vaults/work',
  notePath: 'inbox/note.md'
}

function segment(id: string, text: string, from = 0): ProseSegment {
  return {
    id,
    text,
    sourceRange: { from, to: from + text.length },
    sourceMap: Array.from({ length: text.length + 1 }, (_, index) => from + index),
    fingerprint: `fingerprint:${text}`
  }
}

function diagnostic(
  source: ProseSegment,
  generation: number,
  id = `diagnostic:${source.id}`
): GrammarDiagnostic {
  return {
    id,
    provider: 'test',
    ruleId: 'TEST_RULE',
    category: 'grammar',
    message: 'Test diagnostic',
    range: { ...source.sourceRange },
    original: source.text,
    replacements: [{ value: 'fixed' }],
    severity: 'warning',
    generation,
    segmentId: source.id
  }
}

function provider(
  implementation: (request: GrammarCheckRequest) => Promise<readonly GrammarDiagnostic[]>
): GrammarProvider {
  return { id: 'test', check: vi.fn(implementation) }
}

async function advanceCheck<T>(promise: Promise<T>, milliseconds = 0): Promise<T> {
  await vi.advanceTimersByTimeAsync(milliseconds)
  return promise
}

function applyInput(
  session: GrammarDocumentSession,
  issue: GrammarDiagnostic,
  prose: ProseSegment,
  documentText: string
): GrammarApplyValidationInput {
  const state = session.getState()
  return {
    documentKey: state.documentKey,
    generation: state.generation,
    documentFingerprint: state.documentFingerprint,
    diagnosticId: issue.id,
    segmentId: prose.id,
    segmentFingerprint: prose.fingerprint!,
    range: { ...issue.range },
    original: issue.original,
    documentText
  }
}

describe('GrammarDocumentSessionRegistry', () => {
  it('shares one session and one in-flight provider request across split panes', async () => {
    vi.useFakeTimers()
    try {
      const prose = segment('paragraph', 'This are wrong.')
      const grammarProvider = provider(async ({ generation }) => [diagnostic(prose, generation)])
      const registry = new GrammarDocumentSessionRegistry(grammarProvider, {
        debounceMs: 25
      })
      const left = registry.acquire(NOTE)
      const right = registry.acquire({ ...NOTE })
      const observedStatuses: string[] = []
      right.session.subscribe((state) => observedStatuses.push(state.status))

      expect(left.session).toBe(right.session)
      expect(registry.getReferenceCount(NOTE)).toBe(2)

      const input = { text: prose.text, segments: [prose], language: 'en-US' }
      const leftCheck = left.session.schedule(input)
      const rightCheck = right.session.schedule(input)
      expect(leftCheck).toBe(rightCheck)

      await advanceCheck(leftCheck, 25)
      await expect(rightCheck).resolves.toMatchObject({ accepted: true })
      expect(grammarProvider.check).toHaveBeenCalledOnce()
      expect(observedStatuses).toContain('ready')
      expect(left.session.getState()).toMatchObject({
        documentKey: NOTE,
        documentId: createGrammarDocumentId(NOTE),
        generation: 1,
        status: 'ready'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects wrong-note and stale apply targets before returning a diagnostic', async () => {
    vi.useFakeTimers()
    try {
      const prose = segment('paragraph', 'Bad sentence.')
      const grammarProvider = provider(async ({ generation }) => [diagnostic(prose, generation)])
      const registry = new GrammarDocumentSessionRegistry(grammarProvider, {
        debounceMs: 0
      })
      const { session } = registry.acquire(NOTE)
      await advanceCheck(
        session.schedule({
          text: prose.text,
          segments: [prose],
          language: 'en-US'
        })
      )
      const issue = session.getState().diagnostics[0]!
      const current = applyInput(session, issue, prose, prose.text)

      expect(
        session.validateApply({
          ...current,
          documentKey: { ...NOTE, notePath: 'inbox/other.md' }
        })
      ).toEqual({ valid: false, reason: 'wrong-document' })
      expect(
        session.validateApply({
          ...current,
          generation: current.generation - 1
        })
      ).toEqual({
        valid: false,
        reason: 'stale-generation'
      })
      expect(session.validateApply({ ...current, range: { from: 1, to: 4 } })).toEqual({
        valid: false,
        reason: 'stale-range'
      })
      expect(session.validateApply({ ...current, original: 'Not the issue' })).toEqual({
        valid: false,
        reason: 'original-mismatch'
      })
      expect(
        session.validateApply({
          ...current,
          segmentFingerprint: 'stale-fingerprint'
        })
      ).toEqual({ valid: false, reason: 'stale-segment' })

      const changed = segment('paragraph', 'Changed sentence.')
      const staleCheck = session.schedule({
        text: changed.text,
        segments: [changed],
        language: 'en-US'
      })
      expect(session.validateApply(current)).toEqual({
        valid: false,
        reason: 'stale-document'
      })
      await advanceCheck(staleCheck)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps ignore-once shared and clears it after the document changes', async () => {
    vi.useFakeTimers()
    try {
      const prose = segment('paragraph', 'Bad sentence.')
      const grammarProvider = provider(async ({ segments, generation }) =>
        segments.map((item) => diagnostic(item, generation))
      )
      const registry = new GrammarDocumentSessionRegistry(grammarProvider, {
        debounceMs: 0
      })
      const left = registry.acquire(NOTE)
      const right = registry.acquire(NOTE)

      await advanceCheck(
        left.session.schedule({
          text: prose.text,
          segments: [prose],
          language: 'en-US'
        })
      )
      const issueId = left.session.getState().diagnostics[0]!.id
      expect(left.session.ignoreOnce(issueId)).toBe(true)
      expect(right.session.getState()).toMatchObject({
        diagnostics: [],
        ignoredDiagnosticIds: [issueId]
      })

      const changed = segment('paragraph', 'Bad sentence!')
      await advanceCheck(
        right.session.schedule({
          text: changed.text,
          segments: [changed],
          language: 'en-US'
        })
      )
      expect(left.session.getState().ignoredDiagnosticIds).toEqual([])
      expect(left.session.getState().diagnostics).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes disabled checks through without making a provider request', async () => {
    const grammarProvider = provider(async () => [])
    const registry = new GrammarDocumentSessionRegistry(grammarProvider)
    const { session } = registry.acquire(NOTE)
    const prose = segment('paragraph', 'Unchecked text')

    await expect(
      session.schedule({
        text: prose.text,
        segments: [prose],
        language: 'en-US',
        enabled: false
      })
    ).resolves.toMatchObject({ accepted: false, reason: 'disabled' })
    expect(grammarProvider.check).not.toHaveBeenCalled()
    expect(session.getState()).toMatchObject({
      status: 'disabled',
      diagnostics: []
    })
  })

  it('orders selection and returns the following diagnostic for a safe apply', async () => {
    vi.useFakeTimers()
    try {
      const first = segment('first', 'Bad', 0)
      const second = segment('second', 'Wrong', 4)
      const third = segment('third', 'Nope', 10)
      const text = 'Bad Wrong Nope'
      const grammarProvider = provider(async ({ generation }) => [
        diagnostic(third, generation),
        diagnostic(first, generation),
        diagnostic(second, generation)
      ])
      const registry = new GrammarDocumentSessionRegistry(grammarProvider, {
        debounceMs: 0
      })
      const { session } = registry.acquire(NOTE)
      await advanceCheck(
        session.schedule({
          text,
          segments: [first, second, third],
          language: 'en-US'
        })
      )

      expect(session.selectNextDiagnostic()).toBe('diagnostic:first')
      expect(session.selectNextDiagnostic()).toBe('diagnostic:second')
      expect(session.selectPreviousDiagnostic()).toBe('diagnostic:first')

      const issue = session.getState().diagnostics[1]!
      expect(session.validateApply(applyInput(session, issue, second, text))).toMatchObject({
        valid: true,
        diagnostic: { id: 'diagnostic:second' },
        nextDiagnosticId: 'diagnostic:third'
      })
      expect(session.selectDiagnosticAfter(issue.id)).toBe('diagnostic:third')
      expect(session.getState().selectedDiagnosticId).toBe('diagnostic:third')
    } finally {
      vi.useRealTimers()
    }
  })

  it('disposes and removes a session only after the final view releases it', async () => {
    const grammarProvider = provider(async () => [])
    const registry = new GrammarDocumentSessionRegistry(grammarProvider)
    const first = registry.acquire(NOTE)
    const second = registry.acquire(NOTE)
    const shared = first.session

    first.release()
    first.release()
    expect(registry.get(NOTE)).toBe(shared)
    expect(registry.getReferenceCount(NOTE)).toBe(1)

    second.release()
    expect(registry.get(NOTE)).toBeUndefined()
    expect(registry.size).toBe(0)
    await expect(
      shared.schedule({
        text: 'text',
        segments: [segment('paragraph', 'text')],
        language: 'en-US'
      })
    ).resolves.toMatchObject({ accepted: false, reason: 'disposed' })

    const replacement = registry.acquire(NOTE)
    expect(replacement.session).not.toBe(shared)
  })
})
