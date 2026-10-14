// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_GRAMMAR_PREFERENCES } from '../grammar/preferences'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A store that notifies subscribers, so a saved value re-renders the settings the way zustand does.
const storeMock = vi.hoisted(() => {
  const mock = {
    listeners: new Set<() => void>(),
    grammarEnabled: false,
    grammarPreferences: {} as Record<string, unknown>,
    setGrammarEnabled: vi.fn(),
    setGrammarPreferences: vi.fn((patch: Record<string, unknown>) => {
      mock.grammarPreferences = { ...mock.grammarPreferences, ...patch }
      mock.notify()
    }),
    notify: (): void => mock.listeners.forEach((listener) => listener())
  }
  return mock
})

vi.mock('../store', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useStore: (selector: (state: typeof storeMock) => unknown) =>
      useSyncExternalStore(
        (listener: () => void) => {
          storeMock.listeners.add(listener)
          return () => storeMock.listeners.delete(listener)
        },
        () => selector(storeMock)
      )
  }
})

vi.mock('@zennotes/bridge-contract/bridge', () => ({
  getZenBridge: () => ({ getCapabilities: () => ({ supportsGrammarProviderTransport: true }) })
}))

import { GrammarSettings } from './GrammarSettings'

const mounted: Array<{ root: Root; container: HTMLElement }> = []

beforeEach(() => {
  storeMock.grammarPreferences = { ...DEFAULT_GRAMMAR_PREFERENCES, debounceMs: 750 }
  storeMock.setGrammarPreferences.mockClear()
})

afterEach(() => {
  while (mounted.length) {
    const item = mounted.pop()!
    act(() => item.root.unmount())
    item.container.remove()
  }
  storeMock.listeners.clear()
})

function renderSettings(): { input: HTMLInputElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  act(() => root.render(createElement(GrammarSettings)))
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')
  expect(input).not.toBeNull()
  return { input: input! }
}

// Sets the DOM value the way a keyboard edit does, so React sees a change event.
function typeInto(input: HTMLInputElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setValue.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function blur(input: HTMLInputElement): void {
  act(() => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
}

function press(input: HTMLInputElement, key: string): void {
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
}

describe('GrammarSettings typing pause', () => {
  it('keeps the draft while typing and saves once on Enter', () => {
    const { input } = renderSettings()

    typeInto(input, '1200')
    expect(storeMock.setGrammarPreferences).not.toHaveBeenCalled()
    expect(input.value).toBe('1200')

    press(input, 'Enter')
    expect(storeMock.setGrammarPreferences).toHaveBeenCalledOnce()
    expect(storeMock.setGrammarPreferences).toHaveBeenCalledWith({ debounceMs: 1200 })
    expect(input.value).toBe('1200')
  })

  it('lets the field be cleared, and reverts an empty value on blur', () => {
    const { input } = renderSettings()

    typeInto(input, '')
    expect(input.value).toBe('')
    blur(input)

    expect(storeMock.setGrammarPreferences).not.toHaveBeenCalled()
    expect(input.value).toBe('750')
  })

  it('clamps out-of-range values to the existing limits on blur', () => {
    const { input } = renderSettings()

    typeInto(input, '100')
    blur(input)
    expect(storeMock.setGrammarPreferences).toHaveBeenLastCalledWith({ debounceMs: 250 })
    expect(input.value).toBe('250')

    typeInto(input, '9000')
    blur(input)
    expect(storeMock.setGrammarPreferences).toHaveBeenLastCalledWith({ debounceMs: 5000 })
    expect(input.value).toBe('5000')
  })

  it('reverts an unreadable value without saving it', () => {
    const { input } = renderSettings()

    typeInto(input, 'abc')
    press(input, 'Enter')

    expect(storeMock.setGrammarPreferences).not.toHaveBeenCalled()
    expect(input.value).toBe('750')
  })

  it('cancels the edit on Escape without closing the surrounding dialog', () => {
    const { input } = renderSettings()
    const documentKeydown = vi.fn()
    document.addEventListener('keydown', documentKeydown)

    try {
      typeInto(input, '1200')
      press(input, 'Escape')
      blur(input)

      expect(input.value).toBe('750')
      expect(storeMock.setGrammarPreferences).not.toHaveBeenCalled()
      expect(documentKeydown).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', documentKeydown)
    }
  })

  it('shows a value saved elsewhere, replacing any draft', () => {
    const { input } = renderSettings()

    typeInto(input, '1200')
    act(() => {
      storeMock.grammarPreferences = { ...storeMock.grammarPreferences, debounceMs: 2000 }
      storeMock.notify()
    })

    expect(input.value).toBe('2000')
  })
})
