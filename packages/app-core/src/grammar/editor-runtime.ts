import type { EditorState, Extension } from '@codemirror/state'
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view'
import type { GrammarCheckOutcome } from './coordinator'
import {
  GrammarDocumentSessionRegistry,
  type GrammarDocumentKey,
  type GrammarDocumentSession,
  type GrammarDocumentSessionLease,
  type GrammarDocumentSessionState
} from './document-sessions'
import {
  grammarEditorExtension,
  type GrammarEditorSession,
  type GrammarEditorSnapshot
} from './editor-extension'
import { grammarProviderConfigKey, type GrammarPreferences } from './preferences'
import {
  ensureGrammarSyntaxTree,
  extractProseSegments,
  type GrammarProseOptions
} from './prose'
import { BridgeLanguageToolTransport } from './providers/bridge-transport'
import { LanguageToolProvider } from './providers/languagetool'
import type { GrammarDiagnostic } from './types'

const DEFAULT_LANGUAGE = 'en-US'
const MAX_AUTOMATIC_CHECK_CHARACTERS = 120_000
const AUTOMATIC_PARSE_BUDGET_MS = 8
const AUTOMATIC_PARSE_RETRY_MS = 100
const AUTOMATIC_PARSE_RETRY_LIMIT = 20
const MANUAL_PARSE_BUDGET_MS = 50

let defaultRegistry: GrammarDocumentSessionRegistry | null = null
let defaultRegistryKey = ''

export interface GrammarEditorBinding {
  readonly extension: Extension
  readonly session: GrammarDocumentSession
  /** Re-run the complete currently supported note from the pane's live state. */
  checkNow(state: EditorState): Promise<GrammarCheckOutcome>
  /** Idempotently release this pane's reference to the shared note session. */
  release(): void
}

export interface GrammarEditorBindingOptions {
  language?: string
  maxAutomaticCheckCharacters?: number
  automaticChecks?: boolean
  providerConfigKey?: string
  proseOptions?: GrammarProseOptions
  showUnderlines?: boolean
  ignoreRule?(ruleId: string): void
  addToDictionary?(entry: string): void
  /** @internal Override automatic parse readiness for deterministic runtime tests. */
  automaticParseReady?(state: EditorState, timeoutMs: number): boolean
  /** @internal Override the automatic parse retry delay for deterministic runtime tests. */
  automaticParseRetryMs?: number
}

function editorSnapshot(state: GrammarDocumentSessionState): GrammarEditorSnapshot {
  return {
    documentId: state.documentId,
    generation: state.generation,
    diagnostics: state.diagnostics,
    selectedDiagnosticId: state.selectedDiagnosticId
  }
}

function segmentFingerprintFor(
  state: GrammarDocumentSessionState,
  diagnostic: GrammarDiagnostic
): string | null {
  return state.segments.find((segment) => segment.id === diagnostic.segmentId)?.fingerprint ?? null
}

/** Adapt the shared note session to the intentionally narrow CodeMirror API. */
export function createGrammarEditorSession(
  session: GrammarDocumentSession,
  options: Pick<GrammarEditorBindingOptions, 'ignoreRule' | 'addToDictionary'> = {}
): GrammarEditorSession {
  return {
    getSnapshot: () => editorSnapshot(session.getState()),
    subscribe(listener) {
      return session.subscribe((state) => listener(editorSnapshot(state)))
    },
    getDocumentContext: () => {
      const state = session.getState()
      return { documentId: state.documentId, generation: state.generation }
    },
    ignoreOnce: (diagnosticId) => {
      session.ignoreOnce(diagnosticId)
    },
    ignoreRule: options.ignoreRule,
    addToDictionary: options.addToDictionary,
    onApplied: ({ diagnosticId }) => {
      // Keep the accepted issue out of every split pane until the queued
      // post-transaction check replaces the shared snapshot.
      session.ignoreOnce(diagnosticId)
    },
    selectDiagnostic: (diagnosticId) => {
      session.selectDiagnostic(diagnosticId)
    },
    validateApply(diagnostic, documentText) {
      const state = session.getState()
      const segmentFingerprint = segmentFingerprintFor(state, diagnostic)
      if (!segmentFingerprint) return false
      return session.validateApply({
        documentKey: state.documentKey,
        generation: diagnostic.generation,
        documentFingerprint: state.documentFingerprint,
        diagnosticId: diagnostic.id,
        segmentId: diagnostic.segmentId,
        segmentFingerprint,
        range: diagnostic.range,
        original: diagnostic.original,
        documentText
      }).valid
    }
  }
}

