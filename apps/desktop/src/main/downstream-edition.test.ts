import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseDownstreamEdition, UPSTREAM_EDITION } from './downstream-edition'

describe('parseDownstreamEdition', () => {
  it('accepts the grammar edition only with an explicit disabled updater policy', () => {
    expect(
      parseDownstreamEdition({
        id: 'grammar',
        displayName: 'ZenNotes Grammar Edition',
        updater: 'disabled',
        upstreamRepository: 'ZenNotes/zennotes',
        releaseTagPrefix: 'grammar-v'
      })
    ).toMatchObject({ id: 'grammar', updater: 'disabled' })
  })

  it('falls back to upstream behavior for incomplete or unsafe metadata', () => {
    expect(parseDownstreamEdition(null)).toEqual(UPSTREAM_EDITION)
    expect(parseDownstreamEdition({ id: 'grammar', updater: 'delete-all' })).toEqual(
      UPSTREAM_EDITION
    )
  })

  it('keeps the packaged grammar edition on the disabled updater policy', () => {
    const metadata = JSON.parse(
      readFileSync(
        new URL('../../../../packaging/downstream/grammar-edition.json', import.meta.url),
        'utf8'
      )
    )

    expect(parseDownstreamEdition(metadata)).toMatchObject({
      id: 'grammar',
      updater: 'disabled',
      displayName: 'ZenNotes Grammar Edition'
    })
  })
})
