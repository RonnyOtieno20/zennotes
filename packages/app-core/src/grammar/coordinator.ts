import { isValidProseSegment } from './provider'
import type { GrammarProvider } from './provider'
import type { GrammarDiagnostic, ProseSegment } from './types'

export type GrammarCheckStatus =
  | 'idle'
  | 'checking'
  | 'ready'
  | 'disabled'
  | 'error'

export interface GrammarCoordinatorState {
  documentId: string | null
  generation: number
  status: GrammarCheckStatus
  diagnostics: readonly GrammarDiagnostic[]
  error?: string
}

export interface GrammarCoordinatorRequest {
  documentId: string
  generation: number
  segments: readonly ProseSegment[]
  language: string
  /** Include every provider-affecting option so a settings change invalidates cached results. */
  providerConfigKey?: string
  enabled?: boolean
  /** Recheck all segments, as required by a manual "Check entire note" action. */
  force?: boolean
}

export interface GrammarCoordinatorOptions {
  debounceMs?: number
  maxSegmentsPerBatch?: number
  maxCharactersPerBatch?: number
}

export interface GrammarCheckOutcome {
  accepted: boolean
  reason?: 'disabled' | 'disposed' | 'superseded'
  state: GrammarCoordinatorState
}

interface SegmentCacheEntry {
  contentFingerprint: string
  text: string
  providerConfigKey: string
  sourceMap: readonly (number | null)[]
  insertionMap?: readonly (number | null)[]
  diagnostics: readonly GrammarDiagnostic[]
}

interface PendingTimer {
  token: number
  timer: ReturnType<typeof setTimeout>
  resolve: (outcome: GrammarCheckOutcome) => void
}

const DEFAULT_DEBOUNCE_MS = 750
const DEFAULT_MAX_SEGMENTS_PER_BATCH = 20
const DEFAULT_MAX_CHARACTERS_PER_BATCH = 12_000

function hashText(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function contentFingerprint(segment: ProseSegment): string {
  return segment.fingerprint ?? hashText(segment.text)
}

function mapsEqual(
  left: readonly (number | null)[],
  right: readonly (number | null)[]
): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** Return a uniform source-position shift, or null when a safe remap is impossible. */
function uniformMapDelta(
  previous: readonly (number | null)[],
  next: readonly (number | null)[]
): number | null {
  if (previous.length !== next.length) return null

  let delta: number | undefined
  for (let index = 0; index < previous.length; index += 1) {
    const before = previous[index]
    const after = next[index]
    if (before === null || after === null) {
      if (before !== after) return null
      continue
    }
    const candidate = after - before
    if (delta === undefined) delta = candidate
    else if (candidate !== delta) return null
  }
  return delta ?? null
}

function insertionMapMatchesDelta(
  previous: readonly (number | null)[] | undefined,
  next: readonly (number | null)[] | undefined,
  delta: number
): boolean {
  if (previous === undefined || next === undefined) return previous === next
  if (previous.length !== next.length) return false
  return previous.every((before, index) => {
    const after = next[index]
    if (before === null || after === null) return before === after
    return after - before === delta
  })
}

function rebaseDiagnostics(
  diagnostics: readonly GrammarDiagnostic[],
  delta: number,
  generation: number
): readonly GrammarDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    generation,
    range: {
      from: diagnostic.range.from + delta,
      to: diagnostic.range.to + delta
    }
  }))
}

