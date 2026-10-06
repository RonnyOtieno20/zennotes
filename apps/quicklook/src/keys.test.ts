import { describe, expect, it } from 'vitest'
import { createQuickLookKeys, type QuickLookKey } from './keys'

function key(value: string, extra: Partial<QuickLookKey> = {}): QuickLookKey {
  return { key: value, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, timeStamp: 0, ...extra }
}

describe('createQuickLookKeys', () => {
  it('opens the note on Enter whether Vim mode is on or off', () => {
    expect(createQuickLookKeys(false)(key('Enter'))).toBe('open')
    expect(createQuickLookKeys(true)(key('Enter'))).toBe('open')
  })

  it('leaves every single letter alone with Vim mode off', () => {
    const keys = createQuickLookKeys(false)
    for (const letter of ['o', 'j', 'k', 'g', 'G']) expect(keys(key(letter)), letter).toBeNull()
    expect(keys(key('d', { ctrlKey: true }))).toBeNull()
  })

  it('maps the Vim motions and `o` with Vim mode on', () => {
    const keys = createQuickLookKeys(true)
    expect(keys(key('o'))).toBe('open')
    expect(keys(key('j'))).toBe('lineDown')
    expect(keys(key('k'))).toBe('lineUp')
    expect(keys(key('G', { shiftKey: true }))).toBe('bottom')
    expect(keys(key('d', { ctrlKey: true }))).toBe('halfDown')
    expect(keys(key('u', { ctrlKey: true }))).toBe('halfUp')
  })

  it('reads `gg` only when the second g follows quickly and directly', () => {
    const keys = createQuickLookKeys(true)
    expect(keys(key('g', { timeStamp: 100 }))).toBeNull()
    expect(keys(key('g', { timeStamp: 300 }))).toBe('top')

    expect(keys(key('g', { timeStamp: 1000 }))).toBeNull()
    expect(keys(key('g', { timeStamp: 2000 }))).toBeNull()

    expect(keys(key('g', { timeStamp: 3000 }))).toBeNull()
    expect(keys(key('j', { timeStamp: 3100 }))).toBe('lineDown')
    expect(keys(key('g', { timeStamp: 3200 }))).toBeNull()
  })

  it('never claims a Command or Option shortcut', () => {
    const keys = createQuickLookKeys(true)
    expect(keys(key('Enter', { metaKey: true }))).toBeNull()
    expect(keys(key('j', { altKey: true }))).toBeNull()
  })
})
