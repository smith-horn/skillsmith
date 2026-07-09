/**
 * SMI-4862 / CodeQL #97: SSRF regression tests for apps/api-proxy/api/proxy.ts.
 *
 * Exercises the URL-origin-validation hardening against attack vectors that
 * defeat the previous string-concat guard.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import handler from '../../apps/api-proxy/api/proxy'

const SUPABASE_URL = 'https://vrcnzpmndtroqxxoqkzy.supabase.co'
const NULL_BYTE = String.fromCharCode(0)

function makeReq(
  path: string | undefined,
  headers: Record<string, string> = {},
  extraQuery: Record<string, string | string[]> = {}
): VercelRequest {
  return {
    method: 'GET',
    query: path === undefined ? { ...extraQuery } : { path, ...extraQuery },
    headers,
    body: undefined,
  } as unknown as VercelRequest
}

function makeRes(): VercelResponse & { _status: number; _payload: unknown } {
  const res: Partial<VercelResponse> & { _status: number; _payload: unknown } = {
    _status: 0,
    _payload: undefined,
  }
  res.status = vi.fn((code: number) => {
    res._status = code
    return res as VercelResponse
  }) as unknown as VercelResponse['status']
  res.json = vi.fn((data: unknown) => {
    res._payload = data
    return res as VercelResponse
  }) as unknown as VercelResponse['json']
  res.send = vi.fn((data: unknown) => {
    res._payload = data
    return res as VercelResponse
  }) as unknown as VercelResponse['send']
  res.setHeader = vi.fn() as unknown as VercelResponse['setHeader']
  res.end = vi.fn(() => res as VercelResponse) as unknown as VercelResponse['end']
  return res as VercelResponse & { _status: number; _payload: unknown }
}

describe('SMI-4862: api-proxy SSRF hardening', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = SUPABASE_URL
    vi.restoreAllMocks()
  })

  describe('allowed paths reach upstream', () => {
    it('forwards functions/v1/* to Supabase origin', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )

      const req = makeReq('functions/v1/stats')
      const res = makeRes()
      await handler(req, res)

      expect(fetchSpy).toHaveBeenCalledOnce()
      const calledUrl = String(fetchSpy.mock.calls[0]?.[0] ?? '')
      expect(calledUrl).toBe(`${SUPABASE_URL}/functions/v1/stats`)
      expect(res._status).toBe(200)
    })

    it('forwards rest/v1/* to Supabase origin', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )

      const req = makeReq('rest/v1/skills')
      const res = makeRes()
      await handler(req, res)

      const calledUrl = String(fetchSpy.mock.calls[0]?.[0] ?? '')
      expect(calledUrl).toBe(`${SUPABASE_URL}/rest/v1/skills`)
      expect(res._status).toBe(200)
    })

    it('preserves an @ in path position (URL spec: not userinfo when after a path segment)', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
        )

      const req = makeReq('functions/v1/foo@evil.com/bar')
      const res = makeRes()
      await handler(req, res)

      const calledUrl = String(fetchSpy.mock.calls[0]?.[0] ?? '')
      expect(new URL(calledUrl).origin).toBe(SUPABASE_URL)
      expect(res._status).toBe(200)
    })

    it('passes percent-encoded segments through verbatim', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
        )

      const req = makeReq('functions/v1/foo%2F..%2Fbar')
      const res = makeRes()
      await handler(req, res)

      const calledUrl = String(fetchSpy.mock.calls[0]?.[0] ?? '')
      expect(new URL(calledUrl).origin).toBe(SUPABASE_URL)
      // Upstream decides what %2F means; we only assert we stayed on-origin.
      expect(res._status).toBe(200)
    })
  })

  describe('attack vectors return 400 without making upstream calls', () => {
    it.each([
      ['traversal segment', 'functions/v1/../etc/passwd'],
      ['protocol-relative escape', '//evil.com/x'],
      ['absolute URL', 'https://evil.com'],
      ['CRLF injection', 'functions/v1/foo\r\nHost: evil.com'],
      ['null byte', `functions/v1/foo${NULL_BYTE}bar`],
      ['leading slash', '/functions/v1/foo'],
      ['scheme injection', 'javascript:alert(1)'],
      ['disallowed prefix', 'admin/secret'],
      // Semicolon-dot-dot path confusion: URL constructor does NOT normalise
      // `..;` segments, so this survives to `/functions/v1/..;/etc/passwd`
      // as a literal pathname. Some upstream servers treat `..;/` as a
      // traversal hop (nginx, Java servlet containers). Rejected pre-parse.
      ['semicolon traversal (..;/)', 'functions/v1/..;/etc/passwd'],
      // Percent-encoded NUL: %00 is not a literal 0x00 byte so it bypasses
      // the control-char regex; the URL constructor preserves it as %00 in
      // the pathname. Rejected via explicit pct-encoded check.
      ['percent-encoded NUL (%00)', 'functions/v1/foo%00bar'],
      // Percent-encoded CR and LF: same bypass route as %00.
      ['percent-encoded CR (%0d)', 'functions/v1/foo%0dHost: evil.com'],
      ['percent-encoded LF (%0a)', 'functions/v1/foo%0aHost: evil.com'],
    ])('rejects %s', async (_label, vector) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')

      const req = makeReq(vector)
      const res = makeRes()
      await handler(req, res)

      expect(res._status).toBe(400)
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })

  describe('input shape', () => {
    it('returns 400 when path is missing', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')

      const req = makeReq(undefined)
      const res = makeRes()
      await handler(req, res)

      expect(res._status).toBe(400)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('returns 500 when SUPABASE_URL is unset', async () => {
      delete process.env.SUPABASE_URL
      const fetchSpy = vi.spyOn(globalThis, 'fetch')

      const req = makeReq('functions/v1/stats')
      const res = makeRes()
      await handler(req, res)

      expect(res._status).toBe(500)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('handles CORS preflight', async () => {
      const req = { method: 'OPTIONS', query: {}, headers: {} } as unknown as VercelRequest
      const res = makeRes()
      await handler(req, res)

      expect(res._status).toBe(204)
    })
  })
})

describe('SMI-5598: api-proxy header forwarding', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = SUPABASE_URL
    vi.restoreAllMocks()
  })

  function mockUpstreamJson(headers: Record<string, string> = {}) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json', ...headers },
      })
    )
  }

  function fetchHeaders(fetchSpy: { mock: { calls: unknown[][] } }): Record<string, string> {
    const init = fetchSpy.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined
    return init?.headers ?? {}
  }

  describe('request header forwarding', () => {
    it('forwards x-api-key to the upstream fetch call', async () => {
      const fetchSpy = mockUpstreamJson()

      const req = makeReq('functions/v1/stats', { 'x-api-key': 'sk_live_test123' })
      const res = makeRes()
      await handler(req, res)

      expect(fetchHeaders(fetchSpy)['x-api-key']).toBe('sk_live_test123')
    })

    it('still forwards the existing allow-listed headers (regression)', async () => {
      const fetchSpy = mockUpstreamJson()

      const req = makeReq('functions/v1/stats', {
        authorization: 'Bearer abc123',
        apikey: 'anon-key',
        'content-type': 'application/json',
        'x-request-id': 'req-123',
      })
      const res = makeRes()
      await handler(req, res)

      const calledHeaders = fetchHeaders(fetchSpy)
      expect(calledHeaders.authorization).toBe('Bearer abc123')
      expect(calledHeaders.apikey).toBe('anon-key')
      expect(calledHeaders['content-type']).toBe('application/json')
      expect(calledHeaders['x-request-id']).toBe('req-123')
    })

    it('does not forward non-allow-listed headers', async () => {
      const fetchSpy = mockUpstreamJson()

      const req = makeReq('functions/v1/stats', {
        cookie: 'session=abc123',
        'x-forwarded-host': 'evil.example.com',
      })
      const res = makeRes()
      await handler(req, res)

      const calledHeaders = fetchHeaders(fetchSpy)
      expect(calledHeaders.cookie).toBeUndefined()
      expect(calledHeaders['x-forwarded-host']).toBeUndefined()
    })
  })

  describe('response header forwarding', () => {
    it('forwards x-ratelimit-reset and x-request-id from the upstream response back to the client', async () => {
      mockUpstreamJson({ 'x-ratelimit-reset': '1700000000', 'x-request-id': 'resp-req-1' })

      const req = makeReq('functions/v1/stats')
      const res = makeRes()
      await handler(req, res)

      expect(res.setHeader).toHaveBeenCalledWith('x-ratelimit-reset', '1700000000')
      expect(res.setHeader).toHaveBeenCalledWith('x-request-id', 'resp-req-1')
    })
  })

  describe('CORS allow-list parity (vercel.json)', () => {
    it('Access-Control-Allow-Headers includes X-API-Key', () => {
      const vercelJsonPath = resolve(__dirname, '../../apps/api-proxy/vercel.json')
      const vercelConfig = JSON.parse(readFileSync(vercelJsonPath, 'utf-8')) as {
        headers: Array<{ headers: Array<{ key: string; value: string }> }>
      }
      const allowHeadersEntry = vercelConfig.headers[0]?.headers.find(
        (h) => h.key === 'Access-Control-Allow-Headers'
      )

      expect(allowHeadersEntry?.value).toContain('X-API-Key')
    })
  })

  describe('resolveClientIp', () => {
    it('prefers cf-connecting-ip over x-real-ip and forwards it as the sole x-forwarded-for value', async () => {
      const fetchSpy = mockUpstreamJson()

      const req = makeReq('functions/v1/stats', {
        'cf-connecting-ip': '203.0.113.7',
        // Deliberately different/bogus value to prove cf-connecting-ip wins.
        'x-real-ip': '198.51.100.99',
      })
      const res = makeRes()
      await handler(req, res)

      const forwarded = fetchHeaders(fetchSpy)['x-forwarded-for']
      expect(forwarded).toBe('203.0.113.7')
      expect(forwarded).not.toContain(',')
    })

    it('falls back to x-real-ip when cf-connecting-ip is absent', async () => {
      const fetchSpy = mockUpstreamJson()

      const req = makeReq('functions/v1/stats', { 'x-real-ip': '198.51.100.42' })
      const res = makeRes()
      await handler(req, res)

      expect(fetchHeaders(fetchSpy)['x-forwarded-for']).toBe('198.51.100.42')
    })

    it('does not relay a raw multi-entry client-supplied x-forwarded-for verbatim', async () => {
      const fetchSpy = mockUpstreamJson()

      const req = makeReq('functions/v1/stats', { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })
      const res = makeRes()
      await handler(req, res)

      const forwarded = fetchHeaders(fetchSpy)['x-forwarded-for']
      // resolveClientIp() takes only the first, validated entry — never the
      // literal client-supplied chain.
      expect(forwarded).toBe('1.2.3.4')
      expect(forwarded).not.toBe('1.2.3.4, 5.6.7.8')
    })

    it('drops a malformed cf-connecting-ip and falls back to the next candidate', async () => {
      const fetchSpy = mockUpstreamJson()

      const req = makeReq('functions/v1/stats', {
        'cf-connecting-ip': 'not-an-ip',
        'x-real-ip': '198.51.100.5',
      })
      const res = makeRes()
      await handler(req, res)

      expect(fetchHeaders(fetchSpy)['x-forwarded-for']).toBe('198.51.100.5')
    })

    it('omits x-forwarded-for entirely when a CRLF-injection payload is the only candidate', async () => {
      const fetchSpy = mockUpstreamJson()

      const req = makeReq('functions/v1/stats', {
        'cf-connecting-ip': '1.2.3.4\r\nX-Injected: evil',
      })
      const res = makeRes()
      await handler(req, res)

      expect(fetchHeaders(fetchSpy)['x-forwarded-for']).toBeUndefined()
    })
  })
})

describe('SMI-5606: api-proxy query-string forwarding', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = SUPABASE_URL
    vi.restoreAllMocks()
  })

  function mockUpstreamJson() {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
  }

  it('re-attaches additional query-string params onto the upstream fetch URL', async () => {
    const fetchSpy = mockUpstreamJson()

    const req = makeReq('functions/v1/skills-search', {}, { query: 'test', limit: '1' })
    const res = makeRes()
    await handler(req, res)

    const calledUrl = String(fetchSpy.mock.calls[0]?.[0] ?? '')
    expect(calledUrl).toBe(`${SUPABASE_URL}/functions/v1/skills-search?query=test&limit=1`)
  })

  it('forwards an array-valued (repeated-key) query param as repeated keys', async () => {
    const fetchSpy = mockUpstreamJson()

    const req = makeReq('functions/v1/skills-search', {}, { category: ['dev', 'ops'] })
    const res = makeRes()
    await handler(req, res)

    const calledUrl = String(fetchSpy.mock.calls[0]?.[0] ?? '')
    expect(new URL(calledUrl).searchParams.getAll('category')).toEqual(['dev', 'ops'])
  })

  it('never forwards `path` itself as a query-string parameter (regression)', async () => {
    const fetchSpy = mockUpstreamJson()

    const req = makeReq('functions/v1/skills-search', {}, { query: 'test' })
    const res = makeRes()
    await handler(req, res)

    const calledUrl = String(fetchSpy.mock.calls[0]?.[0] ?? '')
    expect(new URL(calledUrl).searchParams.has('path')).toBe(false)
    expect(calledUrl).toBe(`${SUPABASE_URL}/functions/v1/skills-search?query=test`)
  })
})

describe('SMI-5607: duplicate ?path= query parameter', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = SUPABASE_URL
    vi.restoreAllMocks()
  })

  function mockUpstreamJson() {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
  }

  it('takes the first value and forwards successfully when path arrives duplicated (array-valued)', async () => {
    const fetchSpy = mockUpstreamJson()

    const req = {
      method: 'GET',
      query: { path: ['functions/v1/skills-search', 'x'] },
      headers: {},
      body: undefined,
    } as unknown as VercelRequest
    const res = makeRes()

    await handler(req, res)

    expect(fetchSpy).toHaveBeenCalledOnce()
    const calledUrl = String(fetchSpy.mock.calls[0]?.[0] ?? '')
    expect(calledUrl).toBe(`${SUPABASE_URL}/functions/v1/skills-search`)
    expect(res._status).toBe(200)
  })

  it('returns 400 (not an unhandled crash) when the first duplicated path value is invalid', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const req = {
      method: 'GET',
      query: { path: ['x', 'functions/v1/skills-search'] },
      headers: {},
      body: undefined,
    } as unknown as VercelRequest
    const res = makeRes()

    await handler(req, res)

    expect(res._status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
