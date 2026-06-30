/**
 * cross-harness-inventory.spec.ts
 *
 * SMI-5395 — Cross-harness skill inventory staging e2e (Wave 5 hard gate).
 *
 * Four serial tests exercise the full stack against staging Supabase
 * (no mocks for the surfaces under test — see retro lesson #5: "mocks lie
 * consistently"):
 *
 *   Test A — happy-path round-trip + M6 inline negative control
 *     Push a synthetic device inventory → DB row confirmed via service-role →
 *     /account/skills renders the device card + unknown badge (consent-ON user).
 *
 *   Test B — drift join-key validation (M1/L2, deterministic)
 *     Seed a synthetic registry skill; push matching hash → current badge;
 *     re-push with a mutated hash → drifted badge. Teardown removes both.
 *
 *   Test C — consent + auth negatives (H4)
 *     Consent-OFF user → upload returns applied:false, reason:consent_disabled,
 *     zero DB rows. No Authorization header → gateway 401 (status only, H4).
 *
 *   Test D — concurrent-push PK safety (M2)
 *     Two identical uploadInventory calls in Promise.all; asserts no 23505 /
 *     duplicate-key and all skills present=true.
 *
 * Read-path cross-user RLS isolation (Test E, SMI-5396 C2) lives in the sibling
 * cross-harness-inventory.rls.spec.ts (split out to keep each file under 500).
 *
 * Staging-only: STAGING_SUPABASE_URL must contain `ovhcifugwqnzoebwfuku`.
 * Config/helpers refuse to boot if the prod project ref appears in the URL.
 *
 * Scope: desktop Playwright project only (mobile/WebKit adds no coverage for
 * the inventory push path; CI runner installs chromium only — L5).
 */

import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import {
  injectRealSupabase,
  signInTestUser,
  uploadInventory,
  readDeviceSkills,
  seedRegistrySkill,
  deleteRegistrySkill,
  cleanupDevice,
  readUserConsent,
} from './cross-harness-inventory.helpers'
import { getConfig } from './cross-harness-inventory.config'
import { withTimeout, STAGING_CALL_TIMEOUT_MS } from './cross-harness-inventory.timeout'

// ─── Run-scoped label namespace (H5, P2-1) ───────────────────────────────
//
// runId is injected by the workflow as GITHUB_RUN_ID; locally it falls back
// to 'local'. Every test mints a fresh device_id (UUID) and a label under
// the e2e-inv-<runId>-<tag> namespace so set-reconciliation in one test
// cannot mark another's skill absent (H5). The job-level defensive DELETE
// is scoped to LIKE 'e2e-inv-<github.run_id>-%' (P2-1).
const runId = process.env['GITHUB_RUN_ID'] ?? 'local'

// Governance Low #2: disable Playwright trace for this spec. signInTestUser
// transplants a real staging session, so trace network snapshots would capture
// the test user's JWT in Authorization headers and land in the uploaded
// artifact. Screenshots (only-on-failure — images, no token text) remain for
// debugging; re-enable trace locally when investigating a failure.
test.use({ trace: 'off' })

