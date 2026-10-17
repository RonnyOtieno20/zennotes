// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { setDiagnostics } from '@codemirror/lint'
import { Vim, getCM, vim } from '@replit/codemirror-vim'
import { harperExtensions, type HarperEditorConfig } from './cm-harper'
import {
  grammarEditorExtension,
  getGrammarEditorState,
  type GrammarEditorSession
} from '../grammar/editor-extension'
import type { GrammarDiagnostic } from '../grammar/types'
import { registerGrammarVimActions, runGrammarAction } from './grammar-actions'

vi.mock('harper.js/dist/harper_wasm_slim_bg.wasm?url', () => ({ default: '' }))

const persistence = vi.hoisted(() => ({
  addWord: vi.fn(async () => {}),
  ignore: vi.fn(async () => {})
}))
vi.mock('./harper-runtime', () => ({ harperEditorConfig: () => persistence }))
const cleanup: Array<() => void> = []
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn())
  vi.clearAllMocks()
})

function setup(lt = true, harper = true, replacements = ['good', 'better'], harperFrom = 9) {
  const issue: GrammarDiagnostic = {
    id: 'lt',
    provider: 'test',
    ruleId: 'SPELL',
    category: 'spelling',
    message: 'Spelling mistake',
    range: { from: 0, to: 3 },
    original: 'bad',
    replacements: replacements.map((value) => ({ value })),
    severity: 'warning',
    generation: 1,
    segmentId: 's'
  }
  const session: GrammarEditorSession = {
    getSnapshot: () => ({ documentId: 'zztest-keys.md', generation: 1, diagnostics: [issue] }),
    getDocumentContext: () => ({ documentId: 'zztest-keys.md', generation: 1 }),
    subscribe: () => () => {},
    ignoreOnce: vi.fn(),
    addToDictionary: vi.fn()
  }
  const config: HarperEditorConfig = { session: async () => null, ...persistence }
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: 'bad then teh',
      extensions: [
        vim(),
        ...(lt ? [grammarEditorExtension({ session })] : []),
        ...(harper ? [harperExtensions(config)] : [])
      ]
    })
  })
  if (harper)
    view.dispatch(
      setDiagnostics(view.state, [
        {
          from: harperFrom,
          to: harperFrom + 3,
          severity: 'warning',
          source: 'Harper',
          message: 'Typo',
          harper: {
            from: harperFrom,
            to: harperFrom + 3,
            kind: 'Spelling',
            kindLabel: 'Spelling',
            problem: view.state.sliceDoc(harperFrom, harperFrom + 3),
            message: 'Typo',
            suggestions: [{ kind: 'replace', text: 'the', label: 'the' }]
          },
          sourceText: view.state.doc.toString()
        } as never
      ])
    )
  cleanup.push(() => view.destroy())
  registerGrammarVimActions()
  for (const [keys, action] of Object.entries({
    ']s': 'Next',
    '[s': 'Previous',
    'z=': 'Suggest',
    zg: 'AddWord',
    zG: 'Ignore'
  }))
    Vim.mapCommand(keys, 'action', `zenHarper${action}`, {}, { context: 'normal' })
  return { view, session }
}
function vimKeys(view: EditorView, keys: string) {
  for (const key of keys) Vim.handleKey(getCM(view)!, key, 'user')
}
function key(view: EditorView, value: string) {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
  )
}

