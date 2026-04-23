/**
 * complete-profile.helpers.ts
 *
 * Shared Playwright fixtures for the SMI-4401 Wave 2 E2E suite. Extracted from
 * complete-profile.spec.ts to keep individual spec files under the 500-line
 * pre-commit cap (check-file-length.mjs enforces this for .ts files without
 * test/spec exemptions).
 *
 * Consumers: complete-profile.spec.ts, complete-profile.cohort.spec.ts.
 */

import type { Page, Route } from '@playwright/test'

export const SUPABASE_HOST = 'https://stub.supabase.co'
export const SUPABASE_ANON = 'stub-anon-key'
export const SUPABASE_REF = 'stub' // matches `stub.supabase.co` host prefix

// Stable fixture IDs — used both for storage-state generation and for assertion
// against profiles table rows returned by mocked REST calls.
export const USER_EMAIL = 'testuser@example.com'
export const USER_ID = '00000000-0000-0000-0000-000000000001'

/**
 * Build a minimal Supabase v2 session payload suitable for localStorage injection.
 * The JS client reads `sb-<ref>-auth-token` on boot; when present it skips the
 * initial /auth/v1/token round-trip.
 */
export function buildSessionToken(
  overrides: Partial<{ provider: 'email' | 'github' }> = {}
): string {
  const provider = overrides.provider ?? 'email'
  return JSON.stringify({
    access_token: 'stub-access-token',
    refresh_token: 'stub-refresh-token',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600,
    token_type: 'bearer',
    user: {
      id: USER_ID,
      email: USER_EMAIL,
      app_metadata: { provider, providers: [provider] },
      user_metadata: provider === 'github' ? { first_name: 'Ryan', last_name: 'Smith' } : {},
      aud: 'authenticated',
      role: 'authenticated',
    },
  })
}

/**
 * Inject the `__SUPABASE_CONFIG__` stub + optional session before the page
 * script runs. Mirrors the pattern used by team-tier-gate.spec.ts.
 */
export async function injectSupabaseStub(
  page: Page,
  opts: { session?: string | null } = {}
): Promise<void> {
  await page.addInitScript(
    ({ url, anonKey, ref, session }) => {
      ;(window as unknown as Record<string, unknown>).__SUPABASE_CONFIG__ = {
        url,
        anonKey,
      }
      if (session) {
        try {
          window.localStorage.setItem(`sb-${ref}-auth-token`, session)
        } catch {
          // swallow — some tests run before localStorage is available
        }
      }
    },
    {
      url: SUPABASE_HOST,
      anonKey: SUPABASE_ANON,
      ref: SUPABASE_REF,
      session: opts.session ?? null,
    }
  )
}

/**
 * Route handler that answers RPC, auth, and REST calls with lookup-table bodies.
 *
 * rpcResponses       — map of RPC name → 200 JSON body
 * restResponses      — map of pathname tail → 200 JSON body (e.g. `profiles` → [{...}])
 * functionsResponses — map of edge-fn name → { status, body }
 * onRequest          — invoked with every intercepted URL so tests can assert on
 *                      call presence/absence without re-routing
 */
export interface MockShape {
  rpcResponses?: Record<string, unknown>
  restResponses?: Record<string, unknown>
  functionsResponses?: Record<string, { status: number; body: unknown }>
  onRequest?: (url: string) => void
}

export async function mockSupabase(page: Page, shape: MockShape): Promise<void> {
  const { rpcResponses = {}, restResponses = {}, functionsResponses = {}, onRequest } = shape

  await page.route(`${SUPABASE_HOST}/**`, async (route: Route) => {
    const url = new URL(route.request().url())
    onRequest?.(url.pathname + url.search)

    // RPC: /rest/v1/rpc/<fn_name>
    const rpcMatch = url.pathname.match(/\/rest\/v1\/rpc\/([^/]+)/)
    if (rpcMatch) {
      const fn = rpcMatch[1]
      const body = rpcResponses[fn]
      if (body !== undefined) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(body),
        })
        return
      }
      await route.fulfill({ status: 404, body: 'rpc not mocked: ' + fn })
      return
    }

    // Edge functions: /functions/v1/<name>
    const fnMatch = url.pathname.match(/\/functions\/v1\/([^/]+)/)
    if (fnMatch) {
      const name = fnMatch[1]
      const resp = functionsResponses[name]
      if (resp !== undefined) {
        await route.fulfill({
          status: resp.status,
          contentType: 'application/json',
          body: JSON.stringify(resp.body),
        })
        return
      }
      await route.fulfill({ status: 404, body: 'fn not mocked: ' + name })
      return
    }

    // Auth endpoints: /auth/v1/*
    if (url.pathname.startsWith('/auth/v1/')) {
      // Default: 200 with an empty user — prevents unhandled rejections
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{}',
      })
      return
    }

    // REST: /rest/v1/<table>
    const restMatch = url.pathname.match(/\/rest\/v1\/([^/?]+)/)
    if (restMatch) {
      const table = restMatch[1]
      const body = restResponses[table]
      if (body !== undefined) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(body),
        })
        return
      }
      // Closed-default: empty array so `.single()` yields null without crashing the page.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '[]',
      })
      return
    }

    // Any other Supabase URL — empty 200
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    })
  })
}
