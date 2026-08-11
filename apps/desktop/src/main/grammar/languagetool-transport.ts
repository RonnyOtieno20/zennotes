import type {
  GrammarCancelRequest,
  GrammarCancelResponse,
  GrammarCheckRequest,
  GrammarCheckResponse,
  GrammarLanguageToolResponse
} from '@bridge-contract/grammar'

export const GRAMMAR_DEFAULT_TIMEOUT_MS = 10_000
export const GRAMMAR_MIN_TIMEOUT_MS = 100
export const GRAMMAR_MAX_TIMEOUT_MS = 30_000
export const GRAMMAR_MAX_TEXT_BYTES = 100_000
export const GRAMMAR_MAX_RESPONSE_BYTES = 2 * 1024 * 1024

type GrammarTransportErrorCode =
  | 'invalid-request'
  | 'invalid-endpoint'
  | 'duplicate-request'
  | 'cancelled'
  | 'timeout'
  | 'provider-error'
  | 'response-too-large'
  | 'invalid-response'

export class GrammarTransportError extends Error {
  readonly code: GrammarTransportErrorCode

  constructor(code: GrammarTransportErrorCode, message: string) {
    super(message)
    this.name = 'GrammarTransportError'
    this.code = code
  }
}

interface PendingRequest {
  controller: AbortController
  cancelled: boolean
  timedOut: boolean
}

export interface LanguageToolRequestLifecycle {
  beginRequest(url: URL, ownerId: number): Promise<boolean>
  endRequest(): void
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const LANGUAGE_PATTERN = /^(?:auto|[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*)$/
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const MAX_PROVIDER_IDS = 500
function assertRequestId(requestId: unknown): asserts requestId is string {
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new GrammarTransportError(
      'invalid-request',
      'Invalid grammar request ID'
    )
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  if (normalized === 'localhost' || normalized === '[::1]') return true
  const octets = normalized.split('.')
  if (octets.length !== 4 || octets[0] !== '127') return false
  return octets.every(
    (octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255
  )
}

export function resolveLanguageToolCheckUrl(rawEndpoint: unknown): URL {
  if (
    typeof rawEndpoint !== 'string' ||
    rawEndpoint.length === 0 ||
    rawEndpoint.length > 2048
  ) {
    throw new GrammarTransportError(
      'invalid-endpoint',
      'Invalid LanguageTool endpoint'
    )
  }

  let endpoint: URL
  try {
    endpoint = new URL(rawEndpoint)
  } catch {
    throw new GrammarTransportError(
      'invalid-endpoint',
      'Invalid LanguageTool endpoint'
    )
  }

  if (endpoint.username || endpoint.password) {
    throw new GrammarTransportError(
      'invalid-endpoint',
      'Credentials are not allowed in the LanguageTool endpoint'
    )
  }
  if (endpoint.search) {
    throw new GrammarTransportError(
      'invalid-endpoint',
      'Query parameters are not allowed in the LanguageTool endpoint'
    )
  }

  if (endpoint.protocol === 'http:') {
    if (!isLoopbackHostname(endpoint.hostname)) {
      throw new GrammarTransportError(
        'invalid-endpoint',
        'HTTP LanguageTool endpoints must use a loopback address'
      )
    }
  } else if (endpoint.protocol !== 'https:') {
    throw new GrammarTransportError(
      'invalid-endpoint',
      'LanguageTool endpoints must use HTTPS, or HTTP on loopback'
    )
  }

  endpoint.hash = ''
  const withoutTrailingSlash = endpoint.pathname.replace(/\/+$/, '')
  endpoint.pathname = withoutTrailingSlash.endsWith('/check')
    ? withoutTrailingSlash || '/check'
    : `${withoutTrailingSlash}/check`
  return endpoint
}

function validateCheckRequest(
  request: unknown
): asserts request is GrammarCheckRequest {
  if (!request || typeof request !== 'object') {
    throw new GrammarTransportError(
      'invalid-request',
      'Invalid grammar request'
    )
  }
  const candidate = request as Partial<GrammarCheckRequest>
  assertRequestId(candidate.requestId)
  resolveLanguageToolCheckUrl(candidate.endpoint)

  if (typeof candidate.text !== 'string' || candidate.text.length === 0) {
    throw new GrammarTransportError(
      'invalid-request',
      'Grammar request text must not be empty'
    )
  }
  if (Buffer.byteLength(candidate.text, 'utf8') > GRAMMAR_MAX_TEXT_BYTES) {
    throw new GrammarTransportError(
      'invalid-request',
      'Grammar request text is too large'
    )
  }
  if (
    typeof candidate.language !== 'string' ||
    !LANGUAGE_PATTERN.test(candidate.language)
  ) {
    throw new GrammarTransportError(
      'invalid-request',
      'Invalid grammar language'
    )
  }
  if (
    candidate.timeoutMs !== undefined &&
    (!Number.isInteger(candidate.timeoutMs) ||
      candidate.timeoutMs < GRAMMAR_MIN_TIMEOUT_MS ||
      candidate.timeoutMs > GRAMMAR_MAX_TIMEOUT_MS)
  ) {
    throw new GrammarTransportError(
      'invalid-request',
      'Invalid grammar request timeout'
    )
  }
  for (const values of [
    candidate.enabledCategories,
    candidate.enabledRules,
    candidate.disabledRules
  ]) {
    if (values === undefined) continue
    if (
      !Array.isArray(values) ||
      values.length > MAX_PROVIDER_IDS ||
      values.some(
        (value) => typeof value !== 'string' || !PROVIDER_ID_PATTERN.test(value)
      )
    ) {
      throw new GrammarTransportError(
        'invalid-request',
        'Invalid LanguageTool rule configuration'
      )
    }
  }
}

function validateCancelRequest(
  request: unknown
): asserts request is GrammarCancelRequest {
  if (!request || typeof request !== 'object') {
    throw new GrammarTransportError(
      'invalid-request',
      'Invalid grammar cancellation request'
    )
  }
  assertRequestId((request as Partial<GrammarCancelRequest>).requestId)
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The response is already being rejected; a stream cleanup error is secondary.
  }
}

async function readResponseBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > GRAMMAR_MAX_RESPONSE_BYTES
  ) {
    await discardResponseBody(response)
    throw new GrammarTransportError(
      'response-too-large',
      'LanguageTool response is too large'
    )
  }

  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > GRAMMAR_MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel()
        } catch {
          // Keep the stable size-limit error below.
        }
        throw new GrammarTransportError(
          'response-too-large',
          'LanguageTool response is too large'
        )
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

