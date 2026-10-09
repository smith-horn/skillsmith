/**
 * @fileoverview SMI-6114 / ADR-178 — recordRegistryAudit() reports through the audit RPC
 * @see supabase/migrations/20261008000000_private_registry_audit_attempt_rpc.sql
 * @see docs/internal/implementation/smi-6114-registry-audit-attempt-rpc.md (§ 3, § 4, Verification)
 *
 * The failure posture lives in TypeScript (the SQL is fail-closed): a resolved `{ error }` and a
 * thrown call must each leave exactly one stderr line, a null client must skip the RPC and say so,
 * and a client bound before a failure must be the one that records it. Every absence assertion
 * below is paired with a presence assertion from the same execution.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createLiveRegistryService } from './registry-tools.live.js'
import {
  recordRegistryAudit,
  type AuditRpcClient,
  type RegistryAuditEvent,
} from './registry-tools.live.audit.js'
import {
  AUDIT_RPC,
  AUDIT_RPC_PARAM_KEYS,
  RESOLVED_TEAM,
  SAMPLE_CONTENT,
  auditRpcCalls,
  createFakeClient,
} from './registry-tools.live.test-helpers.js'

const { FAKE_JWT } = vi.hoisted(() => {
  const seg = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return {
    FAKE_JWT: `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg({
      sub: '11111111-2222-3333-4444-555555555555',
      role: 'authenticated',
    })}.sig`,
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

const SKILL = 'myteam/skill-a'
const MUTATIONS = ['publish', 'deprecate', 'undeprecate', 'approve', 'reject']

let stderr: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  vi.clearAllMocks()
  stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
  const { resolveUserAccessToken } = await import('./team-resolver.js')
  vi.mocked(resolveUserAccessToken).mockResolvedValue(FAKE_JWT)
})

afterEach(() => {
  stderr.mockRestore()
})

const stderrLines = (): string[] => stderr.mock.calls.map((c: unknown[]) => String(c[0]))

async function userClient(client: unknown): Promise<void> {
  const { getSupabaseUserClient } = await import('../supabase-client.js')
  vi.mocked(getSupabaseUserClient).mockResolvedValue(client)
}

const event: RegistryAuditEvent = {
  operation: 'get',
  teamId: RESOLVED_TEAM,
  skillId: SKILL,
  version: '1.2.3',
  result: 'not_found',
  authPath: 'user_jwt',
  authRole: 'member',
  detail: 'some_detail',
  fileCount: 3,
  contentHash: 'abc123',
}

describe('recordRegistryAudit() — the RPC call', () => {
  it('calls the RPC with exactly the ten named parameters', async () => {
    const rpc = vi.fn(async () => ({ error: null }))
    await recordRegistryAudit({ rpc }, event)

    expect(rpc).toHaveBeenCalledTimes(1)
    const [fn, params] = rpc.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(fn).toBe(AUDIT_RPC)
    expect(Object.keys(params).sort()).toEqual(AUDIT_RPC_PARAM_KEYS)
    expect(params).toMatchObject({
      p_operation: 'get',
      p_result: 'not_found',
      p_skill_id: SKILL,
      p_version: '1.2.3',
      p_detail: 'some_detail',
      p_file_count: 3,
      p_content_hash: 'abc123',
      p_team_id: RESOLVED_TEAM,
      p_auth_role: 'member',
    })
    expect(
      params.p_license_key_fingerprint === null ||
        /^[0-9a-f]{12}$/.test(String(params.p_license_key_fingerprint))
    ).toBe(true)
    expect(stderr).not.toHaveBeenCalled()
  })

  it('clamps every bounded parameter to the RPC bound (22023 would drop the row)', async () => {
    const rpc = vi.fn(async (_fn: string, _params?: Record<string, unknown>) => ({ error: null }))
    const long = {
      detail: 'd'.repeat(5000),
      skillId: 's'.repeat(300),
      version: 'v'.repeat(100),
      contentHash: 'h'.repeat(200),
      teamId: 't'.repeat(200),
    }
    await recordRegistryAudit({ rpc }, { ...event, ...long })

    expect(rpc).toHaveBeenCalledTimes(1)
    const params = rpc.mock.calls[0][1] as Record<string, string>
    const expected: Array<[string, string, number]> = [
      ['p_detail', long.detail, 1024],
      ['p_skill_id', long.skillId, 256],
      ['p_version', long.version, 64],
      ['p_content_hash', long.contentHash, 128],
      ['p_team_id', long.teamId, 128],
    ]
    for (const [key, input, bound] of expected) {
      expect(params[key], key).toHaveLength(bound)
      expect(input.startsWith(params[key]), key).toBe(true)
    }
    expect(stderr).not.toHaveBeenCalled()
  })

  it('clamps by code points, never leaving a lone surrogate', async () => {
    const rpc = vi.fn(async (_fn: string, _params?: Record<string, unknown>) => ({ error: null }))
    await recordRegistryAudit({ rpc }, { ...event, skillId: 'a'.repeat(255) + '\u{1F600}' + 'b' })

    expect(rpc).toHaveBeenCalledTimes(1)
    const sent = rpc.mock.calls[0][1]?.p_skill_id as string
    expect(sent).toBe('a'.repeat(255) + '\u{1F600}')
    expect(Array.from(sent)).toHaveLength(256)
    expect(sent).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })

  it('never sends a lone surrogate, high or low, even under the length bound', async () => {
    const rpc = vi.fn(async (_fn: string, _params?: Record<string, unknown>) => ({ error: null }))
    await recordRegistryAudit(
      { rpc },
      { ...event, skillId: 'ns/a\uD800b', detail: 'x\uDC00y', version: '\uD800' }
    )

    expect(rpc).toHaveBeenCalledTimes(1)
    const params = rpc.mock.calls[0][1] as Record<string, string>
    expect(params.p_skill_id).toBe('ns/a�b')
    expect(params.p_detail).toBe('x�y')
    expect(params.p_version).toBe('�')
    for (const v of [params.p_skill_id, params.p_detail, params.p_version]) {
      expect(v).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
      )
    }
  })

  it('bounds p_file_count to what the RPC accepts (0..100000, integer) or NULL', async () => {
    const cases: Array<[number, number | null]> = [
      [250000, 100000],
      [-1, null],
      [1.5, null],
      [NaN, null],
      [42, 42],
    ]
    for (const [input, expected] of cases) {
      const rpc = vi.fn(async (_fn: string, _params?: Record<string, unknown>) => ({
        error: null,
      }))
      await recordRegistryAudit({ rpc }, { ...event, fileCount: input })
      expect(rpc, String(input)).toHaveBeenCalledTimes(1)
      expect(rpc.mock.calls[0][1]?.p_file_count, String(input)).toBe(expected)
    }
  })

  it('clamps detail in the stderr failure line too', async () => {
    const rpc = vi.fn(async () => ({ error: { message: 'refused' } }))
    await recordRegistryAudit({ rpc }, { ...event, detail: 'x'.repeat(5000) })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(stderrLines()[0]).toContain(`"detail":"${'x'.repeat(1024)}"`)
    expect(stderrLines()[0]).not.toContain('x'.repeat(1025))
  })

  it('sends NULL, not undefined, for omitted optional fields', async () => {
    const rpc = vi.fn(async (_fn: string, _params?: Record<string, unknown>) => ({ error: null }))
    await recordRegistryAudit(
      { rpc },
      { operation: 'list', teamId: RESOLVED_TEAM, result: 'success', authPath: 'user_jwt' }
    )
    const params = rpc.mock.calls[0][1] as Record<string, unknown>
    for (const key of [
      'p_skill_id',
      'p_version',
      'p_detail',
      'p_file_count',
      'p_content_hash',
      'p_auth_role',
    ]) {
      expect(params[key]).toBeNull()
    }
  })
})

describe('recordRegistryAudit() — a failed audit write is observable, exactly once', () => {
  it('a resolved { error } logs once with operation, result, detail and reason', async () => {
    const rpc = vi.fn(async () => ({ error: { code: '22023', message: 'refused by rpc' } }))
    await expect(recordRegistryAudit({ rpc }, event)).resolves.toBeUndefined()

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(stderr).toHaveBeenCalledTimes(1)
    const line = stderrLines()[0]
    expect(line).toContain('"operation":"get"')
    expect(line).toContain('"result":"not_found"')
    expect(line).toContain('"detail":"some_detail"')
    expect(line).toContain('"reason":"refused by rpc"')
  })

  it('a thrown call logs once, with the thrown reason', async () => {
    const rpc = vi.fn(async () => {
      throw new Error('socket hang up')
    })
    await expect(recordRegistryAudit({ rpc }, event)).resolves.toBeUndefined()

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(stderrLines()[0]).toContain('"reason":"socket hang up"')
  })

  it('a null client skips the RPC and logs no_authenticated_client', async () => {
    const rpc = vi.fn(async () => ({ error: null }))
    await recordRegistryAudit(null, event)

    // Paired presence: the line exists in the same execution that made zero rpc calls.
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(stderrLines()[0]).toContain('"reason":"no_authenticated_client"')
    expect(stderrLines()[0]).toContain('"operation":"get"')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('a success logs nothing (control: the logging is not unconditional)', async () => {
    const rpc = vi.fn(async () => ({ error: null }))
    await recordRegistryAudit({ rpc }, event)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(stderr).not.toHaveBeenCalled()
  })
})

describe('type-level: the unsendable pairings are compile errors', () => {
  it('rejects mutation+success and non-error content_read at compile time', () => {
    const base = { teamId: RESOLVED_TEAM, authPath: 'user_jwt' as const }
    // @ts-expect-error a committed mutation is audited by trg_prs_audit only
    const a: RegistryAuditEvent = { ...base, operation: 'publish', result: 'success' }
    // @ts-expect-error content_read success/denied/not_found is the release RPC's alone
    const b: RegistryAuditEvent = { ...base, operation: 'content_read', result: 'not_found' }
    expect([a.operation, b.operation]).toEqual(['publish', 'content_read'])
  })
})

/** A client whose reads blow up AFTER the getter returned it, recording every rpc call. */
function throwingReadClient(): {
  client: AuditRpcClient
  rpcCalls: Array<{ fn: string; params: unknown }>
} {
  const rpcCalls: Array<{ fn: string; params: unknown }> = []
  return {
    rpcCalls,
    client: {
      rpc: async (fn: string, params?: Record<string, unknown>) => {
        rpcCalls.push({ fn, params })
        return { error: null }
      },
      from: () => {
        throw new Error('boom')
      },
    } as unknown as AuditRpcClient,
  }
}

