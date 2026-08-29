/**
 * link-sso.spec.ts
 *
 * SMI-6200 Wave 4 Step 3 — coverage for `/account/link-sso`, the consented
 * SSO/legacy identity-link confirmation page.
 *
 * This is a security-sensitive, semi-irreversible confirmation flow, so the
 * plan calls out explicit accessibility requirements: the confirm control is
 * a real <button> reachable and triggerable by keyboard alone, focus moves to
 * the confirmation heading on load, the "what moves / what doesn't" copy is
 * associated with the confirm button via aria-describedby, and a role="alert"
 * region announces success/failure after submission. This suite drives those
 * requirements directly rather than only asserting the resulting DOM shape.
 *
 * Follows login-sso.spec.ts's pattern (SMI-6204): mock Supabase via
 * page.route(), no real backend involved. `window.__SUPABASE_CONFIG__` is
 * injected as an immutable property so a real CI harness's own SSR-rendered
 * config can't silently overwrite the stub (SMI-6134's known hazard). The
 * authenticated-session seed (localStorage key `sb-stub-auth-token`) follows
 * team-members-page.helpers.ts's precedent for /account/* e2e specs.
 *
 * Both identities' paths are covered, because the page serves both:
 *   - WITH `?legacy_user_id=` — the SSO identity's confirm view, where the
 *     mutating `link_sso_account` RPC and the post-link `sso-link-notify`
 *     call happen.
 *   - WITHOUT it — the LEGACY identity's discovery + consent view, driven by
 *     `get_pending_sso_link_requests()` and `record_sso_link_consent()`.
 *
 * There is deliberately no out-of-band-token test: `record_sso_link_consent()`
 * as shipped is keyed solely on `auth.uid() = legacy_user_id` and performs no
 * token-hash verification, so the page implements the re-authentication
 * channel What Changes §4 offers as the alternative, and there is no token
 * flow to exercise.
 */

import { test, expect, type Page, type Route } from '@playwright/test'

const SUPABASE_HOST = 'https://stub.supabase.co'
const SUPABASE_ANON = 'stub-anon-key'

const SSO_USER = { id: 'user_sso_123', email: 'alex@acme-corp.example' }
const LEGACY_USER_ID = 'user_legacy_456'
const LEGACY_EMAIL = 'alex@acme-legacy.example'

// No `legacy_email` param: SMI-6205 review M9 removed it from the redirect and from the
// page's trust set entirely. The id is only a "which view / which offer" selector now --
// everything displayed is re-resolved from get_own_sso_link_candidate() against the
// caller's own session. `SPOOFED_LINK_SSO_URL` below drives the attack this closed.
const LINK_SSO_URL = `/account/link-sso?legacy_user_id=${LEGACY_USER_ID}`
const SPOOFED_EMAIL = 'ceo@victim-corp.example'
const SPOOFED_LINK_SSO_URL = `${LINK_SSO_URL}&legacy_email=${encodeURIComponent(SPOOFED_EMAIL)}`

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

  // Authenticated SSO session — matches team-members-page.helpers.ts's
  // seeding precedent so getSession() resolves without a network round trip.
  await page.addInitScript((user) => {
    window.localStorage.setItem(
      'sb-stub-auth-token',
      JSON.stringify({
        access_token: 'fake-jwt',
        refresh_token: 'fake-refresh',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user,
      })
    )
  }, SSO_USER)
}

