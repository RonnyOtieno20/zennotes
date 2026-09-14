import {
  ChangeSet,
  Facet,
  Prec,
  StateEffect,
  StateField,
  type ChangeDesc,
  type EditorState,
  type Extension,
  type Text
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  hoverTooltip,
  keymap,
  showTooltip,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type Tooltip,
  type ViewUpdate
} from '@codemirror/view'
import type { GrammarDiagnostic } from './types'
import { canIgnoreGrammarRule } from './preferences'

export interface GrammarDocumentContext {
  documentId: string | null
  generation: number
}

export interface GrammarEditorSnapshot extends GrammarDocumentContext {
  diagnostics: readonly GrammarDiagnostic[]
  selectedDiagnosticId?: string | null
}

export interface GrammarAppliedReplacement {
  diagnosticId: string
  replacement: string
  from: number
  to: number
  generation: number
}

/**
 * The intentionally small boundary between the editor and a document session.
 * The session owns accepted provider snapshots and ignore persistence; the
 * extension owns only pane-local mapped ranges and transient UI state.
 */
export interface GrammarEditorSession {
  getSnapshot(): GrammarEditorSnapshot
  subscribe(listener: (snapshot: GrammarEditorSnapshot) => void): () => void
  getDocumentContext(): GrammarDocumentContext
  ignoreOnce(diagnosticId: string): void
  ignoreRule?(ruleId: string): void
  addToDictionary?(entry: string): void
  onApplied?(replacement: GrammarAppliedReplacement): void
  selectDiagnostic?(diagnosticId: string | null): void
  /** Optional segment/fingerprint gate owned by the eventual session registry. */
  isDiagnosticCurrent?(diagnostic: GrammarDiagnostic): boolean
  /** Atomic full-document/session validation immediately before dispatch. */
  validateApply?(diagnostic: GrammarDiagnostic, documentText: string): boolean
}

export interface GrammarEditorExtensionOptions {
  session: GrammarEditorSession
  /** Defaults to Alt-Enter; false leaves key binding to EditorPane. */
  openSuggestionsKey?: string | false
  /** Keep diagnostics available to the review panel without drawing editor marks. */
  showUnderlines?: boolean
}

export interface GrammarEditorState {
  documentId: string | null
  generation: number
  diagnostics: readonly GrammarDiagnostic[]
  selectedDiagnosticId: string | null
  openDiagnosticId: string | null
  suggestionCardsEnabled: boolean
  decorations: DecorationSet
}

export type GrammarApplyRejection =
  | 'document'
  | 'generation'
  | 'diagnostic'
  | 'range'
  | 'original'
  | 'replacement'

export type GrammarApplyResult =
  | {
      applied: true
      diagnosticId: string
      nextDiagnosticId: string | null
      nextRange: { from: number; to: number } | null
    }
  | { applied: false; diagnosticId: string; reason: GrammarApplyRejection }

export type GrammarValidationResult =
  | { valid: true; replacement: string }
  | { valid: false; reason: GrammarApplyRejection }

const emptySnapshot: GrammarEditorSnapshot = {
  documentId: null,
  generation: 0,
  diagnostics: []
}

function compareDiagnostics(left: GrammarDiagnostic, right: GrammarDiagnostic): number {
  return (
    left.range.from - right.range.from ||
    left.range.to - right.range.to ||
    left.id.localeCompare(right.id)
  )
}

function isRangeValid(diagnostic: GrammarDiagnostic, length: number): boolean {
  const { from, to } = diagnostic.range
  return Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from <= to && to <= length
}

function sortedValidDiagnostics(
  diagnostics: readonly GrammarDiagnostic[],
  length: number
): readonly GrammarDiagnostic[] {
  return diagnostics
    .filter((item) => isRangeValid(item, length))
    .slice()
    .sort(compareDiagnostics)
}

function editTouchesDiagnostic(changes: ChangeDesc, diagnostic: GrammarDiagnostic): boolean {
  const { from, to } = diagnostic.range
  let touched = false
  changes.iterChangedRanges((fromA, toA) => {
    if (touched) return
    if (from === to) {
      touched = fromA <= from && toA >= from
      return
    }
    if (fromA === toA) touched = fromA > from && fromA < to
    else touched = fromA < to && toA > from
  })
  return touched
}

/** Map an untouched issue through an edit, or drop it when its source was edited. */
export function mapGrammarDiagnostic(
  diagnostic: GrammarDiagnostic,
  changes: ChangeDesc
): GrammarDiagnostic | null {
  if (editTouchesDiagnostic(changes, diagnostic)) return null
  return {
    ...diagnostic,
    range: {
      // Insertions at the start belong before the issue; insertions at the end
      // belong after it. This preserves the exact original span.
      from: changes.mapPos(diagnostic.range.from, 1),
      to: changes.mapPos(diagnostic.range.to, -1)
    }
  }
}

