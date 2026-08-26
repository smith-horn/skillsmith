/**
 * SMI-5898 Wave 2 Step 4: types + per-group query/mutation helpers for
 * `merge-duplicate-skills.ts`, split out to keep that file under the
 * repo's 500-line standard (`scripts/check-file-length.mjs`'s convention).
 * See that file's own header for the full design rationale (psql shell-out,
 * atomicity, reversal-manifest scope).
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { type PgConnParams, queryRows, queryScalar, nullable } from './smi5879-census.pg.ts'

/** R4 guardrail (design doc §B.3.3) — abort if the key ever selects more than a hand-count of rows. */
export const GUARDRAIL_MAX_LOSERS = 500

/** The six tables with a real or soft reference into `skills.id`, per design doc §B.3.2. */
export const DEPENDENT_TABLES = [
  'skill_categories',
  'skills_optimized',
  'skill_transformations',
  'outreach_suppressions',
  'outreach_events',
  'quarantine_approvals',
] as const
export type DependentTable = (typeof DEPENDENT_TABLES)[number]

/** UUID-shaped guard for any id interpolated directly into a generated SQL script (defense-in-depth — these come from our own prior read, never external input). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function assertUuid(id: string, label: string): string {
  if (!UUID_RE.test(id))
    throw new Error(`[merge-duplicate-skills] refusing non-UUID ${label}: "${id}"`)
  return id
}

/** `ARRAY['id1','id2',...]::text[]` literal, validating every id is UUID-shaped first. */
export function idArrayLiteral(ids: string[], label: string): string {
  const quoted = ids.map((id) => `'${assertUuid(id, label)}'`)
  return `ARRAY[${quoted.join(',')}]::text[]`
}

/** A single `skills` row as read for grouping/ranking. */
export interface SkillRow {
  id: string
  repo_url_canonical: string
  repo_url: string | null
  author: string | null
  name: string
  quarantined: boolean
  last_seen_at: string | null
  trust_tier: string | null
  stars: number | null
  updated_at: string | null
}

/** One duplicate group: a survivor plus its losers, ranked per the canonical survivor-selection order. */
export interface DuplicateGroup {
  repoUrlCanonical: string
  survivor: SkillRow
  losers: SkillRow[]
}

/** Per-table row-movement counts for one group, for the dry-run report. */
export interface TableMovement {
  table: DependentTable
  rePointed: number
  discarded: number
  skippedOnConflict: number
}

export interface QuarantineApprovalDelta {
  skillId: string
  before: boolean
  after: boolean
}

export interface ReversalManifest {
  createdAt: string
  groups: Array<{
    repoUrlCanonical: string
    survivorId: string
    loserIds: string[]
  }>
  /** Full pre-merge row snapshots, keyed by table name. */
  rows: Record<'skills' | DependentTable, unknown[]>
}

export interface MergeCounts {
  groups: number
  losersRemoved: number
  tableMovements: TableMovement[]
  isCompleteDeltas: QuarantineApprovalDelta[]
  suppressionCountBefore: number
  suppressionCountAfter: number
}

const RANKING_ORDER_SQL = `
  (quarantined IS TRUE),
  last_seen_at DESC NULLS LAST,
  (CASE trust_tier
     WHEN 'verified' THEN 0 WHEN 'curated' THEN 1
     WHEN 'community' THEN 2 WHEN 'experimental' THEN 3 ELSE 4 END),
  stars DESC NULLS LAST, updated_at DESC NULLS LAST, id
`

/**
 * Find every duplicate group under `repo_url_canonical`, with the survivor
 * ranked first per the canonical survivor-selection order (reused verbatim
 * from `20260726000000_skill_update_drift_detection.sql:411-426`, the same
 * order the database already treats as canonical, so nothing else in the
 * system changes which row it resolves to).
 */
