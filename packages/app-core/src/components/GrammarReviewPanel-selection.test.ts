// @vitest-environment jsdom

import { act, createElement, useCallback, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GrammarDocumentSessionState } from '../grammar/document-sessions'
import type { GrammarCategory, GrammarDiagnostic } from '../grammar/types'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A store that notifies subscribers, so cursor writes re-render the panel the way zustand does.
const storeMock = vi.hoisted(() => ({
  state: { grammarCursorIndex: 0 },
  listeners: new Set<() => void>()
}))

vi.mock('../store', async () => {
  const { useSyncExternalStore } = await import('react')
  const subscribe = (listener: () => void): (() => void) => {
    storeMock.listeners.add(listener)
    return () => storeMock.listeners.delete(listener)
  }
  const state = {
    panelWidths: { grammar: 340 },
    focusedPanel: 'grammar',
    grammarCursorIndex: 0,
    setPanelWidth: (): void => undefined,
    setFocusedPanel: (): void => undefined,
    setGrammarCursorIndex: (idx: number): void => {
      storeMock.state.grammarCursorIndex = idx
      storeMock.listeners.forEach((listener) => listener())
    }
  }
  return {
    useStore: (selector: (store: typeof state) => unknown) =>
      useSyncExternalStore(subscribe, () =>
        selector({ ...state, grammarCursorIndex: storeMock.state.grammarCursorIndex })
      )
  }
})

import { GrammarReviewPanel } from './GrammarReviewPanel'

const mounted: Array<{ root: Root; container: HTMLElement }> = []

afterEach(() => {
  while (mounted.length) {
    const item = mounted.pop()!
    act(() => item.root.unmount())
    item.container.remove()
  }
  storeMock.state.grammarCursorIndex = 0
  storeMock.listeners.clear()
})

function diagnostic(id: string, category: GrammarCategory, from: number): GrammarDiagnostic {
  return {
    id,
    provider: 'test',
    ruleId: `rule-${id}`,
    category,
    message: `Problem ${id}`,
    range: { from, to: from + 4 },
    original: 'word',
    replacements: [{ value: 'fixed' }],
    severity: 'warning',
    generation: 1,
    segmentId: `segment-${id}`
  }
}

const issues = [
  diagnostic('spell', 'spelling', 0),
  diagnostic('grammar', 'grammar', 10),
  diagnostic('style', 'style', 20)
]

// Simulates the j/k keys, which only move the store cursor.
function moveCursor(index: number): void {
  storeMock.state.grammarCursorIndex = index
  storeMock.listeners.forEach((listener) => listener())
}

function sessionState(selectedDiagnosticId: string): GrammarDocumentSessionState {
  return {
    documentKey: { vaultId: '/vault', notePath: 'note.md' },
    documentId: 'note.md',
    documentFingerprint: '20:test',
    generation: 1,
    status: 'ready',
    diagnostics: issues,
    selectedDiagnosticId,
    ignoredDiagnosticIds: [],
    segments: []
  }
}

// Stands in for EditorPane: it owns the selected diagnostic and echoes onSelect back into it.
// `echoLimit` bounds the echo so a feedback loop fails the test instead of hanging it.
function renderPanel(initialId: string, echoLimit = 20): {
  onSelect: ReturnType<typeof vi.fn>
  select: (id: string) => void
} {
  const onSelect = vi.fn()
  const controls = { select: (_id: string): void => undefined }
  function Harness(): JSX.Element {
    const [selectedId, setSelectedId] = useState(initialId)
    const handleSelect = useCallback(
      (id: string): void => {
        onSelect(id)
        if (onSelect.mock.calls.length <= echoLimit) setSelectedId(id)
      },
      []
    )
    useEffect(() => {
      controls.select = setSelectedId
    }, [])
    return createElement(GrammarReviewPanel, {
      enabled: true,
      supported: true,
      state: sessionState(selectedId),
      onEnable: vi.fn(),
      onSelect: handleSelect,
      onApply: vi.fn(),
      onIgnore: vi.fn(),
      onRecheck: vi.fn()
    })
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  act(() => root.render(createElement(Harness)))
  return { onSelect, select: (id) => act(() => controls.select(id)) }
}

describe('GrammarReviewPanel selection sync', () => {
  it('follows a selection made in the editor without echoing it back', () => {
    const { onSelect, select } = renderPanel('spell')

    select('grammar')

    expect(storeMock.state.grammarCursorIndex).toBe(1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('selects the row once when the cursor moves, and keeps the cursor there', () => {
    const { onSelect } = renderPanel('spell')

    act(() => moveCursor(2))

    expect(onSelect.mock.calls).toEqual([['style']])
    expect(storeMock.state.grammarCursorIndex).toBe(2)
  })
})