describe('shared grammar spelling keys', () => {
  it.each([
    [true, false],
    [false, true],
    [true, true]
  ])(
    'navigates enabled engines LT=%s Harper=%s with wrapping and no Vim visual selection',
    (lt, harper) => {
      const { view } = setup(lt, harper)
      vimKeys(view, ']s')
      expect(view.state.selection.main.head).toBe(harper ? 9 : 0)
      expect(view.state.selection.main.empty).toBe(true)
      vimKeys(view, ']s')
      expect(view.state.selection.main.head).toBe(lt ? 0 : 9)
      vimKeys(view, '[s')
      expect(view.state.selection.main.head).toBe(harper ? 9 : 0)
    }
  )
  it('opens a numbered LT card with z= and applies the second fix before Vim consumes the number', () => {
    const { view } = setup()
    vimKeys(view, 'z=')
    expect(getGrammarEditorState(view.state)?.openDiagnosticId).toBe('lt')
    key(view, '2')
    expect(view.state.doc.toString()).toBe('better then teh')
  })
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('applies suggestion %s with its numbered key', (number) => {
    const { view } = setup(
      true,
      false,
      Array.from({ length: 9 }, (_, i) => `fix${i + 1}`)
    )
    vimKeys(view, 'z=')
    key(view, String(number))
    expect(view.state.doc.toString()).toBe(`fix${number} then teh`)
  })
  it('keeps dictionary and ignore actions clickable', () => {
    const { view, session } = setup(true, false)
    vimKeys(view, 'z=')
    const button = [
      ...document.querySelectorAll<HTMLButtonElement>('.cm-grammar-suggestion-card button')
    ].find((button) => button.textContent === 'zgAdd to dictionary')
    expect(button).toBeDefined()
    button!.click()
    expect(session.addToDictionary).toHaveBeenCalledWith('bad')
    expect(session.ignoreOnce).toHaveBeenCalledWith('lt')
  })
  it('Escape closes without changing the note, and an unavailable number never runs an ignore action', () => {
    const { view, session } = setup(true, false, [])
    vimKeys(view, 'z=')
    key(view, '1')
    expect(session.ignoreOnce).not.toHaveBeenCalled()
    key(view, 'Escape')
    expect(getGrammarEditorState(view.state)?.openDiagnosticId).toBeNull()
    expect(view.state.doc.toString()).toBe('bad then teh')
  })
  it('routes zg/zG to the engine at the cursor when both are enabled', () => {
    const { view, session } = setup()
    vimKeys(view, 'zg')
    expect(session.addToDictionary).toHaveBeenCalledWith('bad')
    expect(persistence.addWord).not.toHaveBeenCalled()
    view.dispatch({ selection: { anchor: 9 } })
    vimKeys(view, 'zg')
    expect(persistence.addWord).toHaveBeenCalledWith('teh')
    vimKeys(view, 'zG')
    expect(persistence.ignore).toHaveBeenCalledWith(
      'bad then teh',
      expect.objectContaining({ problem: 'teh' })
    )
  })
  it('ignores an LT issue without modifying text or Harper persistence', () => {
    const { view, session } = setup()
    vimKeys(view, 'zG')
    expect(session.ignoreOnce).toHaveBeenCalledWith('lt')
    expect(view.state.doc.toString()).toBe('bad then teh')
    expect(persistence.ignore).not.toHaveBeenCalled()
  })
  it('visits an overlapping position once and opens only the preferred LT card', () => {
    const { view, session } = setup(true, true, ['good'], 0)
    vimKeys(view, ']s')
    expect(view.state.selection.main.head).toBe(0)
    vimKeys(view, '[s')
    expect(view.state.selection.main.head).toBe(0)
    vimKeys(view, 'z=')
    expect(document.querySelectorAll('.cm-harper-popup')).toHaveLength(1)
    expect(document.querySelector('.cm-harper-popup')?.textContent).toContain('LanguageTool')
    vimKeys(view, 'zG')
    expect(session.ignoreOnce).toHaveBeenCalledExactlyOnceWith('lt')
    expect(persistence.ignore).not.toHaveBeenCalled()
  })
  it('opens Harper at its cursor even while LT has diagnostics elsewhere', () => {
    const { view } = setup()
    view.dispatch({ selection: { anchor: 9 } })
    vimKeys(view, 'z=')
    expect(document.querySelector('.cm-harper-popup')?.textContent).toContain('Harper')
    key(view, '1')
    expect(view.state.doc.toString()).toBe('bad then the')
  })
  it('is inert with both engines disabled', () => {
    const { view } = setup(false, false)
    expect(runGrammarAction(view, 'next')).toBe(false)
    expect(runGrammarAction(view, 'suggest')).toBe(false)
  })
})
