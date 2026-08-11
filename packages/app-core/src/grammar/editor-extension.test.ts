// @vitest-environment jsdom

import { ChangeSet, EditorState } from '@codemirror/state'
import { history, redo, undo } from '@codemirror/commands'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyGrammarReplacement,
  applyGrammarReplacementAndNext,
  buildGrammarDecorations,
  getGrammarEditorState,
  grammarDiagnosticAt,
  grammarEditorExtension,
  ignoreGrammarDiagnosticOnce,
  mapGrammarDiagnostics,
  nextGrammarDiagnostic,
  openAdjacentGrammarSuggestionCard,
  openGrammarSuggestionCard,
  setGrammarSnapshot,
  updateGrammarUi,
  validateGrammarReplacement,
  type GrammarEditorSession,
  type GrammarEditorSnapshot
} from './editor-extension'
import type { GrammarDiagnostic, GrammarCategory } from './types'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
})

function diagnostic(
  id: string,
  from: number,
  to: number,
  original: string,
  category: GrammarCategory = 'grammar'
): GrammarDiagnostic {
  return {
    id,
    provider: 'test',
    ruleId: `rule-${id}`,
    category,
    message: `Problem ${id}`,
    range: { from, to },
    original,
    replacements: [{ value: id === 'one' ? 'good' : 'better' }],
    severity: 'warning',
    generation: 4,
    segmentId: `segment-${id}`
  }
}

function makeSession(snapshot: GrammarEditorSnapshot): GrammarEditorSession & {
  publish(next: GrammarEditorSnapshot): void
  ignoreOnce: ReturnType<typeof vi.fn>
  onApplied: ReturnType<typeof vi.fn>
  selectDiagnostic: ReturnType<typeof vi.fn>
} {
  let current = snapshot
  const listeners = new Set<(value: GrammarEditorSnapshot) => void>()
  return {
    getSnapshot: () => current,
    getDocumentContext: () => ({
      documentId: current.documentId,
      generation: current.generation
    }),
    subscribe(listener) {
      listeners.add(listener)
      listener(current)
      return () => listeners.delete(listener)
    },
    publish(next) {
      current = next
      listeners.forEach((listener) => listener(next))
    },
    ignoreOnce: vi.fn(),
    onApplied: vi.fn(),
    selectDiagnostic: vi.fn()
  }
}

function makeView(
  doc: string,
  session: GrammarEditorSession,
  options: { showUnderlines?: boolean } = {}
): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [history(), grammarEditorExtension({ session, ...options })]
    })
  })
  cleanups.push(() => {
    view.destroy()
    parent.remove()
  })
  return view
}

