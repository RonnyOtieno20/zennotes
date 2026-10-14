import { Facet, StateEffect, StateField, type EditorState } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import type { GrammarDiagnostic } from './types'
import {
  emptySnapshot,
  mapGrammarDiagnostics,
  sortedValidDiagnostics,
  type GrammarEditorExtensionOptions,
  type GrammarEditorSession,
  type GrammarEditorSnapshot,
  type GrammarEditorState
} from './editor-diagnostics'

class GrammarInsertionWidget extends WidgetType {
  constructor(
    private readonly diagnostic: GrammarDiagnostic,
    private readonly selected: boolean
  ) {
    super()
  }

  eq(other: GrammarInsertionWidget): boolean {
    return other.diagnostic.id === this.diagnostic.id && other.selected === this.selected
  }

  toDOM(): HTMLElement {
    const dom = document.createElement('span')
    dom.className = diagnosticClass(this.diagnostic, this.selected)
    dom.dataset.grammarDiagnostic = this.diagnostic.id
    dom.setAttribute('aria-label', this.diagnostic.message)
    return dom
  }
}

function diagnosticClass(diagnostic: GrammarDiagnostic, selected: boolean): string {
  return [
    'cm-grammar-diagnostic',
    `cm-grammar-diagnostic-${diagnostic.category}`,
    selected ? 'cm-grammar-diagnostic-selected' : ''
  ]
    .filter(Boolean)
    .join(' ')
}

export function buildGrammarDecorations(
  diagnostics: readonly GrammarDiagnostic[],
  selectedDiagnosticId: string | null = null
): DecorationSet {
  const ranges = diagnostics.map((diagnostic) => {
    const selected = diagnostic.id === selectedDiagnosticId
    if (diagnostic.range.from === diagnostic.range.to) {
      return Decoration.widget({
        widget: new GrammarInsertionWidget(diagnostic, selected),
        side: 1
      }).range(diagnostic.range.from)
    }
    return Decoration.mark({
      class: diagnosticClass(diagnostic, selected),
      attributes: {
        'data-grammar-diagnostic': diagnostic.id,
        'data-grammar-category': diagnostic.category
      }
    }).range(diagnostic.range.from, diagnostic.range.to)
  })
  return Decoration.set(ranges, true)
}

export interface GrammarUiEffect {
  removeId?: string
  removeIds?: readonly string[]
  selectId?: string | null
  openId?: string | null
}

export const setGrammarSnapshot = StateEffect.define<GrammarEditorSnapshot>()
export const updateGrammarUi = StateEffect.define<GrammarUiEffect>()
export const setGrammarSuggestionCardsEnabled = StateEffect.define<boolean>()

export const grammarSessionFacet = Facet.define<
  GrammarEditorExtensionOptions,
  GrammarEditorExtensionOptions | null
>({
  combine: (values) => values[values.length - 1] ?? null
})

function makeEditorState(
  snapshot: GrammarEditorSnapshot,
  docLength: number,
  selectedDiagnosticId: string | null = snapshot.selectedDiagnosticId ?? null,
  openDiagnosticId: string | null = null,
  showUnderlines = true
): GrammarEditorState {
  const diagnostics = sortedValidDiagnostics(
    snapshot.diagnostics.filter((diagnostic) => diagnostic.generation === snapshot.generation),
    docLength
  )
  const ids = new Set(diagnostics.map((item) => item.id))
  const selected =
    selectedDiagnosticId && ids.has(selectedDiagnosticId) ? selectedDiagnosticId : null
  const open = openDiagnosticId && ids.has(openDiagnosticId) ? openDiagnosticId : null
  return {
    documentId: snapshot.documentId,
    generation: snapshot.generation,
    diagnostics,
    selectedDiagnosticId: selected,
    openDiagnosticId: open,
    suggestionCardsEnabled: true,
    decorations: showUnderlines ? buildGrammarDecorations(diagnostics, selected) : Decoration.none
  }
}

export const grammarEditorStateField = StateField.define<GrammarEditorState>({
  create(state) {
    const options = state.facet(grammarSessionFacet)
    const snapshot = options?.session.getSnapshot() ?? emptySnapshot
    return makeEditorState(
      snapshot,
      state.doc.length,
      snapshot.selectedDiagnosticId ?? null,
      null,
      options?.showUnderlines
    )
  },
  update(value, transaction) {
    let diagnostics = transaction.docChanged
      ? mapGrammarDiagnostics(value.diagnostics, transaction.changes)
      : value.diagnostics
    let documentId = value.documentId
    let generation = value.generation
    let selected = value.selectedDiagnosticId
    let open = value.openDiagnosticId
    let suggestionCardsEnabled = value.suggestionCardsEnabled

    for (const effect of transaction.effects) {
      if (effect.is(setGrammarSnapshot)) {
        documentId = effect.value.documentId
        generation = effect.value.generation
        diagnostics = sortedValidDiagnostics(
          effect.value.diagnostics.filter(
            (diagnostic) => diagnostic.generation === effect.value.generation
          ),
          transaction.state.doc.length
        )
        if (effect.value.selectedDiagnosticId !== undefined) {
          selected = effect.value.selectedDiagnosticId
        }
      } else if (effect.is(updateGrammarUi)) {
        if (effect.value.removeId) {
          diagnostics = diagnostics.filter((item) => item.id !== effect.value.removeId)
        }
        if (effect.value.removeIds?.length) {
          const removed = new Set(effect.value.removeIds)
          diagnostics = diagnostics.filter((item) => !removed.has(item.id))
        }
        if (effect.value.selectId !== undefined) selected = effect.value.selectId
        if (effect.value.openId !== undefined) open = effect.value.openId
      } else if (effect.is(setGrammarSuggestionCardsEnabled)) {
        suggestionCardsEnabled = effect.value
        if (!suggestionCardsEnabled) open = null
      }
    }

    const ids = new Set(diagnostics.map((item) => item.id))
    if (selected && !ids.has(selected)) selected = null
    if (open && !ids.has(open)) open = null
    return {
      documentId,
      generation,
      diagnostics,
      selectedDiagnosticId: selected,
      openDiagnosticId: open,
      suggestionCardsEnabled,
      decorations:
        transaction.state.facet(grammarSessionFacet)?.showUnderlines === false
          ? Decoration.none
          : buildGrammarDecorations(diagnostics, selected)
    }
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
})

export function getGrammarEditorState(state: EditorState): GrammarEditorState | null {
  return state.field(grammarEditorStateField, false) ?? null
}

export function sessionFor(view: EditorView): GrammarEditorSession | null {
  return view.state.facet(grammarSessionFacet)?.session ?? null
}
