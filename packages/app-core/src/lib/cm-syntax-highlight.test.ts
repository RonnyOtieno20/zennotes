// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { ensureSyntaxTree, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { highlightTree } from '@lezer/highlight'
import { afterEach, describe, expect, it } from 'vitest'
import { isReservedCodeFenceTag } from '@shared/custom-code-languages'
import { buildGrammarDecorations } from '../grammar/editor-state'
import { resolveCodeLanguage } from './cm-code-languages'
import { noteMarkdown } from './cm-markdown-language'
import { markdownHighlight } from './cm-syntax-highlight'
import { SearchQuery, openSearchPanel, search, setSearchQuery } from '@codemirror/search'

// Pin the Android aliases as well as one token per language family. A lazy
// LanguageDescription is insufficient: Electron must render without a fetch.
const families: Array<[string[], string, string, string]> = [
  [['sql', 'mysql', 'postgres', 'postgresql', 'psql', 'pgsql', 'sqlite', 'plsql', 'tsql', 'mssql', 'bigquery'], 'SELECT count(*) FROM items WHERE price > 42;', 'SELECT', 'tok-keyword'],
  [['bash', 'sh', 'shell', 'zsh', 'console', 'shellscript', 'fish'], 'if true; then echo "$HOME"; fi # comment', 'if', 'tok-keyword'],
  [['powershell', 'ps1'], 'if ($count -gt 42) { Write-Host "hello" } # comment', 'if', 'tok-keyword'],
  [['js', 'javascript', 'jsx', 'ts', 'typescript', 'tsx', 'mjs', 'cjs'], 'const message = "hello";', 'const', 'tok-keyword'],
  [['py', 'python', 'python3'], 'def greet():\n    return "hello"', 'def', 'tok-keyword'],
  [['kotlin', 'kt', 'kts'], 'fun greet(): String = "hello"', 'fun', 'tok-keyword'],
  [['java'], 'class Greeting { String name = "hello"; }', 'class', 'tok-keyword'],
  [['c', 'cpp', 'c++', 'h', 'hpp'], 'int main() { return 42; }', 'return', 'tok-keyword'],
  [['cs', 'csharp', 'c#'], 'class Greeting { string name = "hello"; }', 'class', 'tok-keyword'],
  [['go', 'golang'], 'package main\nfunc main() { return }', 'func', 'tok-keyword'],
  [['rust', 'rs'], 'fn main() { let value = 42; }', 'fn', 'tok-keyword'],
  [['swift'], 'func greet() { return "hello" }', 'func', 'tok-keyword'],
  [['dart'], 'class Greeting { String name = "hello"; }', 'class', 'tok-keyword'],
  [['scala'], 'class Greeting { val name = "hello" }', 'class', 'tok-keyword'],
  [['groovy', 'gradle'], 'def name = "hello"', 'def', 'tok-keyword'],
  [['php'], '<?php echo "hello"; ?>', 'echo', 'tok-keyword'],
  [['json', 'jsonc'], '{"name": "hello", "count": 42}', '42', 'tok-number'],
  [['json5'], '{name: \'hello\', count: 42, /* comment */}', "'hello'", 'tok-string'],
  [['yaml', 'yml'], 'name: "hello"\ncount: 42', '42', 'tok-number'],
  [['toml'], 'name = "hello"\ncount = 42', '42', 'tok-number'],
  [['ini', 'properties'], '# comment\nname=hello', '# comment', 'tok-comment'],
  [['env'], '# comment\nexport NAME="hello"', '# comment', 'tok-comment'],
  [['css', 'scss', 'less'], '.greeting { color: "red"; }', '"red"', 'tok-string'],
  [['sass'], '.greeting\n  color: "red"', '"red"', 'tok-string'],
  [['html', 'xml', 'svg', 'xhtml', 'vue', 'svelte', 'plist'], '<greeting name="hello">Hi</greeting>', 'greeting', 'tok-tag']
]

function tokens(doc: string): Array<{ text: string; classes: string }> {
  const state = EditorState.create({ doc, extensions: [noteMarkdown()] })
  const tree = ensureSyntaxTree(state, doc.length, 5000)
  expect(tree).not.toBeNull()
  const result: Array<{ text: string; classes: string }> = []
  highlightTree(tree!, markdownHighlight, (from, to, classes) => {
    result.push({ text: doc.slice(from, to), classes })
  })
  return result
}

