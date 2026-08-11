import { describe, expect, it } from 'vitest'
import {
  canIgnoreGrammarRule,
  DEFAULT_GRAMMAR_PREFERENCES,
  classifyGrammarEndpoint,
  grammarProviderConfigKey,
  normalizeGrammarPreferences
} from './preferences'

describe('grammar preferences', () => {
  it('returns safe local-first defaults for malformed input', () => {
    expect(normalizeGrammarPreferences(null)).toEqual(DEFAULT_GRAMMAR_PREFERENCES)
    expect(normalizeGrammarPreferences({ endpoint: ' '.repeat(3000), language: '../bad' })).toEqual(
      DEFAULT_GRAMMAR_PREFERENCES
    )
  })

  it('normalizes bounds, categories, rules, and dictionary entries', () => {
    expect(
      normalizeGrammarPreferences({
        endpoint: ' https://grammar.example.test/v2 ',
        language: 'en-GB',
        debounceMs: 20_000,
        enabledCategories: ['spelling', 'style', 'unknown'],
        ignoredRules: ['RULE_1', 'rule_1', 'bad rule', 'MORFOLOGIK_RULE_EN_GB'],
        customDictionary: ['ZenNotes', 'zennotes', '  CodeMirror  ', '']
      })
    ).toMatchObject({
      endpoint: 'https://grammar.example.test/v2',
      language: 'en-GB',
      debounceMs: 5_000,
      enabledCategories: ['spelling', 'style'],
      ignoredRules: ['RULE_1'],
      customDictionary: ['ZenNotes', 'CodeMirror']
    })
  })

  it('does not allow a blanket spelling-engine rule to be ignored', () => {
    expect(canIgnoreGrammarRule('MORFOLOGIK_RULE_EN_GB')).toBe(false)
    expect(canIgnoreGrammarRule('MORFOLOGIK_RULE_EN_US')).toBe(false)
    expect(canIgnoreGrammarRule('UPPERCASE_SENTENCE_START')).toBe(true)
  })

  it('classifies local, remote, and unsafe endpoints for disclosure', () => {
    expect(classifyGrammarEndpoint('http://127.9.8.7:8081/v2')).toMatchObject({ scope: 'local' })
    expect(classifyGrammarEndpoint('http://[::1]:8081/v2')).toMatchObject({ scope: 'local' })
    expect(classifyGrammarEndpoint('https://grammar.example.test/v2')).toMatchObject({
      scope: 'remote'
    })
    expect(classifyGrammarEndpoint('http://grammar.example.test/v2')).toMatchObject({
      scope: 'invalid'
    })
    expect(classifyGrammarEndpoint('https://user:pass@example.test/v2')).toMatchObject({
      scope: 'invalid'
    })
  })

  it('changes the cache key only for provider-affecting preferences', () => {
    const base = DEFAULT_GRAMMAR_PREFERENCES
    expect(grammarProviderConfigKey({ ...base, showUnderlines: false })).toBe(
      grammarProviderConfigKey(base)
    )
    expect(grammarProviderConfigKey({ ...base, language: 'en-GB' })).not.toBe(
      grammarProviderConfigKey(base)
    )
  })
})
