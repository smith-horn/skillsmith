/**
 * @fileoverview SMI-5905 Wave 3 — `getContent()` entitlement + client-getter-split regression suite
 * @see docs/internal/implementation/private-registry-skill-install.md
 * @see supabase/functions/private-registry-get/index.entitlement.test.ts — the CLI-transport twin
 *
 * Two invariants, both of which a plausible future refactor could silently break:
 *
 * 1. **Entitlement is the ROW's team, never the caller's tier** (Sol plan-review finding #1).
 *    `profiles.tier` is `MAX(tier_rank)` across every team a user belongs to, so a user who is
 *    Enterprise via Team A reads `enterprise` globally even while Team B — which actually owns the
 *    row — has downgraded. The `caller is Enterprise via a DIFFERENT team` case below is the
 *    concrete inversion of that bypass, and it also asserts `profiles` is never read at all.
 *
 * 2. **`getAdminUserClient()` and `getMemberUserClient()` are never swapped at a call site.**
 *    Two assertions, because either alone is weak: the no-signed-in-user error messages differ per
 *    getter (so the call site is observable even when nothing else runs), and the audit row's
 *    `auth_role` is read back off the binding the getter produced (so a swap shows up in
 *    production telemetry, not only here).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createLiveRegistryService } from './registry-tools.live.js'
import { REGISTRY_METADATA_COLUMNS } from './registry-tools.content.types.js'

/** Realistically-shaped token so `accessTokenSubject()` has a real `sub` to read. */
const { FAKE_USER_ID, FAKE_JWT } = vi.hoisted(() => {
  const userId = '11111111-2222-3333-4444-555555555555'
  const seg = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return {
    FAKE_USER_ID: userId,
    FAKE_JWT: `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg({ sub: userId, role: 'authenticated' })}.sig`,
  }
})

vi.mock('../supabase-client.js', () => ({
  isSupabaseConfigured: vi.fn(() => true),
  getSupabaseClient: vi.fn(),
  getSupabaseAdminClient: vi.fn(),
  getSupabaseUserClient: vi.fn(),
  resetSupabaseClients: vi.fn(),
}))

vi.mock('./team-resolver.js', () => ({
  readLicenseKey: vi.fn(() => 'sk_test_fake_license'),
  resolveLicenseTeamId: vi.fn(async () => 'team-alpha'),
  resolveUserAccessToken: vi.fn(async () => FAKE_JWT),
}))

/** The team the caller's license resolves to, and which owns the row under test. */
const TEAM_A = 'team-alpha'
/** An unrelated, still-Enterprise team the caller also belongs to. */
const TEAM_B = 'team-beta'
const SKILL = 'myteam/skill-a'
const CONTENT = { 'SKILL.md': '# Widget', 'scripts/run.sh': 'echo hi' }

interface Row {
  id: string
  team_id: string
  skill_id: string
  version: string
  description: string | null
  content_hash: string
  deprecated: boolean
  published_by: string | null
  published_at: string
  content: Record<string, string>
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'row-1',
    team_id: TEAM_A,
    skill_id: SKILL,
    version: '1.0.0',
    description: 'a widget',
    content_hash: 'a'.repeat(64),
    deprecated: false,
    published_by: null,
    published_at: '2026-07-01T00:00:00Z',
    content: CONTENT,
    ...overrides,
  }
}

interface Recorded {
  table: string
  op: 'select' | 'insert' | 'update'
  columns: string
  filters: Record<string, unknown>
  payload?: Record<string, unknown>
}

/** Rows the caller can see — i.e. the post-RLS, post-tenant-filter view. */
let visibleRows: Row[] = []
let teamsById: Record<string, { subscription_id: string | null }> = {}
let subsById: Record<string, { tier: string; status: string }> = {}
let metadataError: { code?: string; message?: string } | null = null

let auditRows: Record<string, unknown>[] = []
let metadataSelects: string[] = []
let contentQueries = 0
let profileQueries = 0
let adminRegistryQueries = 0
let subscriptionIdsQueried: string[] = []
let userCalls: Recorded[] = []
/** SMI-6111: every `.rpc()` call, across both client kinds — proves check_registry_team_entitlement is only ever called via the MEMBER client. */
let rpcCalls: { kind: 'user' | 'admin'; fn: string; params: Record<string, unknown> }[] = []
/** Set to simulate the RPC call itself failing (network/outage), not a denial. */
let entitlementRpcError: { message?: string } | null = null

