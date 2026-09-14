import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { ensureGrammarSyntaxTree, extractProseSegments } from './prose'

function stateFor(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, addKeymap: false })]
  })
}

function texts(doc: string): string[] {
  return extractProseSegments(stateFor(doc)).map((segment) => segment.text)
}

describe('extractProseSegments', () => {
  it('requires a complete Markdown syntax tree before callers accept results', () => {
    expect(ensureGrammarSyntaxTree(stateFor('Short prose.'), 50)).toBe(true)
    expect(ensureGrammarSyntaxTree(EditorState.create({ doc: 'No language parser.' }), 50)).toBe(
      false
    )
  })

  it('extracts from the completed prepared tree instead of the stale state snapshot', () => {
    const paragraph = 'This are a representative paragraph with an eror.'
    const state = stateFor(Array.from({ length: 100 }, () => paragraph).join('\n\n'))

    expect(ensureGrammarSyntaxTree(state, 100)).toBe(true)
    expect(extractProseSegments(state)).toHaveLength(100)
  })

  it('extracts headings, paragraphs, blockquotes, lists, tasks, and callout prose', () => {
    const doc = `# A **useful** heading

An *ordinary* paragraph.

> Quoted prose stays visible.

- First list item
- [x] Finished task text

> [!NOTE] Callout prose is checked.`

    expect(texts(doc)).toEqual([
      'A useful heading',
      'An ordinary paragraph.',
      'Quoted prose stays visible.',
      'First list item',
      'Finished task text',
      'Callout prose is checked.'
    ])
  })

  it('can exclude configured Markdown regions without changing the defaults', () => {
    const doc = `# Heading prose

Ordinary paragraph.

> Quoted prose.

- List prose.
- [ ] Task prose.

| Heading | Detail |
| --- | --- |
| Cell prose | More prose |`
    const state = stateFor(doc)

    expect(
      extractProseSegments(state, {
        checkHeadings: false,
        checkLists: false,
        checkBlockquotes: false,
        checkTables: false
      }).map((segment) => segment.text)
    ).toEqual(['Ordinary paragraph.'])
    expect(extractProseSegments(state).map((segment) => segment.text)).toContain('Heading prose')
  })

  it('keeps link labels and safe wiki aliases while excluding destinations and embeds', () => {
    const doc =
      'Read [the guide](https://example.com/guide), see [[private/Target|Visible alias]], ' +
      'skip [[Secret Target]], and view ![helpful alt](assets/private-image.png) ' +
      'or ![[diagram.excalidraw|640x480]].'

    const [segment] = extractProseSegments(stateFor(doc))
    expect(segment?.text).toBe(
      'Read the guide, see Visible alias, skip , and view helpful alt or .'
    )
    expect(segment?.text).not.toContain('https://')
    expect(segment?.text).not.toContain('private/Target')
    expect(segment?.text).not.toContain('Secret Target')
    expect(segment?.text).not.toContain('private-image.png')
    expect(segment?.text).not.toContain('diagram.excalidraw')

    const labelOffset = segment!.text.indexOf('the guide')
    const aliasOffset = segment!.text.indexOf('Visible alias')
    expect(segment?.sourceMap[labelOffset]).toBe(doc.indexOf('the guide'))
    expect(segment?.sourceMap[aliasOffset]).toBe(doc.indexOf('Visible alias'))
  })

  it('can exclude Markdown link labels and wiki aliases', () => {
    const doc =
      'Read [the guide](https://example.com), see [[Target|Visible alias]], and keep prose.'
    expect(
      extractProseSegments(stateFor(doc), { checkLinkLabels: false }).map((segment) => segment.text)
    ).toEqual(['Read , see , and keep prose.'])
  })

  it('excludes inline, fenced, indented, diagram, and configuration code', () => {
    const doc = `Visible prose before \`const secret = true\` and after.

    indented_config: do-not-check

\`\`\`mermaid
graph TD
BadGrammar --> Hidden
\`\`\`

\`\`\`function-plot
{"target":"x^2", "bad":"config"}
\`\`\`

Visible prose after blocks.`

    expect(texts(doc)).toEqual(['Visible prose before  and after.', 'Visible prose after blocks.'])
  })

  it('keeps sentence context when inline code starts the prose', () => {
    const doc = '- `AND` combines two conditions.'
    const [segment] = extractProseSegments(stateFor(doc))

    expect(segment?.text).toBe('Code combines two conditions.')
    expect(segment?.sourceMap.slice(0, 4)).toEqual([null, null, null, null])
    expect(segment?.sourceMap[5]).toBe(doc.indexOf('combines'))
  })

  it('keeps a mixed Markdown review fixture free of structured and private content', () => {
    const doc = `---
title: Private project codename
owner: somebody@example.test
---

# This are a heading

This are an ordinary paragraph with an eror and 😀 Unicode.

> A quoted sentence have a problem.

- A list item are checked.
- [ ] A task need attention.

| Public label | Visible detail |
| --- | --- |
| Alpha | This cell are prose |

Read [this are a label](https://user:secret@example.test/private), then run
\`PRIVATE_TOKEN=do-not-check\` and keep visible prose.

$$
private_formula = secret_value
$$

\`\`\`mermaid
graph TD
PrivateNode --> HiddenGrammar
\`\`\`
`
    const prose = extractProseSegments(stateFor(doc))
    const checkedText = prose.map((segment) => segment.text).join('\n')

    expect(checkedText).toContain('This are an ordinary paragraph with an eror and 😀 Unicode.')
    expect(checkedText).toContain('A quoted sentence have a problem.')
    expect(checkedText).toContain('This cell are prose')
    expect(checkedText).toContain('this are a label')
    expect(checkedText).not.toContain('Private project codename')
    expect(checkedText).not.toContain('somebody@example.test')
    expect(checkedText).not.toContain('user:secret')
    expect(checkedText).not.toContain('PRIVATE_TOKEN')
    expect(checkedText).not.toContain('private_formula')
    expect(checkedText).not.toContain('PrivateNode')
    expect(prose.every((segment) => segment.sourceMap.length === segment.text.length + 1)).toBe(true)
  })

  it.each([
    ['YAML', '---\r\ntitle: Hidden words\r\ntags: [private]\r\n---\r\nVisible body.'],
    ['YAML document end', '---\ntitle: Hidden words\n...\nVisible body.'],
    ['TOML', '+++\ntitle = "Hidden words"\nprivate = true\n+++\nVisible body.']
  ])('excludes %s frontmatter', (_kind, doc) => {
    expect(texts(doc)).toEqual(['Visible body.'])
  })

  it('excludes inline and block math without treating currency as math', () => {
    const doc = `The result $x^2 + y^2$ is useful and costs $5 or $10 today.

$$
\\int_0^1 x^2 dx
$$

Another prose block.`

    expect(texts(doc)).toEqual([
      'The result  is useful and costs $5 or $10 today.',
      'Another prose block.'
    ])
  })

  it('extracts table-cell prose and omits delimiter rows', () => {
    const doc = `| Name | Description |
| :--- | ---: |
| Alpha | **Useful** prose |
| [Beta](https://example.com/b) | Uses \`config=true\` safely |`

    expect(texts(doc)).toEqual([
      'Name',
      'Description',
      'Alpha',
      'Useful prose',
      'Beta',
      'Uses  safely'
    ])
  })

  it('removes HTML tags and attributes while retaining visible text', () => {
    const doc = `Before <span title="private attribute">visible inline text</span> after.

<div data-secret="hidden">Visible block text</div>

<script>const hidden = "not prose"</script>`

    expect(texts(doc)).toEqual(['Before visible inline text after.', 'Visible block text'])
  })

  it('maps emoji, astral characters, and combining marks in UTF-16 code units', () => {
    const doc = '# A **bad😀** cafe\u0301 sentence.'
    const [segment] = extractProseSegments(stateFor(doc))
    expect(segment?.text).toBe('A bad😀 cafe\u0301 sentence.')
    expect(segment?.sourceMap).toHaveLength(segment!.text.length + 1)

    const emojiProviderOffset = segment!.text.indexOf('😀')
    const emojiSourceOffset = doc.indexOf('😀')
    expect('😀').toHaveLength(2)
    expect(segment?.sourceMap[emojiProviderOffset]).toBe(emojiSourceOffset)
    expect(segment?.sourceMap[emojiProviderOffset + 1]).toBe(emojiSourceOffset + 1)

    const combiningProviderOffset = segment!.text.indexOf('\u0301')
    expect(segment?.sourceMap[combiningProviderOffset]).toBe(doc.indexOf('\u0301'))
    expect(segment?.sourceRange).toEqual({
      from: doc.indexOf('A'),
      to: doc.length
    })
  })

  it('uses CodeMirror-normalized UTF-16 offsets for both CRLF and LF input', () => {
    const crlf = '# Heading\r\n\r\nFirst 😀 line.\r\nSecond line.\r\n'
    const lf = crlf.replaceAll('\r\n', '\n')
    const crlfState = stateFor(crlf)
    const lfState = stateFor(lf)

    expect(crlfState.doc.toString()).toBe(lf)
    expect(extractProseSegments(crlfState)).toEqual(extractProseSegments(lfState))
    for (const segment of extractProseSegments(crlfState)) {
      expect(segment.sourceMap).toHaveLength(segment.text.length + 1)
      expect(segment.sourceRange.to).toBeLessThanOrEqual(crlfState.doc.length)
    }
  })

  it('keeps multiple prose blocks independent with exact source coordinates', () => {
    const doc = 'First paragraph.\n\nSecond paragraph with **bold words**.\n\nThird paragraph.'
    const segments = extractProseSegments(stateFor(doc))

    expect(segments.map((segment) => segment.text)).toEqual([
      'First paragraph.',
      'Second paragraph with bold words.',
      'Third paragraph.'
    ])
    expect(segments.map((segment) => segment.sourceRange.from)).toEqual([
      doc.indexOf('First'),
      doc.indexOf('Second'),
      doc.indexOf('Third')
    ])

    const boldSegment = segments[1]!
    const providerOffset = boldSegment.text.indexOf('bold words')
    expect(boldSegment.sourceMap[providerOffset]).toBe(doc.indexOf('bold words'))
    expect(boldSegment.sourceMap[providerOffset + 'bold words'.length - 1]).toBe(
      doc.indexOf('bold words') + 'bold words'.length - 1
    )
  })

  it('keeps content IDs stable when prose is inserted before an unchanged paragraph', () => {
    const original = extractProseSegments(
      stateFor('First distinct paragraph.\n\nUnchanged paragraph.')
    )
    const shifted = extractProseSegments(
      stateFor('New leading paragraph.\n\nFirst distinct paragraph.\n\nUnchanged paragraph.')
    )

    expect(shifted[1]?.id).toBe(original[0]?.id)
    expect(shifted[2]?.id).toBe(original[1]?.id)
    expect(shifted[2]?.sourceRange.from).toBeGreaterThan(original[1]!.sourceRange.from)
  })

  it('uses occurrences to distinguish duplicate content IDs', () => {
    const segments = extractProseSegments(stateFor('Repeated prose.\n\nRepeated prose.'))

    expect(segments[0]?.fingerprint).toBe(segments[1]?.fingerprint)
    expect(segments.map((segment) => segment.id)).toEqual([
      `prose:${segments[0]?.fingerprint}:0`,
      `prose:${segments[0]?.fingerprint}:1`
    ])
  })

  it('maps insertions only at source-contiguous provider boundaries', () => {
    const doc = 'A **bold** word'
    const [segment] = extractProseSegments(stateFor(doc))
    const boldOffset = segment!.text.indexOf('bold')
    const afterBoldOffset = boldOffset + 'bold'.length

    expect(segment?.insertionMap).toHaveLength(segment!.text.length + 1)
    expect(segment?.insertionMap?.[0]).toBe(0)
    expect(segment?.insertionMap?.at(-1)).toBe(doc.length)
    expect(segment?.insertionMap?.[boldOffset]).toBeNull()
    expect(segment?.insertionMap?.[boldOffset + 1]).toBe(doc.indexOf('bold') + 1)
    expect(segment?.insertionMap?.[afterBoldOffset]).toBeNull()
  })
})
