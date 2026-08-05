/**
 * @fileoverview Malformed/empty `teamId` defense-in-depth tests for the live
 * Supabase-backed PrivateRegistryService (registry-tools.live.ts)
 * @see SMI-5882 — red-team pass on the private registry
 * @see docs/internal/implementation/smi-5882-redteam-private-registry-privacy-assessment.md
 *   Wave 2 Step 1 ("Line-by-line `team_id` filter audit")
 *
 * Sibling to registry-tools.live.test.ts, split out to keep that file under
 * CLAUDE.md's <500-line guidance rather than growing it further.
 *
 * **Provenance note — why these inputs should be unreachable in production.**
 * In the real MCP/CLI call path, `teamId` always originates from
 * `resolveLicenseTeamId()` (packages/mcp-server/src/tools/team-resolver.ts),
 * which is the output of the `resolve_team_from_license` Postgres RPC
 * (migration 071, SECURITY DEFINER). That function returns either a real
 * `teams.id` UUID or `null` (mapped to an "invalid license" error before any
 * service method is ever called — see registry-tools.ts's `resolveTeamId()`).
 * It can never hand back '', whitespace, or a PostgREST-filter-shaped string.
 * `registry-tools.ts`'s Zod schemas also never accept `teamId` from tool
 * input (ADR-116) — unlike `publish-private.ts`'s Team-tier local-SQLite path,
 * which is a separate, unrelated surface (see plan doc §9).
 *
 * **What this suite actually proves.** It calls `createLiveRegistryService()`
 * directly — bypassing both of the guards above — and feeds every method a
 * batch of hostile `teamId` values: empty string, whitespace-only,
 * PostgREST filter-operator syntax (`*`, `in.(a,b)`, comma-separated,
 * `key=value`-shaped), and `null`/`undefined` coerced through the type
 * system. It asserts the mocked Supabase query-builder receives each value
 * completely unmodified — as a literal `.eq('team_id', <value>)` argument or
 * a literal `insert({ team_id: <value>, ... })` field — never concatenated,
 * escaped, or reinterpreted into a different filter expression. That is the
 * defense-in-depth claim this suite is checking: the service layer performs
 * no client-side string interpolation that a malformed value could exploit,
 * so even if a malformed `teamId` somehow reached this layer, the Supabase
 * JS client's `.eq()` treats it as an ordinary bound value, not as filter
 * syntax to be parsed. This is NOT a demonstration that malformed `teamId`
 * is reachable today — see the provenance note above.
 */

import { describe, it, expect, vi } from 'vitest'
import { createLiveRegistryService } from './registry-tools.live.js'

vi.mock('../supabase-client.js', () => ({
  isSupabaseConfigured: vi.fn(() => true),
  getSupabaseClient: vi.fn(),
  getSupabaseAdminClient: vi.fn(),
  // SMI-5822: deprecate/undeprecate now run through the signed-in user's client, so the
  // teamId pass-through claim has to be re-proved on that client too, not just the admin one.
  getSupabaseUserClient: vi.fn(),
  resetSupabaseClients: vi.fn(),
}))

vi.mock('./team-resolver.js', () => ({
  readLicenseKey: vi.fn(() => 'sk_test_fake_license'),
  resolveLicenseTeamId: vi.fn(async () => 'team-alpha'),
  resolveUserAccessToken: vi.fn(async () => 'fake-user-access-token'),
}))

const SAMPLE_CONTENT = { 'SKILL.md': '# My Skill\n\nDoes a useful thing.' }

// ============================================================================
// Fake Supabase client (recorder) — same shape as registry-tools.live.test.ts,
// but with fixed, always-succeeding responders: these tests are about what
// value reaches the query builder, not about response-handling branches
// (those are already covered in the sibling file).
// ============================================================================

interface Recorded {
  table: string
  op: 'select' | 'insert' | 'update' | 'delete'
  filters: Array<{ column: string; value: unknown }>
  payload?: Record<string, unknown>
  selectCalled: boolean
}

function publishedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    team_id: 'team-alpha',
    skill_id: 'myteam/skill-a',
    version: '1.0.0',
    description: null,
    content_hash: 'hash',
    deprecated: false,
    published_by: null,
    published_at: '2026-07-24T00:00:00Z',
    ...overrides,
  }
}

