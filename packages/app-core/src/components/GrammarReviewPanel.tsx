import { useEffect, useMemo, useRef, useState } from 'react'
import type { GrammarDocumentSessionState } from '../grammar/document-sessions'
import type { GrammarCategory, GrammarDiagnostic } from '../grammar/types'
import { canIgnoreGrammarRule } from '../grammar/preferences'
import { usePanelResize } from '../lib/use-panel-resize'
import { useStore } from '../store'
import { PanelResizeHandle } from './PanelResizeHandle'

const CATEGORY_ORDER: readonly GrammarCategory[] = [
  'spelling',
  'grammar',
  'punctuation',
  'style',
  'other'
]

export type GrammarReviewFilter = 'all' | GrammarCategory

export interface GrammarReviewCounts extends Record<GrammarCategory, number> {
  all: number
}

export function countGrammarDiagnostics(
  diagnostics: readonly GrammarDiagnostic[]
): GrammarReviewCounts {
  const counts: GrammarReviewCounts = {
    all: diagnostics.length,
    spelling: 0,
    grammar: 0,
    punctuation: 0,
    style: 0,
    other: 0
  }
  for (const diagnostic of diagnostics) counts[diagnostic.category] += 1
  return counts
}

export function filterGrammarDiagnostics(
  diagnostics: readonly GrammarDiagnostic[],
  filter: GrammarReviewFilter
): readonly GrammarDiagnostic[] {
  return filter === 'all'
    ? diagnostics
    : diagnostics.filter((diagnostic) => diagnostic.category === filter)
}

function categoryLabel(category: GrammarCategory): string {
  return category[0]!.toUpperCase() + category.slice(1)
}

interface Props {
  enabled: boolean
  supported: boolean
  state: GrammarDocumentSessionState | null
  providerLabel?: string
  onEnable(): void
  onSelect(diagnosticId: string): void
  onApply(diagnosticId: string, replacementIndex: number): void
  onIgnore(diagnosticId: string): void
  onIgnoreRule?(diagnostic: GrammarDiagnostic): void
  onAddToDictionary?(diagnostic: GrammarDiagnostic): void
  onRecheck(): void
}