export async function findDuplicateGroups(conn: PgConnParams): Promise<DuplicateGroup[]> {
  const rows = await queryRows(
    conn,
    `
    WITH dup_keys AS (
      SELECT repo_url_canonical
      FROM skills
      WHERE repo_url_canonical IS NOT NULL
      GROUP BY repo_url_canonical
      HAVING count(*) > 1
    ),
    ranked AS (
      SELECT
        s.id, s.repo_url_canonical, s.repo_url, s.author, s.name, s.quarantined,
        s.last_seen_at, s.trust_tier, s.stars, s.updated_at,
        row_number() OVER (PARTITION BY s.repo_url_canonical ORDER BY ${RANKING_ORDER_SQL}) AS rn
      FROM skills s
      JOIN dup_keys d USING (repo_url_canonical)
    )
    SELECT id, repo_url_canonical, repo_url, author, name, quarantined::text,
           last_seen_at, trust_tier, stars::text, updated_at, rn::text
    FROM ranked ORDER BY repo_url_canonical, rn;
    `
  )

  const byKey = new Map<string, Array<SkillRow & { rn: number }>>()
  for (const r of rows) {
    const row: SkillRow & { rn: number } = {
      id: r[0],
      repo_url_canonical: r[1],
      repo_url: nullable(r[2]),
      author: nullable(r[3]),
      name: r[4],
      // NOTE: the query casts quarantined::text explicitly, which renders as
      // 'true'/'false' (a bare, uncast boolean column would render 't'/'f' —
      // a real bug caught here at implementation time, since nothing else in
      // this file happened to assert on SkillRow.quarantined's parsed value).
      quarantined: r[5] === 'true',
      last_seen_at: nullable(r[6]),
      trust_tier: nullable(r[7]),
      stars: nullable(r[8]) === null ? null : Number(r[8]),
      updated_at: nullable(r[9]),
      rn: Number(r[10]),
    }
    const list = byKey.get(row.repo_url_canonical) ?? []
    list.push(row)
    byKey.set(row.repo_url_canonical, list)
  }

  const groups: DuplicateGroup[] = []
  for (const [repoUrlCanonical, members] of byKey) {
    const survivor = members.find((m) => m.rn === 1)
    if (!survivor)
      throw new Error(`[merge-duplicate-skills] group ${repoUrlCanonical} has no rn=1 row — bug`)
    const losers = members.filter((m) => m.rn !== 1)
    groups.push({ repoUrlCanonical, survivor, losers })
  }
  return groups
}

/** R4 guardrail — total rows that would be removed from `skills`. Throws if it exceeds {@link GUARDRAIL_MAX_LOSERS}. */
export function assertGuardrail(groups: DuplicateGroup[]): void {
  const total = groups.reduce((sum, g) => sum + g.losers.length, 0)
  if (total > GUARDRAIL_MAX_LOSERS) {
    throw new Error(
      `[merge-duplicate-skills] ABORT: merge would remove ${total} rows (guardrail ${GUARDRAIL_MAX_LOSERS}). Re-derive the key — this is not the expected single-repo-rename shape.`
    )
  }
}

export function allLoserIds(groups: DuplicateGroup[]): string[] {
  return groups.flatMap((g) => g.losers.map((l) => l.id))
}
export function allSurvivorIds(groups: DuplicateGroup[]): string[] {
  return groups.map((g) => g.survivor.id)
}

/**
 * Snapshot every row in the six dependent tables belonging to any loser OR
 * survivor, plus every loser's own `skills` row — the full before-image the
 * reversal manifest needs (see `merge-duplicate-skills.ts`'s "Reversal
 * manifest scope" header note). Uses `row_to_json` so the manifest captures
 * every column without this script needing to enumerate each table's
 * schema by hand.
 */
export async function buildReversalManifest(
  conn: PgConnParams,
  groups: DuplicateGroup[]
): Promise<ReversalManifest> {
  const loserIds = allLoserIds(groups)
  const survivorIds = allSurvivorIds(groups)
  const allIds = [...loserIds, ...survivorIds]

  const rows: ReversalManifest['rows'] = {
    skills: [],
    skill_categories: [],
    skills_optimized: [],
    skill_transformations: [],
    outreach_suppressions: [],
    outreach_events: [],
    quarantine_approvals: [],
  }

  if (loserIds.length > 0) {
    const idArr = idArrayLiteral(loserIds, 'loser id')
    const raw = await queryRows(
      conn,
      `SELECT row_to_json(t)::text FROM (SELECT * FROM skills WHERE id = ANY(${idArr})) t;`
    )
    rows.skills = raw.map((r) => JSON.parse(r[0]))
  }

  if (allIds.length > 0) {
    const idArr = idArrayLiteral(allIds, 'skill id')
    for (const table of DEPENDENT_TABLES) {
      const raw = await queryRows(
        conn,
        `SELECT row_to_json(t)::text FROM (SELECT * FROM ${table} WHERE skill_id = ANY(${idArr})) t;`
      )
      rows[table] = raw.map((r) => JSON.parse(r[0]))
    }
  }

  return {
    createdAt: new Date().toISOString(),
    groups: groups.map((g) => ({
      repoUrlCanonical: g.repoUrlCanonical,
      survivorId: g.survivor.id,
      loserIds: g.losers.map((l) => l.id),
    })),
    rows,
  }
}

