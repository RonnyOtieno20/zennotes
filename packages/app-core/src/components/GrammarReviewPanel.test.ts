// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GrammarDocumentSessionState } from '../grammar/document-sessions'
import type { GrammarCategory, GrammarDiagnostic } from '../grammar/types'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const storeMock = vi.hoisted(() => ({
  state: {
    panelWidths: { grammar: 340 },
    focusedPanel: 'grammar',
    grammarCursorIndex: 0,
    setPanelWidth: vi.fn(),
    setFocusedPanel: vi.fn(),
    setGrammarCursorIndex: vi.fn()
  }
}))

vi.mock('../store', () => ({
  useStore: (selector: (state: typeof storeMock.state) => unknown) => selector(storeMock.state)
}))

import {
  GrammarReviewPanel,
  countGrammarDiagnostics,
  filterGrammarDiagnostics
} from './GrammarReviewPanel'

const mounted: Array<{ root: Root; container: HTMLElement }> = []

afterEach(() => {
  while (mounted.length) {
    const item = mounted.pop()!
    act(() => item.root.unmount())
    item.container.remove()
  }
  vi.clearAllMocks()
})

function diagnostic(
  id: string,
  category: GrammarCategory,
  from: number,
  original: string,
  replacement: string
): GrammarDiagnostic {
  return {
    id,
    provider: 'test',
    ruleId: `rule-${id}`,
    category,
    message: `Problem ${id}`,
    range: { from, to: from + original.length },
    original,
    replacements: [{ value: replacement }],
    severity: 'warning',
    generation: 1,
    segmentId: `segment-${id}`
  }
}

const issues = [
  diagnostic('spell', 'spelling', 0, 'eror', 'error'),
  diagnostic('grammar', 'grammar', 10, 'are', 'is')
]

function sessionState(
  overrides: Partial<GrammarDocumentSessionState> = {}
): GrammarDocumentSessionState {
  return {
    documentKey: { vaultId: '/vault', notePath: 'note.md' },
    documentId: 'note.md',
    documentFingerprint: '20:test',
    generation: 1,
    status: 'ready',
    diagnostics: issues,
    selectedDiagnosticId: 'spell',
    ignoredDiagnosticIds: [],
    segments: [],
    ...overrides
  }
}

function renderPanel(
  overrides: {
    enabled?: boolean
    supported?: boolean
    state?: GrammarDocumentSessionState | null
  } = {}
): {
  container: HTMLElement
  onEnable: ReturnType<typeof vi.fn>
  onSelect: ReturnType<typeof vi.fn>
  onApply: ReturnType<typeof vi.fn>
  onIgnore: ReturnType<typeof vi.fn>
  onIgnoreRule: ReturnType<typeof vi.fn>
  onAddToDictionary: ReturnType<typeof vi.fn>
  onRecheck: ReturnType<typeof vi.fn>
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  const callbacks = {
    onEnable: vi.fn(),
    onSelect: vi.fn(),
    onApply: vi.fn(),
    onIgnore: vi.fn(),
    onIgnoreRule: vi.fn(),
    onAddToDictionary: vi.fn(),
    onRecheck: vi.fn()
  }
  act(() => {
    root.render(
      createElement(GrammarReviewPanel, {
        enabled: overrides.enabled ?? true,
        supported: overrides.supported ?? true,
        state: overrides.state === undefined ? sessionState() : overrides.state,
        ...callbacks
      })
    )
  })
  return { container, ...callbacks }
}

function click(element: Element | null): void {
  expect(element).not.toBeNull()
  act(() => (element as HTMLElement).click())
}

describe('grammar review model', () => {
  it('counts and filters issue categories', () => {
    expect(countGrammarDiagnostics(issues)).toMatchObject({
      all: 2,
      spelling: 1,
      grammar: 1,
      punctuation: 0
    })
    expect(filterGrammarDiagnostics(issues, 'spelling').map((item) => item.id)).toEqual(['spell'])
  })
})

describe('GrammarReviewPanel', () => {
  it('keeps shortcuts and controls in responsive panel rows', () => {
    const { container } = renderPanel()
    expect(container.querySelector('[data-grammar-panel]')).not.toBeNull()
    expect(container.querySelector('.grammar-review-shortcuts')?.textContent).toContain(
      'F8 / Shift+F8 issues'
    )
    expect(container.querySelector('.grammar-review-toolbar')).not.toBeNull()
  })

  it('renders categorized cards and applies a replacement with one click', () => {
    const { container, onApply } = renderPanel()
    expect(container.textContent).toContain('2 issues · Local')
    expect(container.querySelectorAll('[data-grammar-idx]')).toHaveLength(2)
    click(container.querySelector('[data-panel-activate]'))
    expect(onApply).toHaveBeenCalledWith('spell', 0)
  })

  it('filters cards by category', () => {
    const { container } = renderPanel()
    click(
      [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Spelling 1'
      ) ?? null
    )
    expect(container.querySelectorAll('[data-grammar-idx]')).toHaveLength(1)
    expect(container.textContent).toContain('Problem spell')
    expect(container.textContent).not.toContain('Problem grammar')
  })

  it('exposes persistent rule and dictionary actions for each issue', () => {
    const { container, onIgnoreRule, onAddToDictionary } = renderPanel()
    const firstCard = container.querySelector('[data-grammar-id="spell"]')
    const button = (label: string): HTMLButtonElement | undefined =>
      [...(firstCard?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        (candidate) => candidate.textContent === label
      )

    click(button('Ignore rule') ?? null)
    expect(onIgnoreRule).toHaveBeenCalledWith(issues[0])
    click(button('Add word') ?? null)
    expect(onAddToDictionary).toHaveBeenCalledWith(issues[0])
  })

  it('shows disabled and connection-failure states with recovery actions', () => {
    const disabled = renderPanel({ enabled: false, state: null })
    expect(disabled.container.textContent).toContain('Grammar checking is off')
    click(
      [...disabled.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Enable grammar')
      ) ?? null
    )
    expect(disabled.onEnable).toHaveBeenCalledOnce()

    const failed = renderPanel({
      state: sessionState({
        status: 'error',
        diagnostics: [],
        error: 'Connection refused'
      })
    })
    expect(failed.container.textContent).toContain('Connection failed')
    expect(failed.container.textContent).toContain('Connection refused')
    click(
      [...failed.container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Try again'
      ) ?? null
    )
    expect(failed.onRecheck).toHaveBeenCalledOnce()
  })
})
