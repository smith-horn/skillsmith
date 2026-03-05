/**
 * A/B Variant Cookie Smoke Tests
 *
 * SMI-3035: Regression guard for variant-cookie stability.
 *
 * Verifies that the Cloudflare Worker + Astro middleware A/B split does not
 * issue a spurious Set-Cookie header to return visitors who already have a
 * valid sk_ab_variant cookie. A Set-Cookie on a return visit indicates the
 * middleware freshly assigned a new variant, meaning the Astro rewrite did
 * not forward the Cookie header correctly (see ADR-111, SMI-3032).
 *
 * Targets the production URL by default. Override with SKILLSMITH_WEBSITE_URL
 * to run against a preview deployment.
 *
 * Run with:
 *   npx playwright test packages/website/tests/e2e/ab-variant-cookies.spec.ts
 */

import { test, expect } from '@playwright/test'

const BASE_URL = process.env.SKILLSMITH_WEBSITE_URL || 'https://www.skillsmith.app'

const VARIANTS = ['control', 'variant-a', 'variant-b'] as const
type Variant = (typeof VARIANTS)[number]

/**
 * Returns all Set-Cookie header values for the given variant cookie scenario.
 * Uses the raw fetch API context to avoid automatic cookie jar behaviour.
 */
async function getSetCookieHeaders(
  request: import('@playwright/test').APIRequestContext,
  cookieVariant: Variant | null
): Promise<string[]> {
  const headers: Record<string, string> = {}
  if (cookieVariant !== null) {
    headers['Cookie'] = `sk_ab_variant=${cookieVariant}`
  }

  const response = await request.get(BASE_URL + '/', {
    headers,
    // Do not follow redirects — we want the response from the origin directly.
    // Cloudflare Worker intercepts at the edge; the response we receive is
    // already the final HTML page (no redirect expected for '/').
    maxRedirects: 0,
  })

  // Collect all Set-Cookie values (Playwright exposes them as a single
  // comma-joined string under 'set-cookie'; split on '\n' for multiple values)
  const raw = response.headers()['set-cookie'] ?? ''
  return raw
    ? raw
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    : []
}

function isAbVariantCookie(setCookieValue: string): boolean {
  return setCookieValue.startsWith('sk_ab_variant=')
}

test.describe('A/B variant cookie stability', () => {
  test('fresh visit receives exactly one sk_ab_variant Set-Cookie', async ({ request }) => {
    const setCookies = await getSetCookieHeaders(request, null)
    const abCookies = setCookies.filter(isAbVariantCookie)

    expect(
      abCookies,
      'Expected exactly one sk_ab_variant Set-Cookie on a fresh (cookie-less) visit'
    ).toHaveLength(1)

    // Cookie must have Domain and a 7-day Max-Age (Worker-issued)
    expect(abCookies[0]).toMatch(/Domain=\.skillsmith\.app/)
    expect(abCookies[0]).toMatch(/Max-Age=604800/)
  })

  for (const variant of VARIANTS) {
    test(`return visit with ${variant} cookie receives no Set-Cookie`, async ({ request }) => {
      const setCookies = await getSetCookieHeaders(request, variant)
      const abCookies = setCookies.filter(isAbVariantCookie)

      expect(
        abCookies,
        `Expected NO sk_ab_variant Set-Cookie for return visitor with Cookie: sk_ab_variant=${variant}. ` +
          `A Set-Cookie here means the middleware freshly assigned a new variant (ADR-111 / SMI-3032).`
      ).toHaveLength(0)
    })
  }
})
