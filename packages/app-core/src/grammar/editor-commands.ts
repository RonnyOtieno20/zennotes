import { ChangeSet } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { GrammarDiagnostic } from './types'
import { addNoteIgnoredGrammarRule } from './note-ignored-rules'
import {
  grammarDiagnosticAt,
  mapGrammarDiagnostics,
  nextGrammarDiagnostic,
  similarGrammarDiagnostics,
  sortedValidDiagnostics,
  validateGrammarReplacement,
  type GrammarApplyRejection,
  type GrammarApplyResult
} from './editor-diagnostics'
import {
  getGrammarEditorState,
  sessionFor,
  setGrammarSuggestionCardsEnabled,
  updateGrammarUi
} from './editor-state'

export function selectGrammarDiagnostic(view: EditorView, diagnosticId: string | null): boolean {
  const grammar = getGrammarEditorState(view.state)
  if (!grammar || (diagnosticId && !grammar.diagnostics.some((item) => item.id === diagnosticId))) {
    return false
  }
  view.dispatch({ effects: updateGrammarUi.of({ selectId: diagnosticId }) })
  sessionFor(view)?.selectDiagnostic?.(diagnosticId)
  return true
}

export function openGrammarSuggestionCard(view: EditorView): boolean {
  const grammar = getGrammarEditorState(view.state)
  if (!grammar?.suggestionCardsEnabled) return false
  const cursor = view.state.selection.main.head
  const diagnostic = grammarDiagnosticAt(grammar.diagnostics, cursor)
  if (!diagnostic) return false
  view.dispatch({
    effects: updateGrammarUi.of({
      selectId: diagnostic.id,
      openId: diagnostic.id
    })
  })
  sessionFor(view)?.selectDiagnostic?.(diagnostic.id)
  return true
}

function navigateAdjacentGrammarDiagnostic(
  view: EditorView,
  direction: -1 | 1,
  openCard: boolean
): boolean {
  const grammar = getGrammarEditorState(view.state)
  if (!grammar) return false
  if (openCard && !grammar.suggestionCardsEnabled) return false
  const diagnostics = sortedValidDiagnostics(grammar.diagnostics, view.state.doc.length)
  if (diagnostics.length === 0) return false

  const activeId = grammar.openDiagnosticId ?? grammar.selectedDiagnosticId
  const activeIndex = activeId
    ? diagnostics.findIndex((diagnostic) => diagnostic.id === activeId)
    : -1
  let target: GrammarDiagnostic
  if (activeIndex >= 0) {
    target = diagnostics[(activeIndex + direction + diagnostics.length) % diagnostics.length]!
  } else {
    const cursor = view.state.selection.main.head
    target =
      direction === 1
        ? diagnostics.find((diagnostic) => diagnostic.range.from >= cursor) ?? diagnostics[0]!
        : diagnostics
            .slice()
            .reverse()
            .find((diagnostic) => diagnostic.range.to <= cursor) ?? diagnostics.at(-1)!
  }

  view.dispatch({
    selection: { anchor: target.range.from },
    effects: [
      updateGrammarUi.of({ selectId: target.id, openId: openCard ? target.id : null }),
      EditorView.scrollIntoView(target.range.from, { y: 'center' })
    ]
  })
  sessionFor(view)?.selectDiagnostic?.(target.id)
  return true
}

/** Open and reveal the adjacent issue, wrapping at either end of the note. */
export function openAdjacentGrammarSuggestionCard(
  view: EditorView,
  direction: -1 | 1
): boolean {
  return navigateAdjacentGrammarDiagnostic(view, direction, true)
}

/** Select the adjacent issue for the review panel without opening a floating card. */
export function selectAdjacentGrammarDiagnostic(
  view: EditorView,
  direction: -1 | 1
): boolean {
  return navigateAdjacentGrammarDiagnostic(view, direction, false)
}

export function setGrammarSuggestionCards(view: EditorView, enabled: boolean): boolean {
  if (!getGrammarEditorState(view.state)) return false
  view.dispatch({ effects: setGrammarSuggestionCardsEnabled.of(enabled) })
  return true
}

export function closeGrammarSuggestionCard(view: EditorView): boolean {
  const grammar = getGrammarEditorState(view.state)
  if (!grammar?.openDiagnosticId) return false
  view.dispatch({ effects: updateGrammarUi.of({ openId: null }) })
  return true
}

function rejected(diagnosticId: string, reason: GrammarApplyRejection): GrammarApplyResult {
  return { applied: false, diagnosticId, reason }
}