describe('hoisted audit client (list / get / namespace)', () => {
  const run = {
    list: (s: ReturnType<typeof createLiveRegistryService>) => s.list(RESOLVED_TEAM),
    get: (s: ReturnType<typeof createLiveRegistryService>) => s.get(RESOLVED_TEAM, SKILL),
    namespace: (s: ReturnType<typeof createLiveRegistryService>) => s.getNamespace(RESOLVED_TEAM),
  }

  // Mutation inventory, relocation/ordering (PR-16, PR #3048 review): moving
  // `auditClient = client` below listSkills() in auditedList was declared to fail this arm at
  // `expect(rpcCalls).toHaveLength(1)` with length 0, and did (1 failed, 22 passed), then restored.
  it.each(['list', 'get', 'namespace'] as const)(
    '%s: getter resolves, then the operation throws -> exactly one rpc on THAT client',
    async (op) => {
      const { client, rpcCalls } = throwingReadClient()
      await userClient(client)
      const service = createLiveRegistryService()

      if (op === 'namespace') await run[op](service)
      else await expect(run[op](service)).rejects.toThrow('boom')

      expect(rpcCalls).toHaveLength(1)
      expect(rpcCalls[0].fn).toBe(AUDIT_RPC)
      expect(rpcCalls[0].params).toMatchObject({
        p_operation: op,
        p_result: 'error',
        p_detail: 'boom',
      })
      expect(stderr).not.toHaveBeenCalled()
    }
  )

  it.each(['list', 'get', 'namespace'] as const)(
    '%s: getter throws -> zero rpc calls and the no_authenticated_client line',
    async (op) => {
      const { resolveUserAccessToken } = await import('./team-resolver.js')
      vi.mocked(resolveUserAccessToken).mockResolvedValue(null)
      const { client, rpcCalls } = throwingReadClient()
      await userClient(client)
      const service = createLiveRegistryService()

      if (op === 'namespace') await run[op](service)
      else await expect(run[op](service)).rejects.toThrow(/skillsmith login/)

      expect(stderr).toHaveBeenCalledTimes(1)
      expect(stderrLines()[0]).toContain('"reason":"no_authenticated_client"')
      expect(stderrLines()[0]).toContain(`"operation":"${op}"`)
      expect(rpcCalls).toHaveLength(0)
    }
  )
})

