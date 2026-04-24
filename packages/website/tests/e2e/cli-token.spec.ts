/**
 * cli-token.spec.ts
 *
 * SMI-4447 — /account/cli-token auto-detect existing active key
 * SMI-4441 — /account/cli-token regenerate-license error-copy hygiene (bundled)
 *
 * Covers the three detection scenarios from the plan (Step 5):
 *   T-1: user has a key named 'CLI Token' → revoke-regen card rendered
 *   T-2: user has a legacy key named 'default' → revoke-regen card + origin-note + name label
 *   T-3: user has zero active keys → Generate CLI Token CTA rendered
 *
 * Plus:
 *   T-4: tier-limit race (400 with current/max/tier) → inline Refresh button surfaced
 *   T-5: regenerate-license payload-shape failure → ERR- reference + /contact link (SMI-4441)
 *   T-6: regenerate-license JSON-parse failure → PARSE- reference + /contact link (SMI-4441)
 *
 * Mocks Supabase via the shared complete-profile.helpers.ts infrastructure so no
 * staging / prod network calls are made (prod ref vrcnzpmndtroqxxoqkzy — see
 * CLAUDE.md). Tests run against the Astro preview server (port 4321).
 */

import { test, expect } from '@playwright/test'
import { buildSessionToken, injectSupabaseStub, mockSupabase } from './complete-profile.helpers'

const CLI_TOKEN_URL = '/account/cli-token'

const LICENSE_ROW_CLI_TOKEN = {
  id: '11111111-1111-1111-1111-111111111111',
  key_prefix: 'sk_live_abcdef',
  name: 'CLI Token',
  tier: 'community',
  created_at: '2026-04-01T00:00:00Z',
  last_used_at: null,
}

const LICENSE_ROW_LEGACY_DEFAULT = {
  id: '22222222-2222-2222-2222-222222222222',
  key_prefix: 'sk_live_123456',
  name: 'default',
  tier: 'community',
  created_at: '2026-01-15T00:00:00Z',
  last_used_at: '2026-04-20T12:00:00Z',
}

const PROFILE_ROW = {
  tier: 'community',
  profile_grace_until: null,
  profile_completed_at: '2026-04-24T00:00:00Z',
}

test.describe('T-1 — existing "CLI Token"-named key', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page, { session: buildSessionToken({ provider: 'email' }) })
  })

  test('renders revoke-regen card; no origin-note; name label at default weight', async ({
    page,
  }) => {
    await mockSupabase(page, {
      restResponses: {
        profiles: [PROFILE_ROW],
        license_keys: [LICENSE_ROW_CLI_TOKEN],
      },
    })
    await page.goto(CLI_TOKEN_URL)

    await expect(page.getByRole('heading', { name: 'Your CLI token is live' })).toBeVisible()
    await expect(page.locator('.key-origin-note')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Revoke & regenerate/ })).toBeVisible()

    // <dl> semantic markup — SR-friendly labeled property.
    const nameDl = page.locator('.key-name-dl')
    await expect(nameDl).toBeVisible()
    await expect(nameDl.locator('dt')).toHaveText('Name')
    await expect(nameDl.locator('dd')).toHaveText('CLI Token')
    await expect(nameDl).toHaveClass(/name-default/)
  })
})

test.describe('T-2 — legacy "default"-named key (pre-migration-080 trigger)', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page, { session: buildSessionToken({ provider: 'github' }) })
  })

  test('renders revoke-regen card, origin-note visible, name label at legacy weight', async ({
    page,
  }) => {
    await mockSupabase(page, {
      restResponses: {
        profiles: [PROFILE_ROW],
        license_keys: [LICENSE_ROW_LEGACY_DEFAULT],
      },
    })
    await page.goto(CLI_TOKEN_URL)

    await expect(page.getByRole('heading', { name: 'Your CLI token is live' })).toBeVisible()
    await expect(page.locator('.key-origin-note')).toBeVisible()
    await expect(page.locator('.key-origin-note')).toContainText('auto-generated this key')

    const nameDl = page.locator('.key-name-dl')
    await expect(nameDl.locator('dd')).toHaveText('default')
    await expect(nameDl).toHaveClass(/name-legacy/)

    await expect(page.getByRole('button', { name: /Revoke & regenerate/ })).toBeVisible()
  })
})

