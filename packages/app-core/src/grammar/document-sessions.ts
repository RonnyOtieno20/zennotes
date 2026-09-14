import {
  GrammarCheckCoordinator,
  type GrammarCheckOutcome,
  type GrammarCheckStatus,
  type GrammarCoordinatorOptions,
  type GrammarCoordinatorState
} from './coordinator'
import type { GrammarProvider } from './provider'
import type { GrammarDiagnostic, ProseSegment, SourceRange } from './types'

export interface GrammarDocumentKey {
  /** Stable identity for the open vault, normally its root or persisted vault id. */
  vaultId: string
  /** Canonical vault-relative note path. */
  notePath: string
}

export interface GrammarDocumentSegmentState {
  id: string
  fingerprint: string
  sourceRange: SourceRange
}

export interface GrammarDocumentSessionState {
  documentKey: GrammarDocumentKey
  documentId: string
  documentFingerprint: string
  generation: number
  status: GrammarCheckStatus
  diagnostics: readonly GrammarDiagnostic[]
  selectedDiagnosticId: string | null
  ignoredDiagnosticIds: readonly string[]
  segments: readonly GrammarDocumentSegmentState[]
  error?: string
}

export interface GrammarDocumentCheckInput {
  text: string
  segments: readonly ProseSegment[]
  language: string
  /** Include every provider-affecting option so coordinator caches remain safe. */
  providerConfigKey?: string
  enabled?: boolean
  /** Recheck all segments even when their cached content is unchanged. */
  force?: boolean
}

export type GrammarApplyRejectionReason =
  | 'wrong-document'
  | 'stale-generation'
  | 'stale-document'
  | 'missing-diagnostic'
  | 'wrong-segment'
  | 'stale-segment'
  | 'stale-range'
  | 'original-mismatch'

export interface GrammarApplyValidationInput {
  documentKey: GrammarDocumentKey
  generation: number
  documentFingerprint: string
  diagnosticId: string
  segmentId: string
  segmentFingerprint: string
  range: SourceRange
  original: string
  /** Current text from the pane that will dispatch the replacement. */
  documentText: string
}

export type GrammarApplyValidationResult =
  | {
      valid: true
      diagnostic: GrammarDiagnostic
      nextDiagnosticId: string | null
    }
  | {
      valid: false
      reason: GrammarApplyRejectionReason
    }

interface InFlightCheck {
  signature: string
  promise: Promise<GrammarCheckOutcome>
}

interface RegistryEntry {
  session: GrammarDocumentSession
  references: Set<symbol>
}

export interface GrammarDocumentSessionLease {
  readonly session: GrammarDocumentSession
  /** Idempotently release this view's reference. */
  release(): void
}