export function applyGrammarReplacement(
  view: EditorView,
  diagnosticId: string,
  replacementIndex: number,
  selectNext = false
): GrammarApplyResult {
  const grammar = getGrammarEditorState(view.state)
  const session = sessionFor(view)
  const diagnostic = grammar?.diagnostics.find((item) => item.id === diagnosticId)
  if (!grammar || !session || !diagnostic) return rejected(diagnosticId, 'diagnostic')

  const snapshot = session.getSnapshot()
  const validation = validateGrammarReplacement({
    diagnostic,
    replacementIndex,
    mappedRange: diagnostic.range,
    document: view.state.doc,
    snapshot,
    currentDocument: session.getDocumentContext(),
    isDiagnosticCurrent: session.isDiagnosticCurrent?.bind(session),
    validateApply: session.validateApply?.bind(session)
  })
  if (!validation.valid) return rejected(diagnosticId, validation.reason)

  const changes = ChangeSet.of(
    [
      {
        from: diagnostic.range.from,
        to: diagnostic.range.to,
        insert: validation.replacement
      }
    ],
    view.state.doc.length
  )
  const remaining = mapGrammarDiagnostics(
    grammar.diagnostics.filter((item) => item.id !== diagnostic.id),
    changes
  )
  const next = selectNext
    ? nextGrammarDiagnostic(remaining, diagnostic.range.from + validation.replacement.length)
    : null

  // One normal dispatch means the replacement and selection are one undoable
  // CodeMirror transaction. No history annotation or follow-up edit is used.
  view.dispatch({
    changes,
    selection: {
      anchor: diagnostic.range.from + validation.replacement.length
    },
    effects: updateGrammarUi.of({
      removeId: diagnostic.id,
      selectId: selectNext ? (next?.id ?? null) : null,
      openId: selectNext ? (next?.id ?? null) : null
    })
  })
  session.onApplied?.({
    diagnosticId: diagnostic.id,
    replacement: validation.replacement,
    from: diagnostic.range.from,
    to: diagnostic.range.to,
    generation: diagnostic.generation
  })
  session.selectDiagnostic?.(selectNext ? (next?.id ?? null) : null)

  const selected = next
    ? (getGrammarEditorState(view.state)?.diagnostics.find((item) => item.id === next.id) ?? null)
    : null
  return {
    applied: true,
    diagnosticId,
    nextDiagnosticId: selected?.id ?? null,
    nextRange: selected ? { ...selected.range } : null
  }
}

/** Applies one fix to every similar issue as a single undoable transaction. */
export function applyGrammarReplacementToAll(
  view: EditorView,
  diagnosticId: string,
  replacementIndex: number
): number {
  const grammar = getGrammarEditorState(view.state)
  const session = sessionFor(view)
  const diagnostic = grammar?.diagnostics.find((item) => item.id === diagnosticId)
  if (!grammar || !session || !diagnostic) return 0
  const value = diagnostic.replacements[replacementIndex]?.value
  if (value === undefined) return 0

  const snapshot = session.getSnapshot()
  const context = session.getDocumentContext()
  const fixes: { diagnostic: GrammarDiagnostic; replacement: string }[] = []
  let lastEnd = -1
  for (const item of similarGrammarDiagnostics(grammar.diagnostics, diagnostic, replacementIndex)) {
    const validation = validateGrammarReplacement({
      diagnostic: item,
      replacementIndex: item.replacements.findIndex((replacement) => replacement.value === value),
      mappedRange: item.range,
      document: view.state.doc,
      snapshot,
      currentDocument: context,
      isDiagnosticCurrent: session.isDiagnosticCurrent?.bind(session),
      validateApply: session.validateApply?.bind(session)
    })
    // Diagnostics are sorted by position; skip any that overlap an earlier fix.
    if (!validation.valid || item.range.from < lastEnd) continue
    fixes.push({ diagnostic: item, replacement: validation.replacement })
    lastEnd = item.range.to
  }
  if (fixes.length === 0) return 0

  const changes = ChangeSet.of(
    fixes.map(({ diagnostic: item, replacement }) => ({
      from: item.range.from,
      to: item.range.to,
      insert: replacement
    })),
    view.state.doc.length
  )
  view.dispatch({
    changes,
    effects: updateGrammarUi.of({
      removeIds: fixes.map(({ diagnostic: item }) => item.id),
      selectId: null,
      openId: null
    })
  })
  for (const { diagnostic: item, replacement } of fixes) {
    session.onApplied?.({
      diagnosticId: item.id,
      replacement,
      from: item.range.from,
      to: item.range.to,
      generation: item.generation
    })
  }
  session.selectDiagnostic?.(null)
  return fixes.length
}

export function applyGrammarReplacementAndNext(
  view: EditorView,
  diagnosticId: string,
  replacementIndex: number
): GrammarApplyResult {
  return applyGrammarReplacement(view, diagnosticId, replacementIndex, true)
}

export function ignoreGrammarDiagnosticOnce(view: EditorView, diagnosticId: string): boolean {
  const grammar = getGrammarEditorState(view.state)
  const session = sessionFor(view)
  const diagnostic = grammar?.diagnostics.find((item) => item.id === diagnosticId)
  if (!grammar || !session || !diagnostic) return false
  const next = nextGrammarDiagnostic(grammar.diagnostics, diagnostic.range.to, diagnostic.id)
  view.dispatch({
    effects: updateGrammarUi.of({
      removeId: diagnostic.id,
      selectId: next?.id ?? null,
      openId: next?.id ?? null
    })
  })
  session.ignoreOnce(diagnostic.id)
  session.selectDiagnostic?.(next?.id ?? null)
  return true
}

/**
 * Hides an issue's rule in this note only, by adding it to the note's
 * `grammar-ignore` front matter. A normal edit, so it saves with the note and
 * undoes like any other change.
 */
export function ignoreGrammarRuleInNote(view: EditorView, diagnosticId: string): boolean {
  const grammar = getGrammarEditorState(view.state)
  const diagnostic = grammar?.diagnostics.find((item) => item.id === diagnosticId)
  if (!grammar || !diagnostic || view.state.readOnly) return false
  const change = addNoteIgnoredGrammarRule(view.state.doc.toString(), diagnostic.ruleId)
  if (!change) return false
  view.dispatch({
    changes: change,
    effects: updateGrammarUi.of({
      removeIds: grammar.diagnostics
        .filter((item) => item.ruleId === diagnostic.ruleId)
        .map((item) => item.id),
      selectId: null,
      openId: null
    })
  })
  sessionFor(view)?.selectDiagnostic?.(null)
  return true
}
