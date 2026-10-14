import type { ChangeDesc, Text } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'
import type { GrammarDiagnostic } from './types'

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

export const emptySnapshot: GrammarEditorSnapshot = {
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

export function sortedValidDiagnostics(
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

/**
 * Every issue that the same fix resolves: same rule, same flagged text, and the
 * same replacement on offer (say each "color" in an en-GB note). Includes `diagnostic`.
 */
export function similarGrammarDiagnostics(
  diagnostics: readonly GrammarDiagnostic[],
  diagnostic: GrammarDiagnostic,
  replacementIndex = 0
): GrammarDiagnostic[] {
  const value = diagnostic.replacements[replacementIndex]?.value
  if (value === undefined || !diagnostic.original) return []
  return diagnostics.filter(
    (item) =>
      item.ruleId === diagnostic.ruleId &&
      item.original === diagnostic.original &&
      item.replacements.some((replacement) => replacement.value === value)
  )
}
