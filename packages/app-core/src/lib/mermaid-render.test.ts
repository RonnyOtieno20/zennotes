// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderMermaidSvg } from './mermaid-render'

// What the stand-in mermaid measured: a capped label inside a diagram, and the
// same capped box outside one.
const measured = vi.hoisted(() => ({ label: [] as number[], outside: [] as number[] }))

// Stands in for mermaid's addHtmlSpan: lay a label out under an inline
// max-width inside a foreignObject and read its width the way mermaid does,
// after an await like its fastdom read.
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (id: string) => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      const foreignObject = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject')
      const label = document.createElement('div')
      label.style.maxWidth = '200px'
      const outside = document.createElement('div')
      outside.style.maxWidth = '200px'
      foreignObject.append(label)
      svg.append(foreignObject)
      document.body.append(svg, outside)
      await Promise.resolve()
      measured.label.push(label.getBoundingClientRect().width)
      measured.outside.push(outside.getBoundingClientRect().width)
      svg.remove()
      outside.remove()
      return { svg: `<svg id="${id}"></svg>` }
    })
  }
}))

const unpatched = Element.prototype.getBoundingClientRect
let reportedWidth = 0
function layoutReports(width: number): void {
  reportedWidth = width
}
const measuring = function (): DOMRect {
  return new DOMRect(0, 0, reportedWidth, 21)
}

describe('renderMermaidSvg label measurement (#911)', () => {
  beforeEach(() => {
    measured.label.length = 0
    measured.outside.length = 0
    Element.prototype.getBoundingClientRect = measuring
  })

  afterEach(() => {
    Element.prototype.getBoundingClientRect = unpatched
  })

  // Both widths are what Chromium reported for a label held at its 200px cap.
  it.each([
    ['120% app zoom on a 2x display', 200.00001525878906],
    ['a 1.333 display scale', 199.9953155517578]
  ])('reads a label held at its cap as exactly the cap at %s', async (scale, width) => {
    layoutReports(width)
    await renderMermaidSvg(`flowchart TB\n  a["at ${scale}"]`, 'light')
    expect(measured.label).toEqual([200])
  })

  it('leaves a label well under its cap alone', async () => {
    layoutReports(133.33333333333334)
    await renderMermaidSvg('flowchart TB\n  a["short"]', 'light')
    expect(measured.label).toEqual([133.33333333333334])
  })

  it('touches nothing outside a diagram label, and restores the browser measurement after', async () => {
    layoutReports(199.9953155517578)
    await renderMermaidSvg('flowchart TB\n  a["outside"]', 'light')
    expect(measured.outside).toEqual([199.9953155517578])
    expect(Element.prototype.getBoundingClientRect).toBe(measuring)
  })

  it('keeps reporting the cap until the last of two overlapping renders finishes', async () => {
    layoutReports(199.9953155517578)
    await Promise.all([
      renderMermaidSvg('flowchart TB\n  a["first"]', 'light'),
      renderMermaidSvg('flowchart TB\n  a["second"]', 'dark')
    ])
    expect(measured.label).toEqual([200, 200])
    expect(Element.prototype.getBoundingClientRect).toBe(measuring)
  })
})
