/**
 * complete-profile.spec.ts
 *
 * SMI-4401 Wave 2 — end-to-end coverage for the free-tier quid-pro-quo auth
 * flow. Spec §6.2 lists 8 journeys (J-TEAM removed post-Option-A).
 *
 * This file owns the primary-flow journeys:
 *   J-A         email fast-path signup → /check-email → callback → /account/cli-token
 *   J-B         GitHub OAuth → /complete-profile pre-filled → /account/cli-token
 *                 (includes routePostAuth loop-guard H1 assertion)
 *   J-C-stub    /device readonly stub (no approve button, no network call)
 *   J-E         legacy 403 recovery via /complete-profile?source=cli → /return-to-cli
 *   J-F-seo     Googlebot UA hits /skills → full HTML + both JSON-LD + no overlay
 *
 * The cohort + crawler-alternative journeys (J-F-anon, J-F-auth, J-EMAIL22)
 * live in complete-profile.cohort.spec.ts to keep each file under the 500-line
 * pre-commit cap (check-file-length.mjs enforces the limit on .ts files and
 * does not exempt test files — see the "File-length enforcement asymmetry"
 * note in MEMORY).
 *
 * Mocking strategy (shared helpers in complete-profile.helpers.ts):
 *   - All Supabase requests are intercepted via page.route(`${SUPABASE_HOST}/**`).
 *   - Auth session state is injected via localStorage (Supabase v2 stores the
 *     session under `sb-<ref>-auth-token`).
 *   - NO staging/prod network calls (prod is vrcnzpmndtroqxxoqkzy, staging is
 *     ovhcifugwqnzoebwfuku — CLAUDE.md). Tests run against the Astro preview
 *     server (playwright.config.ts webServer, port 4321).
 *
 * Expected initial state: tests will FAIL until Worker 1 + Worker 2 land the
 * new pages and Worker 1 wires the validator. That is intentional — the spec
 * contract is the source of truth.
 *
 * Run:
 *   cd packages/website
 *   npx playwright test tests/e2e/complete-profile.spec.ts
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
// J-A — Flow A (email fast-path)
// ---------------------------------------------------------------------------

test.describe('J-A — Flow A: email fast-path signup', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page)
  })

  test('signup submits first/last, routes to /check-email, callback completes, first-visit key issued', async ({
    page,
  }) => {
    // Intercept Supabase so the signup submit does not hit the network.
    await mockSupabase(page, {})
    await page.goto('/signup')

    // Spec §5.6 — new first_name + last_name fields + existing email + password.
    await page.fill('input[name="first_name"]', 'Ryan')
    await page.fill('input[name="last_name"]', 'Smith')
    await page.fill('input[name="email"]', USER_EMAIL)
    await page.fill('input[name="password"]', 'SecurePass123!xyz')
    await page.click('button[type="submit"]')

    // Expected redirect after signup success branch (spec §5.6 client-script block):
    // /check-email?email=<encoded>&next=/account/cli-token
    await page.waitForURL(/\/check-email\?email=/, { timeout: 10_000 })

    // Email should be rendered in bold (spec §5.3 A-22-1).
    await expect(page.locator('#email-display')).toContainText(USER_EMAIL)

    // Simulate the user clicking the Supabase confirm link →
    // lands on /auth/callback with a now-valid session.
    await injectSupabaseStub(page, { session: buildSessionToken({ provider: 'email' }) })
    await mockSupabase(page, {
      restResponses: {
        // handle_new_user fast-path (Wave 1 G2) populated profile_completed_at.
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
    await page.goto('/auth/callback')

    // Callback should bypass /complete-profile (profile already complete) and
    // hit the success path → /account/cli-token (first-visit state).
    await page.waitForURL(/\/account\/cli-token/, { timeout: 10_000 })

    // First-visit UI: fresh sk_live_* key visible.
    await expect(page.locator('body')).toContainText(/sk_live_/)
  })
})

// ---------------------------------------------------------------------------
// J-B — Flow B (GitHub OAuth) + routePostAuth loop-guard (H1)
// ---------------------------------------------------------------------------

test.describe('J-B — Flow B: GitHub OAuth', () => {
  test('callback detects null profile_completed_at and sends to /complete-profile pre-filled', async ({
    page,
  }) => {
    await injectSupabaseStub(page, { session: buildSessionToken({ provider: 'github' }) })
    await mockSupabase(page, {
      restResponses: {
        // profile_completed_at NULL → callback routes to /complete-profile.
        profiles: [
          {
            id: USER_ID,
            first_name: 'Ryan',
            last_name: 'Smith',
            profile_completed_at: null,
            tier: 'community',
            github_orgs: null,
          },
        ],
      },
    })

    await page.goto('/auth/callback')
    await page.waitForURL(/\/complete-profile/, { timeout: 10_000 })

    // handle_new_user split (Wave 1) → first/last populated from GitHub name.
    // Pre-fill assertion (spec §4.5 A-GH-1).
    const firstName = page.locator('input[name="first_name"]')
    const lastName = page.locator('input[name="last_name"]')
    await expect(firstName).toHaveValue('Ryan')
    await expect(lastName).toHaveValue('Smith')

    // GitHub helper row visible (A-GH-3).
    await expect(page.locator('body')).toContainText(/from your GitHub/i)

    // Simulate submit: RPC returns issued_now=true → /account/cli-token.
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
    await page.click('button[type="submit"]')
    await page.waitForURL(/\/account\/cli-token/, { timeout: 10_000 })
  })

  test('H1 loop-guard: arriving at /auth/callback with referrer=/complete-profile surfaces error', async ({
    page,
  }) => {
    // Force document.referrer === `${origin}/complete-profile` to simulate the
    // bounce-back scenario. The routePostAuth helper (spec §5.7 M3) must detect
    // this and render an inline error banner instead of looping.
    await injectSupabaseStub(page, { session: buildSessionToken({ provider: 'github' }) })
    await mockSupabase(page, {
      restResponses: {
        profiles: [
          {
            id: USER_ID,
            first_name: 'Ryan',
            last_name: 'Smith',
            profile_completed_at: null,
            tier: 'community',
          },
        ],
      },
    })

    // First land on /complete-profile so the next /auth/callback hit carries
    // the expected referrer — more faithful than Object.defineProperty.
    await page.goto('/complete-profile')
    await page.goto('/auth/callback')

    // Loop-guard should keep us on /auth/callback with an error banner visible,
    // not redirect to /complete-profile a second time.
    await expect(page).toHaveURL(/\/auth\/callback/)
    await expect(page.locator('body')).toContainText(/went wrong|Try again/i)
  })
})

// ---------------------------------------------------------------------------
// J-C-stub — Flow C (/device stub only)
// ---------------------------------------------------------------------------

test.describe('J-C-stub — Flow C partial (/device stub)', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page)
  })

  test('readonly user_code input renders, no disabled approve button, no network call', async ({
    page,
  }) => {
    const requested: string[] = []
    await mockSupabase(page, {
      onRequest: (url: string) => requested.push(url),
    })

    await page.goto('/device?user_code=BCDF-GHJK')

    // Readonly input reflects the code.
    const codeInput = page.locator('input[aria-label="Approval code"]')
    await expect(codeInput).toHaveValue('BCDF-GHJK')
    await expect(codeInput).toHaveAttribute('readonly', '')

    // L6: no disabled approve button element — zero buttons labeled "Approve".
    const approveBtnCount = await page.locator('button', { hasText: /^approve$/i }).count()
    expect(approveBtnCount).toBe(0)

    // Assert NO network request to any /functions/v1/auth-device-* endpoint.
    const deviceFnCalls = requested.filter((u) => /\/functions\/v1\/auth-device-/.test(u))
    expect(deviceFnCalls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// J-E — Flow E (legacy 403 recovery)
// ---------------------------------------------------------------------------

test.describe('J-E — Flow E: legacy 403 recovery', () => {
  test('source=cli subhead + submit → /return-to-cli with countdown + check-status button', async ({
    page,
  }) => {
    await injectSupabaseStub(page, { session: buildSessionToken({ provider: 'email' }) })
    await mockSupabase(page, {
      rpcResponses: {
        issue_license_key_if_profile_complete: { issued_now: false, reason: 'already_issued' },
      },
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

    await page.goto('/complete-profile?source=cli')

    // cli branch subhead copy (spec §5.1 copy matrix).
    await expect(page.locator('body')).toContainText(/Almost there — re-run your terminal command/i)

    // Fill + submit.
    await page.fill('input[name="first_name"]', 'Ryan')
    await page.fill('input[name="last_name"]', 'Smith')
    await page.click('button[type="submit"]')

    // cli-source default → /return-to-cli.
    await page.waitForURL(/\/return-to-cli/, { timeout: 10_000 })

    // 30s countdown visible on load (spec §5.2 M4).
    const countdown = page.locator('#countdown')
    await expect(countdown).toBeVisible()
    const initialValue = Number(await countdown.textContent())
    expect(initialValue).toBeGreaterThan(0)
    expect(initialValue).toBeLessThanOrEqual(30)

    // Check-status button available + clicking it yields a toast.
    await mockSupabase(page, {
      functionsResponses: {
        stats: { status: 200, body: { ok: true } },
      },
      restResponses: {
        license_keys: [{ status: 'active', user_id: USER_ID }],
      },
    })
    const checkBtn = page.getByRole('button', { name: /check key status/i })
    await expect(checkBtn).toBeVisible()
    await checkBtn.click()
    await expect(page.locator('body')).toContainText(/Key is live|propagating/i)
  })
})

// ---------------------------------------------------------------------------
// J-F-seo — Flow F (crawler UA hits /skills)
// ---------------------------------------------------------------------------

test.describe('J-F-seo — Flow F crawler', () => {
  test.use({
    extraHTTPHeaders: {
      'User-Agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)',
    },
  })

  test('Googlebot sees HTTP 200 + both JSON-LD blocks + no SignedOutOverlay', async ({ page }) => {
    await injectSupabaseStub(page)

    const response = await page.goto('/skills')
    expect(response?.status()).toBe(200)

    // Both JSON-LD blocks present in HTML (spec §4.1 A-SEO-1).
    const html = await page.content()
    // CollectionPage + ItemList block
    expect(html).toMatch(/"@type"\s*:\s*"CollectionPage"/)
    expect(html).toMatch(/"@type"\s*:\s*"ItemList"/)
    // BreadcrumbList block
    expect(html).toMatch(/"@type"\s*:\s*"BreadcrumbList"/)

    // SignedOutOverlay NOT rendered server-side for crawlers (spec §5.5 L7).
    const overlayCount = await page.locator('[role="dialog"][aria-label*="Sign in"]').count()
    expect(overlayCount).toBe(0)
  })
})
