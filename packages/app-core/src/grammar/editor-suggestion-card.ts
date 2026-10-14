import { EditorView, showTooltip, type Tooltip } from '@codemirror/view'
import type { GrammarDiagnostic } from './types'
import { canIgnoreGrammarRule } from './preferences'
import { similarGrammarDiagnostics } from './editor-diagnostics'
import { getGrammarEditorState, grammarEditorStateField, sessionFor } from './editor-state'
import {
  applyGrammarReplacementAndNext,
  applyGrammarReplacementToAll,
  closeGrammarSuggestionCard,
  ignoreGrammarDiagnosticOnce,
  ignoreGrammarRuleInNote
} from './editor-commands'

function appendText(parent: HTMLElement, className: string, text: string): HTMLElement {
  const node = document.createElement('div')
  node.className = className
  node.textContent = text
  parent.appendChild(node)
  return node
}

interface SuggestionCardController {
  active: number
  setActive(index: number): void
  activate(): void
}

const suggestionCardControllers = new WeakMap<EditorView, SuggestionCardController>()

export function suggestionTooltip(diagnostic: GrammarDiagnostic): Tooltip {
  return {
    pos: diagnostic.range.from,
    end: diagnostic.range.to,
    above: false,
    strictSide: false,
    arrow: true,
    create(view) {
      const dom = document.createElement('div')
      dom.className = 'cm-grammar-suggestion-card'
      dom.dataset.grammarDiagnostic = diagnostic.id
      dom.setAttribute('role', 'dialog')
      dom.setAttribute('aria-modal', 'false')
      dom.setAttribute('aria-label', `${diagnostic.category} suggestion`)
      appendText(dom, 'cm-grammar-suggestion-category', diagnostic.category)
      appendText(dom, 'cm-grammar-suggestion-message', diagnostic.message)
      if (diagnostic.original) {
        appendText(dom, 'cm-grammar-suggestion-original', diagnostic.original)
      }

      const actions = document.createElement('div')
      actions.className = 'cm-grammar-suggestion-actions'
      dom.appendChild(actions)
      const buttons: HTMLButtonElement[] = []
      const callbacks: Array<() => void> = []
      const addAction = (button: HTMLButtonElement, callback: () => void): void => {
        const index = buttons.length
        button.addEventListener('mousedown', (event) => event.preventDefault())
        button.addEventListener('mouseenter', () => controller.setActive(index))
        button.addEventListener('click', callback)
        buttons.push(button)
        callbacks.push(callback)
        actions.appendChild(button)
      }
      diagnostic.replacements.forEach((replacement, index) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'cm-grammar-suggestion'
        button.textContent = replacement.value || 'Delete'
        if (replacement.description) button.title = replacement.description
        addAction(button, () => {
          applyGrammarReplacementAndNext(view, diagnostic.id, index)
          view.focus()
        })
      })

      const similar = similarGrammarDiagnostics(
        getGrammarEditorState(view.state)?.diagnostics ?? [],
        diagnostic
      ).length
      if (similar > 1) {
        const fixAll = document.createElement('button')
        fixAll.type = 'button'
        fixAll.className = 'cm-grammar-suggestion'
        fixAll.textContent = `Fix all ${similar}`
        fixAll.title = `Replace every “${diagnostic.original}” with “${diagnostic.replacements[0]!.value}”`
        addAction(fixAll, () => {
          applyGrammarReplacementToAll(view, diagnostic.id, 0)
          view.focus()
        })
      }

      const ignore = document.createElement('button')
      ignore.type = 'button'
      ignore.className = 'cm-grammar-ignore-once'
      ignore.textContent = 'Ignore once'
      addAction(ignore, () => {
        ignoreGrammarDiagnosticOnce(view, diagnostic.id)
        view.focus()
      })

      if (canIgnoreGrammarRule(diagnostic.ruleId) && !view.state.readOnly) {
        const ignoreInNote = document.createElement('button')
        ignoreInNote.type = 'button'
        ignoreInNote.className = 'cm-grammar-ignore-rule-in-note'
        ignoreInNote.textContent = 'Ignore in note'
        ignoreInNote.title = `Hide ${diagnostic.ruleId} in this note (saved in its front matter)`
        addAction(ignoreInNote, () => {
          ignoreGrammarRuleInNote(view, diagnostic.id)
          view.focus()
        })
      }

      if (sessionFor(view)?.ignoreRule && canIgnoreGrammarRule(diagnostic.ruleId)) {
        const ignoreRule = document.createElement('button')
        ignoreRule.type = 'button'
        ignoreRule.className = 'cm-grammar-ignore-rule'
        ignoreRule.textContent = 'Ignore everywhere'
        ignoreRule.title = `Hide ${diagnostic.ruleId} in every note`
        addAction(ignoreRule, () => {
          ignoreGrammarDiagnosticOnce(view, diagnostic.id)
          sessionFor(view)?.ignoreRule?.(diagnostic.ruleId)
          view.focus()
        })
      }

      if (diagnostic.original && sessionFor(view)?.addToDictionary) {
        const addWord = document.createElement('button')
        addWord.type = 'button'
        addWord.className = 'cm-grammar-add-dictionary'
        addWord.textContent = 'Add word'
        addAction(addWord, () => {
          ignoreGrammarDiagnosticOnce(view, diagnostic.id)
          sessionFor(view)?.addToDictionary?.(diagnostic.original)
          view.focus()
        })
      }

      const dismiss = document.createElement('button')
      dismiss.type = 'button'
      dismiss.className = 'cm-grammar-suggestion-dismiss'
      dismiss.textContent = 'Dismiss'
      addAction(dismiss, () => {
        closeGrammarSuggestionCard(view)
        view.focus()
      })

      appendText(
        dom,
        'cm-grammar-suggestion-hint',
        'F8 next · Shift+F8 previous · ↑/↓ or j/k choose · Enter apply · Esc close'
      )

      const controller: SuggestionCardController = {
        active: 0,
        setActive(index) {
          const count = buttons.length
          if (!count) return
          this.active = ((index % count) + count) % count
          buttons.forEach((button, buttonIndex) => {
            button.classList.toggle('cm-grammar-suggestion-active', buttonIndex === this.active)
          })
        },
        activate() {
          callbacks[this.active]?.()
        }
      }
      controller.setActive(0)
      suggestionCardControllers.set(view, controller)
      return {
        dom,
        destroy() {
          if (suggestionCardControllers.get(view) === controller) {
            suggestionCardControllers.delete(view)
          }
        }
      }
    }
  }
}

export function openCardController(view: EditorView): SuggestionCardController | null {
  if (!getGrammarEditorState(view.state)?.openDiagnosticId) return null
  return suggestionCardControllers.get(view) ?? null
}

/** Shows the card for the issue the user opened from the keyboard or a click. */
export const openSuggestionCard = showTooltip.from(grammarEditorStateField, (value) => {
  if (!value.suggestionCardsEnabled) return null
  const diagnostic = value.diagnostics.find((item) => item.id === value.openDiagnosticId)
  return diagnostic ? suggestionTooltip(diagnostic) : null
})
