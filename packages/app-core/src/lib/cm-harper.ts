import { grammarPopupRows, renderGrammarMessage, type GrammarPopupController } from './grammar-popup'
/**
 * Harper in the editor: wavy underlines under grammar and spelling problems,
 * a hover tooltip with the fixes, and a keyboard popup at the cursor.
 *
 * `@codemirror/lint` owns the diagnostics: it debounces the run, keeps
 * positions mapped through later edits, draws the underlines, shows the hover
 * tooltip, and provides next/previous. On top of that sits our own cursor
 * popup (a StateField providing a tooltip, the url-paste-menu shape) so the
 * whole thing works without a mouse: `z=` opens it, digits or Enter apply a
 * suggestion, `zg` teaches the dictionary, `zG` ignores the suggestion.
 *
 * The extension never loads Harper itself. It asks for a session through the
 * config's `session()` and returns no diagnostics until one exists, so the
 * first lint after enabling waits for the wasm and later ones are instant.
 */
import { Diagnostic, forEachDiagnostic, forceLinting, linter } from '@codemirror/lint'
import { Facet, StateEffect, StateField, type Extension } from '@codemirror/state'
import { EditorView, showTooltip, type Tooltip } from '@codemirror/view'
import {
  HARPER_LINT_CHAR_LIMIT,
  harperSuggestionChange,
  type HarperLint,
  type HarperSession,
  type HarperSuggestion
} from './harper-lint'

export const HARPER_LINT_DELAY_MS = 750

export interface HarperEditorConfig {
  /** The shared session, or null while Harper is still loading or failed. */
  session: () => Promise<HarperSession | null>
  /** Persist a word the user added; the extension re-lints afterwards. */
  addWord: (word: string) => Promise<void>
  /** Persist an ignored suggestion; the extension re-lints afterwards. */
  ignore: (text: string, lint: HarperLint) => Promise<void>
}

/** Dispatch to re-run Harper without waiting for an edit (after the
 *  dictionary or the ignore list changed, or after the session arrived). */
export const harperRefresh = StateEffect.define<void>()

interface HarperDiagnostic extends Diagnostic {
  harper: HarperLint
  /** The document as Harper saw it. Ignoring hashes the lint's context in
   *  this text, so a later edit does not change what gets ignored. */
  sourceText: string
}

type HarperAction = NonNullable<Diagnostic['actions']>[number]

/**
 * Where a diagnostic sits now. The lint runs again in the background (a fix
 * elsewhere schedules one), and every run replaces the diagnostic objects, so
 * identity alone would lose a card that stayed open across a refresh. Fall
 * back to the same problem, rule and message at an overlapping position.
 */
function diagnosticRange(view: EditorView, target: HarperDiagnostic): { from: number; to: number } | null {
  let exact: { from: number; to: number } | null = null
  let same: { from: number; to: number } | null = null
  forEachDiagnostic(view.state, (diagnostic, from, to) => {
    if (diagnostic === target) exact = { from, to }
    if (
      !same &&
      isHarperDiagnostic(diagnostic) &&
      diagnostic.harper.kind === target.harper.kind &&
      diagnostic.harper.problem === target.harper.problem &&
      diagnostic.harper.message === target.harper.message &&
      from <= target.to &&
      to >= target.from
    ) {
      same = { from, to }
    }
  })
  return exact ?? same
}

function isHarperDiagnostic(diagnostic: Diagnostic): diagnostic is HarperDiagnostic {
  return diagnostic.source === 'Harper' && 'harper' in diagnostic
}

function applySuggestion(view: EditorView, from: number, to: number, suggestion: HarperSuggestion): void {
  const change = harperSuggestionChange({ from, to }, suggestion)
  view.dispatch({
    changes: change,
    selection: { anchor: change.from + change.insert.length },
    effects: setHarperPopup.of(null)
  })
  view.focus()
}

function toDiagnostic(config: HarperEditorConfig, text: string, lint: HarperLint): HarperDiagnostic {
  const actions: HarperAction[] = lint.suggestions.map((suggestion) => ({
    name: suggestion.label,
    apply: (view, from, to) => applySuggestion(view, from, to, suggestion)
  }))
  if (lint.kind === 'Spelling') {
    actions.push({
      name: 'Add to dictionary',
      apply: (view) => {
        void config.addWord(lint.problem).then(() => refreshHarper(view))
      }
    })
  }
  actions.push({
    name: 'Ignore',
    apply: (view) => {
      void config.ignore(text, lint).then(() => refreshHarper(view))
    }
  })
  return {
    from: lint.from,
    to: lint.to,
    severity: 'warning',
    source: 'Harper',
    message: lint.message,
    markClass: 'cm-harper-lint',
    actions,
    harper: lint,
    sourceText: text
  }
}