function resolve(kind: 'user' | 'admin', r: Recorded): { data: unknown[]; error: unknown } {
  if (r.table === 'private_registry_skills') {
    // The registry table must only ever be reached with the caller's own token on this path.
    if (kind === 'admin') adminRegistryQueries++
    if (r.columns === 'content') {
      contentQueries++
      const found = visibleRows.find((x) => x.id === r.filters.id)
      return { data: found ? [{ content: found.content }] : [], error: null }
    }
    metadataSelects.push(r.columns)
    if (metadataError) return { data: [], error: metadataError }
    const matches = visibleRows
      .filter((x) => r.filters.team_id === undefined || x.team_id === r.filters.team_id)
      .filter((x) => x.skill_id === r.filters.skill_id)
      .filter((x) => r.filters.version === undefined || x.version === r.filters.version)
      // SMI-5949 Wave 3: the real query always sends `.eq('deprecated', false)` — honoring it
      // here (rather than ignoring `state.filters.deprecated` the way this mock ignores columns
      // it ~doesn't care about) is what makes the deprecated-exclusion tests below a genuine proof
      // that the predicate is on the query, not just that the code compiles.
      .filter((x) => r.filters.deprecated === undefined || x.deprecated === r.filters.deprecated)
      .map(({ content: _drop, ...metadata }) => metadata)
    return { data: matches, error: null }
  }
  if (r.table === 'teams') {
    const team = teamsById[String(r.filters.id)]
    return { data: team ? [team] : [], error: null }
  }
  if (r.table === 'subscriptions') {
    subscriptionIdsQueried.push(String(r.filters.id))
    const sub = subsById[String(r.filters.id)]
    return { data: sub ? [sub] : [], error: null }
  }
  if (r.table === 'profiles') {
    profileQueries++
    return { data: [{ tier: 'enterprise' }], error: null }
  }
  if (r.table === 'audit_logs' && r.op === 'insert') {
    auditRows.push(r.payload ?? {})
    return { data: [], error: null }
  }
  return { data: [], error: null }
}

/**
 * SMI-6111: mocks the `check_registry_team_entitlement` SECURITY DEFINER RPC. Mirrors the real
 * SQL function's logic exactly (team_members/`not_member` is out of scope for this file — RLS
 * already proves membership at the metadata-read layer before a team_id ever reaches here, and
 * no test in this file exercises the not_member branch).
 */
function resolveRpc(
  kind: 'user' | 'admin',
  fn: string,
  params: Record<string, unknown> | undefined
): { data: unknown; error: unknown } {
  rpcCalls.push({ kind, fn, params: params ?? {} })
  if (fn !== 'check_registry_team_entitlement') return { data: null, error: null }
  if (entitlementRpcError) return { data: null, error: entitlementRpcError }

  const teamId = String(params?.p_team_id)
  const team = teamsById[teamId]
  if (!team?.subscription_id) {
    return { data: { entitled: false, detail: 'team_has_no_subscription' }, error: null }
  }
  subscriptionIdsQueried.push(team.subscription_id)
  const sub = subsById[team.subscription_id]
  if (!sub) return { data: { entitled: false, detail: 'subscription_not_found' }, error: null }
  if (sub.tier !== 'enterprise') {
    return { data: { entitled: false, detail: 'team_tier_not_enterprise' }, error: null }
  }
  if (!['active', 'trialing', 'past_due'].includes(sub.status)) {
    return { data: { entitled: false, detail: 'team_subscription_inactive' }, error: null }
  }
  return { data: { entitled: true, detail: 'entitled' }, error: null }
}

function createClient(kind: 'user' | 'admin'): unknown {
  return {
    rpc: async (fn: string, params?: Record<string, unknown>) => resolveRpc(kind, fn, params),
    from: (table: string) => {
      const record: Recorded = { table, op: 'select', columns: '', filters: {} }
      if (kind === 'user') userCalls.push(record)
      const chain: Record<string, unknown> = {
        select: (columns?: string) => {
          record.columns = columns ?? ''
          return chain
        },
        eq: (column: string, value: unknown) => {
          record.filters[column] = value
          return chain
        },
        insert: (payload: Record<string, unknown>) => {
          record.op = 'insert'
          record.payload = payload
          return chain
        },
        update: (payload: Record<string, unknown>) => {
          record.op = 'update'
          record.payload = payload
          return chain
        },
        single: async () => {
          const res = resolve(kind, record)
          return { data: res.data[0] ?? null, error: res.error }
        },
        then: (onFulfilled: (v: { data: unknown[]; error: unknown }) => unknown) =>
          Promise.resolve(onFulfilled(resolve(kind, record))),
      }
      return chain
    },
  }
}

