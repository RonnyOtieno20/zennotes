import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { ProseSegment, SourceRange } from './types'

const INLINE_MATH_RE = /(?<![\\$])\$(?!\s)(?!\$)((?:\\.|[^$\\])+?)(?<!\s)\$(?!\$)/g
const BLOCK_MATH_RE = /\$\$(?!\$)([\s\S]+?)\$\$/g

const WHOLE_NODE_EXCLUSIONS = new Set(['CodeBlock', 'FencedCode', 'InlineCode'])

const MARKER_NODE_EXCLUSIONS = new Set([
  'CodeMark',
  'EmphasisMark',
  'HeaderMark',
  'HTMLTag',
  'LinkMark',
  'LinkTitle',
  'ListMark',
  'QuoteMark',
  'StrikethroughMark',
  'TableDelimiter',
  'TaskMarker',
  'URL'
])

interface ProseCandidate extends SourceRange {
  kind: string
}

export interface GrammarProseOptions {
  checkHeadings?: boolean
  checkLists?: boolean
  checkBlockquotes?: boolean
  checkTables?: boolean
  checkLinkLabels?: boolean
}

/**
 * Advance Markdown parsing for a bounded amount of time and report whether the
 * complete document is available. Callers must not treat a partial tree as a
 * complete grammar result.
 */
export function ensureGrammarSyntaxTree(state: EditorState, timeoutMs: number): boolean {
  return ensureSyntaxTree(state, state.doc.length, Math.max(0, timeoutMs)) !== null
}

function isProseCandidate(name: string): boolean {
  return (
    name === 'Paragraph' ||
    name === 'Task' ||
    name === 'TableCell' ||
    name === 'HTMLBlock' ||
    name.startsWith('ATXHeading') ||
    name.startsWith('SetextHeading')
  )
}

function overlaps(a: SourceRange, b: SourceRange): boolean {
  return a.from < b.to && b.from < a.to
}

function contains(ranges: readonly SourceRange[], pos: number): boolean {
  return ranges.some((range) => pos >= range.from && pos < range.to)
}

function mergeRanges(ranges: readonly SourceRange[]): SourceRange[] {
  if (ranges.length === 0) return []
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to)
  const merged: SourceRange[] = [{ ...sorted[0]! }]
  for (let index = 1; index < sorted.length; index += 1) {
    const range = sorted[index]!
    const previous = merged[merged.length - 1]!
    if (range.from <= previous.to) previous.to = Math.max(previous.to, range.to)
    else merged.push({ ...range })
  }
  return merged
}

function frontmatterRange(state: EditorState): SourceRange | null {
  const doc = state.doc
  if (doc.lines < 2) return null
  const delimiter = doc.line(1).text.trim()
  if (delimiter !== '---' && delimiter !== '+++') return null

  const closingDelimiters = delimiter === '---' ? new Set(['---', '...']) : new Set(['+++'])
  for (let lineNumber = 2; lineNumber <= doc.lines; lineNumber += 1) {
    const line = doc.line(lineNumber)
    if (closingDelimiters.has(line.text.trim())) return { from: 0, to: line.to }
  }
  return null
}

function htmlBlockExclusions(text: string, candidate: ProseCandidate): SourceRange[] {
  if (candidate.kind !== 'HTMLBlock') return []
  const raw = text.slice(candidate.from, candidate.to)
  if (/^\s*<!--/u.test(raw) || /^\s*<(?:script|style|pre|template)\b/iu.test(raw)) {
    return [{ from: candidate.from, to: candidate.to }]
  }

  const ranges: SourceRange[] = []
  let index = 0
  while (index < raw.length) {
    if (raw[index] !== '<') {
      index += 1
      continue
    }

    const start = index
    let quote: '"' | "'" | null = null
    index += 1
    while (index < raw.length) {
      const char = raw[index]!
      if (quote) {
        if (char === quote) quote = null
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === '>') {
        index += 1
        ranges.push({
          from: candidate.from + start,
          to: candidate.from + index
        })
        break
      }
      index += 1
    }
    if (index >= raw.length && ranges.at(-1)?.from !== candidate.from + start) {
      ranges.push({ from: candidate.from + start, to: candidate.to })
    }
  }
  return ranges
}

