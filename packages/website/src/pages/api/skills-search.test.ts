/**
 * Regression tests for SMI-5608: skills-search API route must distinguish
 * genuine empty-results from upstream failure. Both failure branches
 * (`!res.ok` and thrown fetch exceptions) previously returned HTTP 200
 * with `{skills: []}`, making a real upstream outage indistinguishable
 * from a legitimate "no results found".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { GET } from './skills-search'

import type { APIContext } from 'astro'

function makeContext(query: string): APIContext {
  return { url: new URL(`https://site/api/skills-search${query}`) } as APIContext
}

describe('GET /api/skills-search', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns 502 (not 200) when upstream responds non-ok', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response)

    const response = await GET(makeContext('?q=react&limit=12'))
    expect(response.status).toBe(502)
    expect(response.status).not.toBe(200)

    const body = await response.json()
    expect(body).toHaveProperty('error')
    expect(body.skills).toEqual([])
  })

  it('returns 502 (not 200) when fetch throws', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network'))

    const response = await GET(makeContext('?q=react&limit=12'))
    expect(response.status).toBe(502)
    expect(response.status).not.toBe(200)

    const body = await response.json()
    expect(body).toHaveProperty('error')
    expect(body.skills).toEqual([])
  })

  it('returns 200 with empty skills for a genuinely short query, without calling fetch', async () => {
    const response = await GET(makeContext('?q=ab&limit=12'))
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body).toEqual({ skills: [] })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns 200 with results on a successful upstream response', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'a/b' }] }),
    } as Response)

    const response = await GET(makeContext('?q=react&limit=12'))
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body.skills).toHaveLength(1)
    expect(body.skills[0]).toEqual({ id: 'a/b' })
  })
})
