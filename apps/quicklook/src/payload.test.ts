import { describe, expect, it } from 'vitest'
import { readQuickLookPayload } from './payload'
import { lookupQuickLookAsset } from './shim'
import { isOutsideLink } from './host'

function page(json: unknown): Pick<Document, 'getElementById'> {
  const text = typeof json === 'string' ? json : JSON.stringify(json)
  return { getElementById: (id: string) => (id === 'zen-quicklook-data' ? ({ textContent: text } as HTMLElement) : null) }
}

describe('readQuickLookPayload', () => {
  it('reads the note the extension embedded', () => {
    expect(
      readQuickLookPayload(
        page({
          title: 'Plan',
          markdown: '# Plan',
          notePath: 'inbox/Plan.md',
          assets: { 'diagram.png': 'zenql://app/asset/0/diagram.png' },
          config: '[vim]\nenabled = true'
        })
      )
    ).toEqual({
      title: 'Plan',
      markdown: '# Plan',
      notePath: 'inbox/Plan.md',
      assets: { 'diagram.png': 'zenql://app/asset/0/diagram.png' },
      config: '[vim]\nenabled = true'
    })
  })

  it('keeps only asset URLs the extension serves', () => {
    const payload = readQuickLookPayload(
      page({
        markdown: '',
        assets: { a: 'zenql://app/asset/0/a.png', b: 'https://tracker.example/pixel.gif', c: 'file:///etc/passwd', d: 42 }
      })
    )
    expect(payload?.assets).toEqual({ a: 'zenql://app/asset/0/a.png' })
  })

  it('is null without a payload or with one that is not a note', () => {
    expect(readQuickLookPayload({ getElementById: () => null })).toBeNull()
    expect(readQuickLookPayload(page('{"markdown": 3}'))).toBeNull()
    expect(readQuickLookPayload(page('not json'))).toBeNull()
  })
})

describe('lookupQuickLookAsset', () => {
  const payload = { assets: { 'my diagram.png': 'zenql://app/asset/0/x.png', 'raw%20name.png': 'zenql://app/asset/1/y.png' } }

  it('finds a reference as written or percent-decoded, ignoring a fragment', () => {
    expect(lookupQuickLookAsset(payload, 'my%20diagram.png#page=2')).toBe('zenql://app/asset/0/x.png')
    expect(lookupQuickLookAsset(payload, 'raw%20name.png')).toBe('zenql://app/asset/1/y.png')
    expect(lookupQuickLookAsset(payload, 'missing.png')).toBeNull()
  })
})

describe('isOutsideLink', () => {
  it('hands web and mail links to the browser and nothing else', () => {
    expect(isOutsideLink('https://zennotes.org')).toBe(true)
    expect(isOutsideLink('mailto:hi@zennotes.org')).toBe(true)
    expect(isOutsideLink('zennotes://open?path=x')).toBe(false)
    expect(isOutsideLink('javascript:alert(1)')).toBe(false)
    expect(isOutsideLink('#heading')).toBe(false)
  })
})