function mathExclusions(
  state: EditorState,
  text: string,
  opaqueRanges: readonly SourceRange[]
): SourceRange[] {
  const ranges: SourceRange[] = []

  BLOCK_MATH_RE.lastIndex = 0
  let block: RegExpExecArray | null
  while ((block = BLOCK_MATH_RE.exec(text)) !== null) {
    const from = block.index
    const to = from + block[0].length
    if (contains(opaqueRanges, from)) continue
    const openLine = state.doc.lineAt(from)
    const closeLine = state.doc.lineAt(Math.max(from, to - 1))
    const before = openLine.text.slice(0, from - openLine.from)
    const after = closeLine.text.slice(to - closeLine.from)
    if (before.trim() === '' && after.trim() === '') ranges.push({ from, to })
  }

  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber)
    if (!line.text.includes('$')) continue
    INLINE_MATH_RE.lastIndex = 0
    let inline: RegExpExecArray | null
    while ((inline = INLINE_MATH_RE.exec(line.text)) !== null) {
      const from = line.from + inline.index
      const to = from + inline[0].length
      const range = { from, to }
      if (
        contains(opaqueRanges, from) ||
        ranges.some((blockRange) => overlaps(blockRange, range))
      ) {
        continue
      }
      ranges.push(range)
    }
  }

  return ranges
}

function wikiLinkExclusions(
  text: string,
  opaqueRanges: readonly SourceRange[],
  keepAliases: boolean
): SourceRange[] {
  const ranges: SourceRange[] = []
  let searchFrom = 0
  while (searchFrom < text.length) {
    const open = text.indexOf('[[', searchFrom)
    if (open === -1) break
    const close = text.indexOf(']]', open + 2)
    if (close === -1) break
    searchFrom = close + 2
    if (contains(opaqueRanges, open)) continue

    const embedded = open > 0 && text[open - 1] === '!'
    const pipe = text.indexOf('|', open + 2)
    const hasAlias = pipe !== -1 && pipe < close && pipe + 1 < close
    if (embedded || !hasAlias || !keepAliases) {
      ranges.push({ from: embedded ? open - 1 : open, to: close + 2 })
      continue
    }

    ranges.push({ from: open, to: pipe + 1 }, { from: close, to: close + 2 })
  }
  return ranges
}

function markdownLinkLabelExclusions(text: string): SourceRange[] {
  const ranges: SourceRange[] = []
  const pattern = /!?\[([^\]\n]+)\](?:\([^\n)]*\)|\[[^\]\n]*\])/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const label = match[1]
    if (!label) continue
    const labelOffset = match[0].indexOf(label)
    ranges.push({
      from: match.index + labelOffset,
      to: match.index + labelOffset + label.length
    })
  }
  return ranges
}

function candidateEnabled(
  state: EditorState,
  candidate: ProseCandidate,
  options: GrammarProseOptions
): boolean {
  if (
    options.checkHeadings === false &&
    (candidate.kind.startsWith('ATXHeading') || candidate.kind.startsWith('SetextHeading'))
  ) {
    return false
  }
  if (options.checkTables === false && candidate.kind === 'TableCell') return false
  if (options.checkLists === false && candidate.kind === 'Task') return false

  const line = state.doc.lineAt(candidate.from)
  const prefix = line.text.slice(0, Math.max(0, candidate.from - line.from))
  if (options.checkBlockquotes === false && /^\s*>/u.test(line.text)) return false
  if (
    options.checkLists === false &&
    /(?:^|>\s*)\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX-]\]\s*)?/u.test(prefix)
  ) {
    return false
  }
  return true
}

