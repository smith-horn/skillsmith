/**
 * SMI-7113: the backfill flag must travel from the orchestrator to the flush, in both twins.
 * @module scripts/tests/indexer/backfill-defer-wiring
 *
 * `flushUpsertAccumulator` never defers in backfill mode (a held-back row would be lost: the
 * crawl cursor has already moved past it). That only matters if the flag actually reaches it, so
 * these tests pin the two hand-offs the flush tests cannot see:
 *   runUpsertPhase -> flushUpsertAccumulator (both twins)   and   runDiscovery -> runUpsertPhase.
 * The flush is replaced by a recorder; its own behaviour is covered in batch-upsert-waf-bisect.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { emptyBlockReport } from '../../indexer/indexer-runners.waf.ts'

const { flushCalls, recorder } = vi.hoisted(() => {
  const calls: { waf: { backfillMode?: boolean } }[] = []
  const rec = async (_s: unknown, _a: unknown, _e: unknown, _c: unknown, waf: object) => {
    calls.push({ waf: waf as { backfillMode?: boolean } })
    return {
      indexed: 0,
      updated: 0,
      failed: 0,
      quarantined: 0,
      errors: [] as string[],
      upsertOkUrls: new Set<string>(),
      blocked: [],
      newlyBlocked: [],
      deferredCount: 0,
      blockBudgetExhausted: false,
      bisectDisabled: false,
      lookupTruncated: false,
    }
  }
  return { flushCalls: calls, recorder: rec }
})
vi.mock('../../indexer/indexer-runners.batch.ts', async (orig) => ({
  ...(await orig<object>()),
  flushUpsertAccumulator: recorder,
}))
vi.mock('../../../supabase/functions/indexer/indexer-runners.batch.ts', async (orig) => ({
  ...(await orig<object>()),
  flushUpsertAccumulator: recorder,
}))

import { runUpsertPhase as nodeRun } from '../../indexer/indexer-runners.ts'
import { runUpsertPhase as denoRun } from '../../../supabase/functions/indexer/indexer-runners.ts'
import { newRateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'

const CLEAN_SKILL_MD =
  '---\nname: skill-0\ndescription: A helpful skill for everyday work in projects.\n---\n\n# Skill\n\nDocumented steps for safe use in projects.\n'
const URL0 = 'https://github.com/acme/skill-0'

const skills = {
  select: () => ({
    in: () => {
      const res = { data: [], error: null }
      return Object.assign(Promise.resolve(res), { eq: () => Promise.resolve(res) })
    },
  }),
  upsert: () => ({ select: () => Promise.resolve({ data: [], error: null }) }),
  update: () => ({
    eq: () => Promise.resolve({ error: null }),
    in: () => Promise.resolve({ error: null }),
  }),
}
const db = {
  from: (t: string) =>
    t === 'audit_logs' ? { insert: () => Promise.resolve({ error: null }) } : skills,
  rpc: () => Promise.resolve({ error: null }),
}
const repo = {
  owner: 'acme',
  name: 'skill-0',
  fullName: 'acme/skill-0',
  description: 'A widget',
  url: URL0,
  stars: 10,
  forks: 2,
  topics: ['claude-code-skill'],
  updatedAt: '2026-06-25T00:00:00.000Z',
  defaultBranch: 'main',
  installable: true,
  repoName: 'skill-0',
  skillPath: '',
  discoveryPath: 'high_trust:acme',
}
const author = {
  owner: 'acme',
  repo: 'skill-0',
  license: 'MIT',
  baseQualityScore: 0.9,
  trustTier: 'verified',
  description: 't',
}

type Invoke = (backfill: boolean | undefined) => Promise<unknown>
const twins: [string, Invoke][] = [
  [
    'scripts twin',
    (b) =>
      nodeRun(
        db as never,
        [repo as never],
        new Map([[URL0, author as never]]),
        new Map(),
        false,
        newRateLimitTelemetry(),
        b
      ),
  ],
  [
    'Deno twin',
    (b) =>
      denoRun(
        db as never,
        [repo as never],
        new Map([[URL0, author as never]]),
        new Map(),
        false,
        b
      ),
  ],
]

describe.each(twins)('runUpsertPhase -> flush backfill wiring (%s)', (_label, invoke) => {
  beforeEach(() => {
    flushCalls.length = 0
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(CLEAN_SKILL_MD, { status: 200 })
    )
    ;(globalThis as { Deno?: unknown }).Deno = { env: { get: (k: string) => process.env[k] } }
  })
  afterEach(() => {
    vi.restoreAllMocks()
    delete (globalThis as { Deno?: unknown }).Deno
  })

  it('hands backfillMode=true to the flush', async () => {
    await invoke(true)
    expect(flushCalls).toHaveLength(1)
    expect(flushCalls[0].waf.backfillMode).toBe(true)
  })

  it('CONTROL: omitted or false never reaches the flush as true (scheduled discovery still defers)', async () => {
    await invoke(undefined)
    await invoke(false)
    expect(flushCalls).toHaveLength(2)
    expect(flushCalls.map((c) => c.waf.backfillMode === true)).toEqual([false, false])
  })
})

describe('runDiscovery -> runUpsertPhase backfill wiring (scripts twin)', () => {
  it('passes the dispatch mode as the final argument of the upsert phase', async () => {
    const seen: unknown[][] = []
    vi.resetModules()
    vi.doMock('../../indexer/indexer-runners.ts', () => ({
      runCategorization: vi.fn(),
      runCodeSearch: vi.fn(),
      runUpsertPhase: vi.fn(async (...args: unknown[]) => {
        seen.push(args)
        return {
          ...emptyBlockReport(),
          indexed: 0,
          updated: 0,
          failed: 0,
          quarantined: 0,
          unchanged: 0,
          quality_gate_filtered: 0,
          meta_list_filtered: 0,
          multiline_truncated: 0,
          errors: [],
        }
      }),
    }))
    vi.doMock('../../indexer/phases/high-trust.ts', () => ({
      runHighTrustPhase: async () => ({
        repos: [],
        errors: [],
        highTrustSkillMap: new Map(),
        wildcardExpansionCount: 0,
        authorsWithWildcards: 0,
        treesApiCallCount: 0,
        truncatedResponseCount: 0,
      }),
    }))
    vi.doMock('../../indexer/typosquat-reference.ts', () => ({
      withTyposquatReferenceNames: async (_s: unknown, base: unknown) => base,
    }))
    const { runDiscovery } = await import('../../indexer/discovery-orchestrator.ts')
    const base = {
      supabase: {} as never,
      requestId: 'req',
      body: {},
      topics: [],
      dryRun: true,
      validationOptions: {},
      validationCache: new Map(),
      telemetry: newRateLimitTelemetry(),
      discoveryPhase: 1 as const,
    }
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await runDiscovery({ ...base, backfillMode: true } as never)
    await runDiscovery({ ...base } as never)
    vi.restoreAllMocks()
    expect(seen).toHaveLength(2)
    expect(seen[0][seen[0].length - 1]).toBe(true)
    expect(seen[1][seen[1].length - 1]).toBe(false)
  })
})
