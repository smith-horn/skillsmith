/**
 * private-registry-dashboard-approve.spec.ts
 *
 * Regression coverage for SMI-6121.
 *
 * Live dogfooding (2026-08-22) found the Approve/Reject buttons on
 * `/account/team/registry` did nothing when clicked — no error, no network
 * request, no visible feedback. Root cause: `registry.astro`'s
 * `astro:page-load` listener had no idempotency guard (see
 * `account-page-load-guards.spec.ts`'s header for the general shape of this
 * bug class), so re-entering the page via a ClientRouter transition attached
 * a fresh click listener to `#content` on top of any still-live one from the
 * previous visit — and this exact interaction had **zero** prior test
 * coverage (neither Playwright nor a manual QA pass had ever clicked these
 * buttons before a real user did).
 *
 * This spec is the required regression test per CLAUDE.md's Shared-State /
 * Concurrency Audit guidance: "any page or component that registers an
 * astro:page-load listener that mutates user-visible state MUST have at
 * least one Playwright test exercising the synthetic re-fire pattern."
 *
 * Auth + Supabase are mocked via complete-profile.helpers.ts (no
 * staging/prod network — prod ref vrcnzpmndtroqxxoqkzy, see CLAUDE.md),
 * matching account-page-load-guards.spec.ts's established pattern.
 */

import { test, expect } from '@playwright/test'
import {
  buildSessionToken,
  injectSupabaseStub,
  mockSupabase,
  SUPABASE_HOST,
} from './complete-profile.helpers'
import { assertNoHandlerAccumulation, refireAstroPageLoad } from './astro-helpers'

const TEAM_ID = 'team-e2e-registry-1'

const PENDING_ROW = {
  skill_id: 'ryan-smith/example-skill',
  version: '1.0.0',
  description: 'A skill pending review.',
  deprecated: false,
  published_by: 'user-submitter',
  published_at: '2026-08-20T00:00:00Z',
  approval_status: 'pending',
  approval_mode: 'review',
}

const APPROVED_ROW = {
  skill_id: 'ryan-smith/approved-skill',
  version: '1.0.0',
  description: 'An already-approved skill.',
  deprecated: false,
  published_by: 'user-owner',
  published_at: '2026-08-10T00:00:00Z',
}

/**
 * registry.astro (SMI-6203) resolves toggle-deprecated/review permission via
 * two independent `has_team_permission(p_team_id, p_permission)` RPC calls
 * (registry:deprecate / registry:approve) rather than a single role check.
 * mockSupabase()'s rpcResponses map keys by function name only — it cannot
 * distinguish the two calls by their `p_permission` param — so this registers
 * a dedicated route that inspects the POST body to answer each call per
 * permission. Registered AFTER mockSupabase() (and thus takes priority per
 * Playwright's most-recently-registered-wins rule, per mockSupabase's own
 * SMI-6134 comment) so it overrides mockSupabase's generic 404-for-unmocked-
 * rpc fallback for this one function name.
 */
async function mockHasTeamPermission(
  page: import('@playwright/test').Page,
  permissions: Partial<Record<'registry:deprecate' | 'registry:approve', boolean>>
): Promise<void> {
  await page.route(`${SUPABASE_HOST}/rest/v1/rpc/has_team_permission`, async (route) => {
    const body = route.request().postDataJSON() as { p_permission?: string } | null
    const permission = body?.p_permission ?? ''
    const allowed = Boolean(
      permissions[permission as 'registry:deprecate' | 'registry:approve'] ?? false
    )
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(allowed),
    })
  })
}

