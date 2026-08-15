/**
 * SMI-5893 Wave 6 Step 4 regression test.
 *
 * RateLimitToast.astro's fetch interceptor used to fire its toast on ANY
 * 429, from ANY origin — including unrelated Supabase auth/session calls.
 * This asserts the scoping logic: a real skills-search 429 (prod API origin
 * or the same-origin /api/skills-search proxy) still triggers tracking, and
 * an unrelated 429 (raw Supabase auth origin, a third-party billing origin)
 * does not.
 */

import { describe, expect, it } from 'vitest'
import {
  extractRequestUrl,
  getTrackedRateLimitOrigins,
  isTrackedRateLimitRequest,
} from './rate-limit-toast-origins'

const PAGE_HREF = 'https://www.skillsmith.app/skills'
const PAGE_ORIGIN = 'https://www.skillsmith.app'
const PROD_API_BASE = 'https://api.skillsmith.app'

describe('getTrackedRateLimitOrigins', () => {
  it('includes the resolved API base origin and the page origin', () => {
    const origins = getTrackedRateLimitOrigins(PROD_API_BASE, PAGE_ORIGIN)
    expect(origins).toContain(PROD_API_BASE)
    expect(origins).toContain(PAGE_ORIGIN)
  })

  it('picks up a configured staging origin automatically (same env var the site already uses)', () => {
    const stagingOrigin = 'https://ovhcifugwqnzoebwfuku.supabase.co'
    const origins = getTrackedRateLimitOrigins(stagingOrigin, PAGE_ORIGIN)
    expect(origins).toContain(stagingOrigin)
  })

  it('falls back to same-origin-only tracking when apiBaseUrl is malformed', () => {
    const origins = getTrackedRateLimitOrigins('not-a-url', PAGE_ORIGIN)
    expect(origins).toEqual([PAGE_ORIGIN])
  })

  it('de-dupes when the API base and page origin are the same', () => {
    const origins = getTrackedRateLimitOrigins(PAGE_ORIGIN, PAGE_ORIGIN)
    expect(origins).toEqual([PAGE_ORIGIN])
  })
})

describe('extractRequestUrl', () => {
  it('returns a string input unchanged', () => {
    expect(extractRequestUrl('/api/skills-search?q=test')).toBe('/api/skills-search?q=test')
  })

  it('reads .href off a URL instance', () => {
    const url = new URL('https://api.skillsmith.app/functions/v1/skills-search')
    expect(extractRequestUrl(url)).toBe(url.href)
  })

  it('reads .url off a Request instance', () => {
    const req = new Request('https://api.skillsmith.app/functions/v1/skills-search')
    expect(extractRequestUrl(req)).toBe(req.url)
  })
})

describe('isTrackedRateLimitRequest — the actual toast-scoping regression guard', () => {
  const trackedOrigins = getTrackedRateLimitOrigins(PROD_API_BASE, PAGE_ORIGIN)

  it('tracks a real skills-search call against the prod API origin', () => {
    expect(
      isTrackedRateLimitRequest(
        'https://api.skillsmith.app/functions/v1/skills-search?query=testing',
        trackedOrigins,
        PAGE_HREF
      )
    ).toBe(true)
  })

  it('tracks the same-origin /api/skills-search proxy path (relative URL)', () => {
    expect(
      isTrackedRateLimitRequest('/api/skills-search?q=testing', trackedOrigins, PAGE_HREF)
    ).toBe(true)
  })

  it('does NOT track an unrelated Supabase auth/session 429 (raw *.supabase.co origin)', () => {
    expect(
      isTrackedRateLimitRequest(
        'https://vrcnzpmndtroqxxoqkzy.supabase.co/auth/v1/token?grant_type=refresh_token',
        trackedOrigins,
        PAGE_HREF
      )
    ).toBe(false)
  })

  it('does NOT track an unrelated third-party 429 (e.g. a billing/analytics call)', () => {
    expect(
      isTrackedRateLimitRequest(
        'https://api.stripe.com/v1/checkout/sessions',
        trackedOrigins,
        PAGE_HREF
      )
    ).toBe(false)
  })

  it('returns false for a malformed request URL rather than throwing', () => {
    // Absolute (has an explicit scheme), so the base is ignored and the
    // missing host makes URL parsing fail outright.
    expect(isTrackedRateLimitRequest('http://', trackedOrigins, PAGE_HREF)).toBe(false)
  })
})