describe('editor fenced syntax', () => {
  for (const [aliases, code, token, tokenClass] of families) {
    for (const alias of aliases) {
      it(`eagerly parses and themes ${alias}`, () => {
        const language = resolveCodeLanguage(alias)
        expect(language).not.toBeNull()
        expect(language).not.toBeInstanceOf(LanguageDescription)
        expect(isReservedCodeFenceTag(alias)).toBe(true)
        expect(tokens(`\`\`\`${alias}\n${code}\n\`\`\``)).toContainEqual({ text: token, classes: tokenClass })
      })
    }
  }

  it('keeps Markdown styling outside fences and supports tilde fences after frontmatter', () => {
    const result = tokens('---\ntitle: Fixture\n---\n# Heading\n\n**bold** and `inline`\n\n~~~BASH title="example"\necho "hello"\n~~~')
    expect(result).toContainEqual({ text: '"hello"', classes: 'tok-string' })
    expect(result.some((token) => token.classes === 'tok-heading1')).toBe(true)
    expect(result.some((token) => token.classes === 'tok-strong')).toBe(true)
    expect(result.some((token) => token.classes === 'tok-monospace')).toBe(true)
    expect(result.some((token) => token.text.includes('Fixture'))).toBe(false)
  })

  it.each(['', 'text', 'txt', 'plain', 'unknown-language-123'])('leaves %j fences plain', (alias) => {
    expect(resolveCodeLanguage(alias)).toBeNull()
    const result = tokens(`\`\`\`${alias}\nconst text = "hello";\n\`\`\``)
    expect(result.some((token) => token.classes === 'tok-keyword')).toBe(false)
    expect(result.some((token) => token.classes === 'tok-string')).toBe(false)
  })

  it('uses Android colour roles for builtins, types, functions, attributes and variables', () => {
    expect(tokens('```json\n{"enabled": true, "missing": null}\n```')).toContainEqual({ text: 'true', classes: 'tok-keyword' })
    expect(tokens('```python\nprint("hello")\n```')).toContainEqual({ text: 'print', classes: 'tok-function' })
    expect(tokens('```ts\nfunction greet(name: string) { return name }\n```')).toContainEqual({ text: 'greet', classes: 'tok-function' })
    expect(tokens('```ts\nconst count: number = 42\n```')).toContainEqual({ text: 'number', classes: 'tok-type' })
    expect(tokens('```html\n<a href="hello">Hi</a>\n```')).toContainEqual({ text: 'href', classes: 'tok-attr' })
    expect(tokens('```yaml\ncount: 42\nenabled: true\n```')).toContainEqual({ text: 'count', classes: 'tok-property' })
    expect(tokens('```sh\necho $HOME\n```')).toContainEqual({ text: '$HOME', classes: 'tok-variable-special' })
  })

  it('updates nested tokens while editing an unclosed shell fence', () => {
    let state = EditorState.create({ doc: '```sh\necho "hello"', extensions: [noteMarkdown()] })
    expect(ensureSyntaxTree(state, state.doc.length, 5000)).not.toBeNull()
    state = state.update({ changes: { from: 11, to: state.doc.length, insert: '42 # comment' } }).state
    const result: string[] = []
    highlightTree(ensureSyntaxTree(state, state.doc.length, 5000)!, markdownHighlight, (from, to, classes) => {
      result.push(`${classes}:${state.doc.sliceString(from, to)}`)
    })
    expect(result).toContain('tok-number:42')
    expect(result).toContain('tok-comment:# comment')
    expect(result.some((token) => token.startsWith('tok-string:'))).toBe(false)
  })
})

describe('syntax and overlapping decorations', () => {
  const views: EditorView[] = []
  afterEach(() => views.splice(0).forEach((view) => { view.dom.parentElement?.remove(); view.destroy() }))

  it('preserves grammar marks and search matches over nested language tokens', () => {
    const doc = '```python\nprint("hello")\n```'
    const from = doc.indexOf('hello')
    const grammar = buildGrammarDecorations([{
      id: 'fixture', provider: 'fixture', ruleId: 'fixture', category: 'spelling',
      message: 'Fixture diagnostic', range: { from, to: from + 5 }, original: 'hello',
      replacements: [], severity: 'warning', generation: 0, segmentId: 'fixture'
    }], 'fixture')
    const state = EditorState.create({
      doc,
      extensions: [noteMarkdown(), syntaxHighlighting(markdownHighlight), search(), EditorView.decorations.of(grammar)]
    })
    ensureSyntaxTree(state, doc.length, 5000)
    const parent = document.body.appendChild(document.createElement('div'))
    const view = new EditorView({ state, parent })
    views.push(view)
    openSearchPanel(view)
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'hello' })) })
    expect(view.dom.querySelector('.cm-grammar-diagnostic-selected')?.textContent).toBe('hello')
    expect(view.dom.querySelector('.cm-searchMatch')?.textContent).toBe('hello')
    const textNode = view.dom.querySelector('.cm-grammar-diagnostic')!
    expect(textNode.closest('.tok-string') ?? textNode.querySelector('.tok-string')).toBeTruthy()
  })

  it('keeps syntax styles free of backgrounds, underlines, and fixed colours', () => {
    const css = readFileSync('src/styles/index.css', 'utf8')
    const rules = [...css.matchAll(/\.cm-editor \.tok-(?:keyword|string|comment|number|type|function|attr|variable-special)[^{]*\{([^}]+)\}/g)]
    expect(rules.length).toBeGreaterThanOrEqual(8)
    for (const [, body] of rules) {
      expect(body).toMatch(/color: rgb\(var\(--z-/)
      expect(body).not.toMatch(/background|text-decoration|opacity:/)
    }
  })
})
