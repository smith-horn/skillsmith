/**
 * SMI-5849 AC-3: prehash-match content_hash-repair branch (Node twin, functional).
 * @module scripts/tests/indexer/content-hash-repair-skip-gate
 *
 * `runUpsertPhase`'s first skip-gate (prehash match on `repo_updated_at`)
 * normally takes the skinny path (a direct per-row UPDATE, no full
 * `repositoryToSkill` computation, no upsert). SMI-5849 root-caused a bug
 * where `content_hash` landed NULL for ~99% of the registry (the
 * subdirectory-search discovery path never set `repo.defaultBranch`, so the
 * upsert phase's `getCachedValidation` cache lookup always missed).
 *
 * AC-3 repairs that NULL "for free" — when the prehash still matches (the
 * repo is otherwise unchanged) but the existing row's `content_hash` is NULL
 * AND this run's discovery phase already cached a validation for the SAME
 * repo (a pure map lookup, zero extra network I/O), the gate falls through
 * to the full re-index path so the cached content_hash gets persisted.
 * Otherwise (content_hash already set, OR no cached validation) the skinny
 * path is completely unchanged.
 *
 * This is the Node-tree counterpart of
 * supabase/functions/indexer/indexer-runners.skip-gate.test.ts's SMI-5849
 * suite. See `last-seen-touch-gate.test.ts`'s header for why a dedicated
 * mock (rather than the requarantine-e2e suite's) is used.
 */

