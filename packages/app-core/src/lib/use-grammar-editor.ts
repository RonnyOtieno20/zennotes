import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import { Compartment } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useStore } from '../store'
import {
  createDefaultGrammarEditorBinding,
  supportsDefaultGrammarEditor,
  updateDefaultGrammarPersonalization,
  type GrammarEditorBinding
} from '../grammar/editor-runtime'
import { classifyGrammarEndpoint, grammarBindingKey } from '../grammar/preferences'
import type { GrammarDocumentSessionState } from '../grammar/document-sessions'
import type { GrammarDiagnostic } from '../grammar/types'
import {
  applyGrammarReplacementAndNext,
  applyGrammarReplacementToAll,
  closeGrammarSuggestionCard,
  getGrammarEditorState,
  ignoreGrammarDiagnosticOnce,
  openAdjacentGrammarSuggestionCard,
  selectAdjacentGrammarDiagnostic,
  selectGrammarDiagnostic,
  setGrammarSuggestionCards
} from '../grammar/editor-extension'
import type { SidePanelId } from './side-panel-fit'
import type { Panel } from './vim-nav'

/**
 * What one pane's CodeMirror view needs from the grammar checker: a
 * compartment to mount it in, and the binding currently installed there.
 * Created once per pane, before the view, so the view's own setup and
 * teardown can reach it.
 */
export class GrammarEditorAttachment {
  readonly compartment = new Compartment()
  binding: GrammarEditorBinding | null = null
  unsubscribe: (() => void) | null = null

  /** Drops this pane's binding, as when the view it was installed in goes away. */
  detach(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.binding?.release()
    this.binding = null
  }
}

export function useGrammarEditorAttachment(): GrammarEditorAttachment {
  return useState(() => new GrammarEditorAttachment())[0]
}

export interface GrammarReviewPanelControls {
  open: boolean
  setOpen: Dispatch<SetStateAction<boolean>>
  toggle: () => void
}

/**
 * The grammar review panel's open state for one pane, with its toggle shortcut
 * and the F8 / Shift+F8 issue navigation that follows it.
 */
export function useGrammarReviewPanel({
  viewRef,
  isActive,
  panelShortcutsApply,
  tuckedSidePanelsRef,
  revealSidePanel,
  focusedPanel,
  setFocusedPanel
}: {
  viewRef: MutableRefObject<EditorView | null>
  isActive: boolean
  panelShortcutsApply: boolean
  tuckedSidePanelsRef: MutableRefObject<readonly SidePanelId[]>
  revealSidePanel: (id: SidePanelId) => void
  focusedPanel: Panel | null
  setFocusedPanel: (panel: Panel | null) => void
}): GrammarReviewPanelControls {
  const [open, setOpen] = useState(false)

  const toggle = useCallback(() => {
    if (tuckedSidePanelsRef.current.includes('grammar')) {
      revealSidePanel('grammar')
      setFocusedPanel('grammar')
      return
    }
    setOpen((open) => {
      const next = !open
      const view = viewRef.current
      if (view) setGrammarSuggestionCards(view, !next)
      if (next) {
        setFocusedPanel('grammar')
      } else if (focusedPanel === 'grammar') {
        setFocusedPanel('editor')
        requestAnimationFrame(() => viewRef.current?.focus())
      }
      return next
    })
  }, [focusedPanel, revealSidePanel, setFocusedPanel, tuckedSidePanelsRef, viewRef])

  useEffect(() => {
    if (!panelShortcutsApply) return
    const handler = (): void => {
      toggle()
    }
    window.addEventListener('zen:toggle-grammar-review', handler)
    return () => window.removeEventListener('zen:toggle-grammar-review', handler)
  }, [panelShortcutsApply, toggle])

  useEffect(() => {
    if (!isActive) return
    const step = (direction: -1 | 1): void => {
      const view = viewRef.current
      if (!view) return
      if (open) {
        if (!selectAdjacentGrammarDiagnostic(view, direction)) return
        if (tuckedSidePanelsRef.current.includes('grammar')) revealSidePanel('grammar')
        setFocusedPanel('grammar')
        return
      }
      if (!openAdjacentGrammarSuggestionCard(view, direction)) return
      setFocusedPanel('editor')
      view.focus()
    }
    const next = (): void => step(1)
    const previous = (): void => step(-1)
    window.addEventListener('zen:next-grammar-issue', next)
    window.addEventListener('zen:previous-grammar-issue', previous)
    return () => {
      window.removeEventListener('zen:next-grammar-issue', next)
      window.removeEventListener('zen:previous-grammar-issue', previous)
    }
  }, [isActive, open, revealSidePanel, setFocusedPanel, tuckedSidePanelsRef, viewRef])

  return { open, setOpen, toggle }
}