function refreshHarper(view: EditorView): void {
  view.dispatch({ effects: harperRefresh.of() })
  forceLinting(view)
}

/* ---------- Cursor popup ---------------------------------------------------- */

interface HarperPopup {
  pos: number
  diagnostic: HarperDiagnostic
  /** How it opened: a keyboard card closes when the cursor leaves the
   *  problem, a hover card when the pointer does. */
  source: 'keyboard' | 'hover'
}

const setHarperPopup = StateEffect.define<HarperPopup | null>()

const controllers = new WeakMap<EditorView, GrammarPopupController>()

function popupTooltip(popup: HarperPopup, config: HarperEditorConfig): Tooltip {
  return {
    pos: popup.pos,
    above: false,
    strictSide: false,
    arrow: false,
    create: (view) => {
      const { harper, sourceText } = popup.diagnostic
      const dom = document.createElement('div')
      dom.className = 'cm-harper-popup'

      const header = document.createElement('div')
      header.className = 'cm-harper-popup-message'
      renderGrammarMessage(header, harper.message)
      dom.appendChild(header)

      const rows = grammarPopupRows(view, dom, () => view.dispatch({ effects: setHarperPopup.of(null) }))
      const { add, controller } = rows

      harper.suggestions.forEach((suggestion, index) => {
        add(suggestion.label, index < 9 ? String(index + 1) : '', () => {
          const range = diagnosticRange(view, popup.diagnostic)
          if (range) applySuggestion(view, range.from, range.to, suggestion)
        })
      })
      if (harper.suggestions.length === 0) {
        const none = document.createElement('div')
        none.className = 'cm-harper-popup-empty'
        none.textContent = 'No automatic fix for this one.'
        dom.appendChild(none)
      }
      const divider = document.createElement('div')
      divider.className = 'cm-harper-popup-divider'
      dom.appendChild(divider)
      if (harper.kind === 'Spelling') {
        add(
          'Add to dictionary',
          'zg',
          () => {
            view.dispatch({ effects: setHarperPopup.of(null) })
            void config.addWord(harper.problem).then(() => refreshHarper(view))
          },
          true
        )
      }
      add(
        'Ignore this suggestion',
        'zG',
        () => {
          view.dispatch({ effects: setHarperPopup.of(null) })
          void config.ignore(sourceText, harper).then(() => refreshHarper(view))
        },
        true
      )

      const footer = document.createElement('div')
      footer.className = 'cm-harper-popup-footer'
      const brand = document.createElement('span')
      brand.className = 'cm-harper-popup-brand'
      brand.textContent = 'Harper'
      const kind = document.createElement('span')
      kind.className = 'cm-harper-popup-kind'
      kind.textContent = harper.kindLabel
      footer.append(brand, kind)
      dom.appendChild(footer)

      controller.setActive(0)
      controllers.set(view, controller)

      return {
        dom,
        destroy() {
          rows.destroy()
          if (controllers.get(view) === controller) controllers.delete(view)
        }
      }
    }
  }
}

function harperDiagnosticAt(
  view: EditorView,
  pos: number
): { diagnostic: HarperDiagnostic; from: number; to: number } | null {
  let found: { diagnostic: HarperDiagnostic; from: number; to: number } | null = null
  forEachDiagnostic(view.state, (diagnostic, from, to) => {
    if (!found && isHarperDiagnostic(diagnostic) && from <= pos && pos <= to) {
      found = { diagnostic, from, to }
    }
  })
  return found
}

const HOVER_OPEN_MS = 300
const HOVER_CLOSE_MS = 220

interface HoverState {
  openTimer: number | null
  closeTimer: number | null
}
const hoverStates = new WeakMap<EditorView, HoverState>()

function hoverState(view: EditorView): HoverState {
  let state = hoverStates.get(view)
  if (!state) {
    state = { openTimer: null, closeTimer: null }
    hoverStates.set(view, state)
  }
  return state
}

/**
 * The same card on mouse hover, through the same tooltip field as `z=`, so
 * the card is always the tooltip element itself and carries its own look.
 * (CodeMirror's `hoverTooltip` wraps its content in a host with stock chrome
 * that ignores the app theme.) The pointer opens the card after a short
 * dwell on an underline and closes it after leaving both the underline and
 * the card, so moving onto the card to click a fix is safe.
 */