import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { runUpsertPhase } from '../../indexer/indexer-runners.ts'
import { newRateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'
import type { GitHubRepository } from '../../indexer/topic-search.ts'
import type { SkillMdValidation } from '../../indexer/skill-processor.ts'

interface ExistingRow {
  id: string
  content_hash: string | null
  last_seen_at: string | null
  repo_updated_at: string | null
  /** SMI-5866: threaded into the prefetch select alongside content_hash. */
  security_score: number | null
}

function repairRepo(url: string, updatedAt: string): GitHubRepository {
  return {
    owner: 'acme',
    name: 'skill-x',
    fullName: 'acme/skill-x',
    description: null,
    url,
    stars: 0,
    forks: 0,
    topics: [],
    updatedAt,
    defaultBranch: 'main',
    installable: true,
    repoName: 'skill-x',
    discoveryPath: 'topic_search:mcp',
  }
}

function buildDb(
  existingByUrl: Map<string, ExistingRow>,
  upserted: Array<Record<string, unknown>>,
  skinnyUpdates: Array<{ url: string; patch: Record<string, unknown> }>
): SupabaseClient {
  const skillsHandle = {
    select() {
      return {
        in(col: string, vals: string[]) {
          if (col === 'id') {
            // SMI-3540 quarantine probe — none of this suite's fixtures are quarantined.
            return { eq: () => Promise.resolve({ data: [], error: null }) }
          }
          const data = vals
            .map((u) => {
              const hit = existingByUrl.get(u)
              return hit
                ? {
                    id: hit.id,
                    repo_url: u,
                    content_hash: hit.content_hash,
                    last_seen_at: hit.last_seen_at,
                    repo_updated_at: hit.repo_updated_at,
                    security_score: hit.security_score,
                  }
                : null
            })
            .filter((r): r is NonNullable<typeof r> => r !== null)
          return Promise.resolve({ data })
        },
      }
    },
    upsert(rows: Record<string, unknown> | Record<string, unknown>[]) {
      const arr = Array.isArray(rows) ? rows : [rows]
      upserted.push(...arr)
      return {
        select: () =>
          Promise.resolve({ data: arr.map((r) => ({ repo_url: r.repo_url })), error: null }),
      }
    },
    update(patch: Record<string, unknown>) {
      return {
        eq(col: string, val: string) {
          if (col === 'repo_url') skinnyUpdates.push({ url: val, patch })
          return Promise.resolve({ error: null })
        },
        in: () => Promise.resolve({ error: null }),
      }
    },
    insert: () => Promise.resolve({ error: null }),
    delete: () => ({ in: () => Promise.resolve({ error: null }) }),
  }

  const db = {
    from(table: string) {
      if (table === 'audit_logs') {
        return { insert: () => Promise.resolve({ error: null }) }
      }
      return skillsHandle
    },
  }

  return db as unknown as SupabaseClient
}

describe('SMI-5849 AC-3: content_hash NULL-repair on the prehash skip-gate (Node twin)', () => {
  it('(a) existing content_hash already non-NULL — stays on the skinny path (no regression)', async () => {
    const repoUpdatedAt = '2026-07-01T00:00:00Z'
    const url = 'https://github.com/acme/skill-x'
    const existingByUrl = new Map<string, ExistingRow>([
      [
        url,
        {
          id: 'id-1',
          content_hash: 'already-set-hash',
          last_seen_at: new Date().toISOString(),
          repo_updated_at: repoUpdatedAt,
          // SMI-5866: security_score is ALSO already set — this test isolates
          // the content_hash-only regression; see test (d) for the score-only case.
          security_score: 5,
        },
      ],
    ])
    const upserted: Array<Record<string, unknown>> = []
    const skinnyUpdates: Array<{ url: string; patch: Record<string, unknown> }> = []
    const db = buildDb(existingByUrl, upserted, skinnyUpdates)

    // Cache DOES hold a validation for this repo, but content_hash and
    // security_score are already non-NULL — the repair check must never even
    // consult it.
    const validationCache = new Map<string, SkillMdValidation>([
      ['acme/skill-x/main', { valid: true, errors: [], content: '# x', contentHash: 'unused' }],
    ])

    const result = await runUpsertPhase(
      db,
      [repairRepo(url, repoUpdatedAt)],
      new Map(),
      validationCache,
      false,
      newRateLimitTelemetry()
    )

    expect(result.errors).toEqual([])
    expect(result.unchanged).toBe(1)
    expect(skinnyUpdates).toHaveLength(1)
    expect(upserted).toHaveLength(0)
  })

  it('(b) existing content_hash NULL, no cached validation — stays on the skinny path, zero extra calls', async () => {
    const repoUpdatedAt = '2026-07-01T00:00:00Z'
    const url = 'https://github.com/acme/skill-x'
    const existingByUrl = new Map<string, ExistingRow>([
      [
        url,
        {
          id: 'id-1',
          content_hash: null,
          last_seen_at: new Date().toISOString(),
          repo_updated_at: repoUpdatedAt,
          security_score: null,
        },
      ],
    ])
    const upserted: Array<Record<string, unknown>> = []
    const skinnyUpdates: Array<{ url: string; patch: Record<string, unknown> }> = []
    const db = buildDb(existingByUrl, upserted, skinnyUpdates)

    const result = await runUpsertPhase(
      db,
      [repairRepo(url, repoUpdatedAt)],
      new Map(),
      new Map(), // validationCache empty — cache miss
      false,
      newRateLimitTelemetry()
    )

    expect(result.errors).toEqual([])
    expect(result.unchanged).toBe(1)
    expect(skinnyUpdates).toHaveLength(1)
    expect(upserted).toHaveLength(0)
  })

  it('(c) existing content_hash NULL, cached validation available — falls through to the full path', async () => {
    const repoUpdatedAt = '2026-07-01T00:00:00Z'
    const url = 'https://github.com/acme/skill-x'
    const existingByUrl = new Map<string, ExistingRow>([
      [
        url,
        {
          id: 'id-1',
          content_hash: null,
          last_seen_at: new Date().toISOString(),
          repo_updated_at: repoUpdatedAt,
          security_score: null,
        },
      ],
    ])
    const upserted: Array<Record<string, unknown>> = []
    const skinnyUpdates: Array<{ url: string; patch: Record<string, unknown> }> = []
    const db = buildDb(existingByUrl, upserted, skinnyUpdates)

    // Cache key matches getCachedValidation(repo.owner, repo.repoName,
    // repo.defaultBranch, cache, repo.skillPath) with skillPath undefined.
    const validationCache = new Map<string, SkillMdValidation>([
      [
        'acme/skill-x/main',
        {
          valid: true,
          errors: [],
          content: '# Skill X\n',
          contentHash: 'repaired-hash-xyz',
        },
      ],
    ])

    const result = await runUpsertPhase(
      db,
      [repairRepo(url, repoUpdatedAt)],
      new Map(),
      validationCache,
      false,
      newRateLimitTelemetry()
    )

    expect(result.errors).toEqual([])
    // Full path: NOT counted as unchanged, no skinny update; a real upsert fires.
    expect(result.unchanged).toBe(0)
    expect(skinnyUpdates).toHaveLength(0)
    expect(upserted).toHaveLength(1)
    expect(upserted[0].content_hash).toBe('repaired-hash-xyz')
  })

  // SMI-5866: the Gate-1 analog of the Gate-2 latch fix — SMI-5849 decoupled
  // content_hash from securityScan, so a row can have content_hash already set
  // while security_score is still NULL. The repair check must fall through on
  // EITHER field missing, not content_hash alone.
  it('(d) existing content_hash non-NULL, security_score NULL, cached validation available — falls through to the full path', async () => {
    const repoUpdatedAt = '2026-07-01T00:00:00Z'
    const url = 'https://github.com/acme/skill-x'
    const existingByUrl = new Map<string, ExistingRow>([
      [
        url,
        {
          id: 'id-1',
          content_hash: 'already-set-hash',
          last_seen_at: new Date().toISOString(),
          repo_updated_at: repoUpdatedAt,
          security_score: null, // the manufactured-latch shape (SMI-5849)
        },
      ],
    ])
    const upserted: Array<Record<string, unknown>> = []
    const skinnyUpdates: Array<{ url: string; patch: Record<string, unknown> }> = []
    const db = buildDb(existingByUrl, upserted, skinnyUpdates)

    const validationCache = new Map<string, SkillMdValidation>([
      ['acme/skill-x/main', { valid: true, errors: [], content: '# Skill X\n', contentHash: 'x' }],
    ])

    const result = await runUpsertPhase(
      db,
      [repairRepo(url, repoUpdatedAt)],
      new Map(),
      validationCache,
      false,
      newRateLimitTelemetry()
    )

    expect(result.errors).toEqual([])
    // Full path fires despite content_hash already being set — score repairs.
    expect(result.unchanged).toBe(0)
    expect(skinnyUpdates).toHaveLength(0)
    expect(upserted).toHaveLength(1)
  })
})
