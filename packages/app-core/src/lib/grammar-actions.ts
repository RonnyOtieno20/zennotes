import { Vim, getCM } from '@replit/codemirror-vim'
import type { EditorView } from '@codemirror/view'
import {
  addGrammarWordToDictionary,
  closeGrammarSuggestionCard,
  getGrammarEditorState,
  grammarDiagnosticAt,
  ignoreGrammarDiagnosticOnce,
  openGrammarSuggestionCard,
  selectGrammarDiagnostic
} from '../grammar/editor-extension'
import {
  closeHarperSuggestions,
  harperAddWordAtCursor,
  harperIgnoreAtCursor,
  harperIssueRanges,
  harperOpenSuggestions
} from './cm-harper'
import { harperEditorConfig } from './harper-runtime'

export type GrammarAction = 'next' | 'previous' | 'suggest' | 'addWord' | 'ignore'

/** One set of spelling bindings across both engines. Equal starts prefer LanguageTool. */
export function runGrammarAction(view: EditorView, action: GrammarAction): boolean {
  const grammar = getGrammarEditorState(view.state)
  const issues = [
    ...(grammar?.diagnostics.map((issue) => ({ ...issue.range, id: issue.id })) ?? []),
    ...harperIssueRanges(view).map((range) => ({ ...range, id: null }))
  ].sort((a, b) => a.from - b.from)
  const cursor = view.state.selection.main.head
  if (action === 'next' || action === 'previous') {
    const starts = issues.filter((issue, index) => !index || issue.from !== issues[index - 1]!.from)
    const target =
      action === 'next'
        ? (starts.find((issue) => issue.from > cursor) ?? starts[0])
        : (starts
            .slice()
            .reverse()
            .find((issue) => issue.from < cursor) ?? starts.at(-1))
    if (!target) return false
    closeGrammarSuggestionCard(view)
    closeHarperSuggestions(view)
    view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true })
    selectGrammarDiagnostic(view, target.id)
    return true
  }
  // Prefer the tightest LT finding under the cursor, then Harper's native
  // at-cursor/first-on-line fallback. Dictionary and ignores stay engine-owned.
  const diagnostic = grammar && grammarDiagnosticAt(grammar.diagnostics, cursor)
  if (diagnostic) {
    closeHarperSuggestions(view)
    if (action === 'suggest') return openGrammarSuggestionCard(view)
    if (action === 'ignore') return ignoreGrammarDiagnosticOnce(view, diagnostic.id)
    return addGrammarWordToDictionary(view, diagnostic.id)
  }
  closeGrammarSuggestionCard(view)
  if (action === 'suggest') return harperOpenSuggestions(view)
  if (action === 'ignore') return harperIgnoreAtCursor(view, harperEditorConfig())
  return harperAddWordAtCursor(view, harperEditorConfig())
}

export function registerGrammarVimActions(): void {
  // Preserve action names and IDs so existing user overrides still work.
  const actions = {
    Next: 'next',
    Previous: 'previous',
    Suggest: 'suggest',
    AddWord: 'addWord',
    Ignore: 'ignore'
  } as const
  for (const [name, action] of Object.entries(actions)) {
    Vim.defineAction(`zenHarper${name}`, (cm: ReturnType<typeof getCM>) => {
      const view = (cm as unknown as { cm6?: EditorView }).cm6
      if (view) runGrammarAction(view, action)
    })
  }
}