describe('getters wrapped by withNoClientAudit: original error rethrown, recorded once, stderr only', () => {
  const sites: Array<{
    name: string
    operation: string
    call: (s: ReturnType<typeof createLiveRegistryService>) => Promise<unknown>
  }> = [
    { name: 'deprecate', operation: 'deprecate', call: (s) => s.deprecate(RESOLVED_TEAM, SKILL) },
    {
      name: 'undeprecate',
      operation: 'undeprecate',
      call: (s) => s.undeprecate(RESOLVED_TEAM, SKILL),
    },
    {
      name: 'publish',
      operation: 'publish',
      call: (s) => s.publish(RESOLVED_TEAM, SKILL, '1.0.0', SAMPLE_CONTENT),
    },
    {
      name: 'getContent',
      operation: 'content_read',
      call: (s) => s.getContent(RESOLVED_TEAM, SKILL),
    },
    {
      name: 'review(approved)',
      operation: 'approve',
      call: (s) => s.review(RESOLVED_TEAM, SKILL, '1.0.0', 'approved'),
    },
    {
      name: 'review(rejected)',
      operation: 'reject',
      call: (s) => s.review(RESOLVED_TEAM, SKILL, '1.0.0', 'rejected'),
    },
  ]

  it.each(sites)(
    '$name rethrows the identical error and records once with a null client',
    async ({ operation, call }) => {
      const sentinel = new Error('token store unavailable')
      const { resolveUserAccessToken } = await import('./team-resolver.js')
      vi.mocked(resolveUserAccessToken).mockRejectedValue(sentinel)
      const { client, rpcCalls } = createFakeClient()
      await userClient(client)

      await expect(call(createLiveRegistryService())).rejects.toBe(sentinel)

      expect(stderr).toHaveBeenCalledTimes(1)
      const line = stderrLines()[0]
      expect(line).toContain(`"operation":"${operation}"`)
      expect(line).toContain('"result":"error"')
      expect(line).toContain('"detail":"no_authenticated_client"')
      expect(line).toContain('"reason":"no_authenticated_client"')
      expect(rpcCalls).toHaveLength(0)
    }
  )

  it('a failure AFTER the getter is recorded by the RPC only, never also by the new catch', async () => {
    const { client, rpcCalls } = createFakeClient({
      thenResponder: () => ({ data: null, error: { code: 'PGRST301', message: 'JWT expired' } }),
    })
    await userClient(client)

    await expect(createLiveRegistryService().deprecate(RESOLVED_TEAM, SKILL)).rejects.toThrow(
      /JWT expired/
    )

    const audit = auditRpcCalls(rpcCalls)
    expect(audit).toHaveLength(1)
    expect(audit[0].params).toMatchObject({ p_operation: 'deprecate', p_result: 'error' })
    expect(stderr).not.toHaveBeenCalled()
  })
})

