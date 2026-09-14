import { describe, expect, it, vi } from 'vitest'
import type { GrammarProvider } from './provider'
import { GrammarCheckCoordinator } from './coordinator'
import type { GrammarCheckRequest, GrammarDiagnostic, ProseSegment } from './types'

function segment(id: string, text: string, from = 0): ProseSegment {
  return {
    id,
    text,
    sourceRange: { from, to: from + text.length },
    sourceMap: Array.from({ length: text.length + 1 }, (_, index) => from + index)
  }
}

function diagnostic(
  source: ProseSegment,
  generation: number,
  offset = 0,
  length = source.text.length
): GrammarDiagnostic {
  return {
    id: `diagnostic-${source.id}`,
    provider: 'test',
    ruleId: 'TEST_RULE',
    category: 'grammar',
    message: 'Test diagnostic',
    range: {
      from: source.sourceMap[offset]!,
      to: source.sourceMap[offset + length]!
    },
    original: source.text.slice(offset, offset + length),
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

function request(
  generation: number,
  segments: readonly ProseSegment[],
  overrides: Partial<Parameters<GrammarCheckCoordinator['schedule']>[0]> = {}
) {
  return {
    documentId: 'note.md',
    generation,
    segments,
    language: 'en-US',
    ...overrides
  }
}

describe('GrammarCheckCoordinator', () => {
  it('debounces checks, rechecks only changed segments, and preserves unchanged diagnostics', async () => {
    vi.useFakeTimers()
    try {
      const first = segment('first', 'This are wrong.', 0)
      const second = segment('second', 'Another eror.', 20)
      const grammarProvider = provider(async ({ segments, generation }) =>
        segments.map((item) => diagnostic(item, generation))
      )
      const coordinator = new GrammarCheckCoordinator(grammarProvider, { debounceMs: 750 })

      const initial = coordinator.schedule(request(1, [first, second]))
      expect(grammarProvider.check).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(750)
      await expect(initial).resolves.toMatchObject({ accepted: true })
      expect(grammarProvider.check).toHaveBeenCalledOnce()

      const changed = segment('second', 'Another error.', 20)
      const next = coordinator.schedule(request(2, [first, changed]))
      expect(coordinator.getState().diagnostics.map((item) => item.segmentId)).toEqual(['first'])
      await vi.advanceTimersByTimeAsync(750)
      await next

      expect(grammarProvider.check).toHaveBeenCalledTimes(2)
      expect(vi.mocked(grammarProvider.check).mock.calls[1]?.[0].segments).toEqual([changed])
      expect(coordinator.getState()).toMatchObject({ generation: 2, status: 'ready' })
      expect(coordinator.getState().diagnostics.map((item) => item.segmentId)).toEqual([
        'first',
        'second'
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a superseded response even when the provider ignores cancellation', async () => {
    const resolvers: Array<(value: readonly GrammarDiagnostic[]) => void> = []
    const grammarProvider = provider(
      () => new Promise((resolve) => resolvers.push(resolve))
    )
    const coordinator = new GrammarCheckCoordinator(grammarProvider, { debounceMs: 0 })
    const oldSegment = segment('paragraph', 'Old eror.')
    const newSegment = segment('paragraph', 'New eror.')

    const oldCheck = coordinator.schedule(request(1, [oldSegment]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const newCheck = coordinator.schedule(request(2, [newSegment]))
    await new Promise((resolve) => setTimeout(resolve, 0))

    resolvers[1]([diagnostic(newSegment, 2)])
    await expect(newCheck).resolves.toMatchObject({ accepted: true })
    resolvers[0]([diagnostic(oldSegment, 1)])
    await expect(oldCheck).resolves.toMatchObject({ accepted: false, reason: 'superseded' })

    expect(coordinator.getState().generation).toBe(2)
    expect(coordinator.getState().diagnostics[0]).toMatchObject({
      generation: 2,
      original: 'New eror.'
    })
  })

  it('safely rebases unchanged cached diagnostics after text is inserted before a segment', async () => {
    const grammarProvider = provider(async ({ segments, generation }) =>
      segments.map((item) => diagnostic(item, generation, 0, 4))
    )
    const coordinator = new GrammarCheckCoordinator(grammarProvider, { debounceMs: 0 })
    const original = segment('paragraph', 'Eror here.', 10)

    const first = coordinator.schedule(request(1, [original]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await first

    const shifted = segment('paragraph', 'Eror here.', 25)
    const second = coordinator.schedule(request(2, [shifted]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await second

    expect(grammarProvider.check).toHaveBeenCalledOnce()
    expect(coordinator.getState().diagnostics[0]).toMatchObject({
      generation: 2,
      range: { from: 25, to: 29 }
    })
  })

  it('rechecks cached text when safe insertion boundaries change', async () => {
    const grammarProvider = provider(async () => [])
    const coordinator = new GrammarCheckCoordinator(grammarProvider, { debounceMs: 0 })
    const original = {
      ...segment('paragraph', 'word'),
      insertionMap: [0, 1, 2, 3, 4]
    }

    const first = coordinator.schedule(request(1, [original]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await first

    const changedBoundary = {
      ...original,
      insertionMap: [0, null, 2, 3, 4]
    }
    const second = coordinator.schedule(request(2, [changedBoundary]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await second

    expect(grammarProvider.check).toHaveBeenCalledTimes(2)
  })

  it('chunks large checks and never sends an unbounded segment list', async () => {
    const grammarProvider = provider(async () => [])
    const coordinator = new GrammarCheckCoordinator(grammarProvider, {
      debounceMs: 0,
      maxSegmentsPerBatch: 2,
      maxCharactersPerBatch: 1_000
    })
    const segments = [segment('a', 'one'), segment('b', 'two'), segment('c', 'three')]

    const result = coordinator.schedule(request(1, segments))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await result

    expect(vi.mocked(grammarProvider.check).mock.calls.map((call) => call[0].segments.length)).toEqual([
      2, 1
    ])
  })

  it('does not call a provider while checking is disabled', async () => {
    const grammarProvider = provider(async () => [])
    const coordinator = new GrammarCheckCoordinator(grammarProvider)

    await expect(
      coordinator.schedule(request(1, [segment('paragraph', 'Text')], { enabled: false }))
    ).resolves.toMatchObject({ accepted: false, reason: 'disabled' })
    expect(grammarProvider.check).not.toHaveBeenCalled()
    expect(coordinator.getState()).toMatchObject({ status: 'disabled', diagnostics: [] })
  })
})