function createRecordingClient(): { client: unknown; calls: Recorded[] } {
  const calls: Recorded[] = []

  function makeQuery(table: string) {
    const record: Recorded = { table, op: 'select', filters: [], selectCalled: false }
    calls.push(record)
    const chain: Record<string, unknown> = {
      select: (_columns?: string) => {
        record.selectCalled = true
        return chain
      },
      eq: (column: string, value: unknown) => {
        record.filters.push({ column, value })
        return chain
      },
      insert: (row: Record<string, unknown>) => {
        record.op = 'insert'
        record.payload = row
        return chain
      },
      update: (row: Record<string, unknown>) => {
        record.op = 'update'
        record.payload = row
        return chain
      },
      // Always resolves to a benign row so publish() / get(versioned) /
      // getNamespace() complete without throwing, regardless of the
      // (possibly malformed) team_id value under test. The assertions below
      // inspect `calls`, not the resolved value.
      single: async () => ({ data: publishedRow(), error: null }),
      then: (onFulfilled: (v: { data: unknown[] | null; error: unknown }) => unknown) => {
        // Mirrors real PostgREST: insert/update only return row data when
        // .select() was chained. deprecate()/undeprecate() always chain
        // .select(), so this branch only matters for symmetry with the
        // sibling test file's fake client.
        if ((record.op === 'update' || record.op === 'insert') && !record.selectCalled) {
          return Promise.resolve(onFulfilled({ data: null, error: null }))
        }
        return Promise.resolve(onFulfilled({ data: [], error: null }))
      },
    }
    return chain
  }

  return { client: { from: (table: string) => makeQuery(table) }, calls }
}

/**
 * Point BOTH client factories at the same recorder.
 *
 * The service now uses two credentials (SMI-5822): service-role for reads/publish, the
 * signed-in user's JWT for deprecate/undeprecate. Wiring both to one recorder keeps every
 * `teamId` assertion below phrased in terms of what reaches the query builder, which is the
 * property this suite is about, independent of which credential carried it.
 */
async function mockClient(client: unknown): Promise<void> {
  const { getSupabaseAdminClient, getSupabaseUserClient } = await import('../supabase-client.js')
  vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)
  vi.mocked(getSupabaseUserClient).mockResolvedValue(client)
}

// ============================================================================
// Malformed teamId matrix
// ============================================================================

interface MalformedTeamId {
  label: string
  value: string
}

const MALFORMED_TEAM_IDS: MalformedTeamId[] = [
  { label: 'empty string', value: '' },
  { label: 'whitespace-only', value: '   ' },
  { label: 'PostgREST wildcard (*)', value: '*' },
  { label: 'PostgREST in.() operator syntax', value: 'in.(team-a,team-b)' },
  { label: 'comma-separated value', value: 'team-a,team-b' },
  { label: 'value containing = / eq. operator syntax', value: 'team_id=eq.team-b' },
  { label: 'PostgREST not.eq. operator syntax', value: 'not.eq.team-b' },
  // Coerced through the type system: production's teamId is always a real
  // string (or the call never reaches a service method — see the provenance
  // note above), but TS's `string` type does not stop a caller from forcing
  // null/undefined through at the JS boundary.
  { label: 'null coerced through the type system', value: null as unknown as string },
  { label: 'undefined coerced through the type system', value: undefined as unknown as string },
]