/** Write the reversal manifest to disk. Throws (does not swallow) on any write failure — `--apply` must refuse to proceed. */
export function writeReversalManifest(manifest: ReversalManifest, filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(manifest, null, 2), 'utf8')
}

/** Read-only per-table movement plan for one group (used by dry-run; apply computes the same numbers from the actual mutation results). */
export async function planGroup(
  conn: PgConnParams,
  group: DuplicateGroup
): Promise<TableMovement[]> {
  const survivorId = assertUuid(group.survivor.id, 'survivor id')
  const loserIds = group.losers.map((l) => assertUuid(l.id, 'loser id'))
  const loserArr = idArrayLiteral(loserIds, 'loser id')
  const movements: TableMovement[] = []

  // 1. skill_categories — union insert ON CONFLICT DO NOTHING, then drop losers' rows.
  {
    const loserCats = await queryRows(
      conn,
      `SELECT category_id FROM skill_categories WHERE skill_id = ANY(${loserArr});`
    )
    const survivorCats = new Set(
      (
        await queryRows(
          conn,
          `SELECT category_id FROM skill_categories WHERE skill_id = '${survivorId}';`
        )
      ).map((r) => r[0])
    )
    const wouldInsert = loserCats.filter((r) => !survivorCats.has(r[0])).length
    movements.push({
      table: 'skill_categories',
      rePointed: wouldInsert,
      discarded: 0,
      skippedOnConflict: loserCats.length - wouldInsert,
    })
  }

  // 2 & 3. skills_optimized / skill_transformations — survivor wins; adopt only if survivor has none.
  for (const table of ['skills_optimized', 'skill_transformations'] as const) {
    const survivorHas =
      (await queryScalar(conn, `SELECT 1 FROM ${table} WHERE skill_id = '${survivorId}';`)) !== null
    const loserCount = Number(
      (await queryScalar(
        conn,
        `SELECT count(*) FROM ${table} WHERE skill_id = ANY(${loserArr});`
      )) ?? '0'
    )
    movements.push({
      table,
      rePointed: !survivorHas && loserCount > 0 ? 1 : 0,
      discarded: !survivorHas && loserCount > 0 ? loserCount - 1 : loserCount,
      skippedOnConflict: 0,
    })
  }

  // 4. outreach_suppressions — sticky: re-point the earliest-suppressed row, drop the rest.
  {
    const survivorHas =
      (await queryScalar(
        conn,
        `SELECT 1 FROM outreach_suppressions WHERE skill_id = '${survivorId}';`
      )) !== null
    const loserCount = Number(
      (await queryScalar(
        conn,
        `SELECT count(*) FROM outreach_suppressions WHERE skill_id = ANY(${loserArr});`
      )) ?? '0'
    )
    movements.push({
      table: 'outreach_suppressions',
      rePointed: !survivorHas && loserCount > 0 ? 1 : 0,
      discarded: 0,
      skippedOnConflict: survivorHas ? loserCount : Math.max(loserCount - 1, 0),
    })
  }

  // 5. outreach_events — re-point all, dedupe none.
  {
    const n = Number(
      (await queryScalar(
        conn,
        `SELECT count(*) FROM outreach_events WHERE skill_id = ANY(${loserArr});`
      )) ?? '0'
    )
    movements.push({ table: 'outreach_events', rePointed: n, discarded: 0, skippedOnConflict: 0 })
  }

  // 6. quarantine_approvals — re-point all, is_complete recomputed separately.
  {
    const n = Number(
      (await queryScalar(
        conn,
        `SELECT count(*) FROM quarantine_approvals WHERE skill_id = ANY(${loserArr});`
      )) ?? '0'
    )
    movements.push({
      table: 'quarantine_approvals',
      rePointed: n,
      discarded: 0,
      skippedOnConflict: 0,
    })
  }

  return movements
}