test.describe('Cross-Harness Skill Inventory (staging)', () => {
  test.describe.configure({ mode: 'serial' })

  // SMI-5395: inventory flow runs on desktop project only (mirrors device-login
  // pattern; iPhone viewport + WebKit provide no additional coverage here).
  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'SMI-5395: inventory e2e runs on desktop project only'
    )
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Test A — happy-path round-trip + M6 inline negative control
  // ──────────────────────────────────────────────────────────────────────────
  test('A: push → device_skills row → /account/skills card renders (consent-ON)', async ({
    page,
  }) => {
    test.setTimeout(120_000)

    const cfg = getConfig()
    const deviceId = randomUUID()
    const label = `e2e-inv-${runId}-a`
    const skillId = `e2e-inv/${runId}-unknown`

    try {
      // ─── 1. Sign in consent-ON user + capture accessToken ───
      await injectRealSupabase(page, { url: cfg.supabaseUrl, anonKey: cfg.supabaseAnonKey })
      const { accessToken } = await withTimeout(
        signInTestUser(page, {
          email: cfg.consentOnUserEmail,
          password: cfg.invUserPassword,
        }),
        STAGING_CALL_TIMEOUT_MS,
        'Test A / signInTestUser'
      )

      // ─── 2. Pre-condition: no device-card for this run's label yet (M6) ───
      await page.goto(`${cfg.websiteBaseUrl}/account/skills`)
      await expect(
        page.locator('[data-testid="device-card"]').filter({ hasText: label }),
        'Pre-condition: no device-card for this run label should exist before push (M6)'
      ).not.toBeVisible()

      // ─── 3. Upload inventory ───
      const { status: uploadStatus, body: uploadBody } = await withTimeout(
        uploadInventory(accessToken, {
          device: {
            device_id: deviceId,
            label,
            platform: 'darwin',
            arch: 'arm64',
            cli_version: '0.0.0-e2e',
          },
          skills: [{ harness: 'claude-code', skill_id: skillId }],
        }),
        STAGING_CALL_TIMEOUT_MS,
        'Test A / uploadInventory'
      )

      expect(uploadStatus, `upload status unexpected; body: ${JSON.stringify(uploadBody)}`).toBe(
        200
      )
      const b = uploadBody as Record<string, unknown>
      expect(b['ok']).toBe(true)
      expect(b['applied']).toBe(true)
      expect(b['device_id']).toBe(deviceId)
      expect(b['skills_present']).toBe(1)
      expect(b['skills_absent']).toBe(0)

      // ─── 4. Service-role DB verification ───
      const rows = await withTimeout(
        readDeviceSkills(deviceId),
        STAGING_CALL_TIMEOUT_MS,
        'Test A / readDeviceSkills'
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]!.present).toBe(true)
      expect(rows[0]!.skill_id).toBe(skillId)

      // ─── 5. Assert consent-ON user's prefs are seeded correctly (H7) ───
      const consentOn = await withTimeout(
        readUserConsent(cfg.consentOnUserId),
        STAGING_CALL_TIMEOUT_MS,
        'Test A / readUserConsent'
      )
      expect(
        consentOn,
        'consent-ON user must have inventory_sync_enabled=true (H7 — seed-e2e-inventory-users.ts)'
      ).toBe(true)

      // ─── 6. Browser render: reload page and assert card + badge ───
      // Locate the card by filtering on the unique skill_id text (M5).
      await page.goto(`${cfg.websiteBaseUrl}/account/skills`)
      const card = page.locator('[data-testid="device-card"]').filter({ hasText: skillId })
      await expect(card, 'device-card for this run should be visible after push').toBeVisible({
        timeout: 15_000,
      })
      // SMI-5442: an unmatched skill_id with no declared provenance now resolves
      // to 'local' (was the flat 'unknown'). 'unknown' is no longer emitted by
      // get_user_inventory.
      await expect(
        card.locator('[data-testid="skill-badge"][data-state="local"]'),
        'skill badge should show data-state="local" for an unmatched skill_id with no provenance (SMI-5442)'
      ).toBeVisible()
    } finally {
      try {
        await cleanupDevice(deviceId)
      } catch {
        /* swallow — best effort; job-level sweep catches orphans */
      }
    }
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Test B — drift join-key validation (M1/L2, deterministic)
  // ──────────────────────────────────────────────────────────────────────────
  test('B: registry hash match → current; mutated hash → drifted (consent-ON)', async ({
    page,
  }) => {
    test.setTimeout(120_000)

    const cfg = getConfig()
    const deviceId = randomUUID()
    const label = `e2e-inv-${runId}-b`
    const skillName = `${runId}-b`
    const author = 'e2e-inv'
    // skill_id produced by the join key (author||'/'||name)
    const skillId = `${author}/${skillName}`
    // 64-hex content hash for a "known" install (L2: no pinned_version so
    // the skill_state CASE reaches current/drifted, not pinned/unknown)
    const H = 'a'.repeat(64)

    let seedDone = false
    try {
      // ─── 1. Seed a synthetic registry skill (M1) ───
      await withTimeout(
        seedRegistrySkill({ author, name: skillName, contentHash: H }),
        STAGING_CALL_TIMEOUT_MS,
        'Test B / seedRegistrySkill'
      )
      seedDone = true

      // ─── 2. Sign in consent-ON user ───
      await injectRealSupabase(page, { url: cfg.supabaseUrl, anonKey: cfg.supabaseAnonKey })
      const { accessToken } = await withTimeout(
        signInTestUser(page, {
          email: cfg.consentOnUserEmail,
          password: cfg.invUserPassword,
        }),
        STAGING_CALL_TIMEOUT_MS,
        'Test B / signInTestUser'
      )

      // ─── 3. Push with matching hash → expect "current" badge ───
      const { status: s1, body: b1 } = await withTimeout(
        uploadInventory(accessToken, {
          device: { device_id: deviceId, label },
          skills: [
            { harness: 'claude-code', skill_id: skillId, version: '1.0.0', content_hash: H },
          ],
        }),
        STAGING_CALL_TIMEOUT_MS,
        'Test B / uploadInventory (matching hash)'
      )
      expect(s1, `first upload status; body: ${JSON.stringify(b1)}`).toBe(200)
      expect((b1 as Record<string, unknown>)['applied']).toBe(true)

      await page.goto(`${cfg.websiteBaseUrl}/account/skills`)
      const cardCurrent = page.locator('[data-testid="device-card"]').filter({ hasText: skillId })
      await expect(cardCurrent).toBeVisible({ timeout: 15_000 })
      await expect(
        cardCurrent.locator('[data-testid="skill-badge"][data-state="current"]'),
        'badge should be "current" when installed hash matches the registry hash'
      ).toBeVisible()

      // ─── 4. Re-push with a mutated hash → expect "drifted" badge (L2) ───
      // Flip the last hex character to produce H' (one byte different).
      const HPrime = H.slice(0, -1) + 'b'
      const { status: s2, body: b2 } = await withTimeout(
        uploadInventory(accessToken, {
          device: { device_id: deviceId, label },
          skills: [
            {
              harness: 'claude-code',
              skill_id: skillId,
              version: '1.0.0',
              content_hash: HPrime,
            },
          ],
        }),
        STAGING_CALL_TIMEOUT_MS,
        'Test B / uploadInventory (mutated hash)'
      )
      expect(s2, `second upload status; body: ${JSON.stringify(b2)}`).toBe(200)
      expect((b2 as Record<string, unknown>)['applied']).toBe(true)

      await page.goto(`${cfg.websiteBaseUrl}/account/skills`)
      const cardDrifted = page.locator('[data-testid="device-card"]').filter({ hasText: skillId })
      await expect(cardDrifted).toBeVisible({ timeout: 15_000 })
      await expect(
        cardDrifted.locator('[data-testid="skill-badge"][data-state="drifted"]'),
        'badge should be "drifted" when installed hash differs from the registry hash'
      ).toBeVisible()
    } finally {
      try {
        await cleanupDevice(deviceId)
      } catch {
        /* swallow */
      }
      if (seedDone) {
        try {
          await deleteRegistrySkill({ author, name: skillName })
        } catch {
          /* swallow */
        }
      }
    }
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Test C — consent + auth negatives (H4)
  // ──────────────────────────────────────────────────────────────────────────
  test('C: consent-OFF → applied:false; no Authorization → 401', async () => {
    test.setTimeout(120_000)

    const cfg = getConfig()
    const deviceId = randomUUID()
    const label = `e2e-inv-${runId}-c`
    const skillId = `e2e-inv/${runId}-c-skill`

    try {
      // ─── C.1: consent-OFF user ───
      // Sign in from node (no page render needed for this subtest).
      const offClient = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      const { data: offData, error: offError } = await withTimeout(
        offClient.auth.signInWithPassword({
          email: cfg.consentOffUserEmail,
          password: cfg.invUserPassword,
        }),
        STAGING_CALL_TIMEOUT_MS,
        'Test C / signInWithPassword (consent-OFF)'
      )
      if (offError || !offData.session) {
        throw new Error(
          `[SMI-5395] Test C: consent-OFF sign-in failed: ${offError?.message ?? 'no session'}`
        )
      }
      const offToken = offData.session.access_token

      const { status: offStatus, body: offBody } = await withTimeout(
        uploadInventory(offToken, {
          device: { device_id: deviceId, label },
          skills: [{ harness: 'claude-code', skill_id: skillId }],
        }),
        STAGING_CALL_TIMEOUT_MS,
        'Test C / uploadInventory (consent-OFF)'
      )
      expect(
        offStatus,
        `consent-OFF upload should return 200; body: ${JSON.stringify(offBody)}`
      ).toBe(200)
      const ob = offBody as Record<string, unknown>
      expect(ob['ok']).toBe(true)
      expect(ob['applied']).toBe(false)
      expect(ob['reason']).toBe('consent_disabled')

      // Service-role confirms zero rows written
      const rows = await withTimeout(
        readDeviceSkills(deviceId),
        STAGING_CALL_TIMEOUT_MS,
        'Test C / readDeviceSkills (consent-OFF)'
      )
      expect(rows, 'consent-OFF upload must write zero device_skills rows').toHaveLength(0)

      // ─── C.2: no Authorization header → 401 (H4) ───
      // The gateway 401s before the fn runs when the JWT is absent; no body
      // shape assertion — the function body is unreachable (H4).
      const noAuthRes = await withTimeout(
        fetch(`${cfg.supabaseUrl}/functions/v1/inventory-upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: cfg.supabaseAnonKey,
            // Authorization header intentionally omitted
          },
          body: JSON.stringify({
            device: { device_id: randomUUID(), label: `${label}-noauth` },
            skills: [{ harness: 'claude-code', skill_id: skillId }],
          }),
        }),
        STAGING_CALL_TIMEOUT_MS,
        'Test C / fetch (no Authorization)'
      )
      expect(
        noAuthRes.status,
        'POST with apikey but no Authorization must return 401 (gateway rejects before fn runs, H4)'
      ).toBe(401)
    } finally {
      try {
        // consent-OFF user should have zero rows; defensive cleanup only
        await cleanupDevice(deviceId)
      } catch {
        /* swallow */
      }
    }
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Test D — concurrent-push PK safety (M2)
  // ──────────────────────────────────────────────────────────────────────────
  test('D: concurrent identical uploads — no 23505, all skills present=true', async () => {
    test.setTimeout(120_000)

    const cfg = getConfig()
    const deviceId = randomUUID()
    const label = `e2e-inv-${runId}-d`

    try {
      // Sign in consent-ON user from node (no page render needed).
      const onClient = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      const { data, error } = await withTimeout(
        onClient.auth.signInWithPassword({
          email: cfg.consentOnUserEmail,
          password: cfg.invUserPassword,
        }),
        STAGING_CALL_TIMEOUT_MS,
        'Test D / signInWithPassword'
      )
      if (error || !data.session) {
        throw new Error(`[SMI-5395] Test D: sign-in failed: ${error?.message ?? 'no session'}`)
      }
      const tok = data.session.access_token

      // Fire two identical uploads concurrently (M2 — identical sets so PK
      // conflict handling is exercised without interleaving-ordering sensitivity).
      const skills = [
        { harness: 'claude-code', skill_id: `e2e-inv/${runId}-d1` },
        { harness: 'claude-code', skill_id: `e2e-inv/${runId}-d2` },
      ]
      const payload = { device: { device_id: deviceId, label }, skills }

      const [r1, r2] = await withTimeout(
        Promise.all([uploadInventory(tok, payload), uploadInventory(tok, payload)]),
        // Give both calls STAGING_CALL_TIMEOUT_MS each plus a small buffer
        STAGING_CALL_TIMEOUT_MS * 2 + 2_000,
        'Test D / Promise.all uploadInventory x2'
      )

      // Neither response should be an HTTP server error
      expect(
        r1.status,
        `first concurrent upload status unexpected; body: ${JSON.stringify(r1.body)}`
      ).toBeLessThan(500)
      expect(
        r2.status,
        `second concurrent upload status unexpected; body: ${JSON.stringify(r2.body)}`
      ).toBeLessThan(500)

      // No 23505 / duplicate-key error in either body
      const body1Str = JSON.stringify(r1.body)
      const body2Str = JSON.stringify(r2.body)
      expect(body1Str, 'first upload body must not contain duplicate key error').not.toMatch(
        /23505|duplicate key/
      )
      expect(body2Str, 'second upload body must not contain duplicate key error').not.toMatch(
        /23505|duplicate key/
      )

      // Both skills must be present=true after the concurrent push
      const rows = await withTimeout(
        readDeviceSkills(deviceId),
        STAGING_CALL_TIMEOUT_MS,
        'Test D / readDeviceSkills'
      )
      const presentRows = rows.filter((r) => r.present === true)
      expect(
        presentRows,
        'all skills must be present=true after concurrent identical pushes'
      ).toHaveLength(2)
      const skillIds = presentRows.map((r) => r.skill_id).sort()
      expect(skillIds).toEqual([`e2e-inv/${runId}-d1`, `e2e-inv/${runId}-d2`].sort())
    } finally {
      try {
        await cleanupDevice(deviceId)
      } catch {
        /* swallow */
      }
    }
  })
})
