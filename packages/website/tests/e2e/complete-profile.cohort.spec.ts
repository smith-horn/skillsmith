/**
 * complete-profile.cohort.spec.ts
 *
 * SMI-4401 Wave 2 — companion spec to complete-profile.spec.ts. Owns the
 * crawler-alternative and email-cohort journeys (spec §6.2):
 *
 *   J-F-anon    anon human → overlay visible → dismiss persists 7 days
 *   J-F-auth    authed human with github_orgs → overlay absent + quota banner + org badges
 *   J-EMAIL22   22-user cohort resend cooldown + /check-email full loop
 *
 * Split from the primary spec to keep each file under the 500-line pre-commit
 * cap (check-file-length.mjs enforces the limit on .ts files without a
 * test/spec exemption — see the "File-length enforcement asymmetry" note in
 * MEMORY). Shared mocking helpers live in complete-profile.helpers.ts.
 *
 * Tests will FAIL until Worker 1 + Worker 2 land the pages + helpers. That is
 * expected.
 *
 * Run:
 *   cd packages/website
 *   npx playwright test tests/e2e/complete-profile.cohort.spec.ts
 */

import { test, expect } from '@playwright/test'
import {
  USER_EMAIL,
  USER_ID,
  buildSessionToken,
  injectSupabaseStub,
  mockSupabase,
} from './complete-profile.helpers'

// ---------------------------------------------------------------------------
// J-F-anon — Flow F (anon human)
// ---------------------------------------------------------------------------

test.describe('J-F-anon — Flow F anonymous human', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page)
    await mockSupabase(page, {})
  })

  test('overlay visible, preview-anonymously dismisses for 7 days, persists across reload', async ({
    page,
  }) => {
    await page.goto('/skills')

    // Overlay visible for anon humans (spec §5.5 Path 2).
    const overlay = page.locator('[role="dialog"][aria-label*="Sign in"]')
    await expect(overlay).toBeVisible()

    // Click "Preview anonymously" → overlay hides + localStorage written.
    await page.getByRole('link', { name: /preview anonymously/i }).click()
    await expect(overlay).not.toBeVisible()

    const dismissedUntil = await page.evaluate(() =>
      window.localStorage.getItem('skills_overlay_dismissed_until')
    )
    expect(dismissedUntil).toBeTruthy()
    // The stored timestamp should be ~7 days in the future.
    const untilMs = new Date(dismissedUntil ?? '').getTime()
    const nowMs = Date.now()
    expect(untilMs - nowMs).toBeGreaterThan(6 * 24 * 60 * 60 * 1000)
    expect(untilMs - nowMs).toBeLessThan(8 * 24 * 60 * 60 * 1000)

    // Reload → overlay stays hidden.
    await page.reload()
    await expect(overlay).not.toBeVisible()
  })

  test('SignedOutOverlay CTA routes to /login?next=/skills', async ({ page }) => {
    // Ensure no prior dismissal pollutes the test.
    await page.addInitScript(() => {
      try {
        window.localStorage.removeItem('skills_overlay_dismissed_until')
      } catch {
        /* noop */
      }
    })
    await page.goto('/skills')
    const overlay = page.locator('[role="dialog"][aria-label*="Sign in"]')
    await expect(overlay).toBeVisible()

    // Click the primary CTA — should navigate to /login with next=/skills.
    await page
      .getByRole('link', { name: /sign in/i })
      .first()
      .click()
    await page.waitForURL(/\/login\?next=%2Fskills/, { timeout: 10_000 })
  })
})

// ---------------------------------------------------------------------------
// J-F-auth — Flow F (authenticated human with github_orgs populated)
// ---------------------------------------------------------------------------

