import { describe, expect, it, vi } from 'vitest'
import {
  GRAMMAR_MAX_RESPONSE_BYTES,
  GRAMMAR_MAX_TEXT_BYTES,
  GrammarTransportError,
  LanguageToolTransport,
  resolveLanguageToolCheckUrl
} from './languagetool-transport'

const VALID_REQUEST = {
  requestId: 'request-1',
  endpoint: 'http://127.0.0.1:8081/v2',
  text: 'This are a test.',
  language: 'en-US',
  enabledCategories: ['GRAMMAR'],
  disabledRules: ['WHITESPACE_RULE']
} as const

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers }
  })
}

describe('resolveLanguageToolCheckUrl', () => {
  it('allows HTTP only for loopback and appends the check path', () => {
    expect(resolveLanguageToolCheckUrl('http://localhost:8081/v2').href).toBe(
      'http://localhost:8081/v2/check'
    )
    expect(
      resolveLanguageToolCheckUrl('http://127.42.0.1:8081/v2/check/').href
    ).toBe('http://127.42.0.1:8081/v2/check')
    expect(resolveLanguageToolCheckUrl('http://[::1]:8081/v2').href).toBe(
      'http://[::1]:8081/v2/check'
    )
    expect(() =>
      resolveLanguageToolCheckUrl('http://languagetool.example/v2')
    ).toThrow(/loopback/)
  })

  it('allows HTTPS remotely and rejects other protocols', () => {
    expect(
      resolveLanguageToolCheckUrl('https://languagetool.example/v2').href
    ).toBe('https://languagetool.example/v2/check')
    expect(() =>
      resolveLanguageToolCheckUrl('ftp://languagetool.example/v2')
    ).toThrow(/HTTPS/)
  })

  it('rejects credentials in authority and all endpoint query parameters', () => {
    expect(() =>
      resolveLanguageToolCheckUrl('https://user:secret@example.com/v2')
    ).toThrow(/Credentials/)
    for (const query of [
      'apiKey=secret',
      'x-api-key=secret',
      'api-key=secret',
      'secret=value',
      'arbitrary=value'
    ]) {
      expect(() =>
        resolveLanguageToolCheckUrl(`https://example.com/v2?${query}`)
      ).toThrow(/Query parameters/)
    }
  })
})

describe('LanguageToolTransport', () => {
  it('posts form-encoded note text without following redirects', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe('POST')
      expect(init?.redirect).toBe('manual')
      expect(String(init?.body)).toBe(
        'language=en-US&text=This+are+a+test.&enabledCategories=GRAMMAR&disabledRules=WHITESPACE_RULE'
      )
      return jsonResponse({ matches: [] })
    })
    const transport = new LanguageToolTransport(fetchImpl)

    await expect(transport.check(VALID_REQUEST, 7)).resolves.toEqual({
      requestId: VALID_REQUEST.requestId,
      response: { matches: [] }
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:8081/v2/check'),
      expect.objectContaining({ redirect: 'manual' })
    )
  })

  it('wraps managed requests in lifecycle activity', async () => {
    const lifecycle = {
      beginRequest: vi.fn(async () => true),
      endRequest: vi.fn()
    }
    const transport = new LanguageToolTransport(
      vi.fn<typeof fetch>(async () => jsonResponse({ matches: [] })),
      lifecycle
    )

    await transport.check(VALID_REQUEST, 7)

    expect(lifecycle.beginRequest).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:8081/v2/check'),
      7
    )
    expect(lifecycle.endRequest).toHaveBeenCalledOnce()
  })

  it('rejects invalid and oversized request text before fetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const transport = new LanguageToolTransport(fetchImpl)

    await expect(
      transport.check({ ...VALID_REQUEST, text: '' }, 1)
    ).rejects.toMatchObject({
      code: 'invalid-request'
    })
    await expect(
      transport.check(
        { ...VALID_REQUEST, text: 'x'.repeat(GRAMMAR_MAX_TEXT_BYTES + 1) },
        1
      )
    ).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(
      transport.check({ ...VALID_REQUEST, enabledRules: ['INVALID RULE'] }, 1)
    ).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(
      transport.check(
        {
          ...VALID_REQUEST,
          disabledRules: Array.from({ length: 501 }, () => 'RULE')
        },
        1
      )
    ).rejects.toMatchObject({ code: 'invalid-request' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('cancels only the matching renderer-owned request ID', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    })
    const transport = new LanguageToolTransport(fetchImpl)
    const checkPromise = transport.check(VALID_REQUEST, 12)
    const rejection = expect(checkPromise).rejects.toMatchObject({
      code: 'cancelled'
    })

    expect(
      transport.cancel({ requestId: VALID_REQUEST.requestId }, 99)
    ).toEqual({
      requestId: VALID_REQUEST.requestId,
      cancelled: false
    })
    expect(
      transport.cancel({ requestId: VALID_REQUEST.requestId }, 12)
    ).toEqual({
      requestId: VALID_REQUEST.requestId,
      cancelled: true
    })
    await rejection
  })

  it('aborts requests at the configured timeout', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    })
    const transport = new LanguageToolTransport(fetchImpl)

    await expect(
      transport.check({ ...VALID_REQUEST, timeoutMs: 100 }, 1)
    ).rejects.toMatchObject({ code: 'timeout' })
  })

  it('rejects redirects, oversized bodies, and malformed responses', async () => {
    const redirecting = new LanguageToolTransport(
      vi.fn<typeof fetch>(async () => new Response(null, { status: 302 }))
    )
    await expect(redirecting.check(VALID_REQUEST, 1)).rejects.toMatchObject({
      code: 'provider-error'
    })

    const oversized = new LanguageToolTransport(
      vi.fn<typeof fetch>(async () =>
        jsonResponse(
          { matches: [] },
          {
            headers: {
              'content-length': String(GRAMMAR_MAX_RESPONSE_BYTES + 1)
            }
          }
        )
      )
    )
    await expect(oversized.check(VALID_REQUEST, 1)).rejects.toMatchObject({
      code: 'response-too-large'
    })

    const undeclaredOversized = new LanguageToolTransport(
      vi.fn<typeof fetch>(
        async () => new Response(new Uint8Array(GRAMMAR_MAX_RESPONSE_BYTES + 1))
      )
    )
    await expect(
      undeclaredOversized.check(VALID_REQUEST, 1)
    ).rejects.toMatchObject({
      code: 'response-too-large'
    })

    const malformed = new LanguageToolTransport(
      vi.fn<typeof fetch>(async () => jsonResponse({ unexpected: true }))
    )
    await expect(malformed.check(VALID_REQUEST, 1)).rejects.toMatchObject({
      code: 'invalid-response'
    })
  })

  it('uses stable typed errors for duplicate active request IDs', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('aborted'))
        )
      })
    })
    const transport = new LanguageToolTransport(fetchImpl)
    const first = transport.check(VALID_REQUEST, 1)
    const firstRejection = expect(first).rejects.toBeInstanceOf(
      GrammarTransportError
    )

    await expect(transport.check(VALID_REQUEST, 1)).rejects.toMatchObject({
      code: 'duplicate-request'
    })
    transport.cancel({ requestId: VALID_REQUEST.requestId }, 1)
    await firstRejection
  })
})