async function mockRegistryPage(
  page: import('@playwright/test').Page,
  opts: {
    role: 'admin' | 'member'
    /**
     * Explicit per-permission overrides — models a team_permission_grants row
     * that diverges from the role-implied default (a grant for a member, or a
     * deny for an admin). Any permission not named here defaults to the
     * role-implied value (admin/owner -> true, member -> false), matching the
     * real default_role_permission matrix for these two permissions.
     */
    permissions?: Partial<Record<'registry:deprecate' | 'registry:approve', boolean>>
    approvedRows?: unknown[]
  }
): Promise<void> {
  await injectSupabaseStub(page, { session: buildSessionToken({ provider: 'email' }) })
  const defaultAllowed = opts.role === 'admin'
  await mockSupabase(page, {
    rpcResponses: {
      check_team_tier_access: { ok: true, team_id: TEAM_ID, tier: 'enterprise' },
      // Backs both the 'pending' and 'rejected' submissions() calls in
      // loadRegistryDashboardData — the mock keys by function name only, so
      // both queries resolve to this same fixture. Harmless for this spec:
      // it only asserts on the Approve button in the Pending section.
      get_private_registry_submissions: [PENDING_ROW],
      review_private_registry_submission: [{ ...PENDING_ROW, approval_status: 'approved' }],
    },
    restResponses: {
      // .single() (loadRegistryDashboardData's namespace lookup) expects PostgREST's
      // unwrapped-object response shape, not an array — mockSupabase returns
      // restResponses[table] verbatim, so this must be a bare object.
      teams: { skill_namespace: 'ryan-smith' },
      private_registry_skills: opts.approvedRows ?? [],
    },
  })
  await mockHasTeamPermission(page, {
    'registry:deprecate': opts.permissions?.['registry:deprecate'] ?? defaultAllowed,
    'registry:approve': opts.permissions?.['registry:approve'] ?? defaultAllowed,
  })
  await page.goto('/account/team/registry')
  await expect(page.locator('#content')).toBeVisible()
}