export function GrammarReviewPanel({
  enabled,
  supported,
  state,
  providerLabel = 'Local',
  onEnable,
  onSelect,
  onApply,
  onIgnore,
  onIgnoreRule,
  onAddToDictionary,
  onRecheck
}: Props): JSX.Element {
  const [filter, setFilter] = useState<GrammarReviewFilter>('all')
  const selectedCardRef = useRef<HTMLElement | null>(null)
  const width = useStore((store) => store.panelWidths.grammar)
  const setPanelWidth = useStore((store) => store.setPanelWidth)
  const focusedPanel = useStore((store) => store.focusedPanel)
  const setFocusedPanel = useStore((store) => store.setFocusedPanel)
  const cursorIndex = useStore((store) => store.grammarCursorIndex)
  const setCursorIndex = useStore((store) => store.setGrammarCursorIndex)
  const { startResize } = usePanelResize(width, (px) => setPanelWidth('grammar', px))
  const diagnostics = state?.diagnostics ?? []
  const counts = useMemo(() => countGrammarDiagnostics(diagnostics), [diagnostics])
  const filtered = useMemo(
    () => filterGrammarDiagnostics(diagnostics, filter),
    [diagnostics, filter]
  )
  const selectedDiagnosticId = state?.selectedDiagnosticId ?? null
  const isFocused = focusedPanel === 'grammar'

  useEffect(() => setFilter('all'), [state?.documentId])

  useEffect(() => {
    const selectedIndex = filtered.findIndex((diagnostic) => diagnostic.id === selectedDiagnosticId)
    if (selectedIndex >= 0 && selectedIndex !== cursorIndex) {
      setCursorIndex(selectedIndex)
      return
    }
    if (!isFocused) return
    const next = filtered.length === 0 ? 0 : Math.min(cursorIndex, filtered.length - 1)
    if (next !== cursorIndex) setCursorIndex(next)
  }, [cursorIndex, filtered, isFocused, selectedDiagnosticId, setCursorIndex])

  useEffect(() => {
    if (!isFocused) return
    const diagnostic = filtered[cursorIndex]
    if (diagnostic && diagnostic.id !== selectedDiagnosticId) onSelect(diagnostic.id)
  }, [cursorIndex, filtered, isFocused, onSelect, selectedDiagnosticId])

  useEffect(() => {
    selectedCardRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedDiagnosticId])

  const selectRelative = (direction: -1 | 1): void => {
    if (filtered.length === 0) return
    const current = filtered.findIndex((diagnostic) => diagnostic.id === selectedDiagnosticId)
    const next = current < 0 ? (direction === 1 ? 0 : filtered.length - 1) : current + direction
    const index = (next + filtered.length) % filtered.length
    setCursorIndex(index)
    onSelect(filtered[index]!.id)
  }

  const unavailableMessage = !supported
    ? 'Grammar review is unavailable in this runtime.'
    : !enabled
      ? 'Grammar checking is off for this device.'
      : null

  const emptyMessage = unavailableMessage
    ? unavailableMessage
    : state?.status === 'error'
      ? 'LanguageTool could not check this note.'
      : state?.status === 'checking'
        ? 'Checking this note…'
        : state?.status === 'ready'
          ? 'No issues found.'
          : state?.status === 'disabled'
            ? 'Automatic checking is paused for this note.'
            : state
              ? 'Waiting for prose to check…'
              : 'Connecting to the local grammar service…'

  return (
    <section
      aria-label="Grammar review"
      data-grammar-panel
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l border-paper-300/70 bg-paper-50/18"
      onMouseDown={() => setFocusedPanel('grammar')}
      onFocusCapture={() => setFocusedPanel('grammar')}
    >
      <PanelResizeHandle onStart={startResize} />
      <div className="border-b border-paper-300/60 px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-xs font-medium uppercase tracking-[0.16em] text-ink-400">
              Grammar review
            </div>
            <div className="mt-1 text-xs text-ink-500">
              {counts.all} issue{counts.all === 1 ? '' : 's'} · {providerLabel}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              data-grammar-panel-control
              aria-label="Previous grammar issue"
              title="Previous issue"
              disabled={filtered.length === 0}
              onClick={() => selectRelative(-1)}
              className="rounded border border-paper-300/70 px-2 py-1 text-xs text-ink-600 hover:bg-paper-200 disabled:cursor-default disabled:opacity-40"
            >
              ↑
            </button>
            <button
              type="button"
              data-grammar-panel-control
              aria-label="Next grammar issue"
              title="Next issue"
              disabled={filtered.length === 0}
              onClick={() => selectRelative(1)}
              className="rounded border border-paper-300/70 px-2 py-1 text-xs text-ink-600 hover:bg-paper-200 disabled:cursor-default disabled:opacity-40"
            >
              ↓
            </button>
            <button
              type="button"
              data-grammar-panel-control
              onClick={onRecheck}
              disabled={!enabled || !supported || state?.status === 'checking'}
              className="rounded border border-paper-300/70 px-2 py-1 text-xs text-ink-600 hover:bg-paper-200 disabled:cursor-default disabled:opacity-40"
            >
              Recheck
            </button>
          </div>
        </div>

        {counts.all > 0 && (
          <div className="mt-3 flex flex-wrap gap-1" aria-label="Grammar issue filters">
            {(['all', ...CATEGORY_ORDER] as const).map((category) => {
              const count = counts[category]
              if (category !== 'all' && count === 0) return null
              const active = filter === category
              return (
                <button
                  key={category}
                  type="button"
                  data-grammar-panel-control
                  aria-pressed={active}
                  onClick={() => setFilter(category)}
                  className={[
                    'rounded-full border px-2 py-0.5 text-2xs font-medium transition-colors',
                    active
                      ? 'border-accent/50 bg-accent/14 text-accent'
                      : 'border-paper-300/70 text-ink-500 hover:bg-paper-200'
                  ].join(' ')}
                >
                  {category === 'all' ? 'All' : categoryLabel(category)} {count}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {state?.status === 'checking' && diagnostics.length > 0 && (
        <div className="border-b border-paper-300/50 bg-accent/6 px-3 py-2 text-xs text-ink-500">
          Rechecking — showing the last accepted results.
        </div>
      )}
      {state?.status === 'error' && (
        <div className="border-b border-paper-300/50 bg-red-500/8 px-3 py-2 text-xs text-ink-600">
          <div className="font-medium">Connection failed</div>
          <div className="mt-0.5 break-words text-ink-500">
            {state.error ?? 'The local LanguageTool service did not respond.'}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {unavailableMessage ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center px-4 text-center text-xs text-ink-500">
            <div>{unavailableMessage}</div>
            {supported && !enabled && (
              <button
                type="button"
                data-grammar-panel-control
                onClick={onEnable}
                className="mt-3 rounded-md bg-accent px-3 py-1.5 font-medium text-white"
              >
                Enable grammar checking
              </button>
            )}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center px-4 text-center text-xs text-ink-500">
            <div>
              {diagnostics.length > 0
                ? `No ${filter === 'all' ? '' : `${categoryLabel(filter)} `}issues in this filter.`
                : emptyMessage}
            </div>
            {state?.status === 'error' && (
              <button
                type="button"
                data-grammar-panel-control
                onClick={onRecheck}
                className="mt-3 rounded-md border border-paper-300/70 px-3 py-1.5 font-medium text-ink-700 hover:bg-paper-200"
              >
                Try again
              </button>
            )}
          </div>
        ) : (
          <ol className="flex flex-col gap-2">
            {filtered.map((diagnostic, rowIndex) => {
              const selected = diagnostic.id === selectedDiagnosticId
              const cursor = isFocused && cursorIndex === rowIndex
              return (
                <li key={diagnostic.id}>
                  <article
                    ref={selected ? selectedCardRef : undefined}
                    data-grammar-idx={rowIndex}
                    data-grammar-id={diagnostic.id}
                    data-grammar-cursor={cursor ? 'true' : undefined}
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => {
                      setCursorIndex(rowIndex)
                      onSelect(diagnostic.id)
                    }}
                    className={[
                      'cursor-pointer rounded-lg border p-2.5 transition-colors',
                      cursor
                        ? 'border-accent bg-accent/12 ring-2 ring-accent/20'
                        : selected
                          ? 'border-accent/45 bg-accent/8'
                          : 'border-paper-300/65 bg-paper-100/45 hover:bg-paper-200/70'
                    ].join(' ')}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span
                        className={`grammar-review-category grammar-review-category-${diagnostic.category}`}
                      >
                        {categoryLabel(diagnostic.category)}
                      </span>
                      <span className="text-2xs text-ink-400">{rowIndex + 1}</span>
                    </div>
                    <div className="mt-2 text-sm leading-snug text-ink-800">
                      {diagnostic.message}
                    </div>
                    {diagnostic.original && (
                      <div className="mt-1.5 truncate font-mono text-xs text-ink-500 line-through">
                        {diagnostic.original}
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {diagnostic.replacements.map((replacement, replacementIndex) => (
                        <button
                          key={`${diagnostic.id}:${replacementIndex}:${replacement.value}`}
                          type="button"
                          data-grammar-panel-control
                          data-panel-activate={replacementIndex === 0 ? 'true' : undefined}
                          title="Apply and move to the next issue"
                          onClick={(event) => {
                            event.stopPropagation()
                            onApply(diagnostic.id, replacementIndex)
                          }}
                          className="max-w-full truncate rounded-md border border-accent/35 bg-accent/10 px-2 py-1 text-xs font-medium text-accent hover:bg-accent/18"
                        >
                          {replacement.value || 'Delete'}
                        </button>
                      ))}
                      <button
                        type="button"
                        data-grammar-panel-control
                        data-panel-activate={
                          diagnostic.replacements.length === 0 ? 'true' : undefined
                        }
                        onClick={(event) => {
                          event.stopPropagation()
                          onIgnore(diagnostic.id)
                        }}
                        className="rounded-md border border-paper-300/70 px-2 py-1 text-xs text-ink-500 hover:bg-paper-200"
                      >
                        Ignore once
                      </button>
                      {onIgnoreRule && canIgnoreGrammarRule(diagnostic.ruleId) && (
                        <button
                          type="button"
                          data-grammar-panel-control
                          onClick={(event) => {
                            event.stopPropagation()
                            onIgnoreRule(diagnostic)
                          }}
                          className="rounded-md border border-paper-300/70 px-2 py-1 text-xs text-ink-500 hover:bg-paper-200"
                        >
                          Ignore rule
                        </button>
                      )}
                      {diagnostic.original && onAddToDictionary && (
                        <button
                          type="button"
                          data-grammar-panel-control
                          onClick={(event) => {
                            event.stopPropagation()
                            onAddToDictionary(diagnostic)
                          }}
                          className="rounded-md border border-paper-300/70 px-2 py-1 text-xs text-ink-500 hover:bg-paper-200"
                        >
                          Add word
                        </button>
                      )}
                    </div>
                    <details
                      className="mt-2 text-2xs text-ink-400"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <summary className="cursor-pointer select-none">Rule details</summary>
                      <div className="mt-1 break-all font-mono">{diagnostic.ruleId}</div>
                    </details>
                  </article>
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </section>
  )
}