describe('grammar diagnostic pure helpers', () => {
  it('maps diagnostics through edits outside their range and drops touched diagnostics', () => {
    const issue = diagnostic('one', 4, 7, 'bad')
    const insertedBefore = ChangeSet.of([{ from: 0, insert: 'xx' }], 10)
    expect(mapGrammarDiagnostics([issue], insertedBefore)[0]?.range).toEqual({
      from: 6,
      to: 9
    })

    const insertedAtStart = ChangeSet.of([{ from: 4, insert: 'xx' }], 10)
    expect(mapGrammarDiagnostics([issue], insertedAtStart)[0]?.range).toEqual({
      from: 6,
      to: 9
    })

    const editedInside = ChangeSet.of([{ from: 5, to: 6, insert: 'x' }], 10)
    expect(mapGrammarDiagnostics([issue], editedInside)).toEqual([])

    const insertion = diagnostic('insert', 4, 4, '')
    expect(mapGrammarDiagnostics([insertion], insertedAtStart)).toEqual([])
  })

  it('finds the tightest diagnostic at a position and wraps next selection', () => {
    const outer = diagnostic('outer', 1, 8, '1234567')
    const inner = diagnostic('inner', 3, 5, '34')
    expect(grammarDiagnosticAt([outer, inner], 4)?.id).toBe('inner')
    expect(nextGrammarDiagnostic([outer, inner], 9)?.id).toBe('outer')
    expect(nextGrammarDiagnostic([outer, inner], 1, 'outer')?.id).toBe('inner')
  })

  it('builds category underlines and a stronger selected decoration', () => {
    const decorations = buildGrammarDecorations(
      [diagnostic('one', 0, 3, 'bad', 'spelling'), diagnostic('two', 4, 9, 'worse', 'style')],
      'two'
    )
    const specs: Array<{ from: number; to: number; className: string }> = []
    decorations.between(0, 9, (from, to, value) => {
      specs.push({ from, to, className: String(value.spec.class) })
    })
    expect(specs).toEqual([
      {
        from: 0,
        to: 3,
        className: 'cm-grammar-diagnostic cm-grammar-diagnostic-spelling'
      },
      {
        from: 4,
        to: 9,
        className:
          'cm-grammar-diagnostic cm-grammar-diagnostic-style cm-grammar-diagnostic-selected'
      }
    ])
  })

  it('validates document, generation, authoritative range, replacement, and original text', () => {
    const issue = diagnostic('one', 0, 3, 'bad')
    const snapshot: GrammarEditorSnapshot = {
      documentId: 'note.md',
      generation: 4,
      diagnostics: [issue]
    }
    const base = {
      diagnostic: issue,
      replacementIndex: 0,
      mappedRange: issue.range,
      document: 'bad text',
      snapshot,
      currentDocument: { documentId: 'note.md', generation: 4 }
    }
    expect(validateGrammarReplacement(base)).toEqual({
      valid: true,
      replacement: 'good'
    })
    expect(
      validateGrammarReplacement({
        ...base,
        currentDocument: { documentId: 'other.md', generation: 4 }
      })
    ).toEqual({ valid: false, reason: 'document' })
    expect(
      validateGrammarReplacement({
        ...base,
        currentDocument: { documentId: 'note.md', generation: 5 }
      })
    ).toEqual({ valid: false, reason: 'generation' })
    expect(validateGrammarReplacement({ ...base, mappedRange: { from: 1, to: 4 } })).toEqual({
      valid: false,
      reason: 'range'
    })
    expect(validateGrammarReplacement({ ...base, document: 'bag text' })).toEqual({
      valid: false,
      reason: 'original'
    })
    expect(validateGrammarReplacement({ ...base, replacementIndex: 99 })).toEqual({
      valid: false,
      reason: 'replacement'
    })
  })
})

