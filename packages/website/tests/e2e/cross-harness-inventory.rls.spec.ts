/**
 * cross-harness-inventory.rls.spec.ts
 *
 * SMI-5396 (Wave 6) — read-path cross-user RLS isolation for the cross-harness
 * skill inventory. Split out of cross-harness-inventory.spec.ts so each file
 * stays under the 500-line standard; shares the same helpers/config/timeout and
 * the same staging-only guards.
 *
 * Why this exists (plan-review C2): the Wave 5 Tests A-D read user X's rows
 * either via the service-role client (which BYPASSES RLS) or as X itself, so
 * none of them prove that a DIFFERENT signed-in user cannot READ X's rows. This
 * spec closes that gap with real, non-service-role reads:
 *
 *   Test E — user X (consent-ON) pushes a uniquely-tagged skill; user Y (the
 *     consent-OFF user — a distinct auth.users row) reads inventory under their
 *     OWN JWT (the get_user_inventory RPC) and under their OWN session (the
 *     /account/skills page). Neither may surface any of X's rows. This exercises
 *     the *_owner_select policies + the auth.uid() filter in get_user_inventory.
 *     Consent is NOT toggled (the two seed users keep fixed consent across the
 *     suite); Y stays consent-OFF and simply owns no devices.
 *
 * Staging-only: STAGING_SUPABASE_URL must contain `ovhcifugwqnzoebwfuku`.
 * Config/helpers refuse to boot if the prod project ref appears in the URL.
 *
 * Scope: desktop Playwright project only (mirrors the sibling spec).
 */

import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import {
  injectRealSupabase,
  signInTestUser,
  uploadInventory,
  cleanupDevice,
} from './cross-harness-inventory.helpers'
import { getConfig } from './cross-harness-inventory.config'
import { withTimeout, STAGING_CALL_TIMEOUT_MS } from './cross-harness-inventory.timeout'

// Run-scoped label namespace (mirrors the sibling spec): every test mints a
// fresh device_id and an e2e-inv-<runId>-<tag> label so the job-level defensive
// DELETE (scoped to LIKE 'e2e-inv-<github.run_id>-%') sweeps any orphans.
const runId = process.env['GITHUB_RUN_ID'] ?? 'local'

// Disable Playwright trace: signInTestUser transplants a real staging session,
// so trace network snapshots would capture the test user's JWT in Authorization
// headers and land in the uploaded artifact (governance Low #2, mirrors sibling).
test.use({ trace: 'off' })

