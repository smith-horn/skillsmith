/**
 * SMI-5551: Verification-based stale quarantine + incident brake + canonical
 * threshold policy — the three "implement first, together" remediation items:
 *  1. Incident brake — `STALE_QUARANTINE_DISABLE` short-circuits the sweep
 *     before ANY query or write.
 *  2. Verification-based quarantine — an expired heartbeat triggers a DIRECT
 *     fetch of the skill's own repo_url; only a genuinely-terminal outcome
 *     (parse failure / 404) or a malicious scan quarantines. A transient fetch
 *     error leaves the row untouched; a live clean fetch refreshes
 *     `last_seen_at` instead of quarantining.
 *  3. One canonical threshold resolver shared by maintenance (7d) + discovery (30d).
 *
 * Shared-state audit (P-5): no destructive quarantine occurs solely from an
 * expired heartbeat; verification success refreshes the heartbeat; 404 / parse
 * failure / transient failure / malicious route distinctly; live-touch is CAS-safe.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isGitCryptEncrypted } from './parity-utils.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

// Module mocks (hoisted). The network layer is deterministic: fetchSkillMd
// routes on the repo name embedded in the Contents API URL, so fixtures pick
// their verification outcome via their repo_url — no per-test mock mutation.

vi.mock('../../indexer/_shared/quarantine.ts', () => ({
  quarantineSkillsBatch: vi.fn(async (_db: unknown, ids: string[]) => ({
    quarantined: ids.length,
    errors: 0,
  })),
  FINDING_STALE: {
    type: 'stale',
    severity: 'info',
    description: 'Skill repository not found during recent indexer runs',
    lineNumber: 0,
  },
}))

vi.mock('../../indexer/_shared/github-auth.ts', () => ({
  buildGitHubHeaders: vi.fn(async () => ({})),
}))

vi.mock('../../indexer/_shared/skill-md-fetch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../indexer/_shared/skill-md-fetch.ts')>()
  return {
    ...actual, // real parseSkillMdUrl — fixtures carry real GitHub URL shapes
    fetchSkillMd: vi.fn(async (parsed: { apiUrl: string }) => {
      if (parsed.apiUrl.includes('/repos/acme/transient/')) {
        return { kind: 'transient' as const, status: 403 }
      }
      if (parsed.apiUrl.includes('/repos/acme/live-clean/')) {
        return { kind: 'content' as const, content: 'clean skill content' }
      }
      if (parsed.apiUrl.includes('/repos/acme/malicious/')) {
        return { kind: 'content' as const, content: 'MALICIOUS skill content' }
      }
      if (parsed.apiUrl.includes('/repos/acme/truncated/')) {
        return { kind: 'content' as const, content: 'TRUNCATED skill content' }
      }
      return { kind: 'not-found' as const }
    }),
  }
})

vi.mock('../../indexer/_shared/security-scanner-edge.ts', () => ({
  scanSkillContent: vi.fn(async (content: string) => {
    if (content.includes('TRUNCATED')) {
      return {
        findings: [],
        riskScore: 0,
        passed: true,
        contentHash: 'hash-truncated',
        multilineTruncated: true,
      }
    }
    return content.includes('MALICIOUS')
      ? {
          findings: [{ type: 'code_execution', severity: 'critical' }],
          riskScore: 90,
          passed: false,
          contentHash: 'hash-bad',
        }
      : { findings: [], riskScore: 0, passed: true, contentHash: 'hash-clean' }
  }),
  // SMI-6020: stale-reconciliation.ts now calls shouldQuarantineFailClosed +
  // isScanTruncated (not shouldQuarantine directly) — the stub MUST carry the
  // same fail-closed semantics or T2.24 would pass vacuously (design §2.7 note).
  shouldQuarantineFailClosed: (scan: { riskScore: number; multilineTruncated?: boolean }) =>
    scan.riskScore >= 40 || scan.multilineTruncated === true,
  isScanTruncated: (scan: { multilineTruncated?: boolean }) => scan.multilineTruncated === true,
  summarizeFindings: (findings: Array<{ type: string }>) => findings.map((f) => f.type).join(', '),
}))

// Import AFTER vi.mock declarations.
import {
  reconcileStaleSkills,
  verifyAndReconcileStaleSkill,
  resolveStaleThresholdDays,
  MAINTENANCE_STALE_DEFAULT_DAYS,
  DISCOVERY_STALE_DEFAULT_DAYS,
  STALE_QUARANTINE_DISABLE_ENV,
  type StaleCandidateRow,
} from '../../indexer/stale-reconciliation.ts'
import { resolveMaintenanceStaleThreshold } from '../../indexer/maintenance-helpers.ts'
import { quarantineSkillsBatch } from '../../indexer/_shared/quarantine.ts'
import { buildGitHubHeaders } from '../../indexer/_shared/github-auth.ts'

const mockQuarantineBatch = vi.mocked(quarantineSkillsBatch)
const mockBuildHeaders = vi.mocked(buildGitHubHeaders)

// Fixtures + capture-mock DB

function makeRow(id: string, repo: string | null): StaleCandidateRow {
  return {
    id,
    author: 'acme',
    name: `skill-${id}`,
    repo_url: repo,
    skill_path: null,
    last_seen_at: '2026-06-28T00:00:00.000Z',
  }
}

interface UpdateCapture {
  payload: Record<string, unknown>
  filters: Array<[string, unknown]>
}

/**
 * Chainable Supabase double capturing update payloads + filters. `selectRows`
 * feeds the candidate query; `updateData` controls what each `.update()`
 * chain resolves with (default: one affected row).
 */