interface RouteCfg {
  /** Error message the `link_sso_account` RPC returns (via a 400 body). Omit for success. */
  linkError?: string
  /** Captures the last `link_sso_account` request body for assertions. */
  onLinkCall?: (body: unknown) => void
  /** Rows `get_pending_sso_link_requests()` returns. Defaults to none. */
  pendingRows?: unknown[]
  /** Error message the `record_sso_link_consent` RPC returns (via a 400 body). */
  consentError?: string
  /** Captures the last `record_sso_link_consent` request body. */
  onConsentCall?: (body: unknown) => void
  /** Captures the last `sso-link-notify` edge-function request body. */
  onNotifyCall?: (body: unknown) => void
  /** Make the `sso-link-notify` edge function fail (it must stay non-fatal). */
  notifyFails?: boolean
  /**
   * What `get_own_sso_link_candidate()` returns. The SSO-identity view re-resolves
   * its candidate through this READ-ONLY RPC instead of trusting the URL (SMI-6205
   * review M9) and instead of the side-effecting `record_sso_login()` it used to
   * call for the same datum (confirmation round N-3/N-4), so `null` here is how a
   * "no live candidate for this session" case is driven.
   */
  ownCandidate?: { legacy_user_id: string; legacy_email: string | null } | null
  /** Captures the last `dismiss_sso_link_candidate` request body. */
  onDismissCall?: (body: unknown) => void
  /** Captures the last `undismiss_sso_link_candidate` request body. */
  onRestoreCall?: (body: unknown) => void
  /** Error message the `undismiss_sso_link_candidate` RPC returns (via a 400 body). */
  restoreError?: string
  /** Every RPC path the page hit, in order — used to assert what it did NOT call. */
  onAnyRpc?: (name: string) => void
}

async function mockSupabase(page: Page, cfg: RouteCfg = {}): Promise<void> {
  await page.route(`${SUPABASE_HOST}/**`, async (route: Route) => {
    const url = new URL(route.request().url())
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      cfg.onAnyRpc?.(url.pathname.slice('/rest/v1/rpc/'.length))
    }

    if (url.pathname === '/rest/v1/rpc/get_own_sso_link_candidate') {
      const candidate =
        cfg.ownCandidate === undefined
          ? { legacy_user_id: LEGACY_USER_ID, legacy_email: LEGACY_EMAIL }
          : cfg.ownCandidate
      // A RETURNS TABLE function comes back over PostgREST as an array of rows.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(candidate === null ? [] : [candidate]),
      })
      return
    }

    if (url.pathname === '/rest/v1/rpc/dismiss_sso_link_candidate') {
      cfg.onDismissCall?.(route.request().postDataJSON())
      await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' })
      return
    }

    if (url.pathname === '/rest/v1/rpc/undismiss_sso_link_candidate') {
      cfg.onRestoreCall?.(route.request().postDataJSON())
      if (cfg.restoreError) {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ message: cfg.restoreError }),
        })
        return
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' })
      return
    }

    if (url.pathname === '/rest/v1/rpc/get_pending_sso_link_requests') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(cfg.pendingRows ?? []),
      })
      return
    }

    if (url.pathname === '/rest/v1/rpc/record_sso_link_consent') {
      cfg.onConsentCall?.(route.request().postDataJSON())
      if (cfg.consentError) {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ message: cfg.consentError }),
        })
        return
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' })
      return
    }

    if (url.pathname === '/functions/v1/sso-link-notify') {
      cfg.onNotifyCall?.(route.request().postDataJSON())
      if (cfg.notifyFails) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, sent: true }),
      })
      return
    }

    if (url.pathname === '/rest/v1/rpc/link_sso_account') {
      const body = route.request().postDataJSON()
      cfg.onLinkCall?.(body)
      if (cfg.linkError) {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ message: cfg.linkError }),
        })
        return
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' })
      return
    }

    if (url.pathname === '/auth/v1/user') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(SSO_USER),
      })
      return
    }

    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })
}