test.describe('J-F-auth — Flow F authenticated human', () => {
  test('no overlay, quota banner visible, github-org badges present on at least one card', async ({
    page,
  }) => {
    await injectSupabaseStub(page, { session: buildSessionToken({ provider: 'github' }) })
    await mockSupabase(page, {
      restResponses: {
        profiles: [
          {
            id: USER_ID,
            first_name: 'Ryan',
            last_name: 'Smith',
            profile_completed_at: new Date().toISOString(),
            tier: 'community',
            github_orgs: ['smith-horn', 'anthropic'],
          },
        ],
      },
    })

    await page.goto('/skills')

    // Overlay NOT in DOM (auth path removes it, spec §5.5 Path 3).
    const overlayCount = await page.locator('[role="dialog"][aria-label*="Sign in"]').count()
    expect(overlayCount).toBe(0)

    // Quota banner visible with the "{N} of {M} free requests remaining" pattern (A-M9-1).
    await expect(page.locator('body')).toContainText(/\d+ of \d+ free requests/i)

    // At least one skill card decorated with a "Matches your org: ..." badge (A-M9-2).
    // The concrete selector depends on the SignedOutOverlay sibling component
    // Worker 2 builds — assert on the copy pattern as the stable contract.
    await expect(page.locator('body')).toContainText(/Matches your org:/i)
  })
})

// ---------------------------------------------------------------------------
// J-EMAIL22 — 22-user cohort resend cooldown + full loop
// ---------------------------------------------------------------------------

test.describe('J-EMAIL22 — 22-user email-verify cohort', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page)
  })

  test('signup → /check-email with email in bold; resend cooldown disables for 60s', async ({
    page,
  }) => {
    await page.goto(`/check-email?email=${encodeURIComponent(USER_EMAIL)}&next=/account/cli-token`)

    // Email rendered in bold (spec §4.2 A-22-1).
    await expect(page.locator('#email-display')).toContainText(USER_EMAIL)

    // Resend button initially enabled.
    const resendBtn = page.getByRole('button', { name: /resend/i })
    await expect(resendBtn).toBeEnabled()

    // Click Resend → cooldown kicks in.
    await resendBtn.click()
    await expect(resendBtn).toBeDisabled()
    await expect(resendBtn).toContainText(/\d+/) // countdown visible

    // Simulate stored cooldown persists across reload (spec §5.3 L1).
    await page.reload()
    const persistedCountdown = page.getByRole('button', { name: /resend/i })
    await expect(persistedCountdown).toBeDisabled()
  })

  test('email cohort: confirm-link → callback → /complete-profile empty → submit → /account/cli-token', async ({
    page,
  }) => {
    // Land on /auth/callback as a fresh email-signup user whose profile is incomplete.
    await injectSupabaseStub(page, { session: buildSessionToken({ provider: 'email' }) })
    await mockSupabase(page, {
      restResponses: {
        profiles: [
          {
            id: USER_ID,
            first_name: '',
            last_name: '',
            profile_completed_at: null,
            tier: 'community',
          },
        ],
      },
    })
    await page.goto('/auth/callback')
    await page.waitForURL(/\/complete-profile/, { timeout: 10_000 })

    // Email signup → empty pre-fill fields (A-22-2).
    await expect(page.locator('input[name="first_name"]')).toHaveValue('')
    await expect(page.locator('input[name="last_name"]')).toHaveValue('')

    // Fill + submit.
    await mockSupabase(page, {
      rpcResponses: {
        issue_license_key_if_profile_complete: { issued_now: true, reason: null },
      },
      restResponses: {
        profiles: [
          {
            id: USER_ID,
            first_name: 'Ryan',
            last_name: 'Smith',
            profile_completed_at: new Date().toISOString(),
            tier: 'community',
          },
        ],
      },
    })
    await page.fill('input[name="first_name"]', 'Ryan')
    await page.fill('input[name="last_name"]', 'Smith')
    await page.click('button[type="submit"]')

    // Default next= for this branch is /account/cli-token (A-22-3).
    await page.waitForURL(/\/account\/cli-token/, { timeout: 10_000 })
    // Fresh sk_live_* key visible.
    await expect(page.locator('body')).toContainText(/sk_live_/)
  })
})
