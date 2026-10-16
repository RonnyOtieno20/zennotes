// @vitest-environment jsdom
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { history, undo, redo } from '@codemirror/commands'
import { Compartment, EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import { wysiwygBlocksPlugin } from './cm-wysiwyg-blocks'
import { wikilinkRenderExtension } from './cm-wikilink-render'
import { mathRenderExtension } from './cm-math-render'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { liveTableField, parseLiveTable, selectionTouchesTable, sourceTableRanges } from './cm-live-tables'
import { livePreviewPlugin } from './cm-live-preview'
import { grammarEditorStateField, setGrammarSnapshot } from '../grammar/editor-state'
import type { GrammarDiagnostic } from '../grammar/types'

vi.mock('../store', () => ({
  useStore: Object.assign(() => null, {
    getState: () => ({ activeNote: null, notes: [], noteRefs: {}, assetFiles: [], vault: null }),
    subscribe: () => () => {}
  })
}))

const TABLE = '| **Name** | Value |\n| :--- | ---: |\n| bad | `a\\|b` |'
const DOC = `Before\n\n${TABLE}\n\nAfter`
const views: EditorView[] = []
afterEach(() => { for (const view of views.splice(0)) { view.destroy(); view.dom.remove() } })

function mount(doc = DOC, anchor = 0, extra: Parameters<typeof EditorState.create>[0] = {}): EditorView {
  const view = new EditorView({ parent: document.body, state: EditorState.create({
    doc, selection: { anchor },
    extensions: [markdown({ base: markdownLanguage }), history(), liveTableField, livePreviewPlugin, wysiwygBlocksPlugin, grammarEditorStateField],
    ...extra
  }) })
  views.push(view)
  forceParsing(view, doc.length, 5000)
  view.dispatch({})
  return view
}
const widget = (view: EditorView): HTMLElement | null => view.dom.querySelector('.cm-live-table')

describe('live table parsing', () => {
  it('parses alignment, optional outer pipes, escapes and inline code pipes', () => {
    const model = parseLiveTable('A | B | C\n:--- | :---: | ---:\nx\\|y | `a|b` | ``a`|b``')!
    expect(model.aligns).toEqual(['left', 'center', 'right'])
    expect(model.rows[1].map((cell) => cell.source)).toEqual(['x\\|y', '`a|b`', '``a`|b``'])
    expect(model.markdown).toContain('x\\|y | `a\\|b` | ``a`\\|b``')
    expect(model.rows[1].map((cell) => model.source.slice(cell.offset, cell.offset + cell.source.length)))
      .toEqual(model.rows[1].map((cell) => cell.source))
  })

  it.each(['| A | B |\n| --- | : |', '| A | B |\n| --- |', '| A | B |\n| | |', '| A | B |\n| ---'])
    ('leaves incomplete delimiters as source: %s', (source) => { expect(parseLiveTable(source)).toBeNull() })

  it('handles empty cells, escaped backslashes and unmatched backticks', () => {
    const model = parseLiveTable('| A | B | C |\n| - | - | - |\n| | \\`x | y |')!
    expect(model.rows[1].map((cell) => cell.source)).toEqual(['', '\\`x', 'y'])
    expect(parseLiveTable('| A | B |\n| - | - |\n| `x | y |')!.rows[1].map((cell) => cell.source)).toEqual(['`x', 'y'])
  })

  it.each(['> ', '- ', '  > ', '> - '])('handles container prefixes %s', (prefix) => {
    const continuation = prefix.replace(/- /g, '  ')
    const source = `${prefix}| A | B |\n${continuation}| :- | -: |\n${continuation}| x | y |`
    const parsed = parseLiveTable(source)!
    expect(parsed.rows[1].map((cell) => cell.source)).toEqual(['x', 'y'])
    expect(parsed.markdown).toBe(source)
    expect(source.slice(parsed.rows[1][1].offset, parsed.rows[1][1].offset + 1)).toBe('y')
  })
})

describe('table selection and decorations', () => {
  it('checks both edges, spanning selections and secondary cursors', () => {
    const table = { from: 10, to: 40 }
    for (const pos of [10, 20, 40]) expect(selectionTouchesTable(EditorSelection.single(pos), table)).toBe(true)
    expect(selectionTouchesTable(EditorSelection.single(5, 45), table)).toBe(true)
    expect(selectionTouchesTable(EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(20)]), table)).toBe(true)
    expect(selectionTouchesTable(EditorSelection.single(41), table)).toBe(false)
  })

  it('renders inactive tables, reveals the whole source, and renders on leaving', () => {
    const view = mount()
    expect(widget(view)?.querySelector('strong')?.textContent).toBe('Name')
    expect(widget(view)?.querySelector('th')?.getAttribute('align')).toBe('left')
    expect(widget(view)?.querySelector('th:nth-child(2)')?.getAttribute('align')).toBe('right')
    expect(widget(view)?.querySelector('code')?.textContent).toBe('a|b')
    for (const anchor of [DOC.indexOf('| **'), DOC.indexOf(':---'), DOC.indexOf('bad'), DOC.indexOf('\n\nAfter')]) {
      view.dispatch({ selection: { anchor } })
      expect(widget(view)).toBeNull()
      expect(sourceTableRanges(view.state)).toHaveLength(1)
      expect(view.contentDOM.textContent).toContain('**Name**')
    }
    view.dispatch({ selection: { anchor: DOC.indexOf('After') } })
    expect(widget(view)).not.toBeNull()
    expect(view.state.facet(EditorView.atomicRanges)).toHaveLength(0)
  })

  it('reveals every table crossed by a selection', () => {
    const doc = `${DOC}\n\n${TABLE}\n\nEnd`
    const view = mount(doc)
    expect(view.dom.querySelectorAll('.cm-live-table')).toHaveLength(2)
    view.dispatch({ selection: { anchor: 0, head: doc.length } })
    expect(view.dom.querySelectorAll('.cm-live-table')).toHaveLength(0)
  })

  it('enters source with vertical arrows, including shifted selection', () => {
    const view = mount()
    const table = view.state.field(liveTableField).tables[0]
    for (const [anchor, key, expected] of [
      [table.from - 1, 'ArrowDown', table.from],
      [table.to + 1, 'ArrowUp', table.to]
    ] as const) {
      view.dispatch({ selection: { anchor } })
      expect(widget(view)).not.toBeNull()
      expect(runScopeHandlers(view, new KeyboardEvent('keydown', { key }), 'editor')).toBe(true)
      expect(view.state.selection.main.head).toBe(expected)
      expect(widget(view)).toBeNull()
    }
    view.dispatch({ selection: { anchor: table.from - 1 } })
    runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true }), 'editor')
    expect(view.state.selection.main.anchor).toBe(table.from - 1)
    expect(view.state.selection.main.head).toBe(table.from)
  })

  it('maps click positions after edits above a cached widget', () => {
    const view = mount()
    const before = widget(view)!
    const model = view.state.field(liveTableField).tables[0].model
    view.dispatch({ changes: { from: 0, insert: 'prefix ' } })
    expect(widget(view)).toBe(before)
    expect(view.state.field(liveTableField).tables[0].model).toBe(model)
    before.querySelector('tbody td:nth-child(2)')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    expect(view.state.selection.main.head).toBe(view.state.doc.toString().indexOf('`a\\|b`'))
    expect(widget(view)).toBeNull()
  })

  it('leaves the scroll container available for native horizontal scrolling', () => {
    const view = mount()
    const table = widget(view)!
    // Scrollbars target the overflowing wrapper, rather than a table cell.
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
    table.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(widget(view)).toBe(table)
    table.querySelector('table')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    expect(view.state.selection.main.head).toBe(DOC.indexOf('| **'))
    expect(widget(view)).toBeNull()
  })

  it('reveals links, wikilinks, math and quote markers on all source rows', () => {
    const doc = 'Before\n\n> | A | B |\n> | --- | --- |\n> | **bold** | [Link](https://example.com) |\n> | [[Note]] | $x+1$ |\n\nAfter'
    const view = mount(doc, doc.indexOf('A |'), { extensions: [
      markdown({ base: markdownLanguage }), liveTableField, livePreviewPlugin,
      wysiwygBlocksPlugin, wikilinkRenderExtension, mathRenderExtension('katex')
    ] })
    expect(view.contentDOM.textContent).toContain('[Link](https://example.com)')
    expect(view.contentDOM.textContent).toContain('[[Note]]')
    expect(view.contentDOM.textContent).toContain('$x+1$')
    expect(view.contentDOM.textContent?.match(/>/g)).toHaveLength(4)
    expect(view.dom.querySelector('.cm-math-inline')).toBeNull()
  })

  it('supports typing, composition transactions and undo/redo without rewriting source', () => {
    const view = mount(DOC, DOC.indexOf('bad'))
    const original = view.state.doc.toString()
    view.dispatch(view.state.replaceSelection('語'), { userEvent: 'input.type.compose' })
    expect(widget(view)).toBeNull()
    expect(view.state.doc.toString()).toBe(original.replace('bad', '語bad'))
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(original)
    expect(redo(view)).toBe(true)
    expect(view.state.doc.toString()).toContain('語bad')
  })

  it('does not render incomplete tables while typing or after leaving', () => {
    const doc = 'Before\n\n| A | B |\n| --- | : |\n\nAfter'
    const view = mount(doc, doc.indexOf(':'))
    expect(widget(view)).toBeNull()
    view.dispatch({ changes: { from: doc.indexOf(':') + 1, insert: '---' } })
    expect(widget(view)).toBeNull()
    view.dispatch({ selection: { anchor: 0 } })
    expect(widget(view)).not.toBeNull()
    expect(undo(view)).toBe(true)
    expect(widget(view)).toBeNull()
  })

  it.each(['> | A | B |\n> | --- | --- |\n> | x | y |', '- | A | B |\n  | --- | --- |\n  | x | y |'])
    ('detects nested tables with whole source ranges: %s', (source) => {
      const view = mount(`Before\n\n${source}\n\nAfter`)
      const range = view.state.field(liveTableField).tables[0]
      expect(view.state.sliceDoc(range.from, range.to)).toBe(source)
      expect(widget(view)?.querySelectorAll('th')).toHaveLength(2)
      view.dispatch({ selection: { anchor: range.from + 1 } })
      expect(widget(view)).toBeNull()
    })

  it('ignores tables in fenced code and frontmatter-like HTML blocks', () => {
    const view = mount(`Before\n\n\`\`\`md\n${TABLE}\n\`\`\`\n\n<!--\n${TABLE}\n-->\n\nAfter`)
    expect(widget(view)).toBeNull()
  })

  it('handles code pipes even when Lezer does not recognize a GFM table', () => {
    const view = mount('Before\n\n| `a|b` | B |\n| --- | --- |\n| x | `c|d` |\n\nAfter')
    expect(widget(view)?.querySelector('th code')?.textContent).toBe('a|b')
    expect(widget(view)?.querySelector('td code')?.textContent).toBe('c|d')
  })

  it('retains width metadata and invalidates its model on edits', () => {
    const doc = `Before\n\n${TABLE}\n<!-- zen:cols=160,240 -->\n\nAfter`
    const view = mount(doc)
    expect(view.state.field(liveTableField).tables[0].model.source).toContain('zen:cols=')
    view.dispatch({ selection: { anchor: doc.indexOf('160') } })
    expect(widget(view)).toBeNull()
  })

  it('preserves the setting-off source path through compartment reconfiguration', () => {
    const compartment = new Compartment()
    const view = mount(DOC, 0, { extensions: [markdown({ base: markdownLanguage }), compartment.of(liveTableField)] })
    expect(widget(view)).not.toBeNull()
    view.dispatch({ effects: compartment.reconfigure([]) })
    expect(widget(view)).toBeNull()
    expect(view.contentDOM.textContent).toContain('| **Name** | Value |')
    view.dispatch({ effects: compartment.reconfigure(liveTableField) })
    expect(widget(view)).not.toBeNull()
  })

  it('keeps grammar underlines in source and hides them in the rendered table', () => {
    const view = mount(DOC, DOC.indexOf('bad'))
    const from = DOC.indexOf('bad')
    const diagnostic: GrammarDiagnostic = {
      id: 'table-grammar', provider: 'test', ruleId: 'test', category: 'grammar',
      message: 'Test issue', range: { from, to: from + 3 }, original: 'bad', replacements: [],
      severity: 'warning', generation: 1, segmentId: 'table'
    }
    view.dispatch({ effects: setGrammarSnapshot.of({ documentId: 'fixture', generation: 1, diagnostics: [diagnostic] }) })
    expect(view.dom.querySelector('.cm-grammar-diagnostic')?.textContent).toBe('bad')
    view.dispatch({ selection: { anchor: 0 } })
    expect(widget(view)).not.toBeNull()
    expect(view.dom.querySelector('.cm-grammar-diagnostic')).toBeNull()
    view.dispatch({ selection: { anchor: from } })
    view.dispatch({ changes: { from, to: from + 3, insert: 'good' } })
    expect(view.dom.querySelector('.cm-grammar-diagnostic')).toBeNull()
    view.dispatch({ selection: { anchor: 0 } })
    expect(widget(view)?.textContent).toContain('good')
  })

  it('reuses all table models on selection-only transactions in a large note', () => {
    const doc = 'Before\n\n' + Array.from({ length: 150 }, (_, i) => `${TABLE}\n\nText ${i}\n\n`).join('')
    const view = mount(doc)
    const models = view.state.field(liveTableField).tables.map((table) => table.model)
    expect(models).toHaveLength(150)
    view.dispatch({ selection: { anchor: doc.indexOf('bad') } })
    expect(view.state.field(liveTableField).tables.map((table) => table.model)).toEqual(models)
    view.dispatch({ changes: { from: 0, insert: 'prefix ' } })
    expect(view.state.field(liveTableField).tables.every((table, i) => table.model === models[i])).toBe(true)
  })
})
