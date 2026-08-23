/**
 * Shared /account/team/members page-mocking helpers for the team-invitations
 * e2e spec family (SMI-4294 / SMI-5589).
 *
 * Split out of team-invitations.spec.ts (SMI-5589) so both
 * team-invitations.spec.ts and team-invitations-github-username.spec.ts can
 * import setupMembersPage() without duplicating its ~200-line route-mocking
 * body — extracting rather than duplicating keeps the 500-line file-length
 * gate satisfied without a second copy to drift out of sync.
 */

import type { Page, Route } from '@playwright/test'

export const SUPABASE_HOST = 'https://stub.supabase.co'
export const SUPABASE_ANON = 'stub-anon-key'

/**
 * SMI-6134 (code-health consolidation follow-up): every account page's own
 * inline SSR script assigns `window.__SUPABASE_CONFIG__ = supabaseConfig` in
 * its `<head>` — under a real CI harness that overwrites this stub with the
 * page's own SSR-rendered environment config (a different Supabase project),
 * silently defeating the mock below. Not yet observed failing here because
 * this spec family isn't currently wired into any GitHub Actions workflow,
 * but this is the exact same latent bug complete-profile.helpers.ts's
 * injectSupabaseStub() had. Defining the property as immutable makes the
 * page's later same-key assignment a silent no-op instead of a real overwrite.
 */
export async function injectSupabaseStub(page: Page): Promise<void> {
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

export const OWNER_USER = { id: 'user_owner', email: 'owner@example.com' }

export interface MembersPageCfg {
  /** RPC list rows. Defaults to one owner + one member. */
  members?: Array<{
    member_id: string
    user_id: string
    role: 'owner' | 'admin' | 'member'
    joined_at: string
    invited_at: string | null
    full_name: string | null
    email: string | null
    github_username?: string | null
  }>
  /** Override removeTeamMember RPC outcome (success by default). */
  removeError?: string
  /** Override setTeamMemberGithubUsername RPC outcome (success by default). SMI-5589. */
  setGithubUsernameError?: string
  /** Delay (ms) for create_team_invitation so the race-window test can see
   * the disabled state. */
  createDelayMs?: number
}

export async function setupMembersPage(page: Page, cfg: MembersPageCfg = {}): Promise<void> {
  await injectSupabaseStub(page)
  const defaultMembers = [
    {
      member_id: 'tm_owner',
      user_id: OWNER_USER.id,
      role: 'owner' as const,
      joined_at: '2026-05-01T00:00:00Z',
      invited_at: null,
      full_name: 'Owner User',
      email: 'owner@example.com',
      github_username: null,
    },
    {
      member_id: 'tm_tony',
      user_id: 'user_tony',
      role: 'member' as const,
      joined_at: '2026-05-15T00:00:00Z',
      invited_at: '2026-05-14T00:00:00Z',
      full_name: 'Tony Lee',
      email: 'tony.lee@example.com',
      github_username: null,
    },
  ]
  const members = cfg.members ?? defaultMembers

  // Track the members list so we can mutate it on remove_team_member.
  const memberStore = [...members]

  await page.route(`${SUPABASE_HOST}/**`, async (route: Route) => {
    const url = new URL(route.request().url())

    // RPC dispatch
    const rpcMatch = url.pathname.match(/\/rest\/v1\/rpc\/([^/]+)/)
    if (rpcMatch) {
      const fn = rpcMatch[1] ?? ''
      if (fn === 'check_team_tier_access') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, team_id: 'team_1', tier: 'team', reason: null }),
        })
        return
      }
      if (fn === 'list_team_members_with_profile') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(memberStore),
        })
        return
      }
      if (fn === 'create_team_invitation') {
        if (cfg.createDelayMs) {
          await new Promise((r) => setTimeout(r, cfg.createDelayMs))
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            invitation_id: 'inv_new',
            token: 'tok_new',
            expires_at: '2026-05-27T00:00:00Z',
            status: 'created',
          }),
        })
        return
      }
      if (fn === 'remove_team_member') {
        if (cfg.removeError) {
          await route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({ message: cfg.removeError }),
          })
          return
        }
        // Parse the requested member_id from the body and remove from store.
        try {
          const body = JSON.parse(route.request().postData() ?? '{}') as { p_member_id?: string }
          const idx = memberStore.findIndex((m) => m.member_id === body.p_member_id)
          if (idx >= 0) memberStore.splice(idx, 1)
        } catch {
          // Ignore parse failures — tests assert on the success path.
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' })
        return
      }
      if (fn === 'set_team_member_github_username') {
        if (cfg.setGithubUsernameError) {
          await route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({ message: cfg.setGithubUsernameError }),
          })
          return
        }
        // Mutate the in-memory store so the follow-up refreshMembersList call
        // (list_team_members_with_profile) reflects the new value. SMI-5589.
        try {
          const body = JSON.parse(route.request().postData() ?? '{}') as {
            p_member_id?: string
            p_github_username?: string | null
          }
          const idx = memberStore.findIndex((m) => m.member_id === body.p_member_id)
          if (idx >= 0) memberStore[idx].github_username = body.p_github_username ?? null
        } catch {
          // Ignore parse failures — tests assert on the success path.
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' })
        return
      }
      await route.fulfill({ status: 404, body: 'rpc not mocked' })
      return
    }

    // GoTrue user
    if (url.pathname === '/auth/v1/user') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(OWNER_USER),
      })
      return
    }

    if (url.pathname === '/auth/v1/token') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'fake-jwt',
          refresh_token: 'fake-refresh',
          user: OWNER_USER,
        }),
      })
      return
    }

    // team-invite-send edge function (success by default)
    if (url.pathname.includes('/functions/v1/team-invite-send')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, sent: true }),
      })
      return
    }

    // Pending-invitations REST select (empty by default)
    if (url.pathname.startsWith('/rest/v1/team_invitations')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '[]',
      })
      return
    }

    // Fallback
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  })

  // Stub auth session so getUser() returns OWNER_USER without a real token.
  await page.addInitScript((user) => {
    const key = `sb-stub-auth-token`
    window.localStorage.setItem(
      key,
      JSON.stringify({
        access_token: 'fake-jwt',
        refresh_token: 'fake-refresh',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user,
      })
    )
  }, OWNER_USER)
}