export function mapGrammarDiagnostics(
  diagnostics: readonly GrammarDiagnostic[],
  changes: ChangeDesc
): readonly GrammarDiagnostic[] {
  return diagnostics
    .map((item) => mapGrammarDiagnostic(item, changes))
    .filter((item): item is GrammarDiagnostic => item !== null)
    .sort(compareDiagnostics)
}

/** Find the tightest issue at a CodeMirror position. */
export function grammarDiagnosticAt(
  diagnostics: readonly GrammarDiagnostic[],
  position: number,
  side = 0
): GrammarDiagnostic | null {
  const matches = diagnostics.filter(({ range }) => {
    if (range.from === range.to) return position === range.from
    if (position > range.from && position < range.to) return true
    return position === range.from ? side >= 0 : position === range.to && side <= 0
  })
  matches.sort(
    (left, right) =>
      left.range.to - left.range.from - (right.range.to - right.range.from) ||
      compareDiagnostics(left, right)
  )
  return matches[0] ?? null
}

/**
 * Select the first issue at/after an anchor, wrapping once. `excludeId` is used
 * by apply-and-next and ignore-once.
 */
export function nextGrammarDiagnostic(
  diagnostics: readonly GrammarDiagnostic[],
  anchor: number,
  excludeId?: string
): GrammarDiagnostic | null {
  const candidates = diagnostics
    .filter((item) => item.id !== excludeId)
    .slice()
    .sort(compareDiagnostics)
  return candidates.find((item) => item.range.from >= anchor) ?? candidates[0] ?? null
}

export interface GrammarReplacementValidationInput {
  diagnostic: GrammarDiagnostic
  replacementIndex: number
  mappedRange: { from: number; to: number }
  document: Text | string
  snapshot: GrammarEditorSnapshot
  currentDocument: GrammarDocumentContext
  isDiagnosticCurrent?: (diagnostic: GrammarDiagnostic) => boolean
  validateApply?: (diagnostic: GrammarDiagnostic, documentText: string) => boolean
}

/** Pure stale-result and source-integrity gate used immediately before apply. */
export function validateGrammarReplacement({
  diagnostic,
  replacementIndex,
  mappedRange,
  document,
  snapshot,
  currentDocument,
  isDiagnosticCurrent,
  validateApply
}: GrammarReplacementValidationInput): GrammarValidationResult {
  if (!currentDocument.documentId || snapshot.documentId !== currentDocument.documentId) {
    return { valid: false, reason: 'document' }
  }
  if (
    diagnostic.generation !== snapshot.generation ||
    diagnostic.generation !== currentDocument.generation
  ) {
    return { valid: false, reason: 'generation' }
  }

  const accepted = snapshot.diagnostics.find((item) => item.id === diagnostic.id)
  if (
    !accepted ||
    accepted.segmentId !== diagnostic.segmentId ||
    accepted.original !== diagnostic.original ||
    accepted.ruleId !== diagnostic.ruleId ||
    isDiagnosticCurrent?.(accepted) === false
  ) {
    return { valid: false, reason: 'diagnostic' }
  }
  if (
    accepted.range.from !== mappedRange.from ||
    accepted.range.to !== mappedRange.to ||
    !Number.isInteger(mappedRange.from) ||
    !Number.isInteger(mappedRange.to) ||
    mappedRange.from < 0 ||
    mappedRange.from > mappedRange.to
  ) {
    return { valid: false, reason: 'range' }
  }

  const replacement = accepted.replacements[replacementIndex]?.value
  if (replacement === undefined) return { valid: false, reason: 'replacement' }

  const text = typeof document === 'string' ? document : document.toString()
  if (mappedRange.to > text.length) return { valid: false, reason: 'range' }
  if (text.slice(mappedRange.from, mappedRange.to) !== accepted.original) {
    return { valid: false, reason: 'original' }
  }
  if (validateApply?.(accepted, text) === false) {
    return { valid: false, reason: 'diagnostic' }
  }
  return { valid: true, replacement }
}

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
  selectId?: string | null
  openId?: string | null
}

export const setGrammarSnapshot = StateEffect.define<GrammarEditorSnapshot>()
export const updateGrammarUi = StateEffect.define<GrammarUiEffect>()
export const setGrammarSuggestionCardsEnabled = StateEffect.define<boolean>()

const grammarSessionFacet = Facet.define<
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
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    showTooltip.from(field, (value) => {
      if (!value.suggestionCardsEnabled) return null
      const diagnostic = value.diagnostics.find((item) => item.id === value.openDiagnosticId)
      return diagnostic ? suggestionTooltip(diagnostic) : null
    })
  ]
})

export function getGrammarEditorState(state: EditorState): GrammarEditorState | null {
  return state.field(grammarEditorStateField, false) ?? null
}

function sessionFor(view: EditorView): GrammarEditorSession | null {
  return view.state.facet(grammarSessionFacet)?.session ?? null
}

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

function appendText(parent: HTMLElement, className: string, text: string): HTMLElement {
  const node = document.createElement('div')
  node.className = className
  node.textContent = text
  parent.appendChild(node)
  return node
}

