import { describe, expect, it } from 'vitest'
import { hashText } from './hash'

describe('hashText', () => {
  it('returns a stable eight-character lowercase hex digest', () => {
    expect(hashText('')).toBe('811c9dc5')
    expect(hashText('a')).toBe('e40c292c')
    expect(hashText('hello world')).toMatch(/^[0-9a-f]{8}$/)
    expect(hashText('hello world')).toBe(hashText('hello world'))
  })

  it('distinguishes different text', () => {
    expect(hashText('The cat sat.')).not.toBe(hashText('The cat sat!'))
  })
})