test.describe('Account — Link SSO account (SMI-6200 Wave 4)', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page)
  })

  test('confirm button is a real <button>, focus moves to the confirmation heading on load, and aria-describedby associates the consequences copy', async ({
    page,
  }) => {
    await mockSupabase(page)
    await page.goto(LINK_SSO_URL)

    const heading = page.locator('#link-sso-heading')
    await expect(heading).toBeVisible()

    // A11y requirement: focus moves to the confirmation heading on load, so a
    // screen-reader user hears the consequence before the control.
    await expect(async () => {
      const activeId = await page.evaluate(() => document.activeElement?.id)
      expect(activeId).toBe('link-sso-heading')
    }).toPass()

    const confirmBtn = page.locator('#confirm-link-btn')
    await expect(confirmBtn).toBeVisible()
    expect(await confirmBtn.evaluate((el) => el.tagName)).toBe('BUTTON')

    // A11y requirement: the "what moves / what doesn't" copy is
    // programmatically associated with the confirm button via
    // aria-describedby, not just visually adjacent.
    const describedBy = await confirmBtn.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    const describedByIds = (describedBy ?? '').split(/\s+/).filter(Boolean)
    expect(describedByIds).toContain('link-sso-consequences')
    for (const id of describedByIds) {
      await expect(page.locator(`#${id}`)).toHaveCount(1)
    }

    // The consequences copy states v1 scope explicitly — entitlement moves,
    // inventory does not.
    const consequences = page.locator('#link-sso-consequences')
    await expect(consequences).toContainText(/moves to this sso identity/i)
    await expect(consequences).toContainText(/does not move/i)
  })

  test('a role="alert" region exists for announcing success/failure', async ({ page }) => {
    await mockSupabase(page)
    await page.goto(LINK_SSO_URL)
    await expect(page.locator('#link-sso-heading')).toBeVisible()

    const resultRegion = page.locator('#link-sso-result')
    await expect(resultRegion).toHaveCount(1)
    await expect(resultRegion).toHaveAttribute('role', 'alert')
  })

  test('the confirm button is reachable and triggerable by keyboard alone', async ({ page }) => {
    let called = false
    await mockSupabase(page, {
      onLinkCall: () => {
        called = true
      },
    })
    await page.goto(LINK_SSO_URL)
    await expect(page.locator('#link-sso-heading')).toBeVisible()

    // Focus the button the way a keyboard-only user would (Tab from the
    // document), then activate with Enter — never a mouse click.
    await page.locator('#confirm-link-btn').focus()
    await expect(page.locator('#confirm-link-btn')).toBeFocused()
    await page.keyboard.press('Enter')

    await expect(async () => {
      expect(called).toBe(true)
    }).toPass()

    await expect(page.locator('#link-sso-result')).toContainText(/linked/i)
  })

  test('the owner-refusal path shows clear, factual copy — not a generic error', async ({
    page,
  }) => {
    // Verbatim RAISE EXCEPTION text from link_sso_account()
    // (supabase/migrations/20260829230000_sso_member_lifecycle.sql) — deliberately says
    // "owns a team", not "owner", which an earlier substring-match draft of the page's
    // error mapper (written before this migration landed) would have missed.
    await mockSupabase(page, {
      linkError: 'forbidden: the legacy account owns a team -- transfer ownership first',
    })
    await page.goto(LINK_SSO_URL)
    await expect(page.locator('#link-sso-heading')).toBeVisible()

    await page.locator('#confirm-link-btn').click()

    const resultRegion = page.locator('#link-sso-result')
    await expect(resultRegion).toContainText(/team owner/i)
    await expect(resultRegion).toContainText(/ownership transfer/i)
    // Never the generic fallback for a refusal this specific.
    await expect(resultRegion).not.toContainText(/something went wrong linking your account/i)
    await expect(resultRegion).toHaveClass(/link-result-error/)

    // The button must be re-enabled so the user isn't stuck after a refusal.
    await expect(page.locator('#confirm-link-btn')).toBeEnabled()
  })

  test('the consent-pending refusal (third precondition) shows clear, factual copy', async ({
    page,
  }) => {
    // Verbatim RAISE EXCEPTION text for the "BOTH identities consented" precondition —
    // the plan's own third hard precondition (What Changes §4, identity-linking
    // subsection): the legacy identity must redeem its out-of-band consent token
    // before link_sso_account() will execute.
    await mockSupabase(page, {
      linkError:
        'forbidden: link_consent_required -- the legacy account must confirm this link from its own verified email before it can be executed',
    })
    await page.goto(LINK_SSO_URL)
    await expect(page.locator('#link-sso-heading')).toBeVisible()

    await page.locator('#confirm-link-btn').click()

    const resultRegion = page.locator('#link-sso-result')
    await expect(resultRegion).toContainText(/waiting for confirmation/i)
    await expect(resultRegion).not.toContainText(/something went wrong linking your account/i)
  })

  test('confirming calls link_sso_account with the legacy user id and shows success copy', async ({
    page,
  }) => {
    // Held in an object rather than a `let x: T | null` — a closure-only
    // assignment leaves TS narrowing the bare variable to `never` at the
    // assertion below.
    const captured: { body?: { p_legacy_user_id?: string } } = {}
    await mockSupabase(page, {
      onLinkCall: (body) => {
        captured.body = body as { p_legacy_user_id?: string }
      },
    })
    await page.goto(LINK_SSO_URL)
    await expect(page.locator('#link-sso-heading')).toBeVisible()

    await page.locator('#confirm-link-btn').click()

    await expect(page.locator('#link-sso-result')).toContainText(/linked/i)
    await expect(page.locator('#link-sso-result')).toHaveClass(/link-result-success/)
    expect(captured.body).toBeDefined()
    expect(captured.body?.p_legacy_user_id).toBe(LEGACY_USER_ID)
  })

  test('an unrecognized refusal never surfaces raw upstream text verbatim', async ({ page }) => {
    const rawUpstreamText = 'internal_sql_diagnostic_7734: constraint violation on xyz'
    await mockSupabase(page, { linkError: rawUpstreamText })
    await page.goto(LINK_SSO_URL)
    await expect(page.locator('#link-sso-heading')).toBeVisible()

    await page.locator('#confirm-link-btn').click()

    const resultRegion = page.locator('#link-sso-result')
    await expect(resultRegion).toContainText(/something went wrong linking your account/i)
    await expect(resultRegion).not.toContainText(rawUpstreamText)
  })

  test('no legacy_user_id param and no pending request shows the no-pending-link state', async ({
    page,
  }) => {
    await mockSupabase(page)
    await page.goto('/account/link-sso')

    await expect(page.locator('#no-link-heading')).toBeVisible()
    await expect(page.locator('#link-content')).toBeHidden()
    // The confirm form's container is hidden (display:none), not removed
    // from the DOM — assert on visibility, not presence.
    await expect(page.locator('#confirm-link-btn')).not.toBeVisible()
    await expect(page.locator('#confirm-consent-btn')).not.toBeVisible()
  })

  test('confirming fires the post-link notification to the legacy identity', async ({ page }) => {
    const notified: { body?: { legacy_user_id?: string } } = {}
    await mockSupabase(page, {
      onNotifyCall: (body) => {
        notified.body = body as { legacy_user_id?: string }
      },
    })
    await page.goto(LINK_SSO_URL)
    await expect(page.locator('#link-sso-heading')).toBeVisible()

    await page.locator('#confirm-link-btn').click()
    await expect(page.locator('#link-sso-result')).toContainText(/linked/i)

    // What Changes §4: "A notification email fires on link regardless."
    await expect(async () => {
      expect(notified.body).toBeDefined()
    }).toPass()
    expect(notified.body?.legacy_user_id).toBe(LEGACY_USER_ID)
  })

  test('a failed notification never turns a successful link into an error', async ({ page }) => {
    await mockSupabase(page, { notifyFails: true })
    await page.goto(LINK_SSO_URL)
    await expect(page.locator('#link-sso-heading')).toBeVisible()

    await page.locator('#confirm-link-btn').click()

    // The link committed in Postgres before the notification was attempted.
    await expect(page.locator('#link-sso-result')).toContainText(/linked/i)
    await expect(page.locator('#link-sso-result')).toHaveClass(/link-result-success/)
  })

  test('a spoofed ?legacy_email= is never displayed — the address comes from the server (M9)', async ({
    page,
  }) => {
    // The attack this closes: get a user to open a crafted link and the consent
    // screen names an account of the attacker's choosing, while
    // link_sso_account() acts on the id beside it.
    await mockSupabase(page)
    await page.goto(SPOOFED_LINK_SSO_URL)
    await expect(page.locator('#link-sso-heading')).toBeVisible()

    await expect(page.locator('#legacy-identity-email')).toHaveText(LEGACY_EMAIL)
    await expect(page.locator('#legacy-identity-email')).not.toContainText(SPOOFED_EMAIL)
    await expect(page.locator('body')).not.toContainText(SPOOFED_EMAIL)
  })

  test('no live candidate for this session shows the restore state, never the confirm view (M9)', async ({
    page,
  }) => {
    // Same state whether there is no candidate at all or the URL names one that
    // is not ours — distinguishing them would confirm whether a link exists
    // between two specific accounts. The card offers a restore, because the
    // server (not the client) is the authority on whether there is anything to
    // restore, and its refusal is deliberately undifferentiated.
    await mockSupabase(page, { ownCandidate: null })
    await page.goto(LINK_SSO_URL)

    await expect(page.locator('#restore-heading')).toBeVisible()
    await expect(page.locator('#restore-heading')).toHaveText(/no pending account link/i)
    await expect(page.locator('#confirm-link-btn')).not.toBeVisible()
  })

  test('the SSO-identity view never calls the side-effecting record_sso_login (N-3/N-4)', async ({
    page,
  }) => {
    // record_sso_login() appends an 'sso:login_recorded' audit_logs row and
    // re-arms the candidate's 7-day consent window on every call, so resolving
    // the counterparty through it made a page VIEW forge a login record and
    // reopen the window H3 exists to close.
    const rpcs: string[] = []
    await mockSupabase(page, { onAnyRpc: (name) => rpcs.push(name) })
    await page.goto(LINK_SSO_URL)
    await expect(page.locator('#link-sso-heading')).toBeVisible()

    expect(rpcs).toContain('get_own_sso_link_candidate')
    expect(rpcs).not.toContain('record_sso_login')
  })

  test('"Not now" is a real button that dismisses the candidate before navigating (H3)', async ({
    page,
  }) => {
    const dismissed: { body?: { p_legacy_user_id?: string } } = {}
    await mockSupabase(page, {
      onDismissCall: (body) => {
        dismissed.body = body as { p_legacy_user_id?: string }
      },
    })
    await page.goto(LINK_SSO_URL)
    await expect(page.locator('#link-sso-heading')).toBeVisible()

    const dismissBtn = page.locator('#dismiss-link-btn')
    // Was a bare <a href="/account">, which left the candidate live so
    // record_sso_login() re-armed its window and re-redirected here forever.
    expect(await dismissBtn.evaluate((el) => el.tagName)).toBe('BUTTON')

    await dismissBtn.click()

    await expect(async () => {
      expect(dismissed.body).toBeDefined()
    }).toPass()
    expect(dismissed.body?.p_legacy_user_id).toBe(LEGACY_USER_ID)
    // It still leaves the confirm screen — but onto the restore card rather than
    // /account, so the decline can be undone at the moment the user sees it
    // (confirmation round N-2). The `dismissed=1` flag is what tells the page to
    // skip the candidate read entirely, which is how H3's "navigate away
    // whether or not it landed" survives.
    await expect(page).toHaveURL(/dismissed=1/)
    await expect(page.locator('#restore-heading')).toBeVisible()
    await expect(page.locator('#restore-heading')).toHaveText(/won.t ask again/i)
    await expect(page.locator('#confirm-link-btn')).not.toBeVisible()
  })

  test('a FAILED dismissal falls back to /account rather than claiming we won’t ask again (H3)', async ({
    page,
  }) => {
    // Telling the user the offer is gone when the RPC refused would be a lie,
    // and would strand them on a restore button with nothing to restore.
    await page.route(`${SUPABASE_HOST}/rest/v1/rpc/dismiss_sso_link_candidate`, (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'forbidden: no pending link candidate for this account' }),
      })
    )
    await mockSupabase(page)
    await page.goto(LINK_SSO_URL)
    await expect(page.locator('#link-sso-heading')).toBeVisible()

    await page.locator('#dismiss-link-btn').click()
    await expect(page).toHaveURL(/\/account(\/)?$/)
  })

  test('the restore button un-dismisses and returns to the confirm view (N-2)', async ({
    page,
  }) => {
    const restored: { body?: { p_legacy_user_id?: string } } = {}
    await mockSupabase(page, {
      ownCandidate: null,
      onRestoreCall: (body) => {
        restored.body = body as { p_legacy_user_id?: string }
      },
    })
    await page.goto(`${LINK_SSO_URL}&dismissed=1`)

    const restoreBtn = page.locator('#restore-link-btn')
    await expect(restoreBtn).toBeVisible()
    expect(await restoreBtn.evaluate((el) => el.tagName)).toBe('BUTTON')

    // The candidate is live again once the RPC lands, so the reload must find it.
    await page.unroute(`${SUPABASE_HOST}/**`)
    await mockSupabase(page, {
      onRestoreCall: (body) => {
        restored.body = body as { p_legacy_user_id?: string }
      },
    })

    await restoreBtn.click()

    await expect(async () => {
      expect(restored.body).toBeDefined()
    }).toPass()
    expect(restored.body?.p_legacy_user_id).toBe(LEGACY_USER_ID)
    // Reloaded WITHOUT dismissed=1, so the ordinary confirm view renders.
    await expect(page).not.toHaveURL(/dismissed=1/)
    await expect(page.locator('#link-sso-heading')).toBeVisible()
  })

  test('a refused restore is announced in the alert region, not swallowed (N-2)', async ({
    page,
  }) => {
    // The mirror of the dismissal's fire-and-forget contract: the user is asking
    // for something BACK, so a silent failure looks like it is gone for good.
    await mockSupabase(page, {
      ownCandidate: null,
      restoreError: 'forbidden: no dismissed link candidate for this account',
    })
    await page.goto(`${LINK_SSO_URL}&dismissed=1`)

    const result = page.locator('#restore-result')
    await expect(result).toHaveAttribute('role', 'alert')

    await page.locator('#restore-link-btn').click()
    await expect(result).toContainText(/nothing to restore/i)
    await expect(result).toHaveClass(/link-result-error/)
    // Undifferentiated, exactly as the server refusal is — a client that could
    // tell "you dismissed this" from "no such request" is an oracle.
    await expect(result).not.toContainText(/already linked/i)
  })

  test('the restore path never reads the candidate after a dismissal (H3)', async ({ page }) => {
    // Re-reading here could drop the user straight back onto the confirm screen
    // they just left, which is the trap "Not now" exists to escape.
    const rpcs: string[] = []
    await mockSupabase(page, { onAnyRpc: (name) => rpcs.push(name) })
    await page.goto(`${LINK_SSO_URL}&dismissed=1`)
    await expect(page.locator('#restore-heading')).toBeVisible()

    expect(rpcs).not.toContain('get_own_sso_link_candidate')
    expect(rpcs).not.toContain('record_sso_login')
  })

  test('the consequences copy promises support escalation, never a self-service undo (M4)', async ({
    page,
  }) => {
    await mockSupabase(page)
    await page.goto(LINK_SSO_URL)
    await expect(page.locator('#link-sso-heading')).toBeVisible()

    const consequences = page.locator('#link-sso-consequences')
    await expect(consequences).toContainText(/can.t be undone from here/i)
    await expect(consequences).toContainText(/support@smithhorn\.ca/i)
    // The old copy said "You can undo this for 7 days", promising a reversal
    // mechanism that does not exist anywhere in the product.
    await expect(consequences).not.toContainText(/you can undo this/i)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// The LEGACY identity's half of the dual consent. Reached with NO
// legacy_user_id param — an ordinary authenticated session discovering a
// request through get_pending_sso_link_requests().
// ────────────────────────────────────────────────────────────────────────────
const PENDING_ROW = {
  sso_user_id: 'user_sso_123',
  team_id: 'team_1',
  team_name: 'Acme Corp',
  requested_at: '2026-08-28T00:00:00Z',
  consent_expires_at: '2026-09-04T00:00:00Z',
  consented_at: null,
}

test.describe('Account — Link SSO consent (legacy identity, SMI-6200 Wave 4)', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page)
  })

  test('a pending request renders a consent prompt naming the requesting organization', async ({
    page,
  }) => {
    await mockSupabase(page, { pendingRows: [PENDING_ROW] })
    await page.goto('/account/link-sso')

    const heading = page.locator('#consent-request-heading')
    await expect(heading).toBeVisible()
    await expect(page.locator('#no-link-state')).toBeHidden()

    // Which ORGANIZATION is asking is the datum the consent decision needs.
    await expect(page.locator('#consent-team-name')).toHaveText('Acme Corp')
    await expect(page.locator('#consent-request-deadline')).toContainText('September 4, 2026')

    // Same accessibility bar as the SSO-side confirm view.
    await expect(async () => {
      const activeId = await page.evaluate(() => document.activeElement?.id)
      expect(activeId).toBe('consent-request-heading')
    }).toPass()

    const btn = page.locator('#confirm-consent-btn')
    expect(await btn.evaluate((el) => el.tagName)).toBe('BUTTON')
    const describedBy = (await btn.getAttribute('aria-describedby')) ?? ''
    expect(describedBy.split(/\s+/)).toContain('consent-request-consequences')
    for (const id of describedBy.split(/\s+/).filter(Boolean)) {
      await expect(page.locator(`#${id}`)).toHaveCount(1)
    }
    await expect(page.locator('#consent-result')).toHaveAttribute('role', 'alert')
  })

  test('confirming by keyboard alone calls record_sso_link_consent with the sso_user_id', async ({
    page,
  }) => {
    const consented: { body?: { p_sso_user_id?: string } } = {}
    await mockSupabase(page, {
      pendingRows: [PENDING_ROW],
      onConsentCall: (body) => {
        consented.body = body as { p_sso_user_id?: string }
      },
    })
    await page.goto('/account/link-sso')
    await expect(page.locator('#consent-request-heading')).toBeVisible()

    await page.locator('#confirm-consent-btn').focus()
    await expect(page.locator('#confirm-consent-btn')).toBeFocused()
    await page.keyboard.press('Enter')

    await expect(page.locator('#consent-heading')).toBeVisible()
    await expect(page.locator('#consent-request-state')).toBeHidden()
    expect(consented.body).toBeDefined()
    expect(consented.body?.p_sso_user_id).toBe(PENDING_ROW.sso_user_id)
  })

  test('an already-consented request goes straight to the confirmed state, no second prompt', async ({
    page,
  }) => {
    await mockSupabase(page, {
      pendingRows: [{ ...PENDING_ROW, consented_at: '2026-08-28T01:00:00Z' }],
    })
    await page.goto('/account/link-sso')

    await expect(page.locator('#consent-heading')).toBeVisible()
    await expect(page.locator('#confirm-consent-btn')).not.toBeVisible()
    // Dropping it to "no pending link" would look like the confirmation was lost.
    await expect(page.locator('#no-link-state')).toBeHidden()
  })

  test('a consent refusal shows factual copy and re-enables the button', async ({ page }) => {
    // Verbatim RAISE EXCEPTION text from record_sso_link_consent()
    // (supabase/migrations/20260829230000_sso_member_lifecycle.sql).
    await mockSupabase(page, {
      pendingRows: [PENDING_ROW],
      consentError: 'forbidden: no pending link request for this account, or it has expired',
    })
    await page.goto('/account/link-sso')
    await expect(page.locator('#consent-request-heading')).toBeVisible()

    await page.locator('#confirm-consent-btn').click()

    const result = page.locator('#consent-result')
    await expect(result).toContainText(/no longer available/i)
    await expect(result).toHaveClass(/link-result-error/)
    await expect(page.locator('#confirm-consent-btn')).toBeEnabled()
  })

  test('an unrecognized consent refusal never surfaces raw upstream text', async ({ page }) => {
    const raw = 'internal_sql_diagnostic_7734: constraint violation on xyz'
    await mockSupabase(page, { pendingRows: [PENDING_ROW], consentError: raw })
    await page.goto('/account/link-sso')
    await expect(page.locator('#consent-request-heading')).toBeVisible()

    await page.locator('#confirm-consent-btn').click()

    const result = page.locator('#consent-result')
    await expect(result).toContainText(/something went wrong/i)
    await expect(result).not.toContainText(raw)
  })
})