describe('grammar CodeMirror extension', () => {
  it('keeps review diagnostics while inline underlines are hidden', () => {
    const session = makeSession({
      documentId: 'note',
      generation: 4,
      diagnostics: [diagnostic('one', 2, 5, 'bad')]
    })
    const view = makeView('A bad sentence.', session, { showUnderlines: false })
    const state = getGrammarEditorState(view.state)

    expect(state?.diagnostics).toHaveLength(1)
    expect(state?.decorations.size).toBe(0)
  })

  it('maps or drops visible diagnostics immediately as the document changes', () => {
    const issue = diagnostic('one', 4, 7, 'bad')
    const session = makeSession({
      documentId: 'note.md',
      generation: 4,
      diagnostics: [issue]
    })
    const view = makeView('xxx bad end', session)

    view.dispatch({ changes: { from: 0, insert: '!' } })
    expect(getGrammarEditorState(view.state)?.diagnostics[0]?.range).toEqual({
      from: 5,
      to: 8
    })
    view.dispatch({ changes: { from: 6, to: 7, insert: 'x' } })
    expect(getGrammarEditorState(view.state)?.diagnostics).toEqual([])
  })

  it('accepts authoritative session snapshots through the exported effect', () => {
    const session = makeSession({
      documentId: 'note.md',
      generation: 4,
      diagnostics: []
    })
    const view = makeView('bad', session)
    const issue = diagnostic('one', 0, 3, 'bad')
    view.dispatch({
      effects: setGrammarSnapshot.of({
        documentId: 'note.md',
        generation: 4,
        diagnostics: [issue]
      })
    })
    expect(getGrammarEditorState(view.state)?.diagnostics.map((item) => item.id)).toEqual(['one'])
  })

  it('applies a replacement in one undoable transaction and reports it', () => {
    const issue = diagnostic('one', 0, 3, 'bad')
    const session = makeSession({
      documentId: 'note.md',
      generation: 4,
      diagnostics: [issue]
    })
    const view = makeView('bad text', session)

    expect(applyGrammarReplacement(view, 'one', 0)).toMatchObject({
      applied: true
    })
    expect(view.state.doc.toString()).toBe('good text')
    expect(session.onApplied).toHaveBeenCalledWith({
      diagnosticId: 'one',
      replacement: 'good',
      from: 0,
      to: 3,
      generation: 4
    })
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('bad text')
    expect(redo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('good text')
  })

  it('rejects apply after an edit maps the local range away from the accepted snapshot', () => {
    const issue = diagnostic('one', 4, 7, 'bad')
    const session = makeSession({
      documentId: 'note.md',
      generation: 4,
      diagnostics: [issue]
    })
    const view = makeView('xxx bad', session)
    view.dispatch({ changes: { from: 0, insert: '!' } })

    expect(applyGrammarReplacement(view, 'one', 0)).toEqual({
      applied: false,
      diagnosticId: 'one',
      reason: 'range'
    })
    expect(view.state.doc.toString()).toBe('!xxx bad')
  })

  it('returns and selects the mapped next issue after apply', () => {
    const first = diagnostic('one', 0, 3, 'bad')
    const second = diagnostic('two', 4, 9, 'worse')
    const session = makeSession({
      documentId: 'note.md',
      generation: 4,
      diagnostics: [first, second]
    })
    const view = makeView('bad worse', session)

    expect(applyGrammarReplacementAndNext(view, 'one', 0)).toEqual({
      applied: true,
      diagnosticId: 'one',
      nextDiagnosticId: 'two',
      nextRange: { from: 5, to: 10 }
    })
    expect(getGrammarEditorState(view.state)?.selectedDiagnosticId).toBe('two')
    expect(getGrammarEditorState(view.state)?.openDiagnosticId).toBe('two')
  })

  it('ignores once and advances without editing the document', () => {
    const first = diagnostic('one', 0, 3, 'bad')
    const second = diagnostic('two', 4, 9, 'worse')
    const session = makeSession({
      documentId: 'note.md',
      generation: 4,
      diagnostics: [first, second]
    })
    const view = makeView('bad worse', session)

    expect(ignoreGrammarDiagnosticOnce(view, 'one')).toBe(true)
    expect(view.state.doc.toString()).toBe('bad worse')
    expect(session.ignoreOnce).toHaveBeenCalledWith('one')
    expect(getGrammarEditorState(view.state)?.diagnostics.map((item) => item.id)).toEqual(['two'])
    expect(getGrammarEditorState(view.state)?.selectedDiagnosticId).toBe('two')
  })

  it('opens at the cursor with Alt-Enter and gives card keys precedence only while open', () => {
    const issue = diagnostic('one', 0, 3, 'bad')
    const session = makeSession({
      documentId: 'note.md',
      generation: 4,
      diagnostics: [issue]
    })
    const view = makeView('bad text', session)
    view.dispatch({ selection: { anchor: 1 } })

    const altEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      altKey: true
    })
    expect(runScopeHandlers(view, altEnter, 'editor')).toBe(true)
    expect(getGrammarEditorState(view.state)?.openDiagnosticId).toBe('one')
    expect(document.querySelector('.cm-grammar-suggestion-card')?.textContent).toContain(
      'Problem one'
    )

    expect(runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'j' }), 'editor')).toBe(true)
    expect(runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'Escape' }), 'editor')).toBe(
      true
    )
    expect(getGrammarEditorState(view.state)?.openDiagnosticId).toBeNull()
    expect(runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'j' }), 'editor')).toBe(false)
  })

  it('opens the actionable correction card from an underlined diagnostic', () => {
    const issue = diagnostic('one', 0, 3, 'bad', 'style')
    const session = makeSession({
      documentId: 'note.md',
      generation: 4,
      diagnostics: [issue]
    })
    const view = makeView('bad text', session)
    expect(document.querySelector('[data-grammar-diagnostic="one"]')).not.toBeNull()
    view.dispatch({
      effects: updateGrammarUi.of({ selectId: 'one', openId: 'one' })
    })

    const card = document.querySelector<HTMLElement>('.cm-grammar-suggestion-card')
    expect(card?.getAttribute('role')).toBe('dialog')
    expect(card?.textContent).toContain('style')
    expect(card?.textContent).toContain('Problem one')
    expect(card?.textContent).toContain('bad')
    expect(card?.textContent).toContain('good')
    expect(card?.textContent).toContain('Ignore once')
  })

  it('offers persistent ignore and dictionary actions when the session supports them', () => {
    const issue = diagnostic('one', 0, 3, 'bad', 'spelling')
    const session = makeSession({
      documentId: 'note.md',
      generation: 4,
      diagnostics: [issue]
    })
    const ignoreRule = vi.fn()
    const addToDictionary = vi.fn()
    Object.assign(session, { ignoreRule, addToDictionary })
    const view = makeView('bad text', session)
    view.dispatch({ effects: updateGrammarUi.of({ openId: 'one' }) })

    const buttons = [
      ...document.querySelectorAll<HTMLButtonElement>('.cm-grammar-suggestion-card button')
    ]
    expect(buttons.map((button) => button.textContent)).toEqual([
      'good',
      'Ignore once',
      'Ignore rule',
      'Add word',
      'Dismiss'
    ])
    buttons.find((button) => button.textContent === 'Ignore rule')?.click()
    expect(ignoreRule).toHaveBeenCalledWith('rule-one')
  })

  it('does not offer to ignore an entire spelling engine', () => {
    const issue = {
      ...diagnostic('one', 0, 3, 'bad', 'spelling'),
      ruleId: 'MORFOLOGIK_RULE_EN_GB'
    }
    const session = makeSession({
      documentId: 'note.md',
      generation: 4,
      diagnostics: [issue]
    })
    Object.assign(session, { ignoreRule: vi.fn(), addToDictionary: vi.fn() })
    const view = makeView('bad text', session)
    view.dispatch({ effects: updateGrammarUi.of({ openId: 'one' }) })

    const labels = [
      ...document.querySelectorAll<HTMLButtonElement>('.cm-grammar-suggestion-card button')
    ].map((button) => button.textContent)
    expect(labels).not.toContain('Ignore rule')
    expect(labels).toContain('Add word')
  })

  it('does not open a suggestion card when the cursor is outside an issue', () => {
    const issue = diagnostic('one', 0, 3, 'bad')
    const session = makeSession({
      documentId: 'note.md',
      generation: 4,
      diagnostics: [issue]
    })
    const view = makeView('bad text', session)
    view.dispatch({ selection: { anchor: 5 } })
    expect(openGrammarSuggestionCard(view)).toBe(false)
  })

  it('opens next and previous issues from the keyboard and wraps', () => {
    const one = diagnostic('one', 0, 3, 'bad')
    const two = diagnostic('two', 4, 8, 'text')
    const session = makeSession({
      documentId: 'note.md',
      generation: 4,
      diagnostics: [one, two]
    })
    const view = makeView('bad text', session)

    expect(openAdjacentGrammarSuggestionCard(view, 1)).toBe(true)
    expect(getGrammarEditorState(view.state)).toMatchObject({
      selectedDiagnosticId: 'one',
      openDiagnosticId: 'one'
    })
    expect(view.state.selection.main).toMatchObject({ from: 0, to: 3 })

    expect(openAdjacentGrammarSuggestionCard(view, -1)).toBe(true)
    expect(getGrammarEditorState(view.state)).toMatchObject({
      selectedDiagnosticId: 'two',
      openDiagnosticId: 'two'
    })
    expect(view.state.selection.main).toMatchObject({ from: 4, to: 8 })
    expect(session.selectDiagnostic).toHaveBeenLastCalledWith('two')
  })
})
