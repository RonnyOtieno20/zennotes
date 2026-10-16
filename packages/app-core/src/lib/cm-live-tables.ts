/** Selection-aware tables. Editing belongs to CodeMirror, never to a second
 * contenteditable in a widget. Block replacements must be supplied directly
 * by a StateField (before CodeMirror computes its viewport). */
import { syntaxTree } from '@codemirror/language'
import { EditorSelection, Prec, StateField, type EditorState } from '@codemirror/state'
import { Decoration, EditorView, keymap, WidgetType, type DecorationSet } from '@codemirror/view'
import { renderMarkdown } from './markdown'
import { parseColWidthsComment, type ColumnAlign } from './markdown-table'

interface Cell {
  source: string
  /** Offset from the beginning of the original table, including containers. */
  offset: number
}

export interface LiveTableModel {
  source: string
  rows: Cell[][]
  aligns: ColumnAlign[]
  markdown: string
  length: number
}

export interface LiveTableRange {
  from: number
  to: number
  model: LiveTableModel
}

/** Preserve escapes and complete backtick spans, including multi-backtick
 * code. Unclosed backticks remain ordinary source while a cell is being typed.
 * GFM requires pipes in code to be escaped; normalize only the render copy. */
function rowCells(source: string, offset: number): { cells: Cell[]; markdown: string; pipes: number } {
  const tokens = Array.from(source.matchAll(/\\[\s\S]|`+|\|/g))
  const nextTick = new Map<number, number>()
  const closing = new Map<number, number>()
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i][0]
    if (token[0] !== '`') continue
    const next = nextTick.get(token.length)
    if (next !== undefined) closing.set(i, next)
    nextTick.set(token.length, i)
  }
  const separators: number[] = []
  const codePipes = new Set<number>()
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const end = closing.get(i)
    if (token[0][0] === '`' && end !== undefined) {
      for (let j = i + 1; j < end; j++) {
        if (tokens[j][0] === '|') codePipes.add(tokens[j].index!)
      }
      i = end
    } else if (token[0] === '|') separators.push(token.index!)
  }
  const boundaries = [-1, ...separators, source.length]
  const cells: Cell[] = []
  for (let i = 1; i < boundaries.length; i++) {
    const start = boundaries[i - 1] + 1
    const end = boundaries[i]
    const raw = source.slice(start, end)
    // Ignore the empty segments outside optional leading/trailing pipes.
    if (!raw.trim() && ((i === 1 && separators[0] === source.search(/\S/)) ||
      (i === boundaries.length - 1 && separators.at(-1) === source.trimEnd().length - 1))) continue
    cells.push({ source: raw.trim(), offset: offset + start + raw.length - raw.trimStart().length })
  }
  let markdown = ''
  for (let i = 0; i < source.length; i++) markdown += (codePipes.has(i) ? '\\' : '') + source[i]
  return { cells, markdown, pipes: separators.length }
}

/** Parse only complete tables. Partial/mismatched delimiter rows stay source.
 * Container prefixes are removed from the render copy, never the document. */
export function parseLiveTable(source: string): LiveTableModel | null {
  const lines = source.split('\n')
  if (lines.length < 2) return null
  let offset = 0
  const rows: ReturnType<typeof rowCells>[] = []
  const prefixes: string[] = []
  let length = 0
  let widths = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const prefix = line.match(/^(?:[ \t]*>[ \t]?)*[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?/)![0]
    const content = line.slice(prefix.length)
    if (i > 1 && parseColWidthsComment(content)) {
      widths = content
      length = offset + line.length
      break
    }
    const row = rowCells(content, offset + prefix.length)
    if (!row.pipes || !content.trim()) break
    rows.push(row)
    prefixes.push(prefix)
    length = offset + line.length
    offset += line.length + 1
  }
  if (rows.length < 2 || !rows[0].cells.length || rows[0].cells.length !== rows[1].cells.length) return null
  const specs = rows[1].cells.map((cell) => cell.source)
  if (!specs.every((spec) => /^:?-+:?$/.test(spec))) return null
  const aligns: ColumnAlign[] = specs.map((spec) => spec.startsWith(':')
    ? spec.endsWith(':') ? 'center' : 'left'
    : spec.endsWith(':') ? 'right' : 'none')
  return {
    source: source.slice(0, length),
    rows: [rows[0].cells, ...rows.slice(2).map((row) => row.cells.slice(0, specs.length))],
    aligns,
    markdown: rows.map((row, i) => (/\S/.test(prefixes[0]) ? prefixes[i] : '') + row.markdown).join('\n') + (widths ? `\n${widths}` : ''),
    length
  }
}

/** Includes empty cursors at either edge and selections spanning the table,
 * even when neither endpoint is inside. Check every selection, not just main. */
export function selectionTouchesTable(selection: EditorSelection, table: { from: number; to: number }): boolean {
  return selection.ranges.some((range) => range.from <= table.to && range.to >= table.from)
}

class LiveTableWidget extends WidgetType {
  constructor(readonly model: LiveTableModel) { super() }

