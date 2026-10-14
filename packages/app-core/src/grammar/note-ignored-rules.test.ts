import { describe, expect, it } from 'vitest'
import { addNoteIgnoredGrammarRule, noteIgnoredGrammarRules } from './note-ignored-rules'

function withRule(text: string, ruleId: string): string | null {
  const change = addNoteIgnoredGrammarRule(text, ruleId)
  return change ? text.slice(0, change.from) + change.insert + text.slice(change.to) : null
}

describe('note ignored grammar rules', () => {
  it('reads inline lists, block lists and bare scalars', () => {
    expect(noteIgnoredGrammarRules('---\ngrammar-ignore: [A_RULE, B_RULE]\n---\nText')).toEqual([
      'A_RULE',
      'B_RULE'
    ])
    expect(noteIgnoredGrammarRules('---\ngrammar-ignore:\n  - A_RULE\n  - B_RULE\n---\n')).toEqual([
      'A_RULE',
      'B_RULE'
    ])
    expect(noteIgnoredGrammarRules('---\nGrammar-Ignore: A_RULE, B_RULE\n---\n')).toEqual([
      'A_RULE',
      'B_RULE'
    ])
  })

  it('reads nothing without front matter or outside it', () => {
    expect(noteIgnoredGrammarRules('Text')).toEqual([])
    expect(noteIgnoredGrammarRules('Text\n---\ngrammar-ignore: [A_RULE]\n---\n')).toEqual([])
    expect(noteIgnoredGrammarRules('---\ntitle: Note\n---\n')).toEqual([])
  })

  it('creates the front matter when the note has none', () => {
    expect(withRule('# Title\n', 'A_RULE')).toBe('---\ngrammar-ignore: [A_RULE]\n---\n# Title\n')
  })

  it('adds the field at the end of existing front matter, leaving the rest as it is', () => {
    expect(withRule('---\ntitle: Note\ntags:\n  - a\n---\nText', 'A_RULE')).toBe(
      '---\ntitle: Note\ntags:\n  - a\ngrammar-ignore: [A_RULE]\n---\nText'
    )
  })

  it('extends an inline list or a bare scalar', () => {
    expect(withRule('---\ngrammar-ignore: [A_RULE]\ntitle: x\n---\n', 'B_RULE')).toBe(
      '---\ngrammar-ignore: [A_RULE, B_RULE]\ntitle: x\n---\n'
    )
    expect(withRule('---\ngrammar-ignore: A_RULE\n---\n', 'B_RULE')).toBe(
      '---\ngrammar-ignore: [A_RULE, B_RULE]\n---\n'
    )
  })

  it('extends a block list with the same indentation', () => {
    expect(withRule('---\ngrammar-ignore:\n    - A_RULE\ntitle: x\n---\n', 'B_RULE')).toBe(
      '---\ngrammar-ignore:\n    - A_RULE\n    - B_RULE\ntitle: x\n---\n'
    )
    expect(withRule('---\ngrammar-ignore:\n---\n', 'A_RULE')).toBe(
      '---\ngrammar-ignore:\n  - A_RULE\n---\n'
    )
  })

  it('keeps CRLF line endings', () => {
    expect(withRule('---\r\ntitle: Note\r\n---\r\nText', 'A_RULE')).toBe(
      '---\r\ntitle: Note\r\ngrammar-ignore: [A_RULE]\r\n---\r\nText'
    )
  })

  it('does nothing for a rule already listed or one that cannot be ignored', () => {
    expect(addNoteIgnoredGrammarRule('---\ngrammar-ignore: [A_RULE]\n---\n', 'A_RULE')).toBeNull()
    expect(addNoteIgnoredGrammarRule('Text', 'MORFOLOGIK_RULE_EN_GB')).toBeNull()
    expect(addNoteIgnoredGrammarRule('Text', 'bad rule]')).toBeNull()
  })
})