function parseLanguageToolResponse(body: string): GrammarLanguageToolResponse {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new GrammarTransportError(
      'invalid-response',
      'LanguageTool returned invalid JSON'
    )
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { matches?: unknown }).matches)
  ) {
    throw new GrammarTransportError(
      'invalid-response',
      'LanguageTool returned an invalid response'
    )
  }
  return parsed as GrammarLanguageToolResponse
}

export class LanguageToolTransport {
  private readonly pending = new Map<string, PendingRequest>()

  constructor(
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly lifecycle?: LanguageToolRequestLifecycle
  ) {}

  private requestKey(ownerId: number, requestId: string): string {
    return `${ownerId}:${requestId}`
  }

  async check(
    request: unknown,
    ownerId: number
  ): Promise<GrammarCheckResponse> {
    validateCheckRequest(request)
    const requestUrl = resolveLanguageToolCheckUrl(request.endpoint)
    const key = this.requestKey(ownerId, request.requestId)
    if (this.pending.has(key)) {
      throw new GrammarTransportError(
        'duplicate-request',
        'Grammar request ID is already active'
      )
    }

    const pending: PendingRequest = {
      controller: new AbortController(),
      cancelled: false,
      timedOut: false
    }
    this.pending.set(key, pending)
    let lifecycleStarted = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const timeoutMs = request.timeoutMs ?? GRAMMAR_DEFAULT_TIMEOUT_MS

    try {
      try {
        lifecycleStarted = (await this.lifecycle?.beginRequest(requestUrl, ownerId)) ?? false
      } catch {
        throw new GrammarTransportError(
          'provider-error',
          'Managed LanguageTool could not be started'
        )
      }
      if (pending.cancelled) {
        throw new GrammarTransportError(
          'cancelled',
          'LanguageTool request was cancelled'
        )
      }
      timeout = setTimeout(() => {
        pending.timedOut = true
        pending.controller.abort()
      }, timeoutMs)

      const params = new URLSearchParams({
        language: request.language,
        text: request.text
      })
      if (request.enabledCategories?.length) {
        params.set('enabledCategories', request.enabledCategories.join(','))
      }
      if (request.enabledRules?.length) {
        params.set('enabledRules', request.enabledRules.join(','))
      }
      if (request.disabledRules?.length) {
        params.set('disabledRules', request.disabledRules.join(','))
      }
      const response = await this.fetchImpl(requestUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8'
        },
        body: params,
        redirect: 'manual',
        signal: pending.controller.signal
      })

      if (response.status >= 300 && response.status < 400) {
        await discardResponseBody(response)
        throw new GrammarTransportError(
          'provider-error',
          'LanguageTool redirects are not allowed'
        )
      }
      if (!response.ok) {
        await discardResponseBody(response)
        throw new GrammarTransportError(
          'provider-error',
          `LanguageTool request failed with status ${response.status}`
        )
      }

      const body = await readResponseBody(response)
      return {
        requestId: request.requestId,
        response: parseLanguageToolResponse(body)
      }
    } catch (error) {
      if (pending.timedOut) {
        throw new GrammarTransportError(
          'timeout',
          'LanguageTool request timed out'
        )
      }
      if (pending.cancelled) {
        throw new GrammarTransportError(
          'cancelled',
          'LanguageTool request was cancelled'
        )
      }
      if (error instanceof GrammarTransportError) throw error
      throw new GrammarTransportError(
        'provider-error',
        'LanguageTool request failed'
      )
    } finally {
      if (timeout !== null) clearTimeout(timeout)
      this.pending.delete(key)
      if (lifecycleStarted) this.lifecycle?.endRequest()
    }
  }

  cancel(request: unknown, ownerId: number): GrammarCancelResponse {
    validateCancelRequest(request)
    const pending = this.pending.get(
      this.requestKey(ownerId, request.requestId)
    )
    if (!pending) return { requestId: request.requestId, cancelled: false }
    pending.cancelled = true
    pending.controller.abort()
    return { requestId: request.requestId, cancelled: true }
  }

  cancelOwner(ownerId: number): void {
    const prefix = `${ownerId}:`
    for (const [key, pending] of this.pending) {
      if (!key.startsWith(prefix)) continue
      pending.cancelled = true
      pending.controller.abort()
    }
  }
}
