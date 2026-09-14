// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GrammarDocumentSessionRegistry } from './document-sessions'
import { applyGrammarReplacement, getGrammarEditorState } from './editor-extension'
import { createGrammarEditorBinding, type GrammarEditorBindingOptions } from './editor-runtime'
import type { GrammarProvider } from './provider'
import type { GrammarDiagnostic } from './types'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
  vi.useRealTimers()
})

function providerWithBadDiagnostic(): GrammarProvider & {
  check: ReturnType<typeof vi.fn>
} {
  return {
    id: 'test',
    check: vi.fn(async ({ segments, generation }) => {
      const diagnostics: GrammarDiagnostic[] = []
      for (const segment of segments) {
        const offset = segment.text.indexOf('bad')
        if (offset < 0) continue
        const from = segment.sourceMap[offset]
        const last = segment.sourceMap[offset + 2]
        if (from == null || last == null) continue
        diagnostics.push({
          id: `bad:${segment.id}`,
          provider: 'test',
          ruleId: 'BAD_WORD',
          category: 'style',
          message: 'Use a clearer word.',
          range: { from, to: last + 1 },
          original: 'bad',
          replacements: [{ value: 'clear' }],
          severity: 'warning',
          generation,
          segmentId: segment.id
        })
      }
      return diagnostics
    })
  }
}

function mount(
  registry: GrammarDocumentSessionRegistry,
  notePath = 'note.md',
  doc = 'A bad sentence.',
  options: GrammarEditorBindingOptions = {}
): {
  view: EditorView
  binding: ReturnType<typeof createGrammarEditorBinding>
  release(): void
} {
  const binding = createGrammarEditorBinding(
    registry,
    { vaultId: '/vault', notePath },
    { maxAutomaticCheckCharacters: 10_000, ...options }
  )
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage, addKeymap: false }), binding.extension]
    })
  })
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    view.destroy()
    binding.release()
    parent.remove()
  }
  cleanups.push(release)
  return { view, binding, release }
}

async function flushCheck(debounceMs: number): Promise<void> {
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(debounceMs)
  await Promise.resolve()
}

