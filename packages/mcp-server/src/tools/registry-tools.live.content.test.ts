/**
 * @fileoverview SMI-6651 (plan D14) — `getContent()` release-RPC regression suite
 * @see docs/internal/implementation/private-registry-skill-install.md
 * @see supabase/functions/private-registry-get/index.test.ts — the Edge Function transport twin
 * @see supabase/migrations/20260915000000_private_registry_content_release_rpc.sql — the RPC
 *
 * Before SMI-6651 this file modeled a three-step client-side flow: a metadata select, a
 * `check_registry_team_entitlement` RPC, and a `content` select — each a separate round trip over
 * the caller's own JWT. `authenticated` no longer holds table-level SELECT on
 * `private_registry_skills` at all (the migration above REVOKEs it and grants back only the
 * metadata columns), so a client-side `content` read is not merely unnecessary now, it is
 * impossible. All three steps are one `release_private_registry_skill_content` SECURITY DEFINER
 * RPC call, and this suite models THAT contract directly rather than the table access it replaced.
 * Version resolution, deprecated-row exclusion, and the team-scoped entitlement decision tree are
 * now internal to the RPC's own SQL and are covered by the migration's own test suite
 * (`scripts/tests/supabase/**`), not here — this file's job is the mapping between the RPC's
 * `status` and what `getContent()` does with it.
 *
 * Two invariants a plausible future refactor could silently re-break:
 *
 * 1. **`getAdminUserClient()` and `getMemberUserClient()` are never swapped at a call site** —
 *    kept from the pre-SMI-6651 suite; `setDeprecated()`'s admin-gated table access is unaffected
 *    by the RPC migration and still needs this coverage.
 * 2. **`getContent()` never reads `private_registry_skills` directly any more.** One dedicated
 *    test installs a client whose `.from()` THROWS unconditionally and confirms `getContent()`
 *    still succeeds — a regression here (reintroducing a client-side select) fails loudly.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createLiveRegistryService } from './registry-tools.live.js'

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
const SKILL = 'myteam/skill-a'
const CONTENT = { 'SKILL.md': '# Widget', 'scripts/run.sh': 'echo hi' }
const REGISTRY_TABLE = 'private_registry_skills'

/** `setDeprecated()`'s own fixture — admin-gated table access, unaffected by SMI-6651. */
interface DeprecateRow {
  id: string
  team_id: string
  skill_id: string
  deprecated: boolean
}

/** Shape of `release_private_registry_skill_content`'s JSONB return value. */
interface ReleaseResult {
  status: 'not_found' | 'denied' | 'released'
  detail?: string
  skill_id?: string
  team_id?: string
  version?: string
  description?: string | null
  content_hash?: string | null
  deprecated?: boolean
  published_at?: string
  content?: unknown
}

function releasedResult(overrides: Partial<ReleaseResult> = {}): ReleaseResult {
  return {
    status: 'released',
    skill_id: SKILL,
    team_id: TEAM_A,
    version: '1.0.0',
    description: 'a widget',
    content_hash: 'a'.repeat(64),
    deprecated: false,
    published_at: '2026-07-01T00:00:00Z',
    content: CONTENT,
    ...overrides,
  }
}

interface Recorded {
  table: string
  op: 'select' | 'insert' | 'update'
  filters: Record<string, unknown>
  payload?: Record<string, unknown>
}

let deprecateRows: DeprecateRow[] = []
let auditRows: Record<string, unknown>[] = []
let userCalls: Recorded[] = []
let adminRegistryQueries = 0
/** Every `.rpc()` call, across both client kinds. */
let rpcCalls: { kind: 'user' | 'admin'; fn: string; params: Record<string, unknown> }[] = []
/** What the release RPC returns for `getContent()` tests. */
let releaseResult: ReleaseResult | null = releasedResult()
/** Set to simulate the RPC call itself failing (network/outage), not a business outcome. */
let releaseRpcError: { message?: string } | null = null
/** Set to make `setDeprecated()`'s table access fail, e.g. an expired JWT (SMI-6114 test). */
let registryTableError: { code?: string; message?: string } | null = null