async function installClients(): Promise<void> {
  const { getSupabaseAdminClient, getSupabaseUserClient } = await import('../supabase-client.js')
  vi.mocked(getSupabaseAdminClient).mockResolvedValue(createClient('admin'))
  vi.mocked(getSupabaseUserClient).mockResolvedValue(createClient('user'))
}

const lastAuditMetadata = (): Record<string, unknown> =>
  auditRows[auditRows.length - 1].metadata as Record<string, unknown>

beforeEach(async () => {
  vi.clearAllMocks()
  const { resolveUserAccessToken } = await import('./team-resolver.js')
  vi.mocked(resolveUserAccessToken).mockResolvedValue(FAKE_JWT)

  visibleRows = [row()]
  teamsById = { [TEAM_A]: { subscription_id: 'sub-a' }, [TEAM_B]: { subscription_id: 'sub-b' } }
  subsById = {
    'sub-a': { tier: 'enterprise', status: 'active' },
    'sub-b': { tier: 'enterprise', status: 'active' },
  }
  metadataError = null
  auditRows = []
  metadataSelects = []
  contentQueries = 0
  profileQueries = 0
  adminRegistryQueries = 0
  subscriptionIdsQueried = []
  userCalls = []
  rpcCalls = []
  entitlementRpcError = null
  await installClients()
})