describe('createLiveRegistryService — malformed teamId defense-in-depth — SMI-5882 Wave 2 Step 1', () => {
  describe.each(MALFORMED_TEAM_IDS)('publish() with teamId: $label', ({ value }) => {
    it('passes the value through unmodified as the insert payload team_id field', async () => {
      const { client, calls } = createRecordingClient()
      await mockClient(client)
      const service = createLiveRegistryService()

      await service.publish(value, 'myteam/skill-a', '1.0.0', SAMPLE_CONTENT)

      const insertCall = calls.find(
        (c) => c.op === 'insert' && c.table === 'private_registry_skills'
      )
      expect(insertCall).toBeDefined()
      // Object.is semantics (vitest's toBe) — proves no trimming, escaping,
      // or filter-string reconstruction happened to the raw value.
      expect(insertCall!.payload?.team_id).toBe(value)
    })
  })

  describe.each(MALFORMED_TEAM_IDS)('list() with teamId: $label', ({ value }) => {
    it('passes the value through unmodified as a literal .eq("team_id", …) filter', async () => {
      const { client, calls } = createRecordingClient()
      await mockClient(client)
      const service = createLiveRegistryService()

      await service.list(value)

      const q = calls.find((c) => c.table === 'private_registry_skills')
      expect(q).toBeDefined()
      const teamFilter = q!.filters.find((f) => f.column === 'team_id')
      expect(teamFilter).toBeDefined()
      expect(teamFilter!.value).toBe(value)
    })
  })

  describe.each(MALFORMED_TEAM_IDS)('get() (versioned) with teamId: $label', ({ value }) => {
    it('passes the value through unmodified as a literal .eq("team_id", …) filter', async () => {
      const { client, calls } = createRecordingClient()
      await mockClient(client)
      const service = createLiveRegistryService()

      await service.get(value, 'myteam/skill-a', '1.0.0')

      const q = calls.find((c) => c.table === 'private_registry_skills')
      expect(q).toBeDefined()
      const teamFilter = q!.filters.find((f) => f.column === 'team_id')
      expect(teamFilter).toBeDefined()
      expect(teamFilter!.value).toBe(value)
    })
  })

  describe.each(MALFORMED_TEAM_IDS)(
    'get() (latest, no version) with teamId: $label',
    ({ value }) => {
      it('passes the value through unmodified as a literal .eq("team_id", …) filter', async () => {
        const { client, calls } = createRecordingClient()
        await mockClient(client)
        const service = createLiveRegistryService()

        await service.get(value, 'myteam/skill-a')

        const q = calls.find((c) => c.table === 'private_registry_skills')
        expect(q).toBeDefined()
        const teamFilter = q!.filters.find((f) => f.column === 'team_id')
        expect(teamFilter).toBeDefined()
        expect(teamFilter!.value).toBe(value)
      })
    }
  )

  describe.each(MALFORMED_TEAM_IDS)('deprecate() with teamId: $label', ({ value }) => {
    it('passes the value through unmodified as a literal .eq("team_id", …) filter', async () => {
      const { client, calls } = createRecordingClient()
      await mockClient(client)
      const service = createLiveRegistryService()

      await service.deprecate(value, 'myteam/skill-a')

      const q = calls.find((c) => c.op === 'update' && c.table === 'private_registry_skills')
      expect(q).toBeDefined()
      const teamFilter = q!.filters.find((f) => f.column === 'team_id')
      expect(teamFilter).toBeDefined()
      expect(teamFilter!.value).toBe(value)
    })
  })

  describe.each(MALFORMED_TEAM_IDS)('undeprecate() with teamId: $label', ({ value }) => {
    it('passes the value through unmodified as a literal .eq("team_id", …) filter', async () => {
      const { client, calls } = createRecordingClient()
      await mockClient(client)
      const service = createLiveRegistryService()

      await service.undeprecate(value, 'myteam/skill-a')

      const q = calls.find((c) => c.op === 'update' && c.table === 'private_registry_skills')
      expect(q).toBeDefined()
      const teamFilter = q!.filters.find((f) => f.column === 'team_id')
      expect(teamFilter).toBeDefined()
      expect(teamFilter!.value).toBe(value)
    })
  })

  describe.each(MALFORMED_TEAM_IDS)('getNamespace() with teamId: $label', ({ value }) => {
    it('passes the value through unmodified as a literal .eq("id", …) filter on the teams table (not "team_id")', async () => {
      const { client, calls } = createRecordingClient()
      await mockClient(client)
      const service = createLiveRegistryService()

      await service.getNamespace(value)

      // getNamespace() queries a DIFFERENT table (`teams`) and a DIFFERENT
      // column (`id`, not `team_id`) — confirmed here per the plan doc's
      // explicit challenge ("confirm this cannot leak another team's
      // namespace"). A malformed value still can't widen the filter to
      // match more than one row: PostgREST .eq() is always an exact-match
      // bound comparison, never a parsed expression, regardless of table.
      const q = calls.find((c) => c.table === 'teams')
      expect(q).toBeDefined()
      expect(q!.filters).toHaveLength(1)
      expect(q!.filters[0]!.column).toBe('id')
      expect(q!.filters[0]!.value).toBe(value)
    })
  })
})