function resolveRpc(
  kind: 'user' | 'admin',
  fn: string,
  params: Record<string, unknown> | undefined
): { data: unknown; error: unknown } {
  rpcCalls.push({ kind, fn, params: params ?? {} })
  if (fn !== 'release_private_registry_skill_content') return { data: null, error: null }
  if (releaseRpcError) return { data: null, error: releaseRpcError }
  return { data: releaseResult, error: null }
}

/**
 * Resolves a `.from(REGISTRY_TABLE)` / `.from('audit_logs')` call — used ONLY by
 * `setDeprecated()`'s admin-gated update+probe and by `recordRegistryAudit()`'s insert.
 * `getContent()` never reaches this any more (SMI-6651) — see the dedicated throw-based test
 * below for the structural proof.
 */
function resolveTableQuery(
  kind: 'user' | 'admin',
  r: Recorded
): { data: unknown[]; error: unknown } {
  if (r.table === REGISTRY_TABLE) {
    if (kind === 'admin') adminRegistryQueries++
    if (registryTableError) return { data: [], error: registryTableError }
    const matches = deprecateRows.filter(
      (x) => x.team_id === r.filters.team_id && x.skill_id === r.filters.skill_id
    )
    if (r.op === 'update' && r.payload) {
      for (const m of matches) Object.assign(m, r.payload)
      return { data: matches, error: null }
    }
    // setDeprecated()'s follow-up probe (`.select('id')`) when the update affected 0 rows.
    return { data: matches.map((m) => ({ id: m.id })), error: null }
  }
  if (r.table === 'audit_logs' && r.op === 'insert') {
    auditRows.push(r.payload ?? {})
    return { data: [], error: null }
  }
  return { data: [], error: null }
}

function createClient(kind: 'user' | 'admin'): unknown {
  return {
    rpc: async (fn: string, params?: Record<string, unknown>) => resolveRpc(kind, fn, params),
    from: (table: string) => {
      const record: Recorded = { table, op: 'select', filters: {} }
      if (kind === 'user') userCalls.push(record)
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          record.filters[column] = value
          return chain
        },
        insert: (payload: Record<string, unknown>) => {
          record.op = 'insert'
          record.payload = payload
          return Promise.resolve(resolveTableQuery(kind, record))
        },
        update: (payload: Record<string, unknown>) => {
          record.op = 'update'
          record.payload = payload
          return chain
        },
        then: (onFulfilled: (v: { data: unknown[]; error: unknown }) => unknown) =>
          Promise.resolve(onFulfilled(resolveTableQuery(kind, record))),
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

  deprecateRows = [{ id: 'row-1', team_id: TEAM_A, skill_id: SKILL, deprecated: false }]
  auditRows = []
  userCalls = []
  adminRegistryQueries = 0
  rpcCalls = []
  registryTableError = null
  releaseResult = releasedResult()
  releaseRpcError = null
  await installClients()
})

// ---------------------------------------------------------------------------
// The getter split (Sol plan-review finding #6) — unaffected by SMI-6651
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
    expect(rpcCalls).toHaveLength(0)
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
    // getContent() no longer writes an app-side audit on success (SMI-6651 — the release RPC
    // does that itself, in the same call). Reach the one app-audit path this function still
    // owns (the RPC call failing outright) to confirm that row still carries the MEMBER
    // binding's authRole.
    releaseRpcError = { message: 'connection refused' }
    await expect(createLiveRegistryService().getContent(TEAM_A, SKILL)).rejects.toThrow(
      /Failed to read registry skill content/i
    )
    expect(lastAuditMetadata().auth_role).toBe('member')
    expect(auditRows[auditRows.length - 1].event_type).toBe('private_registry:content_read')

    // SMI-6114: a successful deprecate writes no client-side row (trg_prs_audit records it), so
    // observe the admin binding on a deprecate the database refused instead.
    auditRows = []
    releaseRpcError = null
    registryTableError = { code: 'PGRST301', message: 'JWT expired' }
    await expect(createLiveRegistryService().deprecate(TEAM_A, SKILL)).rejects.toThrow(
      /JWT expired/
    )
    expect(lastAuditMetadata().auth_role).toBe('admin')
  })

  it('reaches the release RPC through the user-bound client and never touches the table directly', async () => {
    await createLiveRegistryService().getContent(TEAM_A, SKILL)
    expect(adminRegistryQueries).toBe(0)
    expect(userCalls.filter((c) => c.table === REGISTRY_TABLE)).toHaveLength(0)
    expect(rpcCalls).toEqual([
      {
        kind: 'user',
        fn: 'release_private_registry_skill_content',
        params: {
          p_skill_id: SKILL,
          p_version: null,
          p_team_id: TEAM_A,
          p_transport: 'mcp_server',
          p_request_id: null,
        },
      },
    ])
  })
})