test.describe('private registry dashboard — Approve button (SMI-6121 dogfood finding)', () => {
  test('clicking Approve issues exactly one review_private_registry_submission call', async ({
    page,
  }) => {
    await mockRegistryPage(page, { role: 'admin' })

    const approveButton = page.locator('button[data-decision="approved"]').first()
    await expect(approveButton).toBeVisible()
    await expect(approveButton).toBeEnabled()

    await assertNoHandlerAccumulation(
      page,
      'button[data-decision="approved"]',
      /\/rest\/v1\/rpc\/review_private_registry_submission/,
      { clicks: 1, refires: 0 }
    )
  })

  test('re-entering the page via astro:page-load re-fires does not accumulate click handlers', async ({
    page,
  }) => {
    await mockRegistryPage(page, { role: 'admin' })

    // Deliberately NOT assertNoHandlerAccumulation's plain refire loop: this page's listener
    // attachment sits deep behind several `await`s (checkTeamAccess, auth.getSession, the two
    // has_team_permission RPC calls, loadRegistry) inside its astro:page-load handler. A bare
    // `document.dispatchEvent(new Event('astro:page-load'))` returns before any of that async
    // work runs, so firing 3 refires back-to-back with no wait between them just overlaps their
    // early awaits rather than letting each one actually reach the listener-attach line — the
    // accumulation bug wouldn't reproduce even with the guard removed. Waiting for the pending
    // list to finish re-rendering after each refire lets each async chain genuinely complete.
    //
    // Counting rpcHits alone is NOT a reliable signal here: each accumulated listener re-runs
    // its own `createClient()` against the SAME localStorage session key, and supabase-js's own
    // GoTrueClient logs "Multiple GoTrueClient instances detected... may produce undefined
    // behavior when used concurrently" — confirmed live (2026-08-22) to make most, but not
    // reliably all, of the accumulated listeners' OWN `canDeprecate`/`canApprove` closure resolve
    // to `false` instead of throwing, so with the bug present the click is processed multiple times (each
    // logging its own `[registry] click ignored: ...` warning) while `rpcHits` can still land on
    // a small number by coincidence. Counting every listener invocation (successful RPC calls
    // PLUS ignored-click console warnings) is what actually proves how many listeners fired.
    let rpcHits = 0
    await page.route(/\/rest\/v1\/rpc\/review_private_registry_submission/, async (route) => {
      rpcHits += 1
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    })
    let ignoredClickWarnings = 0
    page.on('console', (msg) => {
      if (msg.text().includes('[registry] click ignored')) ignoredClickWarnings += 1
    })

    for (let i = 0; i < 3; i += 1) {
      await refireAstroPageLoad(page)
      await expect(page.locator('button[data-decision="approved"]').first()).toBeVisible()
    }

    await page.locator('button[data-decision="approved"]').first().click()
    await page.waitForLoadState('networkidle')

    const totalHandlerInvocations = rpcHits + ignoredClickWarnings
    expect(
      totalHandlerInvocations,
      `expected exactly 1 click handler to fire regardless of 3 astro:page-load re-fires ` +
        `(${rpcHits} RPC call(s) + ${ignoredClickWarnings} ignored-click warning(s) = ` +
        `${totalHandlerInvocations}) — handler accumulation suspected`
    ).toBe(1)
    expect(rpcHits, 'the one listener that does fire must actually succeed, not be ignored').toBe(1)
  })

  test('a non-admin member sees disabled Approve/Reject buttons, and no click reaches the RPC', async ({
    page,
  }) => {
    await mockRegistryPage(page, { role: 'member' })

    const approveButton = page.locator('button[data-decision="approved"]').first()
    await expect(approveButton).toBeVisible()
    await expect(approveButton).toBeDisabled()

    let rpcHits = 0
    await page.route(/\/rest\/v1\/rpc\/review_private_registry_submission/, async (route) => {
      rpcHits += 1
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    })
    // Disabled buttons don't receive real click events from Playwright's actionability
    // checks, so drive it via the DOM directly — the click handler's own `button.disabled`
    // check (registry.astro) is the actual thing under test here.
    await approveButton.evaluate((el: HTMLButtonElement) => el.click())
    await refireAstroPageLoad(page)
    expect(rpcHits).toBe(0)
  })

  // SMI-6203: registry.astro now resolves toggle-deprecated/review permission per-action
  // (registry:deprecate / registry:approve) via has_team_permission() instead of one blanket
  // role === 'admin' || role === 'owner' check. These two tests are the plan's explicit "smoke
  // rows for a granted member and a denied admin" — proving the gate now tracks the resolved
  // permission grant, not just role.
  test('a member with an explicit registry:approve grant sees enabled Approve/Reject buttons despite role=member', async ({
    page,
  }) => {
    await mockRegistryPage(page, {
      role: 'member',
      permissions: { 'registry:approve': true },
    })

    const approveButton = page.locator('button[data-decision="approved"]').first()
    const rejectButton = page.locator('button[data-decision="rejected"]').first()
    await expect(approveButton).toBeVisible()
    await expect(approveButton).toBeEnabled()
    await expect(rejectButton).toBeEnabled()

    await assertNoHandlerAccumulation(
      page,
      'button[data-decision="approved"]',
      /\/rest\/v1\/rpc\/review_private_registry_submission/,
      { clicks: 1, refires: 0 }
    )
  })

  test('an admin with an explicit registry:deprecate deny grant sees a disabled Deprecate button despite role=admin', async ({
    page,
  }) => {
    await mockRegistryPage(page, {
      role: 'admin',
      permissions: { 'registry:deprecate': false },
      approvedRows: [APPROVED_ROW],
    })

    const deprecateButton = page.locator('button[data-action="toggle-deprecated"]').first()
    await expect(deprecateButton).toBeVisible()
    await expect(deprecateButton).toBeDisabled()

    let rpcHits = 0
    await page.route(/\/rest\/v1\/private_registry_skills/, async (route) => {
      rpcHits += 1
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    })
    // Disabled buttons don't receive real click events from Playwright's actionability
    // checks, so drive it via the DOM directly — the click handler's own `button.disabled`
    // check (registry.astro) is the actual thing under test here.
    await deprecateButton.evaluate((el: HTMLButtonElement) => el.click())
    await refireAstroPageLoad(page)
    expect(rpcHits).toBe(0)
  })
})