function makeDb(opts: {
  selectRows?: StaleCandidateRow[]
  selectError?: { message: string } | null
  updateData?: (c: UpdateCapture) => { data: unknown[] | null; error: { message: string } | null }
}): { db: SupabaseClient; updates: UpdateCapture[]; selectCalls: number[] } {
  const updates: UpdateCapture[] = []
  const selectCalls: number[] = []
  const db = {
    from() {
      return {
        select() {
          selectCalls.push(1)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- chainable test double
          const chain: any = {
            lt: () => chain,
            eq: () => chain,
            order: () => chain,
            limit: async () => ({
              data: opts.selectRows ?? [],
              error: opts.selectError ?? null,
            }),
          }
          return chain
        },
        update(payload: Record<string, unknown>) {
          const capture: UpdateCapture = { payload, filters: [] }
          updates.push(capture)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- chainable test double
          const chain: any = {
            eq(col: string, val: unknown) {
              capture.filters.push([col, val])
              return chain
            },
            select: async () =>
              opts.updateData ? opts.updateData(capture) : { data: [{ id: 'x' }], error: null },
          }
          return chain
        },
      }
    },
  }
  return { db: db as unknown as SupabaseClient, updates, selectCalls }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

// Item 3 — canonical threshold policy

describe('resolveStaleThresholdDays — canonical policy (SMI-5551 item 3)', () => {
  it('caller defaults are 7 (maintenance) and 30 (discovery)', () => {
    expect(MAINTENANCE_STALE_DEFAULT_DAYS).toBe(7)
    expect(DISCOVERY_STALE_DEFAULT_DAYS).toBe(30)
  })

  it('honors any positive finite numeric override', () => {
    expect(resolveStaleThresholdDays(14, 7)).toBe(14)
    expect(resolveStaleThresholdDays(7.5, 30)).toBe(7.5)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['zero', 0],
    ['negative', -3],
    ['string', '7'],
  ])('falls back to the caller default on %s', (_label, raw) => {
    expect(resolveStaleThresholdDays(raw, MAINTENANCE_STALE_DEFAULT_DAYS)).toBe(7)
    expect(resolveStaleThresholdDays(raw, DISCOVERY_STALE_DEFAULT_DAYS)).toBe(30)
  })

  it('resolveMaintenanceStaleThreshold delegates to the canonical resolver', () => {
    expect(resolveMaintenanceStaleThreshold({})).toBe(7)
    expect(resolveMaintenanceStaleThreshold({ staleThresholdDays: 14 })).toBe(14)
    expect(resolveMaintenanceStaleThreshold({ staleThresholdDays: Infinity })).toBe(7)
  })
})

// Item 1 — incident brake

describe('reconcileStaleSkills — incident brake (SMI-5551 item 1)', () => {
  it.each([['1'], ['true'], ['TRUE'], [' true ']])(
    'env %j short-circuits before any query or write',
    async (value) => {
      vi.stubEnv(STALE_QUARANTINE_DISABLE_ENV, value)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { db, updates, selectCalls } = makeDb({ selectRows: [makeRow('r1', null)] })

      const result = await reconcileStaleSkills(db, 7)

      expect(result).toEqual({
        staleQuarantined: 0,
        quarantinedIds: [],
        errors: [],
        verifiedLive: 0,
        transientSkipped: 0,
        maliciousQuarantined: 0,
      })
      expect(selectCalls).toHaveLength(0) // no candidate query
      expect(updates).toHaveLength(0) // no writes
      expect(mockQuarantineBatch).not.toHaveBeenCalled()
      expect(mockBuildHeaders).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(STALE_QUARANTINE_DISABLE_ENV))
    }
  )

  it.each([['0'], [''], ['false']])('env %j does NOT engage the brake', async (value) => {
    vi.stubEnv(STALE_QUARANTINE_DISABLE_ENV, value)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { db, selectCalls } = makeDb({ selectRows: [] })

    await reconcileStaleSkills(db, 7)

    expect(selectCalls).toHaveLength(1) // sweep proceeded to the candidate query
  })
})