function hoverHandlers(config: HarperEditorConfig): Extension {
  const field = popupFieldFor(config)
  const cardHovered = (): boolean =>
    document.querySelector('.cm-harper-popup')?.matches(':hover') ?? false
  const scheduleClose = (view: EditorView): void => {
    const state = hoverState(view)
    if (state.openTimer !== null) {
      window.clearTimeout(state.openTimer)
      state.openTimer = null
    }
    if (state.closeTimer !== null) return
    const tick = (): void => {
      state.closeTimer = null
      const popup = view.state.field(field, false)
      if (!popup || popup.source !== 'hover') return
      if (cardHovered()) {
        state.closeTimer = window.setTimeout(tick, HOVER_CLOSE_MS)
        return
      }
      view.dispatch({ effects: setHarperPopup.of(null) })
    }
    state.closeTimer = window.setTimeout(tick, HOVER_CLOSE_MS)
  }
  return [
    EditorView.domEventHandlers({
      mousemove(event, view) {
        const mark = (event.target as HTMLElement | null)?.closest?.('.cm-harper-lint')
        const found = mark instanceof HTMLElement ? harperDiagnosticAt(view, view.posAtDOM(mark)) : null
        const state = hoverState(view)
        if (!found) {
          scheduleClose(view)
          return false
        }
        if (state.closeTimer !== null) {
          window.clearTimeout(state.closeTimer)
          state.closeTimer = null
        }
        const popup = view.state.field(field, false)
        if (popup && (popup.diagnostic === found.diagnostic || popup.source === 'keyboard')) return false
        if (state.openTimer !== null) return false
        state.openTimer = window.setTimeout(() => {
          state.openTimer = null
          const current = view.state.field(field, false)
          if (current?.source === 'keyboard') return
          view.dispatch({
            effects: setHarperPopup.of({ pos: found.from, diagnostic: found.diagnostic, source: 'hover' })
          })
        }, HOVER_OPEN_MS)
        return false
      },
      mouseleave(_event, view) {
        scheduleClose(view)
        return false
      }
    })
  ]
}

const popupFields = new WeakMap<HarperEditorConfig, StateField<HarperPopup | null>>()

function popupFieldFor(config: HarperEditorConfig): StateField<HarperPopup | null> {
  let field = popupFields.get(config)
  if (!field) {
    field = popupField(config)
    popupFields.set(config, field)
  }
  return field
}

function popupField(config: HarperEditorConfig): StateField<HarperPopup | null> {
  return StateField.define<HarperPopup | null>({
    create: () => null,
    update(value, tr) {
      for (const effect of tr.effects) if (effect.is(setHarperPopup)) return effect.value
      if (!value) return null
      // Any edit closes the card. A caret move away from the problem closes a
      // keyboard card; a hover card follows the pointer instead (see
      // `hoverHandlers`), so the cursor may sit anywhere while reading it.
      if (tr.docChanged) return null
      if (tr.selection && value.source === 'keyboard') {
        const head = tr.state.selection.main.head
        if (head < value.diagnostic.from || head > value.diagnostic.to) return null
      }
      return value
    },
    provide: (field) =>
      showTooltip.from(field, (popup) => (popup ? popupTooltip(popup, config) : null))
  })
}

function openPopup(view: EditorView): GrammarPopupController | null {
  return controllers.get(view) ?? null
}

/** The Harper diagnostic under the cursor, or the first one on its line. */
function diagnosticAtCursor(view: EditorView): { diagnostic: HarperDiagnostic; from: number } | null {
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  let atCursor: { diagnostic: HarperDiagnostic; from: number } | null = null
  let onLine: { diagnostic: HarperDiagnostic; from: number } | null = null
  forEachDiagnostic(view.state, (diagnostic, from, to) => {
    if (!isHarperDiagnostic(diagnostic)) return
    if (from <= head && head <= to && !atCursor) atCursor = { diagnostic, from }
    if (from >= line.from && from <= line.to && !onLine) onLine = { diagnostic, from }
  })
  return atCursor ?? onLine
}

/* ---------- Commands ------------------------------------------------------- */

/** Open the suggestion popup for the problem at the cursor (`z=`). */
export function harperOpenSuggestions(view: EditorView): boolean {
  const found = diagnosticAtCursor(view)
  if (!found) return false
  view.dispatch({
    selection: { anchor: found.from },
    effects: setHarperPopup.of({ pos: found.from, diagnostic: found.diagnostic, source: 'keyboard' })
  })
  return true
}

