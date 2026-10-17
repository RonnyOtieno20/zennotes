import './ui.css'
import { closeHoverTooltips, EditorView, showTooltip, type Tooltip } from '@codemirror/view'
import {
  grammarPopupRows,
  renderGrammarMessage,
  type GrammarPopupController
} from '../lib/grammar-popup'
import type { GrammarDiagnostic } from './types'
import { canIgnoreGrammarRule } from './preferences'
import { similarGrammarDiagnostics } from './editor-diagnostics'
import { getGrammarEditorState, grammarEditorStateField, sessionFor } from './editor-state'
import {
  addGrammarWordToDictionary,
  applyGrammarReplacement,
  applyGrammarReplacementToAll,
  closeGrammarSuggestionCard,
  ignoreGrammarDiagnosticOnce,
  ignoreGrammarRuleInNote
} from './editor-commands'

const controllers = new WeakMap<EditorView, GrammarPopupController>()

export function suggestionTooltip(diagnostic: GrammarDiagnostic): Tooltip {
  return {
    pos: diagnostic.range.from,
    end: diagnostic.range.to,
    above: false,
    strictSide: false,
    arrow: false,
    create(view) {
      const dom = document.createElement('div')
      dom.className = 'cm-harper-popup cm-grammar-suggestion-card grammar-ui'
      dom.dataset.category = diagnostic.category
      dom.dataset.grammarDiagnostic = diagnostic.id
      dom.setAttribute('role', 'dialog')
      dom.setAttribute('aria-label', `${diagnostic.category} suggestion`)
      const header = document.createElement('div')
      header.className = 'cm-harper-popup-message'
      renderGrammarMessage(header, diagnostic.message)
      dom.appendChild(header)
      const close = (): void => {
        closeGrammarSuggestionCard(view)
        view.dispatch({ effects: closeHoverTooltips })
        view.focus()
      }
      const rows = grammarPopupRows(view, dom, close)
      diagnostic.replacements.forEach((replacement, index) => {
        const button = rows.add(
          replacement.value || `Remove “${diagnostic.original}”`,
          index < 9 ? String(index + 1) : '',
          () => {
            applyGrammarReplacement(view, diagnostic.id, index)
            view.focus()
          }
        )
        if (replacement.description) button.title = replacement.description
      })
      if (!diagnostic.replacements.length) {
        const empty = document.createElement('div')
        empty.className = 'cm-harper-popup-empty'
        empty.textContent = 'No automatic fix for this one.'
        dom.appendChild(empty)
      }
      const divider = document.createElement('div')
      divider.className = 'cm-harper-popup-divider'
      dom.appendChild(divider)
      const similar = similarGrammarDiagnostics(
        getGrammarEditorState(view.state)?.diagnostics ?? [],
        diagnostic
      ).length
      if (similar > 1 && diagnostic.replacements.length) {
        rows.add(
          `Fix all ${similar}`,
          '',
          () => {
            applyGrammarReplacementToAll(view, diagnostic.id, 0)
            view.focus()
          },
          true
        )
      }
      if (
        diagnostic.category === 'spelling' &&
        diagnostic.original &&
        sessionFor(view)?.addToDictionary
      ) {
        rows.add(
          'Add to dictionary',
          'zg',
          () => {
            addGrammarWordToDictionary(view, diagnostic.id)
            view.focus()
          },
          true
        )
      }
      rows.add(
        'Ignore this suggestion',
        'zG',
        () => {
          ignoreGrammarDiagnosticOnce(view, diagnostic.id)
          view.focus()
        },
        true
      )
      if (canIgnoreGrammarRule(diagnostic.ruleId) && !view.state.readOnly) {
        rows.add(
          'Ignore in note',
          '',
          () => {
            ignoreGrammarRuleInNote(view, diagnostic.id)
            view.focus()
          },
          true
        )
      }
      if (sessionFor(view)?.ignoreRule && canIgnoreGrammarRule(diagnostic.ruleId)) {
        rows.add(
          'Ignore everywhere',
          '',
          () => {
            ignoreGrammarDiagnosticOnce(view, diagnostic.id)
            sessionFor(view)?.ignoreRule?.(diagnostic.ruleId)
            view.focus()
          },
          true
        )
      }
      const footer = document.createElement('div')
      footer.className = 'cm-harper-popup-footer'
      const brand = document.createElement('span')
      brand.className = 'cm-harper-popup-brand'
      brand.textContent = 'LanguageTool'
      const category = document.createElement('span')
      category.className = 'cm-harper-popup-kind'
      category.textContent = diagnostic.category
      footer.append(brand, category)
      dom.appendChild(footer)
      rows.controller.setActive(0)
      controllers.set(view, rows.controller)
      return {
        dom,
        destroy() {
          rows.destroy()
          if (controllers.get(view) === rows.controller) controllers.delete(view)
        }
      }
    }
  }
}

export function openCardController(view: EditorView): GrammarPopupController | null {
  return getGrammarEditorState(view.state)?.openDiagnosticId
    ? (controllers.get(view) ?? null)
    : null
}

export const openSuggestionCard = showTooltip.from(grammarEditorStateField, (value) => {
  const diagnostic = value.diagnostics.find((item) => item.id === value.openDiagnosticId)
  return diagnostic ? suggestionTooltip(diagnostic) : null
})
