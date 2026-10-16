/** Android's raw Markdown colour roles, without hiding or replacing text.
 * Lezer supplies structure; only hashtags need a small viewport-local scan.
 * The caller supplies the Live Preview predicate so this module never loads
 * the live renderers or the application store.
 */
import { syntaxTree } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { isResolvedMarkdownLink, terminatedLinkTailEnd } from './cm-markdown-links'

const mark = (className: string): Decoration => Decoration.mark({ class: className })
const heading = mark('cm-md-heading')
const marker = mark('cm-md-marker')
const muted = mark('cm-md-muted')
const link = mark('cm-md-link')
const code = mark('cm-md-code')
const done = mark('cm-md-done')
const quote = mark('cm-md-quote')
const delimiter = mark('cm-md-delimiter')
const hashtag = /(^|[^\p{L}\p{N}_/&#])#[\p{L}][\p{L}\p{N}_/-]*/gu

function build(view: EditorView): DecorationSet {
  const { state } = view
  const tree = syntaxTree(state)
  const ranges: ReturnType<Decoration['range']>[] = []
  for (const { from, to } of view.visibleRanges) {
    const add = (deco: Decoration, start: number, end: number): void => {
      start = Math.max(from, start)
      end = Math.min(to, end)
      if (start < end) ranges.push(deco.range(start, end))
    }
    tree.iterate({
      from,
      to,
      enter(node) {
        if (node.name === 'Frontmatter') {
          add(muted, node.from, node.to)
          return false
        }
        if (node.name === 'FencedCode') {
          const info = node.node.getChild('CodeInfo')
          if (info) add(muted, info.from, info.to)
          for (const fence of node.node.getChildren('CodeMark')) add(muted, fence.from, fence.to)
          return false
        }
        if (node.name === 'CodeBlock') return false
        if (/^(ATX|Setext)Heading[1-6]$/.test(node.name)) add(heading, node.from, node.to)
        if (node.name === 'Blockquote') add(quote, node.from, node.to)
        if (node.name === 'EmphasisMark' || node.name === 'StrikethroughMark') add(delimiter, node.from, node.to)
        if (node.name === 'ListMark' || node.name === 'QuoteMark' || node.name === 'TaskMarker') {
          add(marker, node.from, node.to)
        }
        if (node.name === 'TaskMarker' && /\[[xX]\]/.test(state.doc.sliceString(node.from, node.to))) {
          const line = state.doc.lineAt(node.from)
          add(done, line.from, line.to)
        }
        if (node.name === 'InlineCode') {
          add(code, node.from, node.to)
          return false
        }
        // Match navigation semantics: ordinary unresolved brackets stay prose.
        if ((node.name === 'Link' || node.name === 'Image') && isResolvedMarkdownLink(state, node.node)) {
          add(link, node.from, terminatedLinkTailEnd(state, node.to) ?? node.to)
        }
        if (node.name === 'URL') add(link, node.from, node.to)
        // Include both outer brackets of [[wiki links]] too.
        if (node.name === 'Link' && state.doc.sliceString(node.from - 1, node.from) === '[' &&
            state.doc.sliceString(node.to, node.to + 1) === ']') {
          add(link, node.from - 1, node.to + 1)
        }
      }
    })
    const first = state.doc.lineAt(from).number
    const last = state.doc.lineAt(Math.max(from, to - 1)).number
    for (let n = first; n <= last; n++) {
      const line = state.doc.line(n)
      // Long single-line notes can exceed the viewport by megabytes. Scan
      // only the visible slice plus its preceding boundary character.
      const scanFrom = Math.max(line.from, from - 1)
      const text = state.doc.sliceString(scanFrom, Math.min(line.to, to))
      if (!text.includes('#')) continue
      hashtag.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = hashtag.exec(text))) {
        const start = scanFrom + match.index + match[1].length
        let node = tree.resolveInner(start, 1)
        let skipped = false
        for (;;) {
          if (['Frontmatter', 'FencedCode', 'CodeBlock', 'InlineCode', 'Link', 'URL', 'HTMLTag'].includes(node.name)) {
            skipped = true
            break
          }
          if (!node.parent) break
          node = node.parent
        }
        if (!skipped) add(link, start, scanFrom + match.index + match[0].length)
      }
    }
  }
  return Decoration.set(ranges, true)
}

export function markdownSourceHighlight(
  isLivePreview: (view: EditorView) => boolean = () => false
): Extension {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet
    private live: boolean

    constructor(view: EditorView) {
      this.live = isLivePreview(view)
      this.decorations = this.live ? Decoration.none : build(view)
    }

    update(update: ViewUpdate): void {
      const live = isLivePreview(update.view)
      if (live !== this.live || update.docChanged || update.viewportChanged ||
          syntaxTree(update.state) !== syntaxTree(update.startState)) {
        this.live = live
        this.decorations = live ? Decoration.none : build(update.view)
      }
    }
  }, { decorations: (plugin) => plugin.decorations })
}
