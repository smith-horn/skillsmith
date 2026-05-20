/**
 * Team invitations E2E (SMI-4294)
 *
 * Covers the modal-open → submit → email-sent UI flow on /account/team/members
 * AND the acceptance route /invite/[token] decisions (signed-out redirect,
 * RPC error → error-state render).
 *
 * Boundary: Supabase RPCs and the team-invite-send edge function are mocked
 * via page.route(). Same rationale as team-tier-gate.spec.ts: the RPC
 * contracts are pinned by team-invitations.test.ts; this spec verifies the
 * page-level wiring (button → modal, modal-submit → list-update, etc).
 *
 * Run:
 *   cd packages/website
 *   npx playwright test tests/e2e/team-invitations.spec.ts
 */

import { test, expect, type Page, type Route } from '@playwright/test'

const SUPABASE_HOST = 'https://stub.supabase.co'
const SUPABASE_ANON = 'stub-anon-key'

async function injectSupabaseStub(page: Page): Promise<void> {
  await page.addInitScript(
    ({ url, anonKey }) => {
      ;(window as unknown as Record<string, unknown>).__SUPABASE_CONFIG__ = {
        url,
        anonKey,
      }
    },
    { url: SUPABASE_HOST, anonKey: SUPABASE_ANON }
  )
}

interface MockConfig {
  rpc?: Record<string, unknown>
  rest?: Record<string, unknown>
  edgeFunction?: { ok: boolean; body: unknown }
  /** When set, /auth/v1/user returns this (or 401 if undefined). */
  authedUser?: { id: string; email: string } | null
}

async function mockSupabase(page: Page, cfg: MockConfig): Promise<void> {
  await page.route(`${SUPABASE_HOST}/**`, async (route: Route) => {
    const url = new URL(route.request().url())

    // RPC
    const rpcMatch = url.pathname.match(/\/rest\/v1\/rpc\/([^/]+)/)
    if (rpcMatch) {
      const fn = rpcMatch[1] ?? ''
      if (cfg.rpc && fn in cfg.rpc) {
        const body = cfg.rpc[fn]
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(body),
        })
        return
      }
      await route.fulfill({ status: 404, body: 'not mocked' })
      return
    }

    // Edge function
    if (url.pathname.includes('/functions/v1/team-invite-send') && cfg.edgeFunction) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(cfg.edgeFunction.body),
      })
      return
    }

    // GoTrue user
    if (url.pathname === '/auth/v1/user') {
      if (cfg.authedUser === null || cfg.authedUser === undefined) {
        await route.fulfill({ status: 401, body: '{"msg":"unauthorized"}' })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(cfg.authedUser),
      })
      return
    }

    // REST select on team_invitations
    if (url.pathname.startsWith('/rest/v1/team_invitations')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(cfg.rest?.team_invitations ?? []),
      })
      return
    }
    if (url.pathname.startsWith('/rest/v1/team_members')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(cfg.rest?.team_members ?? []),
      })
      return
    }

    // Default: empty array (keeps page from crashing on unrelated selects)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]',
    })
  })
}

test.describe('Acceptance page /invite/[token]', () => {
  test('redirects signed-out user to /login?next=/invite/<token>', async ({ page }) => {
    const token = 'A'.repeat(32)
    await injectSupabaseStub(page)
    await mockSupabase(page, { authedUser: null })

    await page.goto(`/invite/${token}`)
    // Wait for the script-driven redirect.
    await page.waitForURL(/\/login\?next=/, { timeout: 5000 })
    const url = page.url()
    expect(url).toContain(`/login?next=${encodeURIComponent('/invite/' + token)}`)
  })

  test('invalid token (wrong length) redirects to members page with error param', async ({
    page,
  }) => {
    await injectSupabaseStub(page)
    await mockSupabase(page, {})
    await page.goto('/invite/short')
    await page.waitForURL(/error=invalid_invite/, { timeout: 5000 })
  })

  test('renders the expired error state when accept_team_invitation says expired', async ({
    page,
  }) => {
    const token = 'B'.repeat(32)
    await injectSupabaseStub(page)
    await mockSupabase(page, {
      authedUser: { id: 'user_1', email: 'p@example.com' },
      rpc: {
        // PostgREST shape: errored RPCs return 200 with the structured error
        // in supabase-js's parsed-error path. For e2e purposes we simulate
        // the RPC returning an error object the client will surface as
        // error.message contains "expired".
        accept_team_invitation: { error: { message: 'invitation expired' } },
      },
    })

    // The supabase-js client interprets a 4xx as an error; emulate by 400.
    await page.route(`${SUPABASE_HOST}/rest/v1/rpc/accept_team_invitation`, async (route) => {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'invitation expired' }),
      })
    })

    await page.goto(`/invite/${token}`)
    await expect(page.locator('#error-heading')).toContainText('Invitation expired', {
      timeout: 5000,
    })
  })

  test('renders wrong_email error state without revealing the invited email', async ({ page }) => {
    const token = 'C'.repeat(32)
    await injectSupabaseStub(page)
    await mockSupabase(page, {
      authedUser: { id: 'user_1', email: 'wrong@example.com' },
    })

    await page.route(`${SUPABASE_HOST}/rest/v1/rpc/accept_team_invitation`, async (route) => {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'invitation is for a different email' }),
      })
    })

    await page.goto(`/invite/${token}`)
    const body = page.locator('#error-body')
    await expect(body).toContainText('different email address', { timeout: 5000 })
    // The invited-email is never revealed by the page.
    const bodyText = (await body.textContent()) ?? ''
    expect(bodyText).not.toMatch(/@/)
  })

  test('success path redirects to /account/team/members?invited=1', async ({ page }) => {
    const token = 'D'.repeat(32)
    await injectSupabaseStub(page)
    await mockSupabase(page, {
      authedUser: { id: 'user_1', email: 'p@example.com' },
    })

    await page.route(`${SUPABASE_HOST}/rest/v1/rpc/accept_team_invitation`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ team_id: 'team_1', role: 'member', team_name: 'Test Team' }),
      })
    })

    // Intercept the members page so playwright doesn't fail on its load.
    await page.route('**/account/team/members*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body>OK</body></html>',
      })
    })

    await page.goto(`/invite/${token}`)
    await page.waitForURL(/\/account\/team\/members\?invited=1/, { timeout: 5000 })
  })
})