describe('no call site ever sends a mutation success', () => {
  it('across success, denied, not_found and error flows', async () => {
    const all: Array<{ fn: string; params: Record<string, unknown> }> = []
    const flow = async (
      opts: Parameters<typeof createFakeClient>[0],
      run: (s: ReturnType<typeof createLiveRegistryService>) => Promise<unknown>
    ): Promise<void> => {
      const { client, rpcCalls } = createFakeClient(opts)
      await userClient(client)
      await run(createLiveRegistryService()).catch(() => undefined)
      all.push(...auditRpcCalls(rpcCalls))
    }
    const s = (x: ReturnType<typeof createLiveRegistryService>) => x
    await flow({}, (x) => s(x).publish(RESOLVED_TEAM, SKILL, '1.0.0', SAMPLE_CONTENT))
    await flow(
      { thenResponder: () => ({ data: null, error: { code: '23505', message: 'duplicate key' } }) },
      (x) => x.publish(RESOLVED_TEAM, SKILL, '1.0.0', SAMPLE_CONTENT)
    )
    await flow({ thenResponder: () => ({ data: [{ id: 'r' }], error: null }) }, (x) =>
      x.deprecate(RESOLVED_TEAM, SKILL)
    )
    await flow({ thenResponder: () => ({ data: [], error: null }) }, (x) =>
      x.undeprecate(RESOLVED_TEAM, SKILL)
    )
    await flow({}, (x) => x.review(RESOLVED_TEAM, SKILL, '1.0.0', 'approved'))
    let step = 0
    await flow(
      {
        thenResponder: () =>
          step++ === 0 ? { data: [], error: null } : { data: [{ id: 'r' }], error: null },
      },
      (x) => x.deprecate(RESOLVED_TEAM, SKILL)
    )
    await flow(
      {
        rpcResponder: (fn) =>
          fn === 'review_private_registry_submission'
            ? { data: null, error: { code: '42501', message: 'no' } }
            : { data: null, error: null },
      },
      (x) => x.review(RESOLVED_TEAM, SKILL, '1.0.0', 'rejected')
    )

    // Presence: the audit path really ran for each non-success result ...
    expect(new Set(all.map((c) => c.params.p_result))).toEqual(
      new Set(['error', 'not_found', 'denied'])
    )
    // ... and none of them is a mutation success.
    const offenders = all.filter(
      (c) => MUTATIONS.includes(String(c.params.p_operation)) && c.params.p_result === 'success'
    )
    expect(offenders).toEqual([])
  })
})