// ---------------------------------------------------------------------------
// The getter split (Sol plan-review finding #6)
// ---------------------------------------------------------------------------
describe('getAdminUserClient / getMemberUserClient are never swapped at a call site', () => {
  it('getContent() uses the MEMBER getter — its no-user error is not the admin one', async () => {
    const { resolveUserAccessToken } = await import('./team-resolver.js')
    vi.mocked(resolveUserAccessToken).mockResolvedValue(null)

    let message = '<did not reject>'
    try {
      await createLiveRegistryService().getContent(TEAM_A, SKILL)
    } catch (e) {
      message = (e as Error).message
    }

    expect(message).toMatch(/runs as you, not as your team's shared license key/i)
    // Reading a skill you may install is not an admin action; claiming it is would lock every
    // non-admin member out of their own team's registry.
    expect(message).not.toMatch(/only team admins/i)
    // And it never falls back to service-role, which would be the SMI-5822 escalation restored.
    expect(userCalls).toHaveLength(0)
    expect(adminRegistryQueries).toBe(0)
  })

  it('setDeprecated() still uses the ADMIN getter — byte-for-byte the pre-Wave-3 message', async () => {
    const { resolveUserAccessToken } = await import('./team-resolver.js')
    vi.mocked(resolveUserAccessToken).mockResolvedValue(null)

    await expect(createLiveRegistryService().deprecate(TEAM_A, SKILL)).rejects.toThrow(
      /only team admins can deprecate/i
    )
    await expect(createLiveRegistryService().undeprecate(TEAM_A, SKILL)).rejects.toThrow(
      /only team admins can undeprecate/i
    )
  })

  it("records auth_role from the binding the getter produced, not a literal — 'member' vs 'admin'", async () => {
    await createLiveRegistryService().getContent(TEAM_A, SKILL)
    expect(lastAuditMetadata().auth_role).toBe('member')
    expect(auditRows[auditRows.length - 1].event_type).toBe('private_registry:content_read')

    auditRows = []
    await createLiveRegistryService().deprecate(TEAM_A, SKILL)
    expect(lastAuditMetadata().auth_role).toBe('admin')
  })

  it('reads the registry table only through the user-bound client', async () => {
    await createLiveRegistryService().getContent(TEAM_A, SKILL)
    expect(adminRegistryQueries).toBe(0)
    expect(userCalls.filter((c) => c.table === 'private_registry_skills').length).toBe(2)
    // SMI-6111: the entitlement RPC itself must also go through the user-bound client — no
    // service-role client exists in this file anymore, so there is no "admin" leg to swap onto.
    expect(rpcCalls.every((c) => c.kind === 'user')).toBe(true)
    expect(rpcCalls.some((c) => c.fn === 'check_registry_team_entitlement')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Entitlement — the ROW's team, not the caller (Sol plan-review finding #1)
// ---------------------------------------------------------------------------
describe("getContent() entitlement is resolved against the ROW's own team", () => {
  it(
    "caller is Enterprise via a DIFFERENT team but the row's team is downgraded → denied, " +
      'and profiles.tier is never consulted',
    async () => {
      subsById['sub-a'] = { tier: 'team', status: 'active' }
      subsById['sub-b'] = { tier: 'enterprise', status: 'active' }

      await expect(createLiveRegistryService().getContent(TEAM_A, SKILL)).rejects.toThrow(
        /requires an active Enterprise subscription on the team that owns it/i
      )

      // Not a byte of content moved.
      expect(contentQueries).toBe(0)
      // Entitlement was resolved against the row's own team's subscription, and only that one.
      expect(subscriptionIdsQueried).toEqual(['sub-a'])
      // No fallback to the caller's denormalized cross-team MAX(tier_rank).
      expect(profileQueries).toBe(0)
      expect(auditRows[auditRows.length - 1].result).toBe('denied')
      expect(lastAuditMetadata().detail).toBe('team_tier_not_enterprise')
    }
  )

  it.each([
    [
      'canceled subscription',
      () => (subsById['sub-a'] = { tier: 'enterprise', status: 'canceled' }),
      'team_subscription_inactive',
    ],
    [
      'no linked subscription',
      () => (teamsById[TEAM_A] = { subscription_id: null }),
      'team_has_no_subscription',
    ],
    ['missing subscription row', () => delete subsById['sub-a'], 'subscription_not_found'],
  ])('denies on %s and reads no content', async (_label, mutate, detail) => {
    mutate()
    await expect(createLiveRegistryService().getContent(TEAM_A, SKILL)).rejects.toThrow(
      /Enterprise/i
    )
    expect(contentQueries).toBe(0)
    expect(lastAuditMetadata().detail).toBe(detail)
  })

  it.each(['active', 'trialing', 'past_due'])(
    'accepts status "%s" — the same whitelist recompute_user_tier uses',
    async (status) => {
      subsById['sub-a'] = { tier: 'enterprise', status }
      const fetched = await createLiveRegistryService().getContent(TEAM_A, SKILL)
      expect(fetched?.content).toEqual(CONTENT)
    }
  )

  it('surfaces an entitlement-lookup outage as an error, never as "not entitled"', async () => {
    // SMI-6111: the entitlement check is now a member-client RPC call, not a service-role table
    // read — the outage now looks like `.rpc()` resolving with a non-null `error`, not a thrown
    // "no service role key". The audit writer keeps its own working client, so the `error`
    // outcome is still recorded (Sol review #8 wants all four outcomes covered).
    entitlementRpcError = { message: 'connection refused' }

    await expect(createLiveRegistryService().getContent(TEAM_A, SKILL)).rejects.toThrow(
      /Entitlement lookup failed: connection refused/
    )
    expect(contentQueries).toBe(0)
    expect(auditRows[auditRows.length - 1].result).toBe('error')
    expect(lastAuditMetadata().detail).toBe('entitlement_lookup_failed')
    // The RPC was reached via the MEMBER client, never admin.
    expect(rpcCalls).toEqual([
      { kind: 'user', fn: 'check_registry_team_entitlement', params: { p_team_id: TEAM_A } },
    ])
  })
})

// ---------------------------------------------------------------------------
// Visibility, version selection, and content hygiene
// ---------------------------------------------------------------------------
describe('getContent() visibility + version selection', () => {
  it('a cross-team skillId is not an existence oracle — null, no content read', async () => {
    // What RLS + the in-query tenant filter actually produce for another team's skill: no rows.
    visibleRows = []
    await expect(createLiveRegistryService().getContent(TEAM_A, 'other/secret')).resolves.toBeNull()
    expect(contentQueries).toBe(0)
    expect(auditRows[auditRows.length - 1].result).toBe('not_found')
    expect(lastAuditMetadata().detail).toBe('no_visible_row')
  })

  it('scopes the metadata read by team_id (ADR-116) and never selects `content`', async () => {
    await createLiveRegistryService().getContent(TEAM_A, SKILL)
    expect(metadataSelects).toEqual([REGISTRY_METADATA_COLUMNS])
    expect(metadataSelects[0].split(',').map((c) => c.trim())).not.toContain('content')
    const metadataRead = userCalls.find((c) => c.columns === REGISTRY_METADATA_COLUMNS)
    expect(metadataRead?.filters).toMatchObject({ team_id: TEAM_A, skill_id: SKILL })
  })

  it('an omitted version picks the most recently published, not the highest semver', async () => {
    visibleRows = [
      row({ id: 'r-old', version: '2.0.0', published_at: '2026-01-01T00:00:00Z' }),
      row({ id: 'r-new', version: '1.9.0', published_at: '2026-07-20T00:00:00Z' }),
    ]
    const fetched = await createLiveRegistryService().getContent(TEAM_A, SKILL)
    expect(fetched?.version).toBe('1.9.0')
  })

  it('an explicit version pins that version', async () => {
    visibleRows = [
      row({ id: 'r-old', version: '1.0.0', published_at: '2026-01-01T00:00:00Z' }),
      row({ id: 'r-new', version: '2.0.0', published_at: '2026-07-20T00:00:00Z' }),
    ]
    const fetched = await createLiveRegistryService().getContent(TEAM_A, SKILL, '1.0.0')
    expect(fetched?.version).toBe('1.0.0')
  })

  // SMI-5949 Wave 3 (deprecated read-filter closure): getSkillContent() now excludes deprecated
  // versions unconditionally, matching list()/get()/the Edge Function — no opt-in, even by an
  // exact version pin. Supersedes the pre-Wave-3 behavior this test used to assert (a deprecated
  // skill "still installs").
  it('a deprecated skill no longer installs — not found when it is the only version', async () => {
    visibleRows = [row({ deprecated: true })]
    await expect(createLiveRegistryService().getContent(TEAM_A, SKILL)).resolves.toBeNull()
    expect(contentQueries).toBe(0)
  })

  it('falls back to the previous non-deprecated version when the latest is deprecated', async () => {
    visibleRows = [
      row({
        id: 'r-old',
        version: '1.0.0',
        published_at: '2026-01-01T00:00:00Z',
        deprecated: false,
      }),
      row({
        id: 'r-new',
        version: '2.0.0',
        published_at: '2026-07-20T00:00:00Z',
        deprecated: true,
      }),
    ]
    const fetched = await createLiveRegistryService().getContent(TEAM_A, SKILL)
    expect(fetched?.version).toBe('1.0.0')
    expect(fetched?.deprecated).toBe(false)
  })

  it('an exact version pin on a deprecated row still resolves to not-found — no bypass', async () => {
    visibleRows = [row({ version: '3.0.0', deprecated: true })]
    await expect(createLiveRegistryService().getContent(TEAM_A, SKILL, '3.0.0')).resolves.toBeNull()
    expect(contentQueries).toBe(0)
  })

  it('returns the row-derived teamId, and audits a count + digest but never the content', async () => {
    const fetched = await createLiveRegistryService().getContent(TEAM_A, SKILL)
    expect(fetched?.teamId).toBe(TEAM_A)

    const audit = auditRows[auditRows.length - 1]
    expect(audit.result).toBe('success')
    expect(audit.actor).toBe(`user:${FAKE_USER_ID}`)
    expect(lastAuditMetadata().file_count).toBe(2)
    expect(lastAuditMetadata().transport).toBe('mcp_server')
    const serialized = JSON.stringify(audit)
    expect(serialized).not.toContain('# Widget')
    expect(serialized).not.toContain('echo hi')
    expect(serialized).not.toContain('scripts/run.sh')
  })

  it('surfaces a failed metadata query as an error, never as "not found"', async () => {
    metadataError = { code: 'PGRST301', message: 'JWT expired' }
    await expect(createLiveRegistryService().getContent(TEAM_A, SKILL)).rejects.toThrow(
      /Failed to read registry skill content/i
    )
    expect(auditRows[auditRows.length - 1].result).toBe('error')
    expect(lastAuditMetadata().detail).toBe('PGRST301')
  })
})
