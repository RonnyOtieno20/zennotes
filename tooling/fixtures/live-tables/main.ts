import '../../../packages/app-core/src/styles/index.css'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { forceParsing } from '@codemirror/language'
import { noteMarkdown } from '../../../packages/app-core/src/lib/cm-markdown-language'
import { liveTableField } from '../../../packages/app-core/src/lib/cm-live-tables'
import { livePreviewPlugin } from '../../../packages/app-core/src/lib/cm-live-preview'
import { wysiwygBlocksPlugin } from '../../../packages/app-core/src/lib/cm-wysiwyg-blocks'
import { renderMarkdown } from '../../../packages/app-core/src/lib/markdown'
import { grammarEditorStateField, setGrammarSnapshot } from '../../../packages/app-core/src/grammar/editor-state'

const doc = [
  'Before', '',
  '| **Name** | *Status* | Value |', '| :--- | :---: | ---: |',
  '| bad | ready | `a\\|b` |', '| [Link](https://example.com) | ~~old~~ | 42 |', '',
  '> | Quoted | Table |', '> | --- | ---: |', '> | x | y |', '',
  '- | List | Table |', '  | --- | --- |', '  | x | y |', '',
  '| Wide column | Another long column | Third long column | Fourth long column |',
  '| --- | --- | --- | --- |',
  '| abcdefghijklmnopqrstuvwxyz | abcdefghijklmnopqrstuvwxyz | abcdefghijklmnopqrstuvwxyz | abcdefghijklmnopqrstuvwxyz |', '',
  'After', ''
].join('\n')
const view = new EditorView({ parent: document.querySelector('#editor')!, state: EditorState.create({
  doc, extensions: [noteMarkdown(), history(), keymap.of([...defaultKeymap, ...historyKeymap]),
    liveTableField, livePreviewPlugin, wysiwygBlocksPlugin, grammarEditorStateField,
    EditorView.lineWrapping, EditorView.theme({ '&': { border: '1px solid rgb(var(--z-bg-2))' }, '.cm-content': { padding: '12px', fontFamily: 'monospace' } })]
}) })
forceParsing(view, doc.length, 5000)
const from = doc.indexOf('bad')
view.dispatch({ effects: setGrammarSnapshot.of({ documentId: 'throwaway', generation: 1, diagnostics: [{
  id: 'fixture', provider: 'fixture', ruleId: 'fixture', category: 'grammar', message: 'Fixture underline',
  range: { from, to: from + 3 }, original: 'bad', replacements: [], severity: 'warning', generation: 1, segmentId: 'table'
}] }) })
document.querySelector('#preview')!.innerHTML = renderMarkdown(doc)
document.querySelector('#outside')!.addEventListener('click', () => { view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('After') } }); view.focus() })
let dark = false
document.documentElement.dataset.theme = 'apple-light'
document.querySelector('#theme')!.addEventListener('click', () => {
  dark = !dark
  document.documentElement.dataset.theme = dark ? 'apple-dark' : 'apple-light'
})
const style = document.createElement('style')
style.textContent = ':root { --z-text-font:system-ui; --z-prose-block-gap:1em; } section {min-width:0} #preview {overflow-x:auto} body {background:rgb(var(--z-bg));color:rgb(var(--z-fg-1));font:15px system-ui} h1 {font-size:22px;font-weight:600;margin-bottom:12px} h2 {font-weight:600;margin-bottom:12px} button {border:1px solid rgb(var(--z-bg-2));padding:6px 12px;margin-top:12px} .cm-editor {background:rgb(var(--z-bg));color:rgb(var(--z-fg-1))}'
document.head.append(style)
// An in-memory test hook; deliberately no host API and no filesystem access.
Object.assign(window, { tableFixture: { view, liveTableField } })
