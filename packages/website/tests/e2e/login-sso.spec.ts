/**
 * login-sso.spec.ts
 *
 * Smoke coverage for SMI-6204's "Sign in with SSO" path on /login.
 *
 * A real SSO sign-in can't be exercised end-to-end here — it requires a live
 * SAML/OIDC IdP round trip that this suite has no fixture for (see
 * device-login-roundtrip.spec.ts / e2e-staging-runbook.md for how that's
 * handled for the CLI device-login flow instead). What *is* reasonable to
 * cover locally is the error path: `supabase.auth.signInWithSSO({ domain })`
 * against a domain with no SSO configured, or a domain whose provider was
 * disabled (e.g. after a failed reverification), and confirming the login
 * page surfaces two distinct, actionable messages rather than one generic
 * "SSO not configured" string — the two GoTrue 404s the page's script
 * branches on (`sso_provider_not_found` vs `sso_provider_disabled`).
 *
 * Follows team-tier-gate.spec.ts's pattern: mock Supabase via page.route(),
 * no real backend involved. The page's own inline SSR script assigns
 * `window.__SUPABASE_CONFIG__ = supabaseConfig` in its <head> — under a real
 * CI harness that would silently overwrite this stub with the page's actual
 * SSR-rendered project config (SMI-6134's known hazard), so the config is
 * injected as an immutable property the same way complete-profile.helpers.ts
 * and team-tier-gate.spec.ts already do.
 */

import { test, expect, type Page, type Route } from '@playwright/test'

const SUPABASE_HOST = 'https://stub.supabase.co'
const SUPABASE_ANON = 'stub-anon-key'

async function injectSupabaseStub(page: Page): Promise<void> {
  await page.addInitScript(
    ({ url, anonKey }) => {
      Object.defineProperty(window, '__SUPABASE_CONFIG__', {
        value: { url, anonKey },
        writable: false,
        configurable: false,
        enumerable: true,
      })
    },
    { url: SUPABASE_HOST, anonKey: SUPABASE_ANON }
  )
}

/**
 * Mock `/auth/v1/sso` with a 404 carrying the given GoTrue `error_code`.
 * Every other Supabase call (e.g. the page's own `getSession()` check on
 * load) is answered with an empty 200 so it doesn't crash the page.
 */
async function mockSignInWithSSOError(page: Page, errorCode: string, msg: string): Promise<void> {
  await page.route(`${SUPABASE_HOST}/**`, async (route: Route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/auth/v1/sso' && route.request().method() === 'POST') {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ msg, error_code: errorCode }),
      })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })
}

test.describe('Login — Sign in with SSO (SMI-6204)', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page)
  })

  test('toggling "Sign in with SSO" reveals the domain form', async ({ page }) => {
    await mockSignInWithSSOError(page, 'sso_provider_not_found', 'unused for this test')
    await page.goto('/login')

    const ssoForm = page.locator('#sso-form')
    await expect(ssoForm).toBeHidden()

    await page.locator('#sso-toggle-btn').click()
    await expect(ssoForm).toBeVisible()
  })

  test('domain with no SSO provider shows the not-found message and points to password login', async ({
    page,
  }) => {
    await mockSignInWithSSOError(
      page,
      'sso_provider_not_found',
      'No SSO provider assigned for this domain'
    )
    await page.goto('/login')

    await page.locator('#sso-toggle-btn').click()
    await page.locator('#sso-domain').fill('no-sso-configured.example')
    await page.locator('#sso-submit-btn').click()

    const errorMessage = page.locator('#sso-error-message')
    await expect(errorMessage).toBeVisible()
    await expect(errorMessage).toContainText('No SSO provider is set up for')
    await expect(errorMessage).toContainText('sign in with your email and password')
  })

  test('domain with a disabled SSO provider shows the admin-contact message', async ({ page }) => {
    await mockSignInWithSSOError(page, 'sso_provider_disabled', 'SSO provider is disabled')
    await page.goto('/login')

    await page.locator('#sso-toggle-btn').click()
    await page.locator('#sso-domain').fill('disabled-sso.example')
    await page.locator('#sso-submit-btn').click()

    const errorMessage = page.locator('#sso-error-message')
    await expect(errorMessage).toBeVisible()
    await expect(errorMessage).toContainText('SSO is currently disabled')
    await expect(errorMessage).toContainText('Contact your team admin')
  })

  test('a full email address is accepted and only the domain is sent', async ({ page }) => {
    let capturedBody: { domain?: string } | null = null
    await page.route(`${SUPABASE_HOST}/**`, async (route: Route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/auth/v1/sso' && route.request().method() === 'POST') {
        capturedBody = route.request().postDataJSON() as { domain?: string }
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({
            msg: 'No SSO provider assigned for this domain',
            error_code: 'sso_provider_not_found',
          }),
        })
        return
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    })
    await page.goto('/login')

    await page.locator('#sso-toggle-btn').click()
    await page.locator('#sso-domain').fill('person@acme.example')
    await page.locator('#sso-submit-btn').click()

    await expect(page.locator('#sso-error-message')).toBeVisible()
    expect(capturedBody).not.toBeNull()
    expect(capturedBody?.domain).toBe('acme.example')
  })
})
