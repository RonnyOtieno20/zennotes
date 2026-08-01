import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { describe, expect, it, vi } from 'vitest'
import { GrammarCheckCoordinator } from './coordinator'
import { extractProseSegments } from './prose'
import { LanguageToolProvider, type LanguageToolTransport } from './providers/languagetool'

describe('grammar engine proof of concept', () => {
  it('detects intentional prose errors while excluding structured Markdown', async () => {
    const doc = `This 😀 are an eror.

\`const hidden_mispeling = true\`

\`\`\`mermaid
BadGrammar --> Hidden
\`\`\``
    const state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage, addKeymap: false })]
    })
    const segments = extractProseSegments(state)
    expect(segments.map((segment) => segment.text)).toEqual(['This 😀 are an eror.'])

    const check = vi.fn<LanguageToolTransport['check']>(async (request) => {
      const agreementOffset = request.text.indexOf('are')
      const spellingOffset = request.text.indexOf('eror')
      return {
        matches: [
          {
            message: 'The verb does not agree with the subject.',
            offset: agreementOffset,
            length: 3,
            replacements: [{ value: 'is' }],
            rule: {
              id: 'SUBJECT_VERB_AGREEMENT',
              issueType: 'grammar',
              category: { id: 'GRAMMAR', name: 'Grammar' }
            }
          },
          {
            message: 'Possible spelling mistake.',
            offset: spellingOffset,
            length: 4,
            replacements: [{ value: 'error' }],
            rule: {
              id: 'MORFOLOGIK_RULE_EN_US',
              issueType: 'misspelling',
              category: { id: 'TYPOS', name: 'Possible Typo' }
            }
          }
        ]
      }
    })
    const provider = new LanguageToolProvider({ check })
    const coordinator = new GrammarCheckCoordinator(provider, { debounceMs: 0 })

    const checking = coordinator.schedule({
      documentId: 'proof.md',
      generation: 1,
      segments,
      language: 'en-US'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(checking).resolves.toMatchObject({ accepted: true })

    expect(check).toHaveBeenCalledOnce()
    expect(check.mock.calls[0]?.[0].text).not.toContain('hidden_mispeling')
    expect(check.mock.calls[0]?.[0].text).not.toContain('BadGrammar')
    expect(coordinator.getState().diagnostics).toMatchObject([
      {
        category: 'grammar',
        original: 'are',
        range: { from: doc.indexOf('are'), to: doc.indexOf('are') + 3 },
        replacements: [{ value: 'is' }]
      },
      {
        category: 'spelling',
        original: 'eror',
        range: { from: doc.indexOf('eror'), to: doc.indexOf('eror') + 4 },
        replacements: [{ value: 'error' }]
      }
    ])
  })
})
