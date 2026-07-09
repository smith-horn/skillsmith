/**
 * cross-harness-inventory.dotfile-guard.spec.ts
 *
 * SMI-5604 — post-merge retro follow-up for SMI-5594 (`.backups` ghost-row fix).
 *
 * SMI-5594 shipped two independent defense layers against a harness-internal
 * dot-prefixed skill_id (e.g. `.backups`) reaching the user's inventory:
 *   1. Ingestion-time: inventory-upload/payload.ts strips dot-prefixed entries
 *      before they reach reconcile_device_inventory (covered by
 *      inventory-upload/index.test.ts's unit tests).
 *   2. Read-time: get_user_inventory()'s `AND (ds.skill_id IS NULL OR
 *      ds.skill_id !~ '^\.')` predicate — a belt-and-suspenders guard against a
 *      *future regression* in layer 1.
 *
 * The post-merge retro (docs/internal/code_review/2026-07-09-smi-5594-backups-
 * ghost-row-fix-retro.md, Finding F1) found layer 2 had zero regression-test
 * coverage anywhere — the existing e2e suite never exercises the read-time
 * predicate because layer 1 already prevents a dot-prefixed skill_id from
 * reaching device_skills through the normal upload path, so there was no way
 * to observe layer 2 doing anything.
 *
 * This spec closes that gap by bypassing layer 1 directly (a service-role
 * INSERT into device_skills via insertDeviceSkillDirect — simulating exactly
 * the "future ingestion bypass" scenario the migration's own comments call
 * out) and asserting layer 2 still keeps the ghost row off /account/skills.
 *
 * Staging-only, same guards as the sibling spec files in this directory.
 */

import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import {
  injectRealSupabase,
  signInTestUser,
  uploadInventory,
  insertDeviceSkillDirect,
  cleanupDevice,
} from './cross-harness-inventory.helpers'
import { getConfig } from './cross-harness-inventory.config'
import { withTimeout, STAGING_CALL_TIMEOUT_MS } from './cross-harness-inventory.timeout'

const runId = process.env['GITHUB_RUN_ID'] ?? 'local'

// Governance Low #2 (see cross-harness-inventory.spec.ts): disable trace so a
// real staging JWT never lands in a Playwright trace artifact.
test.use({ trace: 'off' })

test.describe('Cross-Harness Skill Inventory — dotfile read-time guard (staging)', () => {
  // SMI-5395: inventory flow runs on desktop project only.
  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'SMI-5604: inventory e2e runs on desktop project only'
    )
  })

  test('E: a dot-prefixed skill_id inserted directly (bypassing ingestion) never renders on /account/skills', async ({
    page,
  }) => {
    test.setTimeout(120_000)

    const cfg = getConfig()
    const deviceId = randomUUID()
    const label = `e2e-inv-${runId}-dotguard`
    const realSkillId = `e2e-inv/${runId}-dotguard-real`
    const ghostSkillId = '.backups'

    try {
      // ─── 1. Sign in + push one real skill (establishes the user_devices row) ───
      await injectRealSupabase(page, { url: cfg.supabaseUrl, anonKey: cfg.supabaseAnonKey })
      const { accessToken } = await withTimeout(
        signInTestUser(page, {
          email: cfg.consentOnUserEmail,
          password: cfg.invUserPassword,
        }),
        STAGING_CALL_TIMEOUT_MS,
        'Test E / signInTestUser'
      )

      const { status: uploadStatus, body: uploadBody } = await withTimeout(
        uploadInventory(accessToken, {
          device: { device_id: deviceId, label },
          skills: [{ harness: 'claude-code', skill_id: realSkillId }],
        }),
        STAGING_CALL_TIMEOUT_MS,
        'Test E / uploadInventory (real skill)'
      )
      expect(uploadStatus, `upload status unexpected; body: ${JSON.stringify(uploadBody)}`).toBe(
        200
      )

      // ─── 2. Bypass the ingestion-time strip: insert the ghost row directly ───
      await withTimeout(
        insertDeviceSkillDirect({
          userId: cfg.consentOnUserId,
          deviceId,
          harness: 'claude-code',
          skillId: ghostSkillId,
        }),
        STAGING_CALL_TIMEOUT_MS,
        'Test E / insertDeviceSkillDirect (ghost row)'
      )

      // ─── 3. Reload /account/skills — the read-time predicate must exclude the ghost row ───
      await page.goto(`${cfg.websiteBaseUrl}/account/skills`)
      const card = page.locator('[data-testid="device-card"]').filter({ hasText: label })
      await expect(
        card,
        'device-card should render for the real skill pushed in step 1'
      ).toBeVisible({ timeout: 15_000 })
      await expect(
        card,
        'the directly-inserted dot-prefixed ghost row must never appear on the page — ' +
          "get_user_inventory()'s read-time predicate (SMI-5594) must exclude it even " +
          'though it bypassed the ingestion-time strip'
      ).not.toContainText(ghostSkillId)
    } finally {
      try {
        await cleanupDevice(deviceId)
      } catch {
        /* swallow — best effort; job-level sweep catches orphans */
      }
    }
  })
})
