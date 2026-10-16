// @vitest-environment jsdom
import { ensureSyntaxTree, syntaxHighlighting } from '@codemirror/language'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { buildGrammarDecorations } from '../grammar/editor-state'
import { markdownLinkExtension } from './cm-markdown-links'
import { noteMarkdown } from './cm-markdown-language'
import { markdownSourceHighlight } from './cm-markdown-source-highlight'
import { markdownHighlight } from './cm-syntax-highlight'

const views: EditorView[] = []
afterEach(() => views.splice(0).forEach((view) => { view.dom.parentElement?.remove(); view.destroy() }))

function editor(doc: string, extra: Parameters<typeof EditorState.create>[0] = {}) {
  const state = EditorState.create({ doc, ...extra, extensions: [
    noteMarkdown(), syntaxHighlighting(markdownHighlight), markdownLinkExtension,
    markdownSourceHighlight(), extra.extensions ?? []
  ] })
  ensureSyntaxTree(state, doc.length, 5000)
  const view = new EditorView({ state, parent: document.body.appendChild(document.createElement('div')) })
  views.push(view)
  return view
}

const texts = (view: EditorView, selector: string) =>
  [...view.dom.querySelectorAll(selector)].map((el) => el.textContent).join('')

describe('Android Markdown styles in source mode', () => {
  it('keeps headings, bold, italics, strikethrough and all delimiters visible', () => {
    const doc = '# Heading\n\n## Second\n\n### Third\n\n#### Fourth\n\n##### Fifth\n\n###### Sixth\n\n**bold** and __bold too__, *italic* and _also italic_, ~~deleted~~'
    const view = editor(doc)
    expect(texts(view, '.cm-md-heading')).toContain('###### Sixth')
    expect(texts(view, '.tok-strong')).toContain('bold')
    expect(texts(view, '.tok-emphasis')).toContain('italic')
    expect(texts(view, '.tok-strikethrough')).toContain('deleted')
    expect(view.state.doc.toString()).toBe(doc)
    expect(view.dom.querySelectorAll('.cm-line').length).toBe(doc.split('\n').length)
    expect(view.dom.querySelector('.cm-content')?.textContent).toContain('**bold**')
  })

  it('styles quote and list markers and strikes only checked task lines', () => {
    const view = editor('> Quoted **bold**\n\n- Item\n+ Another\n1. Ordered\n2) Ordered too\n\n- [ ] Open\n- [x] Done\n- [X] Also done')
    expect(texts(view, '.cm-md-quote')).toContain('Quoted')
    expect(texts(view, '.cm-md-marker')).toContain('>')
    expect(texts(view, '.cm-md-marker')).toContain('1.')
    expect(texts(view, '.cm-md-marker')).toContain('[ ]')
    expect(texts(view, '.cm-md-done')).toContain('Done')
    expect(texts(view, '.cm-md-done')).toContain('Also done')
    expect(texts(view, '.cm-md-done')).not.toContain('Open')
  })

  it('colours resolved links, images, wikilinks and tags without colouring ordinary brackets', () => {
    const view = editor('[Link](https://example.test) ![image](fixture.png) [[Wiki link]] [ordinary]\n\n#tag #nested/tag #with-hyphens word#skip /#skip &#skip\n\n[reference][id]\n\n[id]: https://example.test')
    const links = texts(view, '.cm-md-link')
    for (const text of ['[Link]', '![image]', '[[Wiki link]]', '#tag', '#nested/tag', '#with-hyphens', '[reference]']) expect(links).toContain(text)
    for (const text of ['ordinary', '#skip']) expect(links).not.toContain(text)
  })

  it('dims frontmatter and fences while leaving nested syntax and inline code intact', () => {
    const view = editor('---\ntitle: Fixture #not-tag\n---\n\n`#not-tag **not bold**`\n\n```python\n#not-tag\nprint("hello")\n```\n\n    #indented-code')
    expect(texts(view, '.cm-md-muted')).toContain('title: Fixture')
    expect(texts(view, '.cm-md-muted')).toContain('```python')
    expect(texts(view, '.cm-md-code')).toContain('`#not-tag **not bold**`')
    expect(texts(view, '.cm-md-link')).toBe('')
    expect(texts(view, '.tok-string')).toBe('"hello"')
    expect(texts(view, '.tok-strong')).toBe('')
  })

  it('updates task and tag marks as the user types', () => {
    const view = editor('- [ ] Todo #tag')
    view.dispatch({ changes: { from: 3, to: 4, insert: 'x' } })
    expect(texts(view, '.cm-md-done')).toContain('Todo')
    view.dispatch({ changes: { from: 3, to: 4, insert: ' ' } })
    expect(texts(view, '.cm-md-done')).toBe('')
    const from = view.state.doc.toString().indexOf('#')
    view.dispatch({ changes: { from, to: view.state.doc.length, insert: 'plain' } })
    expect(texts(view, '.cm-md-link')).toBe('')
  })

  it('limits source decorations to the viewport of a large note', () => {
    const view = editor('# Heading\n\n#tag **bold**\n\n'.repeat(5000))
    expect(view.visibleRanges.at(-1)!.to).toBeLessThan(view.state.doc.length)
    expect(view.dom.querySelectorAll('.cm-md-link').length).toBeLessThan(100)
    const before = texts(view, '.cm-md-heading')
    view.dispatch({ changes: { from: view.state.doc.length, insert: '#offscreen' } })
    expect(texts(view, '.cm-md-heading')).toBe(before)
    expect(texts(view, '.cm-md-link')).not.toContain('#offscreen')
  })

  it('yields to Live Preview initially and when its compartment is toggled', () => {
    const live = ViewPlugin.fromClass(class {})
    const compartment = new Compartment()
    const state = EditorState.create({ doc: '# Heading #tag', extensions: [noteMarkdown(),
      markdownSourceHighlight((view) => view.plugin(live) !== null), compartment.of(live)] })
    const view = new EditorView({ state, parent: document.body.appendChild(document.createElement('div')) })
    views.push(view)
    expect(texts(view, '.cm-md-heading')).toBe('')
    view.dispatch({ effects: compartment.reconfigure([]) })
    expect(texts(view, '.cm-md-heading')).toContain('# Heading')
    view.dispatch({ effects: compartment.reconfigure(live) })
    expect(texts(view, '.cm-md-heading')).toBe('')
    expect(texts(view, '.cm-md-link')).toBe('')
  })

  it('preserves grammar underlines within completed tasks and headings', () => {
    const doc = '# Heading\n\n- [x] Done'
    const diagnostics = ['Heading', 'Done'].map((word, index) => ({
      id: String(index), provider: 'fixture', ruleId: 'fixture', category: 'spelling' as const,
      message: 'Fixture', range: { from: doc.indexOf(word), to: doc.indexOf(word) + word.length },
      original: word, replacements: [], severity: 'warning' as const, generation: 0, segmentId: 'fixture'
    }))
    const view = editor(doc, { extensions: EditorView.decorations.of(buildGrammarDecorations(diagnostics, null)) })
    expect(texts(view, '.cm-grammar-diagnostic')).toBe('HeadingDone')
    expect(texts(view, '.cm-md-done')).toContain('Done')
  })
})