describe('grammar editor runtime', () => {
  it('checks initial prose and rechecks after an editor transaction', async () => {
    vi.useFakeTimers()
    const grammarProvider = providerWithBadDiagnostic()
    const registry = new GrammarDocumentSessionRegistry(grammarProvider, {
      debounceMs: 10
    })
    const { view } = mount(registry)

    await flushCheck(10)
    expect(grammarProvider.check).toHaveBeenCalledOnce()
    expect(getGrammarEditorState(view.state)?.diagnostics).toHaveLength(1)

    view.dispatch({ changes: { from: 2, to: 5, insert: 'clear' } })
    await flushCheck(10)
    expect(grammarProvider.check).toHaveBeenCalledTimes(2)
    expect(getGrammarEditorState(view.state)?.diagnostics).toEqual([])
  })

  it('retries the initial automatic check when the Markdown parser is not ready', async () => {
    vi.useFakeTimers()
    const grammarProvider = providerWithBadDiagnostic()
    const registry = new GrammarDocumentSessionRegistry(grammarProvider, {
      debounceMs: 10
    })
    const automaticParseReady = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
    const { view } = mount(registry, 'note.md', 'A bad sentence.', {
      automaticParseReady,
      automaticParseRetryMs: 5
    })

    await Promise.resolve()
    expect(grammarProvider.check).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5)
    await flushCheck(10)
    expect(automaticParseReady).toHaveBeenCalledTimes(2)
    expect(grammarProvider.check).toHaveBeenCalledOnce()
    expect(getGrammarEditorState(view.state)?.diagnostics).toHaveLength(1)
  })

  it('supports an immediate full-note recheck for the review panel', async () => {
    vi.useFakeTimers()
    const grammarProvider = providerWithBadDiagnostic()
    const registry = new GrammarDocumentSessionRegistry(grammarProvider, {
      debounceMs: 10
    })
    const { view, binding } = mount(registry)

    await flushCheck(10)
    expect(grammarProvider.check).toHaveBeenCalledOnce()
    const outcomePromise = binding.checkNow(view.state)
    await vi.advanceTimersByTimeAsync(0)
    const outcome = await outcomePromise
    expect(outcome.accepted).toBe(true)
    expect(grammarProvider.check).toHaveBeenCalledTimes(2)
    expect(binding.session.getState().status).toBe('ready')
  })

  it('can pause automatic checks while keeping manual full-note checks available', async () => {
    vi.useFakeTimers()
    const grammarProvider = providerWithBadDiagnostic()
    const registry = new GrammarDocumentSessionRegistry(grammarProvider, {
      debounceMs: 10
    })
    const { view, binding } = mount(registry, 'note.md', 'A bad sentence.', {
      automaticChecks: false
    })

    await flushCheck(10)
    expect(grammarProvider.check).not.toHaveBeenCalled()
    expect(binding.session.getState().status).toBe('disabled')

    const outcomePromise = binding.checkNow(view.state)
    await vi.advanceTimersByTimeAsync(0)
    await expect(outcomePromise).resolves.toMatchObject({ accepted: true })
    expect(grammarProvider.check).toHaveBeenCalledOnce()
  })

  it('pauses automatic provider work above the configured large-note limit', async () => {
    vi.useFakeTimers()
    const grammarProvider = providerWithBadDiagnostic()
    const registry = new GrammarDocumentSessionRegistry(grammarProvider, {
      debounceMs: 10
    })
    const { binding } = mount(registry, 'large.md', 'A bad sentence beyond the limit.', {
      maxAutomaticCheckCharacters: 12
    })

    await flushCheck(10)
    expect(grammarProvider.check).not.toHaveBeenCalled()
    expect(binding.session.getState()).toMatchObject({
      status: 'disabled',
      diagnostics: []
    })
  })

  it('deduplicates the provider check for two panes on the same note', async () => {
    vi.useFakeTimers()
    const grammarProvider = providerWithBadDiagnostic()
    const registry = new GrammarDocumentSessionRegistry(grammarProvider, {
      debounceMs: 10
    })
    const left = mount(registry)
    const right = mount(registry)

    await flushCheck(10)
    expect(grammarProvider.check).toHaveBeenCalledOnce()
    expect(getGrammarEditorState(left.view.state)?.diagnostics).toHaveLength(1)
    expect(getGrammarEditorState(right.view.state)?.diagnostics).toHaveLength(1)
    expect(registry.getReferenceCount({ vaultId: '/vault', notePath: 'note.md' })).toBe(2)
  })

  it('applies in one pane and removes the accepted issue from every split pane', async () => {
    vi.useFakeTimers()
    const registry = new GrammarDocumentSessionRegistry(providerWithBadDiagnostic(), {
      debounceMs: 10
    })
    const left = mount(registry)
    const right = mount(registry)
    await flushCheck(10)

    const issue = getGrammarEditorState(left.view.state)?.diagnostics[0]
    expect(issue).toBeDefined()
    expect(applyGrammarReplacement(left.view, issue!.id, 0)).toMatchObject({
      applied: true
    })
    expect(left.view.state.doc.toString()).toBe('A clear sentence.')
    expect(getGrammarEditorState(left.view.state)?.diagnostics).toEqual([])
    expect(getGrammarEditorState(right.view.state)?.diagnostics).toEqual([])
  })

  it('rejects a correction after any unscheduled full-document drift', async () => {
    vi.useFakeTimers()
    const grammarProvider = providerWithBadDiagnostic()
    const registry = new GrammarDocumentSessionRegistry(grammarProvider, {
      debounceMs: 10
    })
    const { view } = mount(registry)

    await flushCheck(10)
    const issue = getGrammarEditorState(view.state)?.diagnostics[0]
    expect(issue).toBeDefined()

    // This edit is after the issue, so its local mapped range remains valid.
    // The session's complete-document validator must still reject the apply
    // before the queued recheck has a chance to advance the generation.
    view.dispatch({
      changes: { from: view.state.doc.length, insert: ' Extra.' }
    })
    expect(applyGrammarReplacement(view, issue!.id, 0)).toEqual({
      applied: false,
      diagnosticId: issue!.id,
      reason: 'diagnostic'
    })
    expect(view.state.doc.toString()).toBe('A bad sentence. Extra.')
  })

  it('releasing the final pane cancels and removes the note session', async () => {
    vi.useFakeTimers()
    const providerSignals: AbortSignal[] = []
    const grammarProvider: GrammarProvider = {
      id: 'deferred',
      check: vi.fn(({ signal }) => {
        providerSignals.push(signal)
        return new Promise<readonly GrammarDiagnostic[]>(() => undefined)
      })
    }
    const registry = new GrammarDocumentSessionRegistry(grammarProvider, {
      debounceMs: 0
    })
    const mounted = mount(registry)
    await flushCheck(0)
    expect(registry.size).toBe(1)
    expect(providerSignals[0]?.aborted).toBe(false)

    mounted.release()
    expect(registry.size).toBe(0)
    expect(providerSignals[0]?.aborted).toBe(true)
  })

  it('never publishes a released note response into the next note binding', async () => {
    vi.useFakeTimers()
    const resolvers: Array<(value: readonly GrammarDiagnostic[]) => void> = []
    const grammarProvider: GrammarProvider = {
      id: 'deferred',
      check: vi.fn(
        () =>
          new Promise<readonly GrammarDiagnostic[]>((resolve) => {
            resolvers.push(resolve)
          })
      )
    }
    const registry = new GrammarDocumentSessionRegistry(grammarProvider, {
      debounceMs: 0
    })
    const noteA = mount(registry, 'a.md')
    await flushCheck(0)
    expect(resolvers).toHaveLength(1)

    noteA.release()
    const noteB = mount(registry, 'b.md', 'A clean sentence.')
    await flushCheck(0)
    expect(resolvers).toHaveLength(2)

    resolvers[0]?.([
      {
        id: 'late-a',
        provider: 'deferred',
        ruleId: 'LATE',
        category: 'grammar',
        message: 'Late issue',
        range: { from: 2, to: 5 },
        original: 'bad',
        replacements: [{ value: 'clear' }],
        severity: 'warning',
        generation: 1,
        segmentId: 'old-segment'
      }
    ])
    await Promise.resolve()
    expect(getGrammarEditorState(noteB.view.state)?.diagnostics).toEqual([])

    resolvers[1]?.([])
    await Promise.resolve()
  })
})