  eq(other: LiveTableWidget): boolean { return this.model.source === other.model.source }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('div')
    root.className = 'cm-live-table prose-zen'
    root.contentEditable = 'false'
    root.setAttribute('aria-label', 'Markdown table. Click a cell to edit source.')
    root.innerHTML = renderMarkdown(this.model.markdown)
    root.querySelectorAll('tr').forEach((row, r) => {
      row.querySelectorAll<HTMLElement>('th, td').forEach((cell, c) => {
        cell.dataset.tableOffset = String(this.model.rows[r]?.[c]?.offset ?? 0)
      })
    })
    // Resolve the position from the live DOM, not a constructor-time absolute
    // offset: eq() keeps this widget alive when text is inserted above it.
    const reveal = (event: MouseEvent): void => {
      if (event.button !== 0) return
      const target = event.target instanceof Element ? event.target : null
      // Native scrollbar gestures target the wrapper. Leave those untouched.
      if (!target?.closest('table')) return
      event.preventDefault()
      const cell = target.closest<HTMLElement>('[data-table-offset]')
      const anchor = view.posAtDOM(root) + Number(cell?.dataset.tableOffset ?? 0)
      view.dispatch({ selection: { anchor }, scrollIntoView: true })
      view.focus()
    }
    root.addEventListener('mousedown', reveal)
    // Keyboard/assistive-technology generated clicks have no preceding mousedown.
    root.addEventListener('click', (event) => { if (event.detail === 0) reveal(event) })
    return root
  }

  ignoreEvent(): boolean { return true }
}

interface TableState {
  tables: readonly LiveTableRange[]
  cache: ReadonlyMap<string, LiveTableModel | null>
  decorations: DecorationSet
}

function detectTables(state: EditorState, previous?: TableState): Pick<TableState, 'tables' | 'cache'> {
  const tables: LiveTableRange[] = []
  const cache = new Map<string, LiveTableModel | null>()
  syntaxTree(state).iterate({
    enter(node) {
      // Paragraph fallback covers complete code spans containing unescaped
      // pipes, which Lezer's strictly GFM table splitter cannot recognize.
      if (node.name !== 'Table' && node.name !== 'Paragraph') return
      const from = state.doc.lineAt(node.from).from
      const last = state.doc.lineAt(node.to)
      let to = node.to
      if (last.number < state.doc.lines && parseColWidthsComment(state.doc.line(last.number + 1).text.trim())) {
        to = state.doc.line(last.number + 1).to
      }
      const source = state.sliceDoc(from, to)
      if (!source.includes('\n') || !source.includes('|')) return false
      const model = previous?.cache.has(source) ? previous.cache.get(source)! : parseLiveTable(source)
      cache.set(source, model)
      if (model) tables.push({ from, to: from + model.length, model })
      return false
    }
  })
  return { tables, cache }
}

function decorate(state: EditorState, tables: readonly LiveTableRange[]): DecorationSet {
  return Decoration.set(tables.filter((table) => !selectionTouchesTable(state.selection, table)).map((table) =>
    Decoration.replace({ block: true, widget: new LiveTableWidget(table.model) }).range(table.from, table.to)
  ), true)
}

/** Vertical movement is measured in screen lines, so CodeMirror normally
 * jumps over block widgets even without atomicRanges. Enter their first/last
 * source line before handing subsequent navigation back to the editor. */
function enterTable(view: EditorView, direction: -1 | 1, extend = false): boolean {
  const tables = view.state.field(liveTableField).tables
  let entered = false
  const selection = view.state.changeByRange((range) => {
    const line = view.state.doc.lineAt(range.head)
    const table = tables.find((table) => {
      if (selectionTouchesTable(EditorSelection.create([range]), table)) return false
      const edge = view.state.doc.lineAt(direction === 1 ? table.from : table.to)
      return edge.number === line.number + direction
    })
    if (!table) return { range }
    entered = true
    const head = direction === 1 ? table.from : table.to
    return { range: extend ? EditorSelection.range(range.anchor, head) : EditorSelection.cursor(head) }
  })
  if (entered) view.dispatch({ ...selection, scrollIntoView: true, userEvent: 'select' })
  return entered
}

const tableNavigation = Prec.high(keymap.of([
  { key: 'ArrowDown', run: (view) => enterTable(view, 1), shift: (view) => enterTable(view, 1, true) },
  { key: 'ArrowUp', run: (view) => enterTable(view, -1), shift: (view) => enterTable(view, -1, true) }
]))

export const liveTableField = StateField.define<TableState>({
  create(state) {
    const detected = detectTables(state)
    return { ...detected, decorations: decorate(state, detected.tables) }
  },
  update(value, tr) {
    // Tree positions are authoritative after document changes, including undo,
    // IME and remote edits. Reuse models by source; offsets inside them are
    // relative. Selection-only transactions never parse or render a table.
    if (tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
      const detected = detectTables(tr.state, value)
      return { ...detected, decorations: decorate(tr.state, detected.tables) }
    }
    if (tr.selection) return { ...value, decorations: decorate(tr.state, value.tables) }
    return value
  },
  provide: (field) => [EditorView.decorations.from(field, (value) => value.decorations), tableNavigation]
  // Deliberately no atomicRanges: keyboard navigation must enter the source.
})

/** Let the inline live preview reveal markers on *every* line of the active
 * table, rather than just the line containing the caret. */
export function sourceTableRanges(state: EditorState): readonly LiveTableRange[] {
  return state.field(liveTableField, false)?.tables.filter((table) => selectionTouchesTable(state.selection, table)) ?? []
}