interface SuggestionCardController {
  active: number
  setActive(index: number): void
  activate(): void
}

const suggestionCardControllers = new WeakMap<EditorView, SuggestionCardController>()

function suggestionTooltip(diagnostic: GrammarDiagnostic): Tooltip {
  return {
    pos: diagnostic.range.from,
    end: diagnostic.range.to,
    above: false,
    strictSide: false,
    arrow: true,
    create(view) {
      const dom = document.createElement('div')
      dom.className = 'cm-grammar-suggestion-card'
      dom.dataset.grammarDiagnostic = diagnostic.id
      dom.setAttribute('role', 'dialog')
      dom.setAttribute('aria-modal', 'false')
      dom.setAttribute('aria-label', `${diagnostic.category} suggestion`)
      appendText(dom, 'cm-grammar-suggestion-category', diagnostic.category)
      appendText(dom, 'cm-grammar-suggestion-message', diagnostic.message)
      if (diagnostic.original) {
        appendText(dom, 'cm-grammar-suggestion-original', diagnostic.original)
      }

      const actions = document.createElement('div')
      actions.className = 'cm-grammar-suggestion-actions'
      dom.appendChild(actions)
      const buttons: HTMLButtonElement[] = []
      const callbacks: Array<() => void> = []
      const addAction = (button: HTMLButtonElement, callback: () => void): void => {
        const index = buttons.length
        button.addEventListener('mousedown', (event) => event.preventDefault())
        button.addEventListener('mouseenter', () => controller.setActive(index))
        button.addEventListener('click', callback)
        buttons.push(button)
        callbacks.push(callback)
        actions.appendChild(button)
      }
      diagnostic.replacements.forEach((replacement, index) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'cm-grammar-suggestion'
        button.textContent = replacement.value || 'Delete'
        if (replacement.description) button.title = replacement.description
        addAction(button, () => {
          applyGrammarReplacementAndNext(view, diagnostic.id, index)
          view.focus()
        })
      })

      const ignore = document.createElement('button')
      ignore.type = 'button'
      ignore.className = 'cm-grammar-ignore-once'
      ignore.textContent = 'Ignore once'
      addAction(ignore, () => {
        ignoreGrammarDiagnosticOnce(view, diagnostic.id)
        view.focus()
      })

      if (sessionFor(view)?.ignoreRule && canIgnoreGrammarRule(diagnostic.ruleId)) {
        const ignoreRule = document.createElement('button')
        ignoreRule.type = 'button'
        ignoreRule.className = 'cm-grammar-ignore-rule'
        ignoreRule.textContent = 'Ignore rule'
        addAction(ignoreRule, () => {
          ignoreGrammarDiagnosticOnce(view, diagnostic.id)
          sessionFor(view)?.ignoreRule?.(diagnostic.ruleId)
          view.focus()
        })
      }

      if (diagnostic.original && sessionFor(view)?.addToDictionary) {
        const addWord = document.createElement('button')
        addWord.type = 'button'
        addWord.className = 'cm-grammar-add-dictionary'
        addWord.textContent = 'Add word'
        addAction(addWord, () => {
          ignoreGrammarDiagnosticOnce(view, diagnostic.id)
          sessionFor(view)?.addToDictionary?.(diagnostic.original)
          view.focus()
        })
      }

      const dismiss = document.createElement('button')
      dismiss.type = 'button'
      dismiss.className = 'cm-grammar-suggestion-dismiss'
      dismiss.textContent = 'Dismiss'
      addAction(dismiss, () => {
        closeGrammarSuggestionCard(view)
        view.focus()
      })

      appendText(
        dom,
        'cm-grammar-suggestion-hint',
        'F8 next · Shift+F8 previous · ↑/↓ or j/k choose · Enter apply · Esc close'
      )

      const controller: SuggestionCardController = {
        active: 0,
        setActive(index) {
          const count = buttons.length
          if (!count) return
          this.active = ((index % count) + count) % count
          buttons.forEach((button, buttonIndex) => {
            button.classList.toggle('cm-grammar-suggestion-active', buttonIndex === this.active)
          })
        },
        activate() {
          callbacks[this.active]?.()
        }
      }
      controller.setActive(0)
      suggestionCardControllers.set(view, controller)
      return {
        dom,
        destroy() {
          if (suggestionCardControllers.get(view) === controller) {
            suggestionCardControllers.delete(view)
          }
        }
      }
    }
  }
}

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

function openCardController(view: EditorView): SuggestionCardController | null {
  if (!getGrammarEditorState(view.state)?.openDiagnosticId) return null
  return suggestionCardControllers.get(view) ?? null
}

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
    grammarSessionSubscriber,
    grammarHoverTooltip,
    grammarClickHandler,
    grammarKeymap(options.openSuggestionsKey)
  ]
}

export const createGrammarEditorExtension = grammarEditorExtension