export interface GrammarEditor {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
  supported: boolean
  sessionState: GrammarDocumentSessionState | null
  /** Where the note text goes, for the review panel's footer. */
  providerLabel: string
  revealDiagnostic: (diagnosticId: string) => void
  applyReplacement: (diagnosticId: string, replacementIndex: number) => void
  applyReplacementToAll: (diagnosticId: string, replacementIndex: number) => void
  ignoreDiagnostic: (diagnosticId: string) => void
  ignoreRule: (diagnostic: GrammarDiagnostic) => void
  addToDictionary: (diagnostic: GrammarDiagnostic) => void
  recheck: () => void
}

/**
 * Installs the grammar checker in one pane's editor and returns what the
 * toolbar and review panel need.
 *
 * Call it after the effect that loads a note into the view: its layout effects
 * have to run once the view shows the note they bind to.
 */
export function useGrammarEditor({
  attachment,
  viewRef,
  viewGeneration,
  notePath,
  vaultRoot,
  reviewOpen,
  setFocusedPanel
}: {
  attachment: GrammarEditorAttachment
  viewRef: MutableRefObject<EditorView | null>
  /** Changes whenever the view is created or destroyed. viewRef alone does not
   *  re-run effects, and a deferred hydration mounts the view in a later commit
   *  than the one that first ran the binding effect. */
  viewGeneration: number
  notePath: string | null
  vaultRoot: string | null
  reviewOpen: boolean
  setFocusedPanel: (panel: Panel | null) => void
}): GrammarEditor {
  const enabled = useStore((s) => s.grammarEnabled)
  const preferences = useStore((s) => s.grammarPreferences)
  const setEnabled = useStore((s) => s.setGrammarEnabled)
  const setPreferences = useStore((s) => s.setGrammarPreferences)
  const supported = supportsDefaultGrammarEditor()
  const [sessionState, setSessionState] = useState<GrammarDocumentSessionState | null>(null)

  // Read the lists at call time: depending on them would rebuild the grammar
  // binding, and check the note again, every time one of them grows.
  const ignoreRuleId = useCallback(
    (ruleId: string): void => {
      setPreferences({
        ignoredRules: [...useStore.getState().grammarPreferences.ignoredRules, ruleId]
      })
    },
    [setPreferences]
  )
  const addDictionaryEntry = useCallback(
    (entry: string): void => {
      setPreferences({
        customDictionary: [...useStore.getState().grammarPreferences.customDictionary, entry]
      })
    },
    [setPreferences]
  )
  const bindingKey = grammarBindingKey(preferences)

  // The visible categories, ignored rules and dictionary filter the results
  // every open note already has, so changing one never checks a note again.
  useLayoutEffect(() => {
    updateDefaultGrammarPersonalization(preferences)
  }, [preferences.customDictionary, preferences.enabledCategories, preferences.ignoredRules])

  // Grammar sessions are keyed by vault + note and shared across split panes;
  // the compartment keeps decorations, cards, and transactions pane-local.
  // Keyed on `bindingKey`, not the whole preferences, for the same reason.
  useLayoutEffect(() => {
    const view = viewRef.current
    attachment.detach()
    setSessionState(null)
    if (!view) return

    if (!enabled || !supported || !notePath || !vaultRoot) {
      view.dispatch({ effects: attachment.compartment.reconfigure([]) })
      return
    }

    const binding = createDefaultGrammarEditorBinding(
      { vaultId: vaultRoot, notePath },
      useStore.getState().grammarPreferences,
      { ignoreRule: ignoreRuleId, addToDictionary: addDictionaryEntry }
    )
    attachment.binding = binding
    const unsubscribe = binding.session.subscribe(setSessionState)
    attachment.unsubscribe = unsubscribe
    view.dispatch({ effects: attachment.compartment.reconfigure(binding.extension) })

    return () => {
      if (attachment.binding !== binding) return
      if (attachment.unsubscribe === unsubscribe) {
        attachment.unsubscribe = null
        unsubscribe()
      }
      attachment.binding = null
      binding.release()
    }
  }, [
    addDictionaryEntry,
    attachment,
    bindingKey,
    enabled,
    ignoreRuleId,
    notePath,
    supported,
    vaultRoot,
    viewGeneration,
    viewRef
  ])

  // The review panel and the floating suggestion card are alternate workflows.
  // Keep cards disabled while the panel owns navigation, including after a note
  // change recreates the grammar extension compartment or a deferred view
  // mounts. Declared after the binding effect so it runs once that is installed.
  useLayoutEffect(() => {
    const view = viewRef.current
    if (view) setGrammarSuggestionCards(view, !reviewOpen)
  }, [enabled, notePath, reviewOpen, supported, viewGeneration, viewRef])

  const logSnapshotRef = useRef('')
  useEffect(() => {
    if (!preferences.diagnosticLogging || !sessionState) return
    const snapshotKey = JSON.stringify([
      sessionState.status,
      sessionState.generation,
      sessionState.diagnostics.length,
      sessionState.error ?? null
    ])
    if (logSnapshotRef.current === snapshotKey) return
    logSnapshotRef.current = snapshotKey
    console.info('[zen:grammar]', {
      status: sessionState.status,
      generation: sessionState.generation,
      issueCount: sessionState.diagnostics.length,
      categories: sessionState.diagnostics.reduce<Record<string, number>>(
        (counts, diagnostic) => {
          counts[diagnostic.category] = (counts[diagnostic.category] ?? 0) + 1
          return counts
        },
        {}
      ),
      hasError: Boolean(sessionState.error)
    })
  }, [preferences.diagnosticLogging, sessionState])

  const revealDiagnostic = useCallback(
    (diagnosticId: string): void => {
      const view = viewRef.current
      if (!view || !selectGrammarDiagnostic(view, diagnosticId)) return
      const diagnostic = getGrammarEditorState(view.state)?.diagnostics.find(
        (item) => item.id === diagnosticId
      )
      if (!diagnostic) return
      view.dispatch({
        selection: { anchor: diagnostic.range.from },
        effects: EditorView.scrollIntoView(diagnostic.range.from, { y: 'center' })
      })
    },
    [viewRef]
  )

  const applyReplacement = useCallback(
    (diagnosticId: string, replacementIndex: number): void => {
      const view = viewRef.current
      if (!view) return
      const result = applyGrammarReplacementAndNext(view, diagnosticId, replacementIndex)
      if (!result.applied) return
      closeGrammarSuggestionCard(view)
      if (result.nextDiagnosticId) revealDiagnostic(result.nextDiagnosticId)
      setFocusedPanel('grammar')
    },
    [revealDiagnostic, setFocusedPanel, viewRef]
  )

  const applyReplacementToAll = useCallback(
    (diagnosticId: string, replacementIndex: number): void => {
      const view = viewRef.current
      if (!view || applyGrammarReplacementToAll(view, diagnosticId, replacementIndex) === 0) return
      closeGrammarSuggestionCard(view)
      setFocusedPanel('grammar')
    },
    [setFocusedPanel, viewRef]
  )

  const ignoreDiagnostic = useCallback(
    (diagnosticId: string): void => {
      const view = viewRef.current
      if (!view || !ignoreGrammarDiagnosticOnce(view, diagnosticId)) return
      closeGrammarSuggestionCard(view)
      const nextId = getGrammarEditorState(view.state)?.selectedDiagnosticId
      if (nextId) revealDiagnostic(nextId)
      setFocusedPanel('grammar')
    },
    [revealDiagnostic, setFocusedPanel, viewRef]
  )

  const ignoreRule = useCallback(
    (diagnostic: GrammarDiagnostic): void => {
      ignoreDiagnostic(diagnostic.id)
      ignoreRuleId(diagnostic.ruleId)
    },
    [ignoreDiagnostic, ignoreRuleId]
  )

  const addToDictionary = useCallback(
    (diagnostic: GrammarDiagnostic): void => {
      ignoreDiagnostic(diagnostic.id)
      addDictionaryEntry(diagnostic.original)
    },
    [addDictionaryEntry, ignoreDiagnostic]
  )

  const recheck = useCallback((): void => {
    const binding = attachment.binding
    const view = viewRef.current
    if (!binding || !view) return
    void binding.checkNow(view.state).catch(() => undefined)
  }, [attachment, viewRef])

  const endpoint = classifyGrammarEndpoint(preferences.endpoint)
  return {
    enabled,
    setEnabled,
    supported,
    sessionState,
    providerLabel:
      endpoint.scope === 'remote' ? 'Remote — note text is sent to this service' : endpoint.label,
    revealDiagnostic,
    applyReplacement,
    applyReplacementToAll,
    ignoreDiagnostic,
    ignoreRule,
    addToDictionary,
    recheck
  }
}