function hashText(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Stable and collision-free serialization of a vault/note identity tuple. */
export function createGrammarDocumentId(key: GrammarDocumentKey): string {
  return JSON.stringify([key.vaultId, key.notePath])
}

export function fingerprintGrammarDocument(text: string): string {
  return `${text.length}:${hashText(text)}`
}

function copyKey(key: GrammarDocumentKey): GrammarDocumentKey {
  return { vaultId: key.vaultId, notePath: key.notePath }
}

function sameDocument(left: GrammarDocumentKey, right: GrammarDocumentKey): boolean {
  return left.vaultId === right.vaultId && left.notePath === right.notePath
}

function sameRange(left: SourceRange, right: SourceRange): boolean {
  return left.from === right.from && left.to === right.to
}

function segmentFingerprint(segment: ProseSegment): string {
  return segment.fingerprint ?? fingerprintGrammarDocument(segment.text)
}

function segmentStates(segments: readonly ProseSegment[]): GrammarDocumentSegmentState[] {
  return segments.map((segment) => ({
    id: segment.id,
    fingerprint: segmentFingerprint(segment),
    sourceRange: { ...segment.sourceRange }
  }))
}

function requestSignature(generation: number, input: GrammarDocumentCheckInput): string {
  return JSON.stringify([
    generation,
    input.language,
    input.providerConfigKey ?? '',
    input.enabled !== false,
    input.force === true,
    input.segments.map((segment) => [
      segment.id,
      segmentFingerprint(segment),
      segment.sourceRange.from,
      segment.sourceRange.to,
      segment.sourceMap,
      segment.insertionMap ?? null
    ])
  ])
}

function nextDiagnosticId(
  diagnostics: readonly GrammarDiagnostic[],
  diagnosticId: string
): string | null {
  const index = diagnostics.findIndex((diagnostic) => diagnostic.id === diagnosticId)
  return index >= 0 ? (diagnostics[index + 1]?.id ?? null) : null
}

/**
 * Validate an editor-local replacement against a shared session snapshot.
 *
 * The caller must pass values captured with the rendered diagnostic plus the
 * pane's current document text. Every mutable boundary is checked before a
 * CodeMirror transaction is allowed to use the returned diagnostic.
 */
export function validateGrammarApply(
  state: GrammarDocumentSessionState,
  input: GrammarApplyValidationInput
): GrammarApplyValidationResult {
  if (!sameDocument(state.documentKey, input.documentKey)) {
    return { valid: false, reason: 'wrong-document' }
  }
  if (state.generation !== input.generation) {
    return { valid: false, reason: 'stale-generation' }
  }
  if (
    state.documentFingerprint !== input.documentFingerprint ||
    fingerprintGrammarDocument(input.documentText) !== state.documentFingerprint
  ) {
    return { valid: false, reason: 'stale-document' }
  }

  const diagnostic = state.diagnostics.find((item) => item.id === input.diagnosticId)
  if (!diagnostic) return { valid: false, reason: 'missing-diagnostic' }
  if (diagnostic.generation !== state.generation) {
    return { valid: false, reason: 'stale-generation' }
  }
  if (diagnostic.segmentId !== input.segmentId) {
    return { valid: false, reason: 'wrong-segment' }
  }

  const segment = state.segments.find((item) => item.id === input.segmentId)
  if (!segment || segment.fingerprint !== input.segmentFingerprint) {
    return { valid: false, reason: 'stale-segment' }
  }
  if (
    !sameRange(diagnostic.range, input.range) ||
    input.range.from < segment.sourceRange.from ||
    input.range.to > segment.sourceRange.to ||
    input.range.to < input.range.from
  ) {
    return { valid: false, reason: 'stale-range' }
  }
  if (
    diagnostic.original !== input.original ||
    input.documentText.slice(input.range.from, input.range.to) !== input.original
  ) {
    return { valid: false, reason: 'original-mismatch' }
  }

  return {
    valid: true,
    diagnostic,
    nextDiagnosticId: nextDiagnosticId(state.diagnostics, diagnostic.id)
  }
}

/** One shared grammar request and review state for a single vault note. */
export class GrammarDocumentSession {
  private readonly listeners = new Set<(state: GrammarDocumentSessionState) => void>()
  private readonly ignored = new Set<string>()
  private documentText = ''
  private coordinatorState: GrammarCoordinatorState
  private allDiagnostics: readonly GrammarDiagnostic[] = []
  private selectedDiagnosticId: string | null = null
  private segments: readonly ProseSegment[] = []
  private generation = 0
  private documentFingerprint = fingerprintGrammarDocument('')
  private inFlight: InFlightCheck | null = null
  private disposed = false
  private state: GrammarDocumentSessionState

  constructor(
    readonly documentKey: GrammarDocumentKey,
    private readonly coordinator: GrammarCheckCoordinator
  ) {
    this.documentKey = copyKey(documentKey)
    this.coordinatorState = coordinator.getState()
    this.state = this.buildState()
    coordinator.subscribe((coordinatorState) => {
      if (this.disposed) return
      this.coordinatorState = coordinatorState
      this.allDiagnostics = coordinatorState.diagnostics
      if (
        this.selectedDiagnosticId !== null &&
        !this.visibleDiagnostics().some((diagnostic) => diagnostic.id === this.selectedDiagnosticId)
      ) {
        this.selectedDiagnosticId = null
      }
      this.publish()
    })
  }

  getState(): GrammarDocumentSessionState {
    return this.state
  }

  subscribe(listener: (state: GrammarDocumentSessionState) => void): () => void {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    listener(this.state)
    return () => this.listeners.delete(listener)
  }

  schedule(input: GrammarDocumentCheckInput): Promise<GrammarCheckOutcome> {
    return this.check(input, false)
  }

  checkNow(input: GrammarDocumentCheckInput): Promise<GrammarCheckOutcome> {
    return this.check({ ...input, force: input.force ?? true }, true)
  }

  ignoreOnce(diagnosticId: string): boolean {
    if (!this.visibleDiagnostics().some((diagnostic) => diagnostic.id === diagnosticId)) {
      return false
    }
    const nextId = nextDiagnosticId(this.visibleDiagnostics(), diagnosticId)
    this.ignored.add(diagnosticId)
    if (this.selectedDiagnosticId === diagnosticId) this.selectedDiagnosticId = nextId
    this.publish()
    return true
  }

  selectDiagnostic(diagnosticId: string | null): boolean {
    if (
      diagnosticId !== null &&
      !this.visibleDiagnostics().some((diagnostic) => diagnostic.id === diagnosticId)
    ) {
      return false
    }
    if (this.selectedDiagnosticId === diagnosticId) return true
    this.selectedDiagnosticId = diagnosticId
    this.publish()
    return true
  }

  selectNextDiagnostic(): string | null {
    return this.moveSelection(1)
  }

  selectPreviousDiagnostic(): string | null {
    return this.moveSelection(-1)
  }

  /** Select the following issue after an apply, without wrapping back to the first. */
  selectDiagnosticAfter(diagnosticId: string): string | null {
    const nextId = nextDiagnosticId(this.visibleDiagnostics(), diagnosticId)
    this.selectDiagnostic(nextId)
    return nextId
  }

  validateApply(input: GrammarApplyValidationInput): GrammarApplyValidationResult {
    if (input.documentText !== this.documentText) {
      return { valid: false, reason: 'stale-document' }
    }
    return validateGrammarApply(this.state, input)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.inFlight = null
    this.coordinator.dispose()
    this.listeners.clear()
    this.ignored.clear()
  }

  private check(
    input: GrammarDocumentCheckInput,
    immediately: boolean
  ): Promise<GrammarCheckOutcome> {
    if (this.disposed) {
      return Promise.resolve({
        accepted: false,
        reason: 'disposed',
        state: this.coordinatorState
      })
    }

    if (input.text !== this.documentText || this.generation === 0) {
      this.documentText = input.text
      this.documentFingerprint = fingerprintGrammarDocument(input.text)
      this.generation += 1
      this.ignored.clear()
      this.selectedDiagnosticId = null
    }
    this.segments = input.segments
    this.publish()

    const signature = requestSignature(this.generation, input)
    if (this.inFlight?.signature === signature) return this.inFlight.promise

    const request = {
      documentId: createGrammarDocumentId(this.documentKey),
      generation: this.generation,
      segments: input.segments,
      language: input.language,
      providerConfigKey: input.providerConfigKey,
      enabled: input.enabled,
      force: input.force
    }
    const promise = immediately
      ? this.coordinator.checkNow(request)
      : this.coordinator.schedule(request)
    const inFlight = { signature, promise }
    this.inFlight = inFlight
    const clearInFlight = () => {
      if (this.inFlight === inFlight) this.inFlight = null
    }
    void promise.then(clearInFlight, clearInFlight)
    return promise
  }

  private moveSelection(direction: 1 | -1): string | null {
    const diagnostics = this.visibleDiagnostics()
    if (diagnostics.length === 0) {
      this.selectDiagnostic(null)
      return null
    }
    const current = diagnostics.findIndex(
      (diagnostic) => diagnostic.id === this.selectedDiagnosticId
    )
    const next =
      current < 0
        ? direction === 1
          ? 0
          : diagnostics.length - 1
        : (current + direction + diagnostics.length) % diagnostics.length
    const selected = diagnostics[next]!.id
    this.selectDiagnostic(selected)
    return selected
  }

  private visibleDiagnostics(): readonly GrammarDiagnostic[] {
    return this.allDiagnostics.filter((diagnostic) => !this.ignored.has(diagnostic.id))
  }

  private buildState(): GrammarDocumentSessionState {
    const visible = this.visibleDiagnostics()
    return {
      documentKey: copyKey(this.documentKey),
      documentId: createGrammarDocumentId(this.documentKey),
      documentFingerprint: this.documentFingerprint,
      generation: this.generation,
      status: this.coordinatorState.status,
      diagnostics: visible,
      selectedDiagnosticId: this.selectedDiagnosticId,
      ignoredDiagnosticIds: [...this.ignored],
      segments: segmentStates(this.segments),
      ...(this.coordinatorState.error ? { error: this.coordinatorState.error } : {})
    }
  }

  private publish(): void {
    this.state = this.buildState()
    for (const listener of this.listeners) listener(this.state)
  }
}

/** Reference-counted owner for document sessions shared by split editor panes. */
export class GrammarDocumentSessionRegistry {
  private readonly entries = new Map<string, RegistryEntry>()

  constructor(
    private readonly provider: GrammarProvider,
    private readonly coordinatorOptions: GrammarCoordinatorOptions = {}
  ) {}

  acquire(documentKey: GrammarDocumentKey): GrammarDocumentSessionLease {
    const documentId = createGrammarDocumentId(documentKey)
    let entry = this.entries.get(documentId)
    if (!entry) {
      entry = {
        session: new GrammarDocumentSession(
          documentKey,
          new GrammarCheckCoordinator(this.provider, this.coordinatorOptions)
        ),
        references: new Set()
      }
      this.entries.set(documentId, entry)
    }

    const reference = Symbol(documentId)
    entry.references.add(reference)
    let released = false
    return {
      session: entry.session,
      release: () => {
        if (released) return
        released = true
        const current = this.entries.get(documentId)
        if (current !== entry) return
        current.references.delete(reference)
        if (current.references.size > 0) return
        this.entries.delete(documentId)
        current.session.dispose()
      }
    }
  }

  get(documentKey: GrammarDocumentKey): GrammarDocumentSession | undefined {
    return this.entries.get(createGrammarDocumentId(documentKey))?.session
  }

  getReferenceCount(documentKey: GrammarDocumentKey): number {
    return this.entries.get(createGrammarDocumentId(documentKey))?.references.size ?? 0
  }

  get size(): number {
    return this.entries.size
  }

  dispose(): void {
    for (const entry of this.entries.values()) entry.session.dispose()
    this.entries.clear()
  }
}