// Item 2 — per-candidate verification outcomes

describe('verifyAndReconcileStaleSkill — outcome routing (SMI-5551 item 2)', () => {
  it('unparseable repo_url → confirmed-dead, no write', async () => {
    const { db, updates } = makeDb({})
    const outcome = await verifyAndReconcileStaleSkill(db, makeRow('x', 'not-a-github-url'), {})
    expect(outcome).toBe('confirmed-dead')
    expect(updates).toHaveLength(0)
  })

  it('SKILL.md 404 → confirmed-dead, no write (caller batches the quarantine)', async () => {
    const { db, updates } = makeDb({})
    const outcome = await verifyAndReconcileStaleSkill(
      db,
      makeRow('x', 'https://github.com/acme/gone'),
      {}
    )
    expect(outcome).toBe('confirmed-dead')
    expect(updates).toHaveLength(0)
  })

  it('transient fetch error → transient, row left completely untouched', async () => {
    const { db, updates } = makeDb({})
    const outcome = await verifyAndReconcileStaleSkill(
      db,
      makeRow('x', 'https://github.com/acme/transient'),
      {}
    )
    expect(outcome).toBe('transient')
    expect(updates).toHaveLength(0)
    expect(mockQuarantineBatch).not.toHaveBeenCalled()
  })

  it('live + clean → live-refreshed: CAS heartbeat touch, never quarantined', async () => {
    const { db, updates } = makeDb({})
    const outcome = await verifyAndReconcileStaleSkill(
      db,
      makeRow('x', 'https://github.com/acme/live-clean'),
      {}
    )
    expect(outcome).toBe('live-refreshed')
    expect(updates).toHaveLength(1)
    const touch = updates[0]
    expect(touch.payload).toMatchObject({
      content_hash: 'hash-clean',
      security_score: 0,
    })
    expect(typeof touch.payload.last_seen_at).toBe('string')
    expect(touch.payload).not.toHaveProperty('quarantined')
    // E1-style CAS: guarded on quarantined=false so a concurrent quarantine wins.
    expect(touch.filters).toContainEqual(['id', 'x'])
    expect(touch.filters).toContainEqual(['quarantined', false])
  })

  it('live + clean but CAS lost → cas-skipped', async () => {
    const { db } = makeDb({ updateData: () => ({ data: [], error: null }) })
    const outcome = await verifyAndReconcileStaleSkill(
      db,
      makeRow('x', 'https://github.com/acme/live-clean'),
      {}
    )
    expect(outcome).toBe('cas-skipped')
  })

  it('live + malicious → malicious-quarantined with the REAL finding, not stale', async () => {
    const { db, updates } = makeDb({})
    const outcome = await verifyAndReconcileStaleSkill(
      db,
      makeRow('x', 'https://github.com/acme/malicious'),
      {}
    )
    expect(outcome).toBe('malicious-quarantined')
    expect(updates).toHaveLength(1)
    const q = updates[0]
    expect(q.payload.quarantined).toBe(true)
    expect(q.payload.quarantine_reason).toBe('code_execution')
    expect(q.payload.quarantine_reason).not.toBe('stale')
    expect(q.payload.security_score).toBe(90)
    expect(Array.isArray(q.payload.security_findings)).toBe(true)
    // Fail-closed: matched by id only (no quarantined CAS — end-state wins).
    expect(q.filters).toEqual([['id', 'x']])
  })

  it('malicious write failure → error (row left as-is)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { db } = makeDb({ updateData: () => ({ data: null, error: { message: 'boom' } }) })
    const outcome = await verifyAndReconcileStaleSkill(
      db,
      makeRow('x', 'https://github.com/acme/malicious'),
      {}
    )
    expect(outcome).toBe('error')
    expect(errSpy).toHaveBeenCalled()
  })

  // T2.24 (SMI-6020, design §2.7): a truncated (score 0, multilineTruncated:
  // true) scan on a live row must quarantine — fail-closed — not live-refresh.
  it('live + truncated scan → malicious-quarantined, no security_score key in the update', async () => {
    const { db, updates } = makeDb({})
    const outcome = await verifyAndReconcileStaleSkill(
      db,
      makeRow('x', 'https://github.com/acme/truncated'),
      {}
    )
    expect(outcome).toBe('malicious-quarantined')
    expect(updates).toHaveLength(1)
    const q = updates[0]
    expect(q.payload.quarantined).toBe(true)
    expect(q.payload).not.toHaveProperty('security_score')
    expect(q.payload).not.toHaveProperty('security_findings')
  })
})