test.describe('T-3 — zero active keys', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page, { session: buildSessionToken({ provider: 'email' }) })
  })

  test('renders Generate CLI Token CTA; no keys-section, no origin-note', async ({ page }) => {
    await mockSupabase(page, {
      restResponses: {
        profiles: [PROFILE_ROW],
        license_keys: [],
      },
    })
    await page.goto(CLI_TOKEN_URL)

    await expect(page.getByRole('button', { name: 'Generate CLI Token' })).toBeVisible()
    await expect(page.locator('.keys-section')).toHaveCount(0)
    await expect(page.locator('.key-origin-note')).toHaveCount(0)
  })
})

test.describe('T-4 — tier-limit race (SMI-4447 §3)', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page, { session: buildSessionToken({ provider: 'email' }) })
  })

  test('400 with current/max/tier surfaces friendly copy + inline Refresh button', async ({
    page,
  }) => {
    await mockSupabase(page, {
      restResponses: {
        profiles: [PROFILE_ROW],
        license_keys: [],
      },
      functionsResponses: {
        'generate-license': {
          status: 400,
          body: {
            error: 'Maximum 1 active key(s) allowed for community tier',
            current: 1,
            max: 1,
            tier: 'community',
          },
        },
      },
    })
    await page.goto(CLI_TOKEN_URL)

    await page.getByRole('button', { name: 'Generate CLI Token' }).click()

    const err = page.locator('#generate-error')
    await expect(err).toBeVisible()
    await expect(err).toContainText('Looks like a key was added from another tab')
    await expect(err.getByRole('button', { name: 'Refresh' })).toBeVisible()
    // Raw API message must NOT leak to the user.
    await expect(err).not.toContainText('Maximum 1 active key(s)')
  })
})

test.describe('T-5 / T-6 — regenerate-license error copy (SMI-4441)', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page, { session: buildSessionToken({ provider: 'email' }) })
  })

  test('payload-shape failure shows ERR- reference + contact link (no reload copy)', async ({
    page,
  }) => {
    await mockSupabase(page, {
      restResponses: {
        profiles: [PROFILE_ROW],
        license_keys: [LICENSE_ROW_CLI_TOKEN],
      },
      functionsResponses: {
        'regenerate-license': { status: 200, body: {} }, // missing key + key_prefix
      },
    })
    await page.goto(CLI_TOKEN_URL)

    await page.getByRole('button', { name: /Revoke & regenerate/ }).click()
    await page.getByRole('button', { name: 'Confirm' }).click()

    const status = page.locator('#regen-status')
    await expect(status).toContainText('Contact support')
    await expect(status.locator('code')).toContainText(/^ERR-[0-9a-f]{8}$/)
    await expect(status).not.toContainText('reload the page')
    await expect(status.getByRole('link', { name: 'Contact support' })).toHaveAttribute(
      'href',
      '/contact?topic=cli-token'
    )
  })

  test('JSON-parse failure shows PARSE- reference + contact link', async ({ page }) => {
    // Return non-JSON body to trip the catch branch.
    await mockSupabase(page, {
      restResponses: {
        profiles: [PROFILE_ROW],
        license_keys: [LICENSE_ROW_CLI_TOKEN],
      },
    })
    await page.route('**/functions/v1/regenerate-license', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: 'not-json-at-all',
      })
    })
    await page.goto(CLI_TOKEN_URL)

    await page.getByRole('button', { name: /Revoke & regenerate/ }).click()
    await page.getByRole('button', { name: 'Confirm' }).click()

    const status = page.locator('#regen-status')
    await expect(status).toContainText('Contact support')
    await expect(status.locator('code')).toContainText(/^PARSE-[0-9a-f]{8}$/)
    await expect(status).not.toContainText('reload the page')
  })
})