// ---------------------------------------------------------------------------
// The release RPC call itself (SMI-6651 / D14)
// ---------------------------------------------------------------------------
describe('getContent() calls release_private_registry_skill_content with the exact args', () => {
  it('passes an explicit version through as p_version', async () => {
    await createLiveRegistryService().getContent(TEAM_A, SKILL, '2.0.0')
    expect(rpcCalls).toEqual([
      {
        kind: 'user',
        fn: 'release_private_registry_skill_content',
        params: {
          p_skill_id: SKILL,
          p_version: '2.0.0',
          p_team_id: TEAM_A,
          p_transport: 'mcp_server',
          p_request_id: null,
        },
      },
    ])
  })

  // SMI-6651 revert-then-restore (b): reintroducing a direct `.from(REGISTRY_TABLE)` select in
  // getContent() makes THIS test fail, because the installed client throws unconditionally on
  // any `.from()` call — a regression here fails loudly, not silently.
  it('never calls .from() at all — a client that throws on any .from() call still succeeds', async () => {
    const { getSupabaseUserClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseUserClient).mockResolvedValue({
      rpc: async (fn: string, params?: Record<string, unknown>) => resolveRpc('user', fn, params),
      from: () => {
        throw new Error('content path must not call .from() on the user-bound client')
      },
    })

    const fetched = await createLiveRegistryService().getContent(TEAM_A, SKILL)
    expect(fetched?.content).toEqual(CONTENT)
  })
})