function compareDiagnostics(left: GrammarDiagnostic, right: GrammarDiagnostic): number {
  return (
    left.range.from - right.range.from ||
    left.range.to - right.range.to ||
    left.id.localeCompare(right.id)
  )
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

/**
 * Owns one document's grammar request lifecycle.
 *
 * The coordinator deliberately has no editor or React dependencies. A future
 * CodeMirror extension can subscribe to snapshots without gaining permission to
 * accept stale network results.
 */
export class GrammarCheckCoordinator {
  private readonly debounceMs: number
  private readonly maxSegmentsPerBatch: number
  private readonly maxCharactersPerBatch: number
  private readonly listeners = new Set<(state: GrammarCoordinatorState) => void>()
  private readonly cache = new Map<string, SegmentCacheEntry>()
  private sequence = 0
  private pending: PendingTimer | null = null
  private activeController: AbortController | null = null
  private disposed = false
  private activeProviderConfigKey = ''
  private latestRequest: GrammarCoordinatorRequest | null = null
  private state: GrammarCoordinatorState = {
    documentId: null,
    generation: 0,
    status: 'idle',
    diagnostics: []
  }

  constructor(
    private readonly provider: GrammarProvider,
    options: GrammarCoordinatorOptions = {}
  ) {
    this.debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS)
    this.maxSegmentsPerBatch = Math.max(
      1,
      options.maxSegmentsPerBatch ?? DEFAULT_MAX_SEGMENTS_PER_BATCH
    )
    this.maxCharactersPerBatch = Math.max(
      1,
      options.maxCharactersPerBatch ?? DEFAULT_MAX_CHARACTERS_PER_BATCH
    )
  }

  getState(): GrammarCoordinatorState {
    return this.state
  }

  subscribe(listener: (state: GrammarCoordinatorState) => void): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => this.listeners.delete(listener)
  }

  schedule(request: GrammarCoordinatorRequest): Promise<GrammarCheckOutcome> {
    return this.enqueue(request, this.debounceMs)
  }

  checkNow(request: GrammarCoordinatorRequest): Promise<GrammarCheckOutcome> {
    return this.enqueue({ ...request, force: request.force ?? true }, 0)
  }

  cancel(): void {
    this.sequence += 1
    this.resolvePendingAsSuperseded()
    this.activeController?.abort()
    this.activeController = null
    if (!this.disposed && this.state.status === 'checking') {
      this.publish({ ...this.state, status: 'idle', error: undefined })
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancel()
    this.cache.clear()
    this.listeners.clear()
  }

  private enqueue(
    request: GrammarCoordinatorRequest,
    delayMs: number
  ): Promise<GrammarCheckOutcome> {
    if (this.disposed) {
      return Promise.resolve({ accepted: false, reason: 'disposed', state: this.state })
    }

    const invalidSegment = request.segments.find((segment) => !isValidProseSegment(segment))
    if (invalidSegment) {
      return Promise.reject(new Error(`Invalid prose segment: ${invalidSegment.id || '<missing id>'}`))
    }

    this.resolvePendingAsSuperseded()
    this.activeController?.abort()
    const token = ++this.sequence
    this.prepareRequest(request)

    if (request.enabled === false) {
      this.cache.clear()
      this.publish({
        documentId: request.documentId,
        generation: request.generation,
        status: 'disabled',
        diagnostics: []
      })
      return Promise.resolve({ accepted: false, reason: 'disabled', state: this.state })
    }

    this.publish({ ...this.state, status: 'checking', error: undefined })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending = null
        void this.run(request, token).then(resolve)
      }, delayMs)
      this.pending = { token, timer, resolve }
    })
  }

  private prepareRequest(request: GrammarCoordinatorRequest): void {
    const providerConfigKey = this.providerKey(request)
    if (
      this.state.documentId !== request.documentId ||
      this.activeProviderConfigKey !== providerConfigKey
    ) {
      this.cache.clear()
    }

    this.latestRequest = request
    this.activeProviderConfigKey = providerConfigKey
    const currentIds = new Set(request.segments.map((segment) => segment.id))
    for (const id of this.cache.keys()) {
      if (!currentIds.has(id)) this.cache.delete(id)
    }

    for (const segment of request.segments) {
      const cached = this.cache.get(segment.id)
      if (
        !cached ||
        cached.providerConfigKey !== providerConfigKey ||
        cached.contentFingerprint !== contentFingerprint(segment) ||
        cached.text !== segment.text
      ) {
        this.cache.delete(segment.id)
        continue
      }

      if (mapsEqual(cached.sourceMap, segment.sourceMap)) {
        if (!insertionMapMatchesDelta(cached.insertionMap, segment.insertionMap, 0)) {
          this.cache.delete(segment.id)
          continue
        }
        cached.diagnostics = rebaseDiagnostics(cached.diagnostics, 0, request.generation)
        continue
      }

      const delta = uniformMapDelta(cached.sourceMap, segment.sourceMap)
      if (
        delta === null ||
        !insertionMapMatchesDelta(cached.insertionMap, segment.insertionMap, delta)
      ) {
        this.cache.delete(segment.id)
        continue
      }
      cached.sourceMap = [...segment.sourceMap]
      cached.insertionMap = segment.insertionMap ? [...segment.insertionMap] : undefined
      cached.diagnostics = rebaseDiagnostics(cached.diagnostics, delta, request.generation)
    }

    this.publish({
      documentId: request.documentId,
      generation: request.generation,
      status: this.state.status,
      diagnostics: this.collectDiagnostics()
    })
  }

  private async run(
    request: GrammarCoordinatorRequest,
    token: number
  ): Promise<GrammarCheckOutcome> {
    const controller = new AbortController()
    this.activeController = controller
    const providerConfigKey = this.providerKey(request)
    const changed = request.segments.filter(
      (segment) => request.force || !this.cache.has(segment.id)
    )

    try {
      const diagnostics: GrammarDiagnostic[] = []
      for (const batch of this.createBatches(changed)) {
        if (!this.isCurrent(request, token)) {
          return { accepted: false, reason: 'superseded', state: this.state }
        }
        const batchDiagnostics = await this.provider.check({
          segments: batch,
          generation: request.generation,
          language: request.language,
          signal: controller.signal
        })
        diagnostics.push(...batchDiagnostics)
      }

      if (!this.isCurrent(request, token)) {
        return { accepted: false, reason: 'superseded', state: this.state }
      }

      const checkedIds = new Set(changed.map((segment) => segment.id))
      const diagnosticsBySegment = new Map<string, GrammarDiagnostic[]>()
      for (const diagnostic of diagnostics) {
        if (!checkedIds.has(diagnostic.segmentId)) continue
        const list = diagnosticsBySegment.get(diagnostic.segmentId) ?? []
        list.push(diagnostic)
        diagnosticsBySegment.set(diagnostic.segmentId, list)
      }

      for (const segment of changed) {
        this.cache.set(segment.id, {
          contentFingerprint: contentFingerprint(segment),
          text: segment.text,
          providerConfigKey,
          sourceMap: [...segment.sourceMap],
          ...(segment.insertionMap ? { insertionMap: [...segment.insertionMap] } : {}),
          diagnostics: diagnosticsBySegment.get(segment.id) ?? []
        })
      }

      this.publish({
        documentId: request.documentId,
        generation: request.generation,
        status: 'ready',
        diagnostics: this.collectDiagnostics()
      })
      return { accepted: true, state: this.state }
    } catch (error) {
      if (isAbortError(error) || !this.isCurrent(request, token)) {
        return { accepted: false, reason: 'superseded', state: this.state }
      }
      const message = error instanceof Error ? error.message : 'Grammar check failed'
      this.publish({ ...this.state, status: 'error', error: message })
      return { accepted: true, state: this.state }
    } finally {
      if (this.sequence === token) this.activeController = null
    }
  }

  private isCurrent(request: GrammarCoordinatorRequest, token: number): boolean {
    return (
      !this.disposed &&
      this.sequence === token &&
      this.latestRequest?.documentId === request.documentId &&
      this.latestRequest?.generation === request.generation &&
      this.providerKey(this.latestRequest) === this.providerKey(request)
    )
  }

  private providerKey(request: GrammarCoordinatorRequest): string {
    return `${this.provider.id}\u0000${request.language}\u0000${request.providerConfigKey ?? ''}`
  }

  private createBatches(segments: readonly ProseSegment[]): ProseSegment[][] {
    const batches: ProseSegment[][] = []
    let current: ProseSegment[] = []
    let characters = 0

    for (const segment of segments) {
      const wouldOverflow =
        current.length > 0 &&
        (current.length >= this.maxSegmentsPerBatch ||
          characters + segment.text.length > this.maxCharactersPerBatch)
      if (wouldOverflow) {
        batches.push(current)
        current = []
        characters = 0
      }
      current.push(segment)
      characters += segment.text.length
    }
    if (current.length > 0) batches.push(current)
    return batches
  }

  private collectDiagnostics(): readonly GrammarDiagnostic[] {
    return [...this.cache.values()]
      .flatMap((entry) => entry.diagnostics)
      .sort(compareDiagnostics)
  }

  private resolvePendingAsSuperseded(): void {
    if (!this.pending) return
    clearTimeout(this.pending.timer)
    this.pending.resolve({ accepted: false, reason: 'superseded', state: this.state })
    this.pending = null
  }

  private publish(state: GrammarCoordinatorState): void {
    this.state = state
    for (const listener of this.listeners) listener(state)
  }
}
