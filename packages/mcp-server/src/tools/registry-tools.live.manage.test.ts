/**
 * @fileoverview Live-mode tests for private_registry_manage (list/get/deprecate/namespace)
 * @see SMI-5816: Private skill registry — real implementation (ADR-129)
 *
 * Exercises the live Supabase-backed service (registry-tools.live.ts) by mocking
 * `getSupabaseAdminClient`/`getSupabaseUserClient` with recording fake clients (see
 * registry-tools.live.test-helpers.ts). `publish` coverage lives in the sibling
 * registry-tools.live.test.ts — split from one file, SMI-5949 Wave 2, to stay under the 500-line
 * audit:standards gate. Focus areas:
 *   - every operation is scoped to the license-resolved team_id (a caller can never
 *     target another team — the service-layer half of cross-tenant isolation; the
 *     DB/RLS half is asserted in scripts/tests/private-registry-rls.test.ts);
 *   - SMI-5949 Wave 2 Step 3 (D-4 surfaces 3/4): list/get carry a mandatory
 *     approval_status='approved' in-query predicate, since RLS does not enforce it either
 *     (still true post-SMI-6109 — see the class doc comment below);
 *   - deprecate/undeprecate require a real representation (`.select()`) so a successful
 *     update is never misreported as not-found;
 *   - SMI-6109: list/get/getNamespace moved off the service-role client onto the signed-in
 *     user's own JWT (member-level, `getMemberUserClient()`) — every test below now mocks
 *     `getSupabaseUserClient` via `mockBothClients()` (both credential getters point at one
 *     recorder) rather than `getSupabaseAdminClient()` alone, and a new describe block covers
 *     the not-logged-in path these three now share with `getContent`/`publish`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  executePrivateRegistryManage,
  setPrivateRegistryService,
  createStubRegistryService,
} from './registry-tools.js'
import { createLiveRegistryService } from './registry-tools.live.js'
import {
  RESOLVED_TEAM,
  createFakeClient,
  makeContext,
  mockBothClients,
  publishedRow,
} from './registry-tools.live.test-helpers.js'

vi.mock('../supabase-client.js', () => ({
  isSupabaseConfigured: vi.fn(() => true),
  getSupabaseClient: vi.fn(),
  getSupabaseAdminClient: vi.fn(),
  getSupabaseUserClient: vi.fn(),
  resetSupabaseClients: vi.fn(),
}))

// readLicenseKey is kept — registry-tools.live.audit.ts still calls it directly for the audit
// row's masked-credential metadata. resolveLicenseTeamId is dropped: registry-tools.ts no longer
// calls it (SMI-6622 — see the registry-tools.team.js mock below).
vi.mock('./team-resolver.js', () => ({
  readLicenseKey: vi.fn(() => 'sk_test_fake_license'),
  resolveUserAccessToken: vi.fn(async () => 'fake-user-access-token'),
}))

// SMI-6622: registry-tools.ts's resolveTeamId() now delegates to registry-tools.team.js, not
// team-resolver.js's resolveLicenseTeamId.
// importOriginal + spread (SMI-6622 round 2) — see registry-tools.install-action.test.ts's
// identical comment for why (a future new export never needs re-adding to every mock).
vi.mock('./registry-tools.team.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./registry-tools.team.js')>()
  return {
    ...actual,
    resolveRegistryTeamId: vi.fn(async () => ({
      teamId: 'team-alpha',
      source: 'env:SKILLSMITH_LICENSE_KEY',
    })),
    readRegistryCredential: vi.fn(() => 'sk_test_fake_license'),
  }
})

// ============================================================================
// Shared setup
// ============================================================================

beforeEach(async () => {
  setPrivateRegistryService(createLiveRegistryService())
  // SMI-6622 round 5 PR-07 finding 3: reset the signed-in default HERE, at the top level, rather
  // than in a local per-describe `beforeEach` — a test anywhere below can override
  // `resolveUserAccessToken` via a PERSISTENT `mockResolvedValue(null)` (not `...Once`; the
  // "namespace surfaces the probe's own ... login error" test below does this deliberately, to
  // cover the probe's own second call), and this file's shared `afterEach`'s `vi.clearAllMocks()`
  // does NOT undo a `mockResolvedValue` override — it only clears recorded calls/results, not a
  // configured implementation. Resetting the default here, before EVERY test, means no earlier
  // test's override can ever leak into a later one regardless of describe-block ordering. A test
  // that wants a signed-out caller still overrides this from within its own body, which always runs
  // after this `beforeEach`.
  const { resolveUserAccessToken } = await import('./team-resolver.js')
  vi.mocked(resolveUserAccessToken).mockResolvedValue('fake-user-access-token')
})

afterEach(() => {
  setPrivateRegistryService(createStubRegistryService())
  vi.clearAllMocks()
})

// ============================================================================
// manage — namespace action
// ============================================================================

describe('private_registry_manage namespace action — SMI-5852 AC-11', () => {
  it('returns the team namespace without attempting a publish', async () => {
    const { client } = createFakeClient({
      singleResponder: () => ({ data: { skill_namespace: 'myteam' }, error: null }),
    })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage({ action: 'namespace' }, makeContext())

    expect(result.success).toBe(true)
    expect(result.namespace).toBe('myteam')
  })

  it('surfaces a typed error when the namespace cannot be resolved, and audits a genuine query error as error (not success)', async () => {
    const { client, calls } = createFakeClient({
      // No `code` field, so this is NOT PGRST116 (genuine no-rows) — a real query failure
      // (e.g. connection error, RLS denial surfaced as an error), not "no namespace configured".
      singleResponder: () => ({ data: null, error: { message: 'connection failure' } }),
    })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage({ action: 'namespace' }, makeContext())

    expect(result.success).toBe(false)
    // SMI-6622 round 5 PR-07: a genuine query failure now surfaces the probe's own FIXED, AUTHORED
    // text (never the raw `error.message` — see registry-tools.membership-check.ts's header on why
    // that field is never read at all) rather than the generic "unable to resolve...skillsmith
    // login" text — a probe failure must never be indistinguishable from "you're just not a
    // member," so it gets its own, distinct wording. No `code` was given in this fixture, so none
    // is appended either.
    expect(result.error).toMatch(/unable to verify your team membership/i)
    expect(result.error).toMatch(/the membership check itself failed/i)
    expect(result.error).not.toContain('connection failure')

    // Cross-provider review finding (SMI-6109): the original draft collapsed this into `null` and
    // audited it as 'success' — a real outage reported as a successful read, in a log whose whole
    // purpose is security observability.
    const auditInsert = calls.find((c) => c.table === 'audit_logs')
    expect(auditInsert).toBeDefined()
    expect(auditInsert!.payload?.result).toBe('error')
  })

  // SMI-6622 round 5 PR-07 finding 2: no live test previously covered a CONFIRMED member whose team
  // has a genuinely null `skill_namespace` — the generic "unable to resolve...skillsmith login"
  // branch was reachable only in theory. `callCount` gives getNamespace()'s own `.single()` call a
  // clean null (data present, `skill_namespace: null` — a real row, not a PGRST116 no-rows) and the
  // SEPARATE membership probe's `.single()` call a confirmed-member row, so the probe's
  // `membershipOverrideError()` returns `null` (nothing to override) and execution falls through to
  // the generic text — the ONLY case that text is still reachable from, post round-4/5.
  it('namespace falls through to the generic "unable to resolve" text for a confirmed member with a genuinely null skill_namespace', async () => {
    let callCount = 0
    const { client } = createFakeClient({
      singleResponder: () => {
        callCount += 1
        if (callCount === 1) return { data: { skill_namespace: null }, error: null } // getNamespace()'s own query
        return { data: { id: RESOLVED_TEAM }, error: null } // probe: confirmed member
      },
    })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage({ action: 'namespace' }, makeContext())

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/unable to resolve/i)
    expect(result.error).toMatch(/skillsmith login/i)
    // Distinct from a probe-failure result — a confirmed member never gets that wording.
    expect(result.error).not.toMatch(/unable to verify your team membership/i)
  })

  // SMI-6622 round 2 finding 3: "Add tests for ... the non-member message." PGRST116 on EVERY
  // `.single()` call covers both getNamespace()'s own query and the membership-check probe's —
  // both are genuinely "no visible row for this team" under an RLS-scoped caller, so returning the
  // SAME PGRST116 for both is not a shortcut, it is the real scenario this test targets.
  it('replaces the generic namespace-unresolved message with the specific non-member message when confirmed', async () => {
    const { client } = createFakeClient({
      singleResponder: () => ({ data: null, error: { code: 'PGRST116', message: 'no rows' } }),
    })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage({ action: 'namespace' }, makeContext())

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not a member of the team resolved from/i)
    expect(result.error).toMatch(/SKILLSMITH_LICENSE_KEY environment variable/)
    expect(result.error).not.toMatch(/unable to resolve/i)
  })
})

// ============================================================================
// manage — every read/update is scoped to the resolved team (cross-tenant guard)
// ============================================================================

describe('private_registry_manage live mode — team scoping — SMI-5816', () => {
  it('list filters by the resolved team_id AND approval_status=approved (SMI-5949 D-4 surface 3)', async () => {
    const { client, calls } = createFakeClient({ thenResponder: () => ({ data: [], error: null }) })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage({ action: 'list' }, makeContext())

    expect(result.success).toBe(true)
    expect(result.dataSource).toBe('live')
    const q = calls.find((c) => c.table === 'private_registry_skills')
    expect(q!.filters.some((f) => f.column === 'team_id' && f.value === RESOLVED_TEAM)).toBe(true)
    expect(q!.filters.some((f) => f.column === 'approval_status' && f.value === 'approved')).toBe(
      true
    )
  })

  it('get filters by resolved team_id + skill_id + version + approval_status=approved (SMI-5949 D-4 surface 4)', async () => {
    const { client, calls } = createFakeClient({
      singleResponder: () => ({ data: publishedRow(), error: null }),
    })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage(
      { action: 'get', skillId: 'myteam/skill-a', version: '1.0.0' },
      makeContext()
    )

    expect(result.success).toBe(true)
    const q = calls.find((c) => c.table === 'private_registry_skills')
    expect(q!.filters.some((f) => f.column === 'team_id' && f.value === RESOLVED_TEAM)).toBe(true)
    expect(q!.filters.some((f) => f.column === 'skill_id' && f.value === 'myteam/skill-a')).toBe(
      true
    )
    expect(q!.filters.some((f) => f.column === 'version' && f.value === '1.0.0')).toBe(true)
    expect(q!.filters.some((f) => f.column === 'approval_status' && f.value === 'approved')).toBe(
      true
    )
    expect(result.skill?.approvalStatus).toBe('approved')
  })

  it('get (latest, no version) filters by approval_status=approved (SMI-5949 D-4 surface 4)', async () => {
    const { client, calls } = createFakeClient({
      thenResponder: () => ({ data: [publishedRow()], error: null }),
    })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage(
      { action: 'get', skillId: 'myteam/skill-a' },
      makeContext()
    )

    expect(result.success).toBe(true)
    const q = calls.find((c) => c.table === 'private_registry_skills')
    expect(q!.filters.some((f) => f.column === 'approval_status' && f.value === 'approved')).toBe(
      true
    )
  })

  it('deprecate updates deprecated=true scoped to team_id + skill_id', async () => {
    const { client, calls } = createFakeClient({
      thenResponder: () => ({ data: [publishedRow({ deprecated: true })], error: null }),
    })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage(
      { action: 'deprecate', skillId: 'myteam/skill-a' },
      makeContext()
    )

    expect(result.success).toBe(true)
    const q = calls.find((c) => c.op === 'update')
    expect(q).toBeDefined()
    expect(q!.payload?.deprecated).toBe(true)
    expect(q!.filters.some((f) => f.column === 'team_id' && f.value === RESOLVED_TEAM)).toBe(true)
    expect(q!.filters.some((f) => f.column === 'skill_id' && f.value === 'myteam/skill-a')).toBe(
      true
    )
  })

  it('deprecate returns not-found when no row in this team matches', async () => {
    // Zero updated rows AND zero readable rows: the skill genuinely does not exist for this
    // team. Contrast with the "member, not admin" case below, where the rows ARE readable.
    const { client } = createFakeClient({ thenResponder: () => ({ data: [], error: null }) })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage(
      { action: 'deprecate', skillId: 'myteam/ghost' },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/i)
  })

  // Regression test: an update without .select() gets `data: null` back from PostgREST even when
  // rows were actually changed — the fake client's `then()` enforces this. If either method ever
  // drops its .select() call again, this fails because the "successful" mutation is (correctly)
  // reported as not-found.
  it.each([
    { action: 'deprecate' as const, deprecated: true },
    { action: 'undeprecate' as const, deprecated: false },
  ])('$action requests a representation (select) so a real update is detected', async (c) => {
    const { client } = createFakeClient({
      thenResponder: () => ({ data: [publishedRow({ deprecated: c.deprecated })], error: null }),
    })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage(
      { action: c.action, skillId: 'myteam/skill-a' },
      makeContext()
    )

    expect(result.success).toBe(true)
  })

  it('get distinguishes a real database error from a not-found result', async () => {
    const { client } = createFakeClient({
      singleResponder: () => ({
        data: null,
        error: { code: '08006', message: 'connection failure' },
      }),
    })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage(
      { action: 'get', skillId: 'myteam/skill-a', version: '1.0.0' },
      makeContext()
    )

    // A connectivity/permission failure must surface as an error, not silently
    // read as "skill not found" — the two are operationally very different.
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/connection failure/i)
    expect(result.error).not.toMatch(/not found/i)
  })

  // ==========================================================================
  // SMI-5949 Wave 3: `deprecated` read-filter closure
  // ==========================================================================

  it('list filters by deprecated=false by default (SMI-5949 Wave 3)', async () => {
    const { client, calls } = createFakeClient({ thenResponder: () => ({ data: [], error: null }) })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage({ action: 'list' }, makeContext())

    expect(result.success).toBe(true)
    const q = calls.find((c) => c.table === 'private_registry_skills')
    expect(q!.filters.some((f) => f.column === 'deprecated' && f.value === false)).toBe(true)
  })

  it('list with includeDeprecated:true skips the deprecated predicate (SMI-5949 Wave 3)', async () => {
    const { client, calls } = createFakeClient({ thenResponder: () => ({ data: [], error: null }) })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage(
      { action: 'list', includeDeprecated: true },
      makeContext()
    )

    expect(result.success).toBe(true)
    const q = calls.find((c) => c.table === 'private_registry_skills')
    expect(q!.filters.some((f) => f.column === 'deprecated')).toBe(false)
  })

  it('list with includeDeprecated:false still filters deprecated=false (explicit false is the same as omitted)', async () => {
    const { client, calls } = createFakeClient({ thenResponder: () => ({ data: [], error: null }) })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage(
      { action: 'list', includeDeprecated: false },
      makeContext()
    )

    expect(result.success).toBe(true)
    const q = calls.find((c) => c.table === 'private_registry_skills')
    expect(q!.filters.some((f) => f.column === 'deprecated' && f.value === false)).toBe(true)
  })

  it('get (pinned version) always filters deprecated=false, with no opt-in (SMI-5949 Wave 3)', async () => {
    const { client, calls } = createFakeClient({
      singleResponder: () => ({ data: publishedRow(), error: null }),
    })
    await mockBothClients(client)

    // `get` has no `includeDeprecated` field at all — passing extra input is not possible through
    // the typed handler, so this asserts the predicate is present unconditionally.
    const result = await executePrivateRegistryManage(
      { action: 'get', skillId: 'myteam/skill-a', version: '1.0.0' },
      makeContext()
    )

    expect(result.success).toBe(true)
    const q = calls.find((c) => c.table === 'private_registry_skills')
    expect(q!.filters.some((f) => f.column === 'deprecated' && f.value === false)).toBe(true)
  })

  it('get (latest, no version) always filters deprecated=false, with no opt-in (SMI-5949 Wave 3)', async () => {
    const { client, calls } = createFakeClient({
      thenResponder: () => ({ data: [publishedRow()], error: null }),
    })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage(
      { action: 'get', skillId: 'myteam/skill-a' },
      makeContext()
    )

    expect(result.success).toBe(true)
    const q = calls.find((c) => c.table === 'private_registry_skills')
    expect(q!.filters.some((f) => f.column === 'deprecated' && f.value === false)).toBe(true)
  })

  it('get returns null (not-found) for PostgREST’s genuine no-rows code, and audits it as not_found (not success)', async () => {
    const { client, calls } = createFakeClient({
      singleResponder: () => ({
        data: null,
        error: {
          code: 'PGRST116',
          message: 'JSON object requested, multiple (or no) rows returned',
        },
      }),
    })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage(
      { action: 'get', skillId: 'myteam/ghost', version: '1.0.0' },
      makeContext()
    )

    // Cross-provider review finding (SMI-6109): a not-found get() was previously audited as
    // 'success', which is misleading in a log whose purpose is security observability.
    const auditInsert = calls.find((c) => c.table === 'audit_logs')
    expect(auditInsert).toBeDefined()
    expect(auditInsert!.payload?.result).toBe('not_found')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/i)
  })
})

// ============================================================================
// SMI-6109: list/get/getNamespace now require a signed-in user (member-level), not just a
// license key — mirrors registry-tools.live.admin-auth.test.ts's pattern for the admin-gated
// deprecate/undeprecate pair.
// ============================================================================

describe('private_registry_manage live mode — SMI-6109 member-credential requirement', () => {
  it('list refuses — and issues no query — when no user is signed in', async () => {
    const { resolveUserAccessToken } = await import('./team-resolver.js')
    vi.mocked(resolveUserAccessToken).mockResolvedValueOnce(null)
    const { client, calls } = createFakeClient()
    await mockBothClients(client)

    const result = await executePrivateRegistryManage({ action: 'list' }, makeContext())

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/skillsmith login/i)
    // Any team member may list — this is not an admin-only error.
    expect(result.error).not.toMatch(/only team admins/i)
    expect(calls.find((c) => c.table === 'private_registry_skills')).toBeUndefined()
  })

  it('get refuses — and issues no query — when no user is signed in', async () => {
    const { resolveUserAccessToken } = await import('./team-resolver.js')
    vi.mocked(resolveUserAccessToken).mockResolvedValueOnce(null)
    const { client, calls } = createFakeClient()
    await mockBothClients(client)

    const result = await executePrivateRegistryManage(
      { action: 'get', skillId: 'myteam/skill-a' },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/skillsmith login/i)
    expect(calls.find((c) => c.table === 'private_registry_skills')).toBeUndefined()
  })

  // getNamespace's documented contract (registry-tools.ts's PrivateRegistryService interface) is
  // "or null if it could not be resolved" — it never throws, unlike list/get above, so a
  // not-logged-in caller cannot get the same loud, distinguishable "run skillsmith login" error
  // list/get surface directly from getNamespace() itself. Cross-provider review (SMI-6109) flagged
  // the resulting UX gap; round 4 PR-07 closed it more precisely than the original partial fix did:
  // the membership-check probe's OWN not-signed-in error (which already names `skillsmith login`)
  // now surfaces verbatim via `membershipOverrideError()`'s 'probe_failed' verdict, so this case no
  // longer shares the generic "unable to resolve" text with a genuinely-unconfigured team — it gets
  // the exact, specific reason. See registry-tools.live.member-reads.ts's header comment for why
  // getNamespace()'s own never-throws contract is deliberate, and registry-tools.membership-
  // check.ts's header for the round-4 'probe_failed' verdict.
  it('namespace surfaces the probe\'s own "run skillsmith login" error when no user is signed in', async () => {
    const { resolveUserAccessToken } = await import('./team-resolver.js')
    // SMI-6622 round 2 finding 3: persistent (not `...Once`) — a genuinely-signed-out caller
    // returns null on EVERY resolveUserAccessToken() call, including the membership-check probe
    // this handler now also attempts. A single queued `null` only covered auditedGetNamespace()'s
    // own call and let the probe's own (second) getMemberUserClient() call fall through to this
    // mock's default token, incorrectly reaching a real `teams` query.
    vi.mocked(resolveUserAccessToken).mockResolvedValue(null)
    const { client, calls } = createFakeClient()
    await mockBothClients(client)

    const result = await executePrivateRegistryManage({ action: 'namespace' }, makeContext())

    expect(result.success).toBe(false)
    // SMI-6622 round 5 PR-07: the probe now checks `resolveUserAccessToken()` directly, BEFORE
    // constructing any client (registry-tools.membership-check.ts's `probeTeamMembership()`), and
    // returns FIXED, AUTHORED not-signed-in text — never a forwarded exception message —
    // distinguishable from an unrelated "unable to resolve" outage/misconfiguration.
    expect(result.error).toMatch(/unable to verify your team membership/i)
    expect(result.error).toMatch(/you are not signed in/i)
    expect(result.error).toMatch(/skillsmith login/i)
    // No client was ever constructed for the probe, so no `teams` query ran either.
    expect(calls.find((c) => c.table === 'teams')).toBeUndefined()
  })
})

// ============================================================================
// Round 4/5/6 PR-07: a failed membership probe must never look identical to a genuinely
// empty/unset registry — an empty `list` or null `namespace` plus a PROBE FAILURE (not a confirmed
// member, not a confirmed non-member) must return `success:false`, never fall through to
// `success:true`. Round 6 (third consecutive finding on this surface): the probe's failure text
// must never carry ANY external string, full stop — round 5's validated error CODE is gone
// entirely (an upstream-controlled code cannot be trusted just because it matches a pattern), and
// `resolveUserAccessToken()`/`getSupabaseUserClient()` failures are now covered too, not only the
// query layer. The signed-in default is reset in this file's shared top-level `beforeEach`
// (finding 3), so no local override is needed here.
// ============================================================================

describe('private_registry_manage — membership probe failures never leak raw text, and are distinct from success (SMI-6622 round 4/5/6 PR-07)', () => {
  it('list: returns success:false with ONLY authored text — never a JWT, API key, or license key — when the membership probe query throws', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig'
    const apiKey = 'sk_live_abcdefghijklmnopqrstuvwx'
    const licenseKey = 'sk_test_fake_license'
    const { client } = createFakeClient({
      thenResponder: () => ({ data: [], error: null }), // list() itself: genuinely empty
      singleResponder: () => {
        // A hostile/misbehaving driver embedding credential-shaped text in a thrown exception's
        // own message — this must never reach the result (round 5 PR-07 finding 1).
        throw new Error(
          `upstream failure while proxying token ${jwt} key ${apiKey} license ${licenseKey}`
        )
      },
    })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage({ action: 'list' }, makeContext())

    expect(result.success).toBe(false)
    expect(result.error).not.toContain(jwt)
    expect(result.error).not.toContain(apiKey)
    expect(result.error).not.toContain(licenseKey)
    // Fixed, authored `transport_error` text — probeTeamMembership() never reads the exception's
    // own message.
    expect(result.error).toMatch(/unable to verify your team membership/i)
    expect(result.error).toMatch(/a network error interrupted the check/i)
  })

  // SMI-6622 round 6 PR-07 finding 2: round 5's SAFE_ERROR_CODE_PATTERN let a real Postgres
  // SQLSTATE (e.g. `42501`) through on the theory that "short + uppercase-alnum" was a safe enough
  // shape — but the code is STILL upstream-controlled, and an upstream value that merely happens to
  // match a pattern is not thereby trustworthy. Round 6 removed the allow-list entirely: no code
  // ever appears, whether it looks like a real SQLSTATE or is an adversarial string shaped to pass
  // the old pattern.
  it.each([
    ['a real-looking Postgres SQLSTATE', '42501'],
    ['an adversarial upstream string shaped to pass the removed allow-pattern', 'SECRET1234'],
  ])(
    'list: drops the query-error code entirely — %s never reaches the result',
    async (_label, code) => {
      const { client } = createFakeClient({
        thenResponder: () => ({ data: [], error: null }),
        singleResponder: () => ({ data: null, error: { code, message: 'irrelevant' } }),
      })
      await mockBothClients(client)

      const result = await executePrivateRegistryManage({ action: 'list' }, makeContext())

      expect(result.success).toBe(false)
      expect(result.error).not.toContain(code)
      expect(result.error).toMatch(/unable to verify your team membership/i)
      expect(result.error).toMatch(/the membership check itself failed\. try again/i)
    }
  )

  // SMI-6622 round 6 PR-07 finding 1 (HIGH): `resolveUserAccessToken()` used to be awaited outside
  // both `try` blocks in `probeTeamMembership` — a rejection escaped uncaught into
  // `registry-tools.manage-action.ts`'s dispatcher catch, which copies `err.message` into the
  // result. `tryBindMemberUserClient()` (registry-tools.live.auth.ts) now wraps that resolution in
  // its own `try`. `service.list()` ALSO resolves a token (for its own binding) before the probe
  // ever runs — the mock below lets that FIRST call succeed normally and only rejects the SECOND
  // (the probe's), so this test isolates the probe's own handling from that separate, pre-existing,
  // out-of-scope call site (SMI-6649).
  it('list: returns success:false with ONLY authored text — never a JWT, API key, or license key — when resolveUserAccessToken() itself rejects', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig'
    const apiKey = 'sk_live_abcdefghijklmnopqrstuvwx'
    const licenseKey = 'sk_test_fake_license'
    const { resolveUserAccessToken } = await import('./team-resolver.js')
    let callCount = 0
    vi.mocked(resolveUserAccessToken).mockImplementation(async () => {
      callCount += 1
      if (callCount === 1) return 'fake-user-access-token' // service.list()'s own resolution
      throw new Error(`keychain read failed: token ${jwt} key ${apiKey} license ${licenseKey}`)
    })
    const { client } = createFakeClient({ thenResponder: () => ({ data: [], error: null }) })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage({ action: 'list' }, makeContext())

    expect(result.success).toBe(false)
    expect(result.error).not.toContain(jwt)
    expect(result.error).not.toContain(apiKey)
    expect(result.error).not.toContain(licenseKey)
    expect(result.error).toMatch(/unable to verify your team membership/i)
    expect(result.error).toMatch(/your saved sign-in could not be read or refreshed/i)
  })

  // SMI-6622 round 6 PR-07 finding 3: `client_unavailable` must be NEUTRAL — it covers non-auth
  // client-construction failures (an invalid URL, the Vitest prod-fallback guard in
  // supabase-client.ts) as well as auth ones, so it must never tell the caller to sign in. Same
  // call-isolation technique as the token-rejection test above: the FIRST `getSupabaseUserClient()`
  // call is service.list()'s own (succeeds normally), only the SECOND (the probe's) throws.
  it('list: returns NEUTRAL client_unavailable text (no "skillsmith login") when getSupabaseUserClient() itself throws', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig'
    const apiKey = 'sk_live_abcdefghijklmnopqrstuvwx'
    const licenseKey = 'sk_test_fake_license'
    const { client } = createFakeClient({ thenResponder: () => ({ data: [], error: null }) })
    await mockBothClients(client)
    const { getSupabaseUserClient } = await import('../supabase-client.js')
    let callCount = 0
    vi.mocked(getSupabaseUserClient).mockImplementation(async () => {
      callCount += 1
      if (callCount === 1) return client // service.list()'s own binding succeeds
      throw new Error(`client init failed: token ${jwt} key ${apiKey} license ${licenseKey}`)
    })

    const result = await executePrivateRegistryManage({ action: 'list' }, makeContext())

    expect(result.success).toBe(false)
    expect(result.error).not.toContain(jwt)
    expect(result.error).not.toContain(apiKey)
    expect(result.error).not.toContain(licenseKey)
    expect(result.error).toMatch(/unable to verify your team membership/i)
    expect(result.error).toMatch(/the registry client could not be created on this machine/i)
    expect(result.error).not.toMatch(/skillsmith login/i)
  })

  // SMI-6622 round 6 PR-07 finding 3 (double token resolution): the probe must resolve the token
  // EXACTLY ONCE — round 5's probe checked `resolveUserAccessToken()` itself AND ALSO called
  // `getMemberUserClient()`, which resolved it again internally, duplicating keychain/refresh work
  // and leaving a window where the credential could change between the two reads. Calls
  // `probeTeamMembership()` directly (not through the full action handler) so the delta measured is
  // the probe's own, not conflated with `service.list()`'s separate, unrelated resolution.
  it('probeTeamMembership() calls resolveUserAccessToken() exactly once', async () => {
    const { resolveUserAccessToken } = await import('./team-resolver.js')
    const { probeTeamMembership } = await import('./registry-tools.membership-check.js')
    const { client } = createFakeClient({
      singleResponder: () => ({ data: { id: RESOLVED_TEAM }, error: null }),
    })
    await mockBothClients(client)

    const before = vi.mocked(resolveUserAccessToken).mock.calls.length
    await probeTeamMembership(RESOLVED_TEAM)
    const after = vi.mocked(resolveUserAccessToken).mock.calls.length

    expect(after - before).toBe(1)
  })

  it('namespace: returns success:false when the membership probe throws, even though getNamespace() itself returned a clean null', async () => {
    // The 1st `.single()` call is getNamespace()'s own query (a genuine "no namespace configured"
    // — data present, skill_namespace null, NOT an error); the 2nd is the separate membership
    // probe, which throws. Two distinct responses on the SAME mocked terminal method, in call
    // order — not a shortcut, this is the real two-query sequence registry-tools.manage-action.ts
    // actually issues.
    let callCount = 0
    const { client } = createFakeClient({
      singleResponder: () => {
        callCount += 1
        if (callCount === 1) return { data: { skill_namespace: null }, error: null }
        throw new Error('network blip')
      },
    })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage({ action: 'namespace' }, makeContext())

    expect(result.success).toBe(false)
    // SMI-6622 round 5 PR-07: fixed, authored `transport_error` text — the thrown 'network blip'
    // message is never read or forwarded.
    expect(result.error).toMatch(/unable to verify your team membership/i)
    expect(result.error).toMatch(/a network error interrupted the check/i)
    expect(result.error).not.toContain('network blip')
  })

  it('namespace: returns success:false when the membership probe returns a non-PGRST116 query error, even though getNamespace() itself returned a clean null', async () => {
    let callCount = 0
    const { client } = createFakeClient({
      singleResponder: () => {
        callCount += 1
        if (callCount === 1) return { data: { skill_namespace: null }, error: null }
        return { data: null, error: { message: 'db connection reset' } } // no code — none appended
      },
    })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage({ action: 'namespace' }, makeContext())

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/unable to verify your team membership/i)
    expect(result.error).toMatch(/the membership check itself failed\. try again/i)
    expect(result.error).not.toContain('db connection reset')
  })

  // Control (item d): a genuinely CONFIRMED member with a genuinely empty registry must still
  // succeed — the fix must not turn every empty list into a failure, only an UNRESOLVED one.
  it('list: still returns success:true with an empty list for a genuinely confirmed member (control)', async () => {
    const { client } = createFakeClient({
      thenResponder: () => ({ data: [], error: null }),
      singleResponder: () => ({ data: { id: RESOLVED_TEAM }, error: null }), // probe: confirmed member
    })
    await mockBothClients(client)

    const result = await executePrivateRegistryManage({ action: 'list' }, makeContext())

    expect(result.success).toBe(true)
    expect(result.skills).toEqual([])
  })
})