function calloutMarkerExclusions(
  text: string,
  candidates: readonly ProseCandidate[]
): SourceRange[] {
  const ranges: SourceRange[] = []
  for (const candidate of candidates) {
    if (candidate.kind !== 'Paragraph') continue
    const raw = text.slice(candidate.from, candidate.to)
    const marker = /^\s*\[![\p{L}\p{N}_-]+\][+-]?(?=\s|$)/u.exec(raw)
    if (marker)
      ranges.push({
        from: candidate.from,
        to: candidate.from + marker[0].length
      })
  }
  return ranges
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function buildSegment(
  text: string,
  candidate: ProseCandidate,
  exclusions: readonly SourceRange[]
): ProseSegment | null {
  const codeUnits: string[] = []
  const sourceOffsets: number[] = []
  let exclusionIndex = 0

  for (let sourceOffset = candidate.from; sourceOffset < candidate.to; sourceOffset += 1) {
    while (exclusionIndex < exclusions.length && exclusions[exclusionIndex]!.to <= sourceOffset) {
      exclusionIndex += 1
    }
    const exclusion = exclusions[exclusionIndex]
    if (exclusion && sourceOffset >= exclusion.from && sourceOffset < exclusion.to) continue
    codeUnits.push(text.slice(sourceOffset, sourceOffset + 1))
    sourceOffsets.push(sourceOffset)
  }

  let fromIndex = 0
  let toIndex = codeUnits.length
  while (fromIndex < toIndex && /\s/u.test(codeUnits[fromIndex]!)) fromIndex += 1
  while (toIndex > fromIndex && /\s/u.test(codeUnits[toIndex - 1]!)) toIndex -= 1
  if (fromIndex === toIndex) return null

  const segmentText = codeUnits.slice(fromIndex, toIndex).join('')
  if (!/[\p{L}\p{N}]/u.test(segmentText)) return null
  const mappedOffsets = sourceOffsets.slice(fromIndex, toIndex)
  const sourceFrom = mappedOffsets[0]!
  const sourceTo = mappedOffsets[mappedOffsets.length - 1]! + 1
  const sourceMap = [...mappedOffsets, sourceTo]
  const insertionMap: Array<number | null> = [sourceFrom]
  for (let index = 1; index < mappedOffsets.length; index += 1) {
    insertionMap.push(
      mappedOffsets[index] === mappedOffsets[index - 1]! + 1 ? mappedOffsets[index]! : null
    )
  }
  insertionMap.push(sourceTo)
  const contentFingerprint = fingerprint(segmentText)

  return {
    id: '',
    text: segmentText,
    sourceRange: { from: sourceFrom, to: sourceTo },
    sourceMap,
    insertionMap,
    fingerprint: contentFingerprint
  }
}

/**
 * Extract provider-ready prose from the CodeMirror Markdown syntax tree.
 *
 * Offsets in `text`, `sourceRange`, and `sourceMap` are JavaScript/CodeMirror
 * UTF-16 code-unit offsets. Markdown that Lezer models is filtered by node
 * range; only ZenNotes syntax that Lezer does not model (frontmatter, math,
 * wikilinks, and callout markers) is handled by the focused scanners above.
 */
export function extractProseSegments(
  state: EditorState,
  options: GrammarProseOptions = {}
): ProseSegment[] {
  const text = state.doc.toString()
  // `ensureSyntaxTree` returns its completed tree without committing it to the
  // immutable EditorState. Reuse that tree when a caller prepared it first;
  // falling back to `syntaxTree` preserves the lightweight unit-level API.
  const tree = ensureSyntaxTree(state, state.doc.length, 0) ?? syntaxTree(state)
  const candidates: ProseCandidate[] = []
  const syntaxExclusions: SourceRange[] = []
  const opaqueRanges: SourceRange[] = []

  tree.iterate({
    enter(node) {
      if (isProseCandidate(node.name)) {
        const candidate = { kind: node.name, from: node.from, to: node.to }
        if (candidateEnabled(state, candidate, options)) candidates.push(candidate)
      }
      if (WHOLE_NODE_EXCLUSIONS.has(node.name)) {
        const range = { from: node.from, to: node.to }
        syntaxExclusions.push(range)
        opaqueRanges.push(range)
        return false
      }
      if (MARKER_NODE_EXCLUSIONS.has(node.name)) {
        syntaxExclusions.push({ from: node.from, to: node.to })
      }
      return undefined
    }
  })

  const frontmatter = frontmatterRange(state)
  if (frontmatter) {
    syntaxExclusions.push(frontmatter)
    opaqueRanges.push(frontmatter)
  }
  for (const candidate of candidates) syntaxExclusions.push(...htmlBlockExclusions(text, candidate))
  syntaxExclusions.push(...mathExclusions(state, text, opaqueRanges))
  syntaxExclusions.push(
    ...wikiLinkExclusions(text, opaqueRanges, options.checkLinkLabels !== false)
  )
  if (options.checkLinkLabels === false) {
    syntaxExclusions.push(...markdownLinkLabelExclusions(text))
  }
  syntaxExclusions.push(...calloutMarkerExclusions(text, candidates))

  const exclusions = mergeRanges(syntaxExclusions)
  const segments = candidates
    .sort((a, b) => a.from - b.from || a.to - b.to)
    .map((candidate) => buildSegment(text, candidate, exclusions))
    .filter((segment): segment is ProseSegment => segment !== null)
  const occurrences = new Map<string, number>()
  return segments.map((segment) => {
    const contentFingerprint = segment.fingerprint!
    const occurrence = occurrences.get(contentFingerprint) ?? 0
    occurrences.set(contentFingerprint, occurrence + 1)
    return { ...segment, id: `prose:${contentFingerprint}:${occurrence}` }
  })
}