// ---------------------------------------------------------------------------
// Mapping the RPC's `status` to getContent()'s return/throw (SMI-6651 / D14)
// ---------------------------------------------------------------------------
describe('getContent() maps release RPC outcomes', () => {
  it('not_found → null, no app-side audit', async () => {
    releaseResult = { status: 'not_found' }
    await expect(createLiveRegistryService().getContent(TEAM_A, SKILL)).resolves.toBeNull()
    expect(auditRows).toHaveLength(0)
  })

  // Byte-identity (contract §2): an other-team skillId and a genuinely nonexistent one collapse
  // to the identical `{"status":"not_found"}` on the wire — the caller cannot and must not tell
  // them apart.
  it('two different not_found causes are indistinguishable to the caller', async () => {
    releaseResult = { status: 'not_found' } // stands in for "other team" (RLS-filtered)
    const other = await createLiveRegistryService().getContent(TEAM_A, 'globex/secret')
    releaseResult = { status: 'not_found' } // stands in for "genuinely missing"
    const missing = await createLiveRegistryService().getContent(TEAM_A, 'myteam/does-not-exist')
    expect(other).toBeNull()
    expect(missing).toBeNull()
    expect(other).toEqual(missing)
  })

  it('denied → throws the exact Enterprise message, no app-side audit', async () => {
    releaseResult = { status: 'denied', detail: 'team_tier_not_enterprise' }
    await expect(createLiveRegistryService().getContent(TEAM_A, SKILL)).rejects.toThrow(
      /requires an active Enterprise subscription on the team that owns it/i
    )
    expect(auditRows).toHaveLength(0)
  })

  it('released → returns the exact RegistrySkillContent shape, no app-side audit', async () => {
    const fetched = await createLiveRegistryService().getContent(TEAM_A, SKILL)
    expect(fetched).toEqual({
      skillId: SKILL,
      version: '1.0.0',
      teamId: TEAM_A,
      content: CONTENT,
      contentHash: 'a'.repeat(64),
      deprecated: false,
      publishedAt: '2026-07-01T00:00:00Z',
    })
    expect(auditRows).toHaveLength(0)
  })

  // SMI-6651 revert-then-restore (c): adding an app-side audit call on any of the three outcomes
  // above makes THIS test fail.
  it('never audits app-side for an outcome the RPC itself already audited', async () => {
    releaseResult = { status: 'not_found' }
    await createLiveRegistryService().getContent(TEAM_A, SKILL)
    expect(auditRows).toHaveLength(0)

    releaseResult = { status: 'denied', detail: 'team_tier_not_enterprise' }
    await expect(createLiveRegistryService().getContent(TEAM_A, SKILL)).rejects.toThrow()
    expect(auditRows).toHaveLength(0)

    releaseResult = releasedResult()
    await createLiveRegistryService().getContent(TEAM_A, SKILL)
    expect(auditRows).toHaveLength(0)
  })

  it('an RPC transport failure throws and audits exactly once with detail release_rpc_failed', async () => {
    releaseRpcError = { message: 'connection refused' }
    await expect(createLiveRegistryService().getContent(TEAM_A, SKILL)).rejects.toThrow(
      /Failed to read registry skill content: connection refused/
    )
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0].result).toBe('error')
    expect(auditRows[0].actor).toBe(`user:${FAKE_USER_ID}`)
    expect(lastAuditMetadata().detail).toBe('release_rpc_failed')
  })

  // The RPC always returns jsonb; `data: null, error: null` means something broke server-side,
  // never a legitimate "nothing to see here" -- an outage must not be reported as not-found.
  // SMI-6651 revert-then-restore (1): folding this back into the not_found branch (`!result ||
  // result.status === 'not_found'`) makes THIS test fail.
  it('null RPC data with no error throws as an outage, audited with detail release_rpc_no_data', async () => {
    releaseResult = null
    await expect(createLiveRegistryService().getContent(TEAM_A, SKILL)).rejects.toThrow(
      /Failed to read registry skill content: release_rpc_no_data/
    )
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0].result).toBe('error')
    expect(lastAuditMetadata().detail).toBe('release_rpc_no_data')
  })

  // An unrecognized `status` and a malformed `content` payload are different failure shapes and
  // must be told apart in `audit_logs` -- distinct details, distinct audit calls.
  it('an unrecognized status throws and audits with detail release_rpc_unrecognized_status', async () => {
    releaseResult = { status: 'something_else' } as unknown as ReleaseResult
    await expect(createLiveRegistryService().getContent(TEAM_A, SKILL)).rejects.toThrow(
      /release_rpc_unrecognized_status/
    )
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0].result).toBe('error')
    expect(lastAuditMetadata().detail).toBe('release_rpc_unrecognized_status')
  })

  it('a released response with malformed content throws and audits with detail content_malformed_after_release', async () => {
    releaseResult = releasedResult({ content: ['not', 'an', 'object'] })
    await expect(createLiveRegistryService().getContent(TEAM_A, SKILL)).rejects.toThrow(
      /content_malformed_after_release/
    )
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0].result).toBe('error')
    expect(lastAuditMetadata().detail).toBe('content_malformed_after_release')
  })

  // The DB's own CHECK only requires a non-empty string SKILL.md; every other content key can be
  // any JSON type, and `authenticated` still keeps GRANT INSERT (... content) — so a released
  // payload can arrive `{"SKILL.md":"ok","x":123}`. The array check above does not catch this.
  it('a released response with a non-string content value throws and audits with detail content_malformed_after_release', async () => {
    releaseResult = releasedResult({ content: { 'SKILL.md': 'ok', x: 123 } })
    await expect(createLiveRegistryService().getContent(TEAM_A, SKILL)).rejects.toThrow(
      /content_malformed_after_release/
    )
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0].result).toBe('error')
    expect(lastAuditMetadata().detail).toBe('content_malformed_after_release')
  })

  it('never records the content payload in the RPC-error audit row', async () => {
    releaseRpcError = { message: 'connection refused' }
    await expect(createLiveRegistryService().getContent(TEAM_A, SKILL)).rejects.toThrow()
    const serialized = JSON.stringify(auditRows[0])
    expect(serialized).not.toContain('# Widget')
    expect(serialized).not.toContain('echo hi')
  })
})