/** `quarantine_approvals.is_complete` before-state for a skill, per design doc §B.3.2: `COUNT(DISTINCT reviewer_id) >= required_approvals`. */
export async function isCompleteFor(conn: PgConnParams, skillId: string): Promise<boolean | null> {
  const id = assertUuid(skillId, 'skill id')
  const row = (
    await queryRows(
      conn,
      `SELECT bool_or(is_complete) FROM quarantine_approvals WHERE skill_id = '${id}';`
    )
  )[0]
  if (!row) return null
  return nullable(row[0]) === null ? null : row[0] === 't'
}

/** Count distinct suppressed skill_ids among the given ids — used for the pre/post suppression-preservation proof. */
export async function suppressedSkillCount(conn: PgConnParams, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const arr = idArrayLiteral(ids, 'skill id')
  const n = await queryScalar(
    conn,
    `SELECT count(DISTINCT skill_id) FROM outreach_suppressions WHERE skill_id = ANY(${arr});`
  )
  return Number(n ?? '0')
}

/** Build the SQL mutation block for one group's per-table merge rules, per design doc §B.3.2. */
export function buildGroupMutationSql(group: DuplicateGroup): string {
  const survivorId = assertUuid(group.survivor.id, 'survivor id')
  const loserIds = group.losers.map((l) => assertUuid(l.id, 'loser id'))
  const loserArr = idArrayLiteral(loserIds, 'loser id')

  return `
-- Group: ${group.repoUrlCanonical}
-- 1. skill_categories: union insert, then drop losers' rows.
INSERT INTO skill_categories (skill_id, category_id)
  SELECT '${survivorId}', category_id FROM skill_categories WHERE skill_id = ANY(${loserArr})
  ON CONFLICT DO NOTHING;
DELETE FROM skill_categories WHERE skill_id = ANY(${loserArr});

-- 2. skills_optimized: adopt the newest loser row only if survivor has none, else discard all losers.
WITH adopt AS (
  SELECT skill_id FROM skills_optimized WHERE skill_id = ANY(${loserArr})
  ORDER BY updated_at DESC NULLS LAST LIMIT 1
)
UPDATE skills_optimized SET skill_id = '${survivorId}'
WHERE skill_id IN (SELECT skill_id FROM adopt)
  AND NOT EXISTS (SELECT 1 FROM skills_optimized WHERE skill_id = '${survivorId}');
DELETE FROM skills_optimized WHERE skill_id = ANY(${loserArr});

-- 3. skill_transformations: same adopt-if-empty rule.
WITH adopt AS (
  SELECT skill_id FROM skill_transformations WHERE skill_id = ANY(${loserArr})
  ORDER BY transformed_at DESC NULLS LAST LIMIT 1
)
UPDATE skill_transformations SET skill_id = '${survivorId}'
WHERE skill_id IN (SELECT skill_id FROM adopt)
  AND NOT EXISTS (SELECT 1 FROM skill_transformations WHERE skill_id = '${survivorId}');
DELETE FROM skill_transformations WHERE skill_id = ANY(${loserArr});

-- 4. outreach_suppressions: sticky — re-point the earliest-suppressed loser row only if survivor isn't already suppressed.
WITH adopt AS (
  SELECT id FROM outreach_suppressions WHERE skill_id = ANY(${loserArr})
  ORDER BY suppressed_at ASC LIMIT 1
)
UPDATE outreach_suppressions SET skill_id = '${survivorId}'
WHERE id IN (SELECT id FROM adopt)
  AND NOT EXISTS (SELECT 1 FROM outreach_suppressions WHERE skill_id = '${survivorId}');
DELETE FROM outreach_suppressions WHERE skill_id = ANY(${loserArr});

-- 5. outreach_events: re-point all, dedupe none (append-only event log).
UPDATE outreach_events SET skill_id = '${survivorId}' WHERE skill_id = ANY(${loserArr});

-- 6. quarantine_approvals: re-point all, then recompute is_complete.
UPDATE quarantine_approvals SET skill_id = '${survivorId}' WHERE skill_id = ANY(${loserArr});
UPDATE quarantine_approvals SET is_complete = sub.new_complete
FROM (
  SELECT (count(DISTINCT reviewer_id) >= max(required_approvals)) AS new_complete
  FROM quarantine_approvals WHERE skill_id = '${survivorId}'
) sub
WHERE skill_id = '${survivorId}';

-- 7. skills: remove the losers.
DELETE FROM skills WHERE id = ANY(${loserArr});
`
}
