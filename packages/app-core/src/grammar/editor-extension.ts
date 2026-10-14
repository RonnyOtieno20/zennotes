import { Prec, type Extension } from '@codemirror/state'
import { EditorView, hoverTooltip, keymap, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import {
  grammarDiagnosticAt,
  type GrammarEditorExtensionOptions,
  type GrammarEditorSession,
  type GrammarEditorSnapshot
} from './editor-diagnostics'
import {
  getGrammarEditorState,
  grammarEditorStateField,
  grammarSessionFacet,
  sessionFor,
  setGrammarSnapshot,
  updateGrammarUi
} from './editor-state'
import { closeGrammarSuggestionCard, openGrammarSuggestionCard } from './editor-commands'
import { openCardController, openSuggestionCard, suggestionTooltip } from './editor-suggestion-card'

// The grammar editor extension is split by concern; this module wires it into
// CodeMirror and re-exports the public API so callers import from one place.
export * from './editor-diagnostics'
export {
  buildGrammarDecorations,
  getGrammarEditorState,
  grammarEditorStateField,
  setGrammarSnapshot,
  setGrammarSuggestionCardsEnabled,
  updateGrammarUi,
  type GrammarUiEffect
} from './editor-state'
export * from './editor-commands'

const grammarHoverTooltip = hoverTooltip((view, position, side) => {
  const grammar = getGrammarEditorState(view.state)
  if (!grammar?.suggestionCardsEnabled || grammar.openDiagnosticId) return null
  const diagnostic = grammarDiagnosticAt(grammar.diagnostics, position, side)
  return diagnostic ? suggestionTooltip(diagnostic) : null
})

const grammarClickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (!getGrammarEditorState(view.state)?.suggestionCardsEnabled) return false
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-grammar-diagnostic]')
        : null
    const diagnosticId = target?.dataset.grammarDiagnostic
    if (!diagnosticId) return false
    view.dispatch({
      effects: updateGrammarUi.of({
        selectId: diagnosticId,
        openId: diagnosticId
      })
    })
    sessionFor(view)?.selectDiagnostic?.(diagnosticId)
    return false
  }
})

class GrammarSessionSubscriber {
  private unsubscribe: (() => void) | null = null
  private session: GrammarEditorSession | null = null
  private connection = 0

  constructor(private readonly view: EditorView) {
    this.connect(view.state.facet(grammarSessionFacet)?.session ?? null)
  }

  update(update: ViewUpdate): void {
    const session = update.state.facet(grammarSessionFacet)?.session ?? null
    if (session !== this.session) this.connect(session)
  }

  destroy(): void {
    this.connection += 1
    this.unsubscribe?.()
  }

  private connect(session: GrammarEditorSession | null): void {
    const connection = ++this.connection
    this.unsubscribe?.()
    this.session = session
    if (!session) {
      this.unsubscribe = null
      return
    }

    let subscribing = true
    let initial: GrammarEditorSnapshot = session.getSnapshot()
    this.unsubscribe = session.subscribe((snapshot) => {
      if (subscribing) {
        initial = snapshot
        return
      }
      this.view.dispatch({ effects: setGrammarSnapshot.of(snapshot) })
    })
    subscribing = false
    // A coordinator publishes its current value synchronously from subscribe.
    // Defer that first dispatch because a view/plugin may still be constructing
    // or reconfiguring. The token also prevents work after disconnect/destroy.
    const snapshot = initial
    queueMicrotask(() => {
      if (
        this.connection !== connection ||
        this.session !== session ||
        session.getSnapshot() !== snapshot
      )
        return
      const state = getGrammarEditorState(this.view.state)
      if (state?.documentId === snapshot.documentId && state.generation === snapshot.generation) {
        return
      }
      this.view.dispatch({ effects: setGrammarSnapshot.of(snapshot) })
    })
  }
}

const grammarSessionSubscriber = ViewPlugin.fromClass(GrammarSessionSubscriber)

function grammarKeymap(openKey: string | false | undefined): Extension {
  const bindings = [
    ...(openKey === false ? [] : [{ key: openKey ?? 'Alt-Enter', run: openGrammarSuggestionCard }]),
    {
      key: 'ArrowDown',
      run: (view: EditorView) => {
        const controller = openCardController(view)
        if (!controller) return false
        controller.setActive(controller.active + 1)
        return true
      }
    },
    {
      key: 'ArrowUp',
      run: (view: EditorView) => {
        const controller = openCardController(view)
        if (!controller) return false
        controller.setActive(controller.active - 1)
        return true
      }
    },
    {
      key: 'j',
      run: (view: EditorView) => {
        const controller = openCardController(view)
        if (!controller) return false
        controller.setActive(controller.active + 1)
        return true
      }
    },
    {
      key: 'k',
      run: (view: EditorView) => {
        const controller = openCardController(view)
        if (!controller) return false
        controller.setActive(controller.active - 1)
        return true
      }
    },
    {
      key: 'Enter',
      run: (view: EditorView) => {
        const controller = openCardController(view)
        if (!controller) return false
        controller.activate()
        return true
      }
    },
    {
      key: 'Escape',
      run: closeGrammarSuggestionCard
    }
  ]
  return Prec.highest(keymap.of(bindings))
}

export function grammarEditorExtension(options: GrammarEditorExtensionOptions): Extension {
  return [
    grammarSessionFacet.of(options),
    grammarEditorStateField,
    openSuggestionCard,
    grammarSessionSubscriber,
    grammarHoverTooltip,
    grammarClickHandler,
    grammarKeymap(options.openSuggestionsKey)
  ]
}

export const createGrammarEditorExtension = grammarEditorExtension
