/**
 * cross-harness-inventory.contrast.spec.ts
 *
 * SMI-6503 — rendered WCAG AA contrast regression for the /account/skills
 * device cards, against staging.
 *
 * Why a browser test and not a unit test: the regression this guards was a
 * COMPOSITING failure. `.device-card--stale` carried `opacity: .72`, which
 * renders the card's whole subtree into an offscreen buffer and composites it
 * at 72% — costing every colour on the card about a third of its contrast and
 * pushing six of eight text elements under AA. Every declared value in the
 * stylesheet still looked compliant, so no amount of string or AST assertion
 * could see it. Only computed styles on a rendered page can.
 *
 * The sibling unit tests in skills-page-render.contrast.test.ts assert the
 * declarations; this asserts what the browser actually paints. Both are needed
 * and neither substitutes for the other.
 *
 * Seeds a STALE device specifically: a fresh card cannot reproduce the bug, so
 * a test that seeds only fresh devices would pass against the very defect it
 * exists to catch.
 *
 * Readiness contract before measuring (all must hold, else hard failure):
 *   - the exact seeded device-card count is present, not merely > 0
 *   - at least one card is `.device-card--stale`
 *   - both seeded harness groups have rendered
 *   - document.fonts.ready has resolved
 * and after measuring:
 *   - scannedTextNodes > 0    (an empty scan yields zero failures, which is
 *                              otherwise indistinguishable from success)
 *   - staleCards > 0
 *
 * The contrast maths lives in cross-harness-inventory.contrast-probe.ts and is
 * unit-tested against known ratios in tests/contrast-probe.test.ts — including
 * the group-opacity case. A checker exercised only by the page it checks cannot
 * tell "the page passes" from "the checker is broken".
 *
 * Staging-only: STAGING_SUPABASE_URL must contain `ovhcifugwqnzoebwfuku`.
 * Config/helpers refuse to boot if the prod project ref appears in the URL.
 *
 * Scope: desktop Playwright project only (mirrors the sibling specs).
 */

import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import {
  injectRealSupabase,
  signInTestUser,
  insertDeviceSkillDirect,
  seedStaleDevice,
  cleanupDevice,
} from './cross-harness-inventory.helpers'
import { getConfig } from './cross-harness-inventory.config'
import { withTimeout, STAGING_CALL_TIMEOUT_MS } from './cross-harness-inventory.timeout'
import {
  COLLECT_IN_PAGE,
  evaluateSamples,
  formatReport,
} from './cross-harness-inventory.contrast-probe'

const runId = process.env['GITHUB_RUN_ID'] ?? 'local'

// Disable Playwright trace: signInTestUser transplants a real staging session,
// so trace network snapshots would capture the test user's JWT in Authorization
// headers and land in the uploaded artifact (mirrors the sibling specs).
test.use({ trace: 'off' })

/** Comfortably past STALE_AFTER_HOURS (24) without being absurd. */
const HOURS_STALE = 48

test.describe('Cross-Harness Skill Inventory — rendered contrast (staging)', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'SMI-6503: contrast e2e runs on desktop project only'
    )
  })

  test('stale device card meets WCAG AA on every rendered text node', async ({ page }) => {
    const cfg = getConfig()
    const deviceId = randomUUID()
    const label = `e2e-inv-${runId}-contrast`
    const harnesses = ['agents', 'claude-code'] as const

    try {
      // ─── 1. Seed a stale device with both harness groups ──────────────────
      await seedStaleDevice({
        userId: cfg.consentOnUserId,
        deviceId,
        label,
        platform: 'darwin',
        hoursStale: HOURS_STALE,
      })
      for (const harness of harnesses) {
        await insertDeviceSkillDirect({
          userId: cfg.consentOnUserId,
          deviceId,
          harness,
          skillId: `smi6503/${harness}-probe`,
        })
      }

      // ─── 2. Sign in and render ────────────────────────────────────────────
      await injectRealSupabase(page, { url: cfg.supabaseUrl, anonKey: cfg.supabaseAnonKey })
      await withTimeout(
        signInTestUser(page, {
          email: cfg.consentOnUserEmail,
          password: cfg.invUserPassword,
        }),
        STAGING_CALL_TIMEOUT_MS,
        'contrast / signInTestUser'
      )
      await page.goto(`${cfg.websiteBaseUrl}/account/skills`)

      // ─── 3. Readiness contract ────────────────────────────────────────────
      // Every one of these is a positive signal. None of them is a sleep.
      const seededCard = page.locator('[data-testid="device-card"]').filter({ hasText: label })
      await expect(seededCard, 'seeded device-card should render').toBeVisible({
        timeout: 30_000,
      })
      // The card ITSELF carries the class — a descendant locator would silently
      // match nothing and the assertion would never fire.
      await expect(
        seededCard,
        'seeded card should be classified stale — the bug only manifests when it is'
      ).toHaveClass(/device-card--stale/, { timeout: 10_000 })

      for (const harness of harnesses) {
        await expect(
          seededCard.locator('.harness-heading', { hasText: harnessHeadingFor(harness) }),
          `harness group "${harness}" should have rendered before measuring`
        ).toHaveCount(1, { timeout: 10_000 })
      }

      // Fonts affect glyph rendering, not computed colour, but a pending web
      // font means the page is still settling — measure after it resolves.
      await page.evaluate(() => document.fonts.ready.then(() => undefined))

      // ─── 4. Measure ───────────────────────────────────────────────────────
      const collected = await page.evaluate(COLLECT_IN_PAGE)
      const result = evaluateSamples(collected as never)

      // Always print the full table, pass or fail, so a green run still shows
      // its work and a regression is diagnosable from CI logs alone.
      console.log(formatReport(result))

      // ─── 5. Assert ────────────────────────────────────────────────────────
      // Order matters: the "measured nothing" guards come FIRST. An empty scan
      // produces an empty failures array, which would otherwise read as a pass.
      expect(
        result.scannedTextNodes,
        'probe scanned zero text nodes — the page did not render, or the ' +
          'selector no longer matches. This is a failure, not a pass.'
      ).toBeGreaterThan(0)
      expect(
        result.staleCards,
        'probe found no stale card — staleness seeding or classification broke, ' +
          'so the measurement would not have exercised the regression.'
      ).toBeGreaterThan(0)

      expect(
        result.failures.map((f) => `${f.selector} ${f.ratio.toFixed(2)}<${f.threshold}`),
        'every rendered text node on a stale device card must meet WCAG AA'
      ).toEqual([])
    } finally {
      await cleanupDevice(deviceId).catch((e: unknown) => {
        console.error(`[SMI-6503] cleanupDevice failed for ${deviceId}:`, e)
      })
    }
  })
})

/**
 * Mirrors HARNESS_HEADING_LABELS for the two harnesses this spec seeds. Kept
 * local and literal rather than imported: the point of the readiness assertion
 * is that the PAGE renders the expected label, so deriving the expectation from
 * the same map the page uses would make it vacuous.
 */
function harnessHeadingFor(harness: 'agents' | 'claude-code'): string {
  return harness === 'agents' ? 'Shared (AGENTS.md)' : 'Claude Code'
}