/**
 * Move the cursor to the next or previous Harper problem, wrapping around.
 * The cursor lands at the start of the problem and nothing is selected:
 * @codemirror/lint's own next/previous select the whole range, which drops
 * Vim into visual mode and takes `z=` with it. Vim's `]s` moves; so does this.
 */
function moveToProblem(view: EditorView, direction: 1 | -1): boolean {
  const head = view.state.selection.main.head
  const starts: number[] = []
  forEachDiagnostic(view.state, (diagnostic, from) => {
    if (isHarperDiagnostic(diagnostic)) starts.push(from)
  })
  if (starts.length === 0) return false
  starts.sort((left, right) => left - right)
  const candidates =
    direction === 1 ? starts.filter((from) => from > head) : starts.filter((from) => from < head)
  const target =
    direction === 1
      ? (candidates[0] ?? starts[0])
      : (candidates[candidates.length - 1] ?? starts[starts.length - 1])
  if (target === head && starts.length === 1) return false
  view.dispatch({ selection: { anchor: target }, scrollIntoView: true })
  return true
}

/** Jump to the next Harper problem (`]s`). */
export function harperNextSuggestion(view: EditorView): boolean {
  return moveToProblem(view, 1)
}

/** Jump to the previous Harper problem (`[s`). */
export function harperPreviousSuggestion(view: EditorView): boolean {
  return moveToProblem(view, -1)
}

/** Apply the first suggestion for the problem at the cursor. */
export function harperApplyFirstSuggestion(view: EditorView): boolean {
  const found = diagnosticAtCursor(view)
  const suggestion = found?.diagnostic.harper.suggestions[0]
  if (!found || !suggestion) return false
  const range = diagnosticRange(view, found.diagnostic)
  if (!range) return false
  applySuggestion(view, range.from, range.to, suggestion)
  return true
}

/** Add the misspelled word at the cursor to the dictionary (`zg`). */
export function harperAddWordAtCursor(view: EditorView, config: HarperEditorConfig): boolean {
  const found = diagnosticAtCursor(view)
  if (!found || found.diagnostic.harper.kind !== 'Spelling') return false
  view.dispatch({ effects: setHarperPopup.of(null) })
  void config.addWord(found.diagnostic.harper.problem).then(() => refreshHarper(view))
  return true
}

/** Ignore the suggestion at the cursor from now on (`zG`). */
export function harperIgnoreAtCursor(view: EditorView, config: HarperEditorConfig): boolean {
  const found = diagnosticAtCursor(view)
  if (!found) return false
  view.dispatch({ effects: setHarperPopup.of(null) })
  void config.ignore(found.diagnostic.sourceText, found.diagnostic.harper).then(() =>
    refreshHarper(view)
  )
  return true
}

const harperConfigFacet = Facet.define<HarperEditorConfig>()

/** True when this view has Harper installed (the compartment is not empty). */
export function harperActive(view: EditorView): boolean {
  return view.state.facet(harperConfigFacet).length > 0
}

/* ---------- Extension ------------------------------------------------------ */

export function harperExtensions(config: HarperEditorConfig): Extension {
  const source = linter(
    async (view) => {
      const text = view.state.doc.toString()
      if (text.length > HARPER_LINT_CHAR_LIMIT) return []
      const session = await config.session()
      if (!session) return []
      const lints = await session.lint(text)
      return lints.map((lint) => toDiagnostic(config, text, lint))
    },
    {
      delay: HARPER_LINT_DELAY_MS,
      needsRefresh: (update) =>
        update.transactions.some((tr) => tr.effects.some((effect) => effect.is(harperRefresh))),
      // The stock lint tooltip is replaced by `hoverPopup` below.
      tooltipFilter: () => []
    }
  )

  return [
    harperConfigFacet.of(config),
    source,
    popupFieldFor(config),
    hoverHandlers(config)
  ]
}

/** Mapped issue positions used by the shared spelling motions. */
export function harperIssueRanges(view: EditorView): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = []
  forEachDiagnostic(view.state, (diagnostic, from, to) => {
    if (isHarperDiagnostic(diagnostic)) ranges.push({ from, to })
  })
  return ranges
}

export function closeHarperSuggestions(view: EditorView): void {
  view.dispatch({ effects: setHarperPopup.of(null) })
}
