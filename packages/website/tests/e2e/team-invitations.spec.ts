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
 * The /account/team/members-specific admin github_username set path
 * (SMI-5589) lives in the sibling team-invitations-github-username.spec.ts,
 * split out to keep both files under the 500-line audit:standards limit.
 *
 * Run:
 *   cd packages/website
 *   npx playwright test tests/e2e/team-invitations.spec.ts
 */

import { test, expect, type Page, type Route } from '@playwright/test'

import { SUPABASE_HOST, injectSupabaseStub, setupMembersPage } from './team-members-page.helpers'

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

// ──────────────────────────────────────────────────────────────────────────
// SMI-4294 post-smoke regressions (Bugs 1, 2, 3)
//
// These three specs cover the three issues found during post-smoke UAT of
// the original SMI-4294 ship:
//   - Bug 1: Send-invite button stays solid orange after click
//   - Bug 2: Teammate row renders without name/email (RLS-stripped profile)
//   - Bug 3: No way to remove a team member
//
// The flow re-uses the existing mockSupabase harness but adds two RPC
// stubs: check_team_tier_access (so the gate passes as 'owner' on team_1)
// and list_team_members_with_profile (so the members list paints with
// real-looking rows).
// ──────────────────────────────────────────────────────────────────────────

test.describe('SMI-4294 post-smoke: members page', () => {
  test('Bug 2 regression: owner sees teammate name + email (RPC-fed, not RLS-stripped)', async ({
    page,
  }) => {
    await setupMembersPage(page)
    await page.goto('/account/team/members')

    // The member-list paints after refreshMembersList resolves.
    const tonyRow = page.locator('[data-member-id="tm_tony"]')
    await expect(tonyRow).toBeVisible({ timeout: 5000 })
    await expect(tonyRow.locator('.member-name')).toHaveText('Tony Lee')
    await expect(tonyRow.locator('.member-email')).toHaveText('tony.lee@example.com')

    // SMI-5151: per-member card — no stray avatar initial; the Remove button
    // carries a disambiguating aria-label so the action is unambiguously scoped.
    await expect(tonyRow.locator('.member-avatar')).toHaveCount(0)
    await expect(tonyRow.locator('[data-action="remove-member"]')).toHaveAttribute(
      'aria-label',
      'Remove Tony Lee'
    )
  })

  test('Bug 3 regression: owner removes member; row disappears; count decrements', async ({
    page,
  }) => {
    await setupMembersPage(page)
    await page.goto('/account/team/members')

    const heading = page.locator('#members-heading')
    await expect(heading).toHaveText('Members (2)', { timeout: 5000 })

    const tonyRow = page.locator('[data-member-id="tm_tony"]')
    await expect(tonyRow).toBeVisible()

    // Auto-accept the window.confirm dialog.
    page.once('dialog', (dialog) => {
      dialog.accept().catch(() => undefined)
    })

    await tonyRow.locator('[data-action="remove-member"]').click()

    // Post-remove: row gone, count decremented.
    await expect(tonyRow).toHaveCount(0, { timeout: 5000 })
    await expect(heading).toHaveText('Members (1)')
  })

  test('Bug 1 regression: race-window — submit button disables + shows "Sending..." mid-flight', async ({
    page,
  }) => {
    // 250ms delay on create_team_invitation gives the test a comfortable
    // window to observe the disabled + text-swapped state.
    await setupMembersPage(page, { createDelayMs: 250 })
    await page.goto('/account/team/members')

    await page.locator('#invite-btn').click()
    const modal = page.locator('#team-invite-modal')
    await expect(modal).toBeVisible()

    await page.locator('#invite-email').fill('newteammate@example.com')

    const submitBtn = page.locator('#invite-submit')
    // Kick the submit but don't await — we want to observe mid-flight state.
    const clickPromise = submitBtn.click()

    // The disable + text swap fires synchronously in the submit handler,
    // before any await; assert with a tight timeout so the test would fail
    // if a future refactor moved it after the RPC await.
    await expect(submitBtn).toBeDisabled({ timeout: 100 })
    await expect(submitBtn).toHaveText('Sending...', { timeout: 100 })
    await expect(submitBtn).toHaveAttribute('aria-busy', 'true', { timeout: 100 })

    await clickPromise

    // After a successful invite the button stays LOCKED (disabled, "Sent") so a
    // completed action can't be re-pressed; aria-busy clears.
    await expect(submitBtn).toHaveText('Sent', { timeout: 5000 })
    await expect(submitBtn).toBeDisabled()
    await expect(submitBtn).not.toHaveAttribute('aria-busy', 'true')

    // Editing the email re-arms the button for the next invite.
    await page.locator('#invite-email').fill('another@example.com')
    await expect(submitBtn).toBeEnabled()
    await expect(submitBtn).toHaveText('Send invite')
  })
})