function grammarCheckExtension(
  session: GrammarDocumentSession,
  options: GrammarEditorBindingOptions
): Extension {
  const language = options.language ?? DEFAULT_LANGUAGE
  const maxCharacters = options.maxAutomaticCheckCharacters ?? MAX_AUTOMATIC_CHECK_CHARACTERS
  const automaticChecks = options.automaticChecks !== false
  const automaticParseReady = options.automaticParseReady ?? ensureGrammarSyntaxTree
  const automaticParseRetryMs = options.automaticParseRetryMs ?? AUTOMATIC_PARSE_RETRY_MS

  return ViewPlugin.fromClass(
    class {
      private queued = false
      private destroyed = false
      private parseRetryCount = 0
      private parseRetryTimer: ReturnType<typeof setTimeout> | null = null

      constructor(private readonly view: EditorView) {
        this.queue()
      }

      update(update: ViewUpdate): void {
        if (!update.docChanged) return
        this.cancelParseRetry()
        this.parseRetryCount = 0
        this.queue()
      }

      destroy(): void {
        this.destroyed = true
        this.cancelParseRetry()
      }

      private cancelParseRetry(): void {
        if (this.parseRetryTimer === null) return
        clearTimeout(this.parseRetryTimer)
        this.parseRetryTimer = null
      }

      private retryWhenParsed(): void {
        if (this.destroyed || this.parseRetryTimer !== null) return
        if (this.parseRetryCount >= AUTOMATIC_PARSE_RETRY_LIMIT) {
          const state = this.view.state
          void session.schedule({
            text: state.doc.toString(),
            segments: [],
            language,
            providerConfigKey: options.providerConfigKey,
            enabled: false
          })
          return
        }

        this.parseRetryCount += 1
        this.parseRetryTimer = setTimeout(() => {
          this.parseRetryTimer = null
          this.queue()
        }, automaticParseRetryMs)
      }

      private queue(): void {
        if (this.queued || this.destroyed) return
        this.queued = true
        queueMicrotask(() => {
          this.queued = false
          if (this.destroyed) return

          const state = this.view.state
          const text = state.doc.toString()
          if (!automaticChecks || text.length > maxCharacters) {
            this.cancelParseRetry()
            this.parseRetryCount = 0
            void session.schedule({
              text,
              segments: [],
              language,
              providerConfigKey: options.providerConfigKey,
              enabled: false
            })
            return
          }

          if (!automaticParseReady(state, AUTOMATIC_PARSE_BUDGET_MS)) {
            this.retryWhenParsed()
            return
          }

          this.cancelParseRetry()
          this.parseRetryCount = 0

          const segments = extractProseSegments(state, options.proseOptions)
          void session
            .schedule({
              text,
              segments,
              language,
              providerConfigKey: options.providerConfigKey
            })
            .catch(() => undefined)
        })
      }
    }
  )
}

/**
 * Acquire one pane-local editor binding backed by the registry's shared note
 * session. The host editor remains responsible for installing its Markdown
 * language extension, so grammar checking never defeats large-note deferral.
 */
export function createGrammarEditorBinding(
  registry: GrammarDocumentSessionRegistry,
  documentKey: GrammarDocumentKey,
  options: GrammarEditorBindingOptions = {}
): GrammarEditorBinding {
  const lease: GrammarDocumentSessionLease = registry.acquire(documentKey)
  const editorSession = createGrammarEditorSession(lease.session, options)
  const language = options.language ?? DEFAULT_LANGUAGE
  const maxCharacters = options.maxAutomaticCheckCharacters ?? MAX_AUTOMATIC_CHECK_CHARACTERS
  let released = false

  return {
    session: lease.session,
    extension: [
      grammarCheckExtension(lease.session, options),
      grammarEditorExtension({
        session: editorSession,
        showUnderlines: options.showUnderlines
      })
    ],
    checkNow(state) {
      const text = state.doc.toString()
      if (
        text.length > maxCharacters ||
        !ensureGrammarSyntaxTree(state, MANUAL_PARSE_BUDGET_MS)
      ) {
        return lease.session.checkNow({
          text,
          segments: [],
          language,
          providerConfigKey: options.providerConfigKey,
          enabled: false
        })
      }
      return lease.session.checkNow({
        text,
        segments: extractProseSegments(state, options.proseOptions),
        language,
        providerConfigKey: options.providerConfigKey,
        force: true
      })
    },
    release() {
      if (released) return
      released = true
      lease.release()
    }
  }
}

export function supportsDefaultGrammarEditor(): boolean {
  return window.zen.getCapabilities().supportsGrammarProviderTransport === true
}

function getDefaultRegistry(preferences: GrammarPreferences): GrammarDocumentSessionRegistry {
  const registryKey = JSON.stringify([
    preferences.endpoint,
    preferences.debounceMs,
    preferences.enabledCategories,
    preferences.ignoredRules,
    preferences.customDictionary
  ])
  if (!defaultRegistry || defaultRegistryKey !== registryKey) {
    defaultRegistry?.dispose()
    defaultRegistry = new GrammarDocumentSessionRegistry(
      new LanguageToolProvider(
        new BridgeLanguageToolTransport({
          bridge: window.zen,
          endpoint: preferences.endpoint
        }),
        {
          visibleCategories: preferences.enabledCategories,
          disabledRules: preferences.ignoredRules,
          customDictionary: preferences.customDictionary
        }
      ),
      { debounceMs: preferences.debounceMs }
    )
    defaultRegistryKey = registryKey
  }
  return defaultRegistry
}

/** Desktop binding using the host-confined localhost LanguageTool transport. */
export function createDefaultGrammarEditorBinding(
  documentKey: GrammarDocumentKey,
  preferences: GrammarPreferences,
  actions: Pick<GrammarEditorBindingOptions, 'ignoreRule' | 'addToDictionary'> = {}
): GrammarEditorBinding {
  if (!supportsDefaultGrammarEditor()) {
    throw new Error('Grammar checking is unavailable in this runtime')
  }
  return createGrammarEditorBinding(getDefaultRegistry(preferences), documentKey, {
    language: preferences.language,
    automaticChecks: preferences.automaticChecks,
    providerConfigKey: grammarProviderConfigKey(preferences),
    proseOptions: {
      checkHeadings: preferences.checkHeadings,
      checkLists: preferences.checkLists,
      checkBlockquotes: preferences.checkBlockquotes,
      checkTables: preferences.checkTables,
      checkLinkLabels: preferences.checkLinkLabels
    },
    showUnderlines: preferences.showUnderlines,
    ...actions
  })
}