test.describe('Cross-Harness Skill Inventory — RLS isolation (staging)', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'SMI-5396: inventory RLS e2e runs on desktop project only'
    )
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Test E — read-path cross-user RLS isolation (SMI-5396 C2)
  // ──────────────────────────────────────────────────────────────────────────
  test('E: user Y cannot read user X inventory via RPC or page (RLS isolation)', async ({
    page,
  }) => {
    test.setTimeout(120_000)

    const cfg = getConfig()
    const deviceId = randomUUID()
    const label = `e2e-inv-${runId}-e`
    const secretSkillId = `e2e-inv/${runId}-e-secret`

    try {
      // ─── 1. User X (consent-ON) pushes a uniquely-tagged skill (node-side) ───
      const xClient = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      const { data: xData, error: xErr } = await withTimeout(
        xClient.auth.signInWithPassword({
          email: cfg.consentOnUserEmail,
          password: cfg.invUserPassword,
        }),
        STAGING_CALL_TIMEOUT_MS,
        'Test E / signInWithPassword (X)'
      )
      if (xErr || !xData.session) {
        throw new Error(`[SMI-5396] Test E: X sign-in failed: ${xErr?.message ?? 'no session'}`)
      }
      const { status: upStatus, body: upBody } = await withTimeout(
        uploadInventory(xData.session.access_token, {
          device: {
            device_id: deviceId,
            label,
            platform: 'darwin',
            arch: 'arm64',
            cli_version: '0.0.0-e2e',
          },
          skills: [{ harness: 'claude-code', skill_id: secretSkillId }],
        }),
        STAGING_CALL_TIMEOUT_MS,
        'Test E / uploadInventory (X)'
      )
      expect(upStatus, `X upload status; body: ${JSON.stringify(upBody)}`).toBe(200)
      expect((upBody as Record<string, unknown>)['applied']).toBe(true)

      // ─── 2. User Y reads get_user_inventory under their OWN JWT ───
      // get_user_inventory (migration 20260626000001) is LANGUAGE sql filtering
      // ONLY on `WHERE d.user_id = auth.uid()` — it does NOT gate reads on
      // inventory_sync_enabled (consent gates writes, not reads), so Y's empty
      // result is due to the auth.uid() filter, not consent suppression. Y is a
      // distinct auth.users row and owns no devices, so Y must see none of X's
      // rows; a broken filter would leak them.
      const yClient = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      const { data: yData, error: yErr } = await withTimeout(
        yClient.auth.signInWithPassword({
          email: cfg.consentOffUserEmail,
          password: cfg.invUserPassword,
        }),
        STAGING_CALL_TIMEOUT_MS,
        'Test E / signInWithPassword (Y)'
      )
      if (yErr || !yData.session) {
        throw new Error(`[SMI-5396] Test E: Y sign-in failed: ${yErr?.message ?? 'no session'}`)
      }
      const { data: yRows, error: yRpcErr } = await withTimeout(
        yClient.rpc('get_user_inventory'),
        STAGING_CALL_TIMEOUT_MS,
        'Test E / get_user_inventory (Y)'
      )
      expect(yRpcErr, `Y get_user_inventory errored: ${yRpcErr?.message ?? ''}`).toBeNull()
      const yResult = (yRows ?? []) as Array<Record<string, unknown>>
      // Core isolation assertion: none of X's identifiers appear in Y's read.
      expect(
        yResult.some((r) => r['device_id'] === deviceId),
        "Y's inventory must not contain X's device_id (RLS read isolation)"
      ).toBe(false)
      expect(
        yResult.some((r) => r['skill_id'] === secretSkillId),
        "Y's inventory must not contain X's secret skill_id (RLS read isolation)"
      ).toBe(false)

      // ─── 2b. Direct PostgREST table read as Y — exercises the *_owner_select
      // RLS POLICIES directly (get_user_inventory is SECURITY DEFINER and
      // self-filters on auth.uid(); the table policies protect direct REST
      // reads). X's row EXISTS and is owned by X, so a correct policy returns it
      // to nobody but X. Either RLS filters it to [] or the authenticated role
      // lacks direct table SELECT — both mean "no leak"; the ONLY failure is X's
      // row appearing in Y's direct read, which would be a real RLS regression.
      const { data: yDirect } = await withTimeout(
        yClient.from('device_skills').select('device_id, skill_id').eq('device_id', deviceId),
        STAGING_CALL_TIMEOUT_MS,
        'Test E / direct device_skills read (Y)'
      )
      const directRows = (yDirect ?? []) as Array<Record<string, unknown>>
      expect(
        directRows.some((r) => r['device_id'] === deviceId),
        "Y's direct device_skills read must not leak X's row (RLS *_owner_select policy)"
      ).toBe(false)

      // ─── 3. Browser: Y's /account/skills must not render X's card ───
      await injectRealSupabase(page, { url: cfg.supabaseUrl, anonKey: cfg.supabaseAnonKey })
      await withTimeout(
        signInTestUser(page, {
          email: cfg.consentOffUserEmail,
          password: cfg.invUserPassword,
        }),
        STAGING_CALL_TIMEOUT_MS,
        'Test E / signInTestUser (Y, page)'
      )
      await page.goto(`${cfg.websiteBaseUrl}/account/skills`)
      // The page may legitimately render an empty state for Y; the invariant is
      // simply that X's uniquely-tagged skill never appears anywhere on Y's page.
      await expect(
        page.locator('[data-testid="device-card"]').filter({ hasText: secretSkillId }),
        "Y's /account/skills must not render any device-card containing X's secret skill"
      ).toHaveCount(0)
      await expect(
        page.getByText(secretSkillId, { exact: false }),
        "X's secret skill_id must not appear anywhere on Y's page"
      ).toHaveCount(0)
    } finally {
      try {
        await cleanupDevice(deviceId)
      } catch {
        /* swallow — best effort; job-level sweep catches orphans */
      }
    }
  })
})
