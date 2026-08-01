export interface SourceRange {
  from: number
  to: number
}

export type GrammarCategory = 'spelling' | 'grammar' | 'punctuation' | 'style' | 'other'

export type GrammarSeverity = 'info' | 'warning' | 'error'

export interface GrammarReplacement {
  value: string
  description?: string
}

export interface GrammarDiagnosticContext {
  text: string
  /** A UTF-16 range relative to `text`, when the provider supplied a valid one. */
  range?: SourceRange
}

export interface GrammarDiagnostic {
  id: string
  provider: string
  ruleId: string
  category: GrammarCategory
  message: string
  shortMessage?: string
  range: SourceRange
  original: string
  replacements: readonly GrammarReplacement[]
  severity: GrammarSeverity
  generation: number
  segmentId: string
  context?: GrammarDiagnosticContext
  docsUrl?: string
}

/**
 * A Markdown prose fragment sent to a grammar provider.
 *
 * LanguageTool reports Java-string offsets, which are UTF-16 code-unit offsets.
 * For `i < text.length`, `sourceMap[i]` maps provider UTF-16 code unit `i` to
 * the offset of its corresponding source code unit. The final entry is one past
 * the last mapped source code unit. This per-code-unit representation keeps a
 * range from accidentally absorbing stripped trailing Markdown markers.
 * Synthetic or otherwise unrepresentable code units are `null`; provider
 * diagnostics that include one are rejected.
 *
 * `insertionMap`, when present, explicitly marks provider boundaries where a
 * zero-length diagnostic can be applied without crossing hidden Markdown.
 */
export interface ProseSegment {
  id: string
  text: string
  sourceRange: SourceRange
  sourceMap: readonly (number | null)[]
  insertionMap?: readonly (number | null)[]
  fingerprint?: string
}

export interface GrammarCheckRequest {
  segments: readonly ProseSegment[]
  generation: number
  language: string
  signal: AbortSignal
}
