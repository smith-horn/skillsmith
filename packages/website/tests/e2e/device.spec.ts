/**
 * device.spec.ts
 *
 * SMI-4454 — /device preview state shows CLI identity (version, platform, hostname)
 *
 * Covers:
 *   D-1: populated meta → CLI, Platform, Host rows render formatted values
 *   D-2: all-null meta (pre-migration-082 code) → all rows render em-dash
 *   D-3: preview endpoint returns 404 → page lands on expired state, no preview flash
 *   D-4: preview endpoint network failure → graceful degrade to preview with em-dashes
 *   D-5: XSS smoke — hostname with HTML tags renders as literal text (textContent, not innerHTML)
 *
 * Mocks Supabase via the shared complete-profile.helpers.ts infrastructure so no
 * staging / prod network calls are made. Tests run against the Astro preview
 * server (port 4321).
 */

import { test, expect } from '@playwright/test'
import { buildSessionToken, injectSupabaseStub, mockSupabase } from './complete-profile.helpers'

const DEVICE_URL = '/device?user_code=BCDFGHJK'

const POPULATED_META = {
  client_type: 'cli',
  cli_version: '0.4.12',
  node_version: 'v22.21.1',
  platform: 'darwin',
  arch: 'arm64',
  hostname: 'MacBook-Pro-10.local',
  created_at: '2026-04-24T12:00:00Z',
}

const NULL_META = {
  client_type: 'cli',
  cli_version: null,
  node_version: null,
  platform: null,
  arch: null,
  hostname: null,
  created_at: null,
}

test.describe('D-1 — populated preview meta', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page, { session: buildSessionToken({ provider: 'email' }) })
  })

  test('renders CLI version, platform+arch+node, and hostname', async ({ page }) => {
    await mockSupabase(page, {
      functionsResponses: {
        'auth-device-preview': { status: 200, body: POPULATED_META },
      },
    })
    await page.goto(DEVICE_URL)

    // Preview state visible
    await expect(page.locator('#state-preview')).toBeVisible()
    await expect(page.locator('#state-expired')).toBeHidden()

    await expect(page.locator('#meta-cli')).toHaveText('Skillsmith CLI v0.4.12')
    await expect(page.locator('#meta-platform')).toHaveText('darwin arm64 · node v22.21.1')
    await expect(page.locator('#meta-hostname')).toHaveText('MacBook-Pro-10.local')
  })
})

test.describe('D-2 — all-null meta (pre-migration-082 code)', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page, { session: buildSessionToken({ provider: 'email' }) })
  })

  test('renders em-dash in all three rows', async ({ page }) => {
    await mockSupabase(page, {
      functionsResponses: {
        'auth-device-preview': { status: 200, body: NULL_META },
      },
    })
    await page.goto(DEVICE_URL)

    await expect(page.locator('#state-preview')).toBeVisible()

    await expect(page.locator('#meta-cli')).toHaveText('—')
    await expect(page.locator('#meta-platform')).toHaveText('—')
    await expect(page.locator('#meta-hostname')).toHaveText('—')
  })
})

test.describe('D-3 — preview endpoint 404 (expired/missing code)', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page, { session: buildSessionToken({ provider: 'email' }) })
  })

  test('lands on expired state, no preview flash', async ({ page }) => {
    await mockSupabase(page, {
      functionsResponses: {
        'auth-device-preview': { status: 404, body: { error: 'not_found' } },
      },
    })
    await page.goto(DEVICE_URL)

    await expect(page.locator('#state-expired')).toBeVisible()
    await expect(page.locator('#state-preview')).toBeHidden()
  })
})

test.describe('D-4 — preview endpoint network failure', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page, { session: buildSessionToken({ provider: 'email' }) })
  })

  test('graceful degrade: preview state visible with em-dash rows', async ({ page }) => {
    // Stub default Supabase routes so the page boots cleanly, then override
    // the preview endpoint with an abort to simulate a network failure.
    await mockSupabase(page, {})
    await page.route('**/functions/v1/auth-device-preview', (route) => route.abort('failed'))

    await page.goto(DEVICE_URL)

    await expect(page.locator('#state-preview')).toBeVisible()
    await expect(page.locator('#meta-cli')).toHaveText('—')
    await expect(page.locator('#meta-platform')).toHaveText('—')
    await expect(page.locator('#meta-hostname')).toHaveText('—')
  })
})

test.describe('D-5 — XSS smoke (textContent, not innerHTML)', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page, { session: buildSessionToken({ provider: 'email' }) })
  })

  test('hostname containing HTML tags renders as literal text', async ({ page }) => {
    await mockSupabase(page, {
      functionsResponses: {
        'auth-device-preview': {
          status: 200,
          body: {
            ...POPULATED_META,
            hostname: '<img src=x onerror=alert(1)>',
          },
        },
      },
    })
    await page.goto(DEVICE_URL)

    const hostEl = page.locator('#meta-hostname')
    // Literal-string match — proves textContent path (innerHTML would strip/render tag).
    await expect(hostEl).toHaveText('<img src=x onerror=alert(1)>')
    // And no child <img> was materialised.
    await expect(hostEl.locator('img')).toHaveCount(0)
  })
})