// Item 2 — full-sweep routing

describe('reconcileStaleSkills — verification sweep routing (SMI-5551 item 2)', () => {
  it('quarantines ONLY directly-verified terminal rows; transient and live rows survive', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const rows = [
      makeRow('dead-404', 'https://github.com/acme/gone'),
      makeRow('flaky', 'https://github.com/acme/transient'),
      makeRow('alive', 'https://github.com/acme/live-clean'),
      makeRow('evil', 'https://github.com/acme/malicious'),
      makeRow('unparseable', 'not-a-github-url'),
    ]
    const { db, updates } = makeDb({ selectRows: rows })

    const result = await reconcileStaleSkills(db, 7)

    // Terminal rows (404 + parse failure) went through the shared batch
    // helper with the 'stale' reason — exactly as before, nothing else did.
    expect(mockQuarantineBatch).toHaveBeenCalledTimes(1)
    const [, ids, finding, reason] = mockQuarantineBatch.mock.calls[0]
    expect(ids).toEqual(['dead-404', 'unparseable'])
    expect((finding as { type: string }).type).toBe('stale')
    expect(reason).toBe('stale')

    expect(result.staleQuarantined).toBe(2)
    expect(result.maliciousQuarantined).toBe(1)
    expect(result.verifiedLive).toBe(1)
    expect(result.transientSkipped).toBe(1)
    expect(result.errors).toHaveLength(0)
    // Notification set covers stale-dead AND malicious quarantines.
    expect([...result.quarantinedIds].sort()).toEqual(['dead-404', 'evil', 'unparseable'])

    // Row-level writes: one live-touch + one malicious quarantine — the
    // transient row got NO write of any kind (retried next cycle).
    expect(updates).toHaveLength(2)
    const touched = updates.find((u) => !('quarantined' in u.payload))
    expect(touched?.filters).toContainEqual(['id', 'alive'])
    const quarantined = updates.find((u) => u.payload.quarantined === true)
    expect(quarantined?.filters).toContainEqual(['id', 'evil'])
  })

  it('an expired heartbeat ALONE never quarantines (live rows all refresh)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const rows = [
      makeRow('a', 'https://github.com/acme/live-clean'),
      makeRow('b', 'https://github.com/acme/live-clean'),
    ]
    const { db } = makeDb({ selectRows: rows })

    const result = await reconcileStaleSkills(db, 7)

    expect(mockQuarantineBatch).not.toHaveBeenCalled()
    expect(result.staleQuarantined).toBe(0)
    expect(result.verifiedLive).toBe(2)
    expect(result.quarantinedIds).toEqual([])
  })

  it('returns the empty-sweep shape without building headers when no candidates', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { db } = makeDb({ selectRows: [] })

    const result = await reconcileStaleSkills(db, 7)

    expect(result.staleQuarantined).toBe(0)
    expect(mockBuildHeaders).not.toHaveBeenCalled()
  })

  it('fails safe when GitHub headers cannot be built: error recorded, ZERO quarantines', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    mockBuildHeaders.mockRejectedValueOnce(new Error('no token'))
    const { db, updates } = makeDb({
      selectRows: [makeRow('dead-404', 'https://github.com/acme/gone')],
    })

    const result = await reconcileStaleSkills(db, 7)

    expect(result.staleQuarantined).toBe(0)
    expect(result.errors.some((e) => e.includes('no token'))).toBe(true)
    expect(mockQuarantineBatch).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })

  it('query error returns the zero-result shape (unchanged early-out)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { db } = makeDb({ selectError: { message: 'db down' } })

    const result = await reconcileStaleSkills(db, 7)

    expect(result.staleQuarantined).toBe(0)
    expect(errSpy).toHaveBeenCalled()
    expect(mockQuarantineBatch).not.toHaveBeenCalled()
  })
})

