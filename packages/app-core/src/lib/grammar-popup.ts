import type { EditorView } from '@codemirror/view'

export interface GrammarPopupController {
  active: number
  count: number
  setActive(index: number): void
  activate(): void
}

/** Harper's native popup rows and capture-phase keys, shared by both checkers. */
export function grammarPopupRows(view: EditorView, dom: HTMLElement, close: () => void) {
  const items: HTMLButtonElement[] = []
  const actions: Array<() => void> = []
  let suggestionCount = 0
  const controller: GrammarPopupController = {
    active: 0,
    get count() {
      return items.length
    },
    setActive(index) {
      if (!items.length) return
      this.active = ((index % items.length) + items.length) % items.length
      items.forEach((item, i) => item.classList.toggle('cm-harper-popup-active', i === this.active))
    },
    activate() {
      actions[this.active]?.()
    }
  }
  const add = (
    label: string,
    hint: string,
    onPick: () => void,
    secondary = false
  ): HTMLButtonElement => {
    const index = items.length
    if (!secondary) suggestionCount++
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'cm-harper-popup-item' + (secondary ? ' cm-harper-popup-secondary' : '')
    const hintEl = document.createElement('span')
    hintEl.className = 'cm-harper-popup-hint'
    hintEl.textContent = hint
    const labelEl = document.createElement('span')
    labelEl.className = 'cm-harper-popup-label'
    labelEl.textContent = label
    button.append(hintEl, labelEl)
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('mouseenter', () => controller.setActive(index))
    button.addEventListener('click', (event) => {
      event.preventDefault()
      onPick()
    })
    items.push(button)
    actions.push(onPick)
    dom.appendChild(button)
    return button
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return
    if (event.metaKey || event.ctrlKey || event.altKey) {
      if (
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        (event.key === 'n' || event.key === 'p')
      ) {
        controller.setActive(controller.active + (event.key === 'n' ? 1 : -1))
      } else return
    } else if (/^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1
      // Numbers apply suggestions only, never dictionary or ignore actions.
      if (index < suggestionCount) {
        controller.setActive(index)
        controller.activate()
      }
    } else if (event.key === 'ArrowDown' || event.key === 'j') {
      controller.setActive(controller.active + 1)
    } else if (event.key === 'ArrowUp' || event.key === 'k') {
      controller.setActive(controller.active - 1)
    } else if (event.key === 'Enter') {
      controller.activate()
    } else if (event.key === 'Escape') close()
    else return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  view.contentDOM.addEventListener('keydown', onKeyDown, true)
  dom.addEventListener('keydown', onKeyDown, true)
  return {
    add,
    controller,
    destroy() {
      view.contentDOM.removeEventListener('keydown', onKeyDown, true)
      dom.removeEventListener('keydown', onKeyDown, true)
    }
  }
}

/** Harper messages quote the problem in backticks; show those as code. */
export function renderGrammarMessage(target: HTMLElement, message: string): void {
  message.split('`').forEach((part, index) => {
    if (!part) return
    if (index % 2) {
      const code = document.createElement('code')
      code.className = 'cm-harper-popup-code'
      code.textContent = part
      target.appendChild(code)
    } else target.appendChild(document.createTextNode(part))
  })
}
