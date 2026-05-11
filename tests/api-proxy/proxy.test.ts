/**
 * SMI-4862 / CodeQL #97: SSRF regression tests for apps/api-proxy/api/proxy.ts.
 *
 * Exercises the URL-origin-validation hardening against attack vectors that
 * defeat the previous string-concat guard.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import handler from '../../apps/api-proxy/api/proxy'

const SUPABASE_URL = 'https://vrcnzpmndtroqxxoqkzy.supabase.co'
const NULL_BYTE = String.fromCharCode(0)

function makeReq(path: string | undefined): VercelRequest {
  return {
    method: 'GET',
    query: path === undefined ? {} : { path },
    headers: {},
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