// Deno-twin alignment guards (source-text; the esm.sh twin can't be executed
// under Node vitest for its env/read paths — mirrors the SMI-5358 pattern in
// stale-reconciliation-boundary.test.ts).

describe('SMI-5551 twin alignment — Deno sources carry the same three items', () => {
  const denoStale = resolve(REPO_ROOT, 'supabase/functions/indexer/stale-reconciliation.ts')
  const denoFetch = resolve(REPO_ROOT, 'supabase/functions/_shared/skill-md-fetch.ts')
  const denoMaint = resolve(REPO_ROOT, 'supabase/functions/indexer/maintenance-helpers.ts')
  const denoDisc = resolve(REPO_ROOT, 'supabase/functions/indexer/discovery-orchestrator.ts')

  it.skipIf(isGitCryptEncrypted(denoStale))(
    'Deno stale-reconciliation has the brake, verification, and canonical resolver',
    () => {
      const src = readFileSync(denoStale, 'utf8')
      expect(src).toContain('STALE_QUARANTINE_DISABLE')
      expect(src).toContain('fetchSkillMd(')
      expect(src).toContain("fetched.kind === 'transient'")
      expect(src).toContain('verifyAndReconcileStaleSkill')
      expect(src).toContain('export function resolveStaleThresholdDays')
      // The shared batch helper is fed ONLY the directly-verified dead set.
      expect(src.replace(/\s+/g, ' ')).toContain(
        'quarantineSkillsBatch( supabase, confirmedDeadIds,'
      )
    }
  )

  it.skipIf(isGitCryptEncrypted(denoFetch))(
    'Deno skill-md-fetch twin exists with the transient/not-found split',
    () => {
      const src = readFileSync(denoFetch, 'utf8')
      expect(src).toContain('export function parseSkillMdUrl')
      expect(src).toContain("kind: 'transient'")
      expect(src).toContain("kind: 'not-found'")
    }
  )

  it.skipIf(isGitCryptEncrypted(denoMaint))(
    'Deno maintenance-helpers delegates to the canonical resolver',
    () => {
      const src = readFileSync(denoMaint, 'utf8')
      expect(src).toContain('resolveStaleThresholdDays(')
      expect(src).toContain('MAINTENANCE_STALE_DEFAULT_DAYS')
    }
  )

  it.skipIf(isGitCryptEncrypted(denoDisc))(
    'Deno discovery-orchestrator delegates to the canonical resolver',
    () => {
      const src = readFileSync(denoDisc, 'utf8')
      expect(src).toContain('resolveStaleThresholdDays(')
      expect(src).toContain('DISCOVERY_STALE_DEFAULT_DAYS')
    }
  )

  it('Node phase-split delegates to the canonical resolver (runs in every lane)', () => {
    const src = readFileSync(
      resolve(REPO_ROOT, 'scripts/indexer/discovery-orchestrator.phase-split.ts'),
      'utf8'
    )
    expect(src).toContain('resolveStaleThresholdDays(')
    expect(src).toContain('DISCOVERY_STALE_DEFAULT_DAYS')
  })
})
