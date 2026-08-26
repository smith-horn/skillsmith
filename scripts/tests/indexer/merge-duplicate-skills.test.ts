/**
 * SMI-5898 Wave 2 Step 4: tests for `merge-duplicate-skills.ts` against a
 * real ephemeral Postgres instance (not mocked — this repo's testing bar
 * for PL/pgSQL-adjacent logic). See `merge-duplicate-skills.test-helpers.ts`
 * for how to stand one up.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import {
  queryRows,
  testConnParamsFromEnv,
  type PgConnParams,
} from '../../indexer/smi5879-census.pg.ts'
import {
  resetSchema,
  insertSkill,
  prePushNoLiveTestPg,
} from './merge-duplicate-skills.test-helpers.ts'
import {
  findDuplicateGroups,
  assertGuardrail,
  buildReversalManifest,
  planGroup,
  GUARDRAIL_MAX_LOSERS,
} from '../../indexer/merge-duplicate-skills.helpers.ts'
import { runMerge } from '../../indexer/merge-duplicate-skills.ts'

describe.skipIf(prePushNoLiveTestPg)('merge-duplicate-skills (live Postgres)', () => {
  let conn: PgConnParams

  beforeAll(async () => {
    const base = testConnParamsFromEnv()
    if (!base) throw new Error('unreachable — describe.skipIf guards this')
    conn = await resetSchema(base, 'merge_duplicate_skills_test')
  })

  it('findDuplicateGroups groups by repo_url_canonical and ranks the most-recently-seen row as survivor', async () => {
    const loserId = await insertSkill(conn, {
      repoUrl: 'https://github.com/Owner/Repo/tree/main/skill-a',
      author: 'owner',
      lastSeenAt: '2026-01-01T00:00:00Z',
    })
    const survivorId = await insertSkill(conn, {
      repoUrl: 'https://github.com/owner/repo/tree/main/skill-a',
      author: 'owner',
      lastSeenAt: '2026-06-01T00:00:00Z',
    })

    const groups = await findDuplicateGroups(conn)
    const group = groups.find(
      (g) => g.survivor.id === survivorId || g.losers.some((l) => l.id === survivorId)
    )
    expect(group).toBeDefined()
    expect(group!.survivor.id).toBe(survivorId)
    expect(group!.losers.map((l) => l.id)).toEqual([loserId])
  })

  it('a quarantined row never wins even with a later last_seen_at', async () => {
    const cleanId = await insertSkill(conn, {
      repoUrl: 'https://github.com/quarantest/repo/tree/main/x',
      lastSeenAt: '2026-01-01T00:00:00Z',
      quarantined: false,
    })
    const quarantinedId = await insertSkill(conn, {
      repoUrl: 'https://github.com/quarantest/repo/tree/main/x'.toLowerCase(),
      lastSeenAt: '2026-06-01T00:00:00Z',
      quarantined: true,
    })

    const groups = await findDuplicateGroups(conn)
    const group = groups.find((g) =>
      [g.survivor.id, ...g.losers.map((l) => l.id)].includes(cleanId)
    )
    expect(group!.survivor.id).toBe(cleanId)
    expect(group!.losers.map((l) => l.id)).toContain(quarantinedId)
  })

  it('assertGuardrail throws when total losers exceed the guardrail', () => {
    // +2 items so slice(1) (the losers) is GUARDRAIL_MAX_LOSERS + 1 — genuinely over, not exactly at the line.
    const bogus = Array.from({ length: GUARDRAIL_MAX_LOSERS + 2 }, (_, i) => ({
      id: `loser-${i}`,
      author: null,
      name: 'x',
      quarantined: false,
      last_seen_at: null,
      trust_tier: null,
      stars: null,
      updated_at: null,
      repo_url: null,
      repo_url_canonical: 'x',
    }))
    expect(() =>
      assertGuardrail([{ repoUrlCanonical: 'x', survivor: bogus[0], losers: bogus.slice(1) }])
    ).toThrow(/guardrail/)
  })

  it('assertGuardrail does not throw at or under the guardrail', () => {
    const bogus = Array.from({ length: GUARDRAIL_MAX_LOSERS }, (_, i) => ({
      id: `loser-${i}`,
      author: null,
      name: 'x',
      quarantined: false,
      last_seen_at: null,
      trust_tier: null,
      stars: null,
      updated_at: null,
      repo_url: null,
      repo_url_canonical: 'x',
    }))
    expect(() =>
      assertGuardrail([{ repoUrlCanonical: 'x', survivor: bogus[0], losers: bogus.slice(1) }])
    ).not.toThrow()
  })

  it('end-to-end --apply: merges categories, adopts an empty-survivor cache row, preserves suppression, recomputes is_complete, and deletes the loser', async () => {
    const survivorId = await insertSkill(conn, {
      repoUrl: 'https://github.com/e2e/Repo/tree/main/x',
      lastSeenAt: '2026-06-01T00:00:00Z',
    })
    const loserId = await insertSkill(conn, {
      repoUrl: 'https://github.com/e2e/repo/tree/main/x',
      lastSeenAt: '2026-01-01T00:00:00Z',
    })

    await queryRows(conn, `INSERT INTO categories (id) VALUES ('cat-a'), ('cat-b');`)
    await queryRows(
      conn,
      `INSERT INTO skill_categories (skill_id, category_id) VALUES ('${loserId}', 'cat-a'), ('${loserId}', 'cat-b');`
    )
    // Loser has a skills_optimized row, survivor has none — should be adopted.
    await queryRows(conn, `INSERT INTO skills_optimized (skill_id) VALUES ('${loserId}');`)
    // Loser is suppressed; survivor is not — suppression must survive onto the survivor.
    await queryRows(
      conn,
      `INSERT INTO outreach_suppressions (skill_id, suppressed_at) VALUES ('${loserId}', '2026-01-01T00:00:00Z');`
    )
    // Two approvals on the loser from distinct reviewers, required_approvals=2 — should complete after re-point.
    await queryRows(
      conn,
      `INSERT INTO quarantine_approvals (skill_id, reviewer_id, required_approvals, is_complete)
       VALUES ('${loserId}', gen_random_uuid(), 2, false), ('${loserId}', gen_random_uuid(), 2, false);`
    )

    const db = {
      from: () => ({ insert: async () => ({ data: null, error: null }) }),
    } as unknown as Parameters<typeof runMerge>[1]

    const dryRun = await runMerge(conn, db, {
      apply: false,
      manifestPath: '/tmp/smi5898-merge-test-dry.json',
    })
    expect(dryRun.groups).toBeGreaterThanOrEqual(1)

    const result = await runMerge(conn, db, {
      apply: true,
      manifestPath: '/tmp/smi5898-merge-test-apply.json',
    })
    expect(result.losersRemoved).toBeGreaterThanOrEqual(1)
    expect(result.suppressionCountBefore).toBe(result.suppressionCountAfter)

    const loserGone = await queryRows(conn, `SELECT 1 FROM skills WHERE id = '${loserId}';`)
    expect(loserGone).toEqual([])

    const survivorCats = await queryRows(
      conn,
      `SELECT category_id FROM skill_categories WHERE skill_id = '${survivorId}' ORDER BY category_id;`
    )
    expect(survivorCats.map((r) => r[0])).toEqual(['cat-a', 'cat-b'])

    const survivorOptimized = await queryRows(
      conn,
      `SELECT 1 FROM skills_optimized WHERE skill_id = '${survivorId}';`
    )
    expect(survivorOptimized).toHaveLength(1)

    const survivorSuppressed = await queryRows(
      conn,
      `SELECT 1 FROM outreach_suppressions WHERE skill_id = '${survivorId}';`
    )
    expect(survivorSuppressed).toHaveLength(1)

    // No ::text cast — a bare boolean column renders 't'/'f' in psql's unaligned
    // output, unlike an explicit ::text cast (which renders 'true'/'false').
    const survivorComplete = await queryRows(
      conn,
      `SELECT is_complete FROM quarantine_approvals WHERE skill_id = '${survivorId}' LIMIT 1;`
    )
    expect(survivorComplete[0][0]).toBe('t')
  })

  it('planGroup reports skill_categories rows already on the survivor as skippedOnConflict, not rePointed', async () => {
    const survivorId = await insertSkill(conn, {
      repoUrl: 'https://github.com/plangroup/Repo/tree/main/y',
      lastSeenAt: '2026-06-01T00:00:00Z',
    })
    const loserId = await insertSkill(conn, {
      repoUrl: 'https://github.com/plangroup/repo/tree/main/y',
      lastSeenAt: '2026-01-01T00:00:00Z',
    })
    await queryRows(
      conn,
      `INSERT INTO categories (id) VALUES ('cat-shared') ON CONFLICT DO NOTHING;`
    )
    await queryRows(
      conn,
      `INSERT INTO skill_categories (skill_id, category_id) VALUES ('${survivorId}', 'cat-shared'), ('${loserId}', 'cat-shared');`
    )

    const groups = await findDuplicateGroups(conn)
    const group = groups.find((g) => g.survivor.id === survivorId)!
    const movements = await planGroup(conn, group)
    const catMovement = movements.find((m) => m.table === 'skill_categories')!
    expect(catMovement.rePointed).toBe(0)
    expect(catMovement.skippedOnConflict).toBe(1)
  })

  it('buildReversalManifest captures full before-images of loser rows and touched dependent-table rows', async () => {
    const survivorId = await insertSkill(conn, {
      repoUrl: 'https://github.com/manifest/Repo/tree/main/z',
      lastSeenAt: '2026-06-01T00:00:00Z',
    })
    const loserId = await insertSkill(conn, {
      repoUrl: 'https://github.com/manifest/repo/tree/main/z',
      lastSeenAt: '2026-01-01T00:00:00Z',
    })
    await queryRows(conn, `INSERT INTO outreach_events (skill_id) VALUES ('${loserId}');`)

    const groups = await findDuplicateGroups(conn)
    const group = groups.find((g) => g.survivor.id === survivorId)!
    const manifest = await buildReversalManifest(conn, [group])

    expect(manifest.rows.skills).toHaveLength(1)
    expect((manifest.rows.skills[0] as { id: string }).id).toBe(loserId)
    expect(manifest.rows.outreach_events.length).toBeGreaterThanOrEqual(1)
    expect(manifest.groups).toEqual([
      { repoUrlCanonical: group.repoUrlCanonical, survivorId, loserIds: [loserId] },
    ])
  })
})
