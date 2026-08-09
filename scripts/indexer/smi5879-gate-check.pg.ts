/**
 * Production `Smi5879GateCheckDbDeps` implementation for smi5879-gate-check.ts.
 * @module scripts/indexer/smi5879-gate-check.pg
 *
 * Thin wrapper over item 1's `smi5879-census.pg.ts` psql helper (imported,
 * never modified) plus the exact SQL from design doc §8.3.5.2 (digest
 * verification) and §8.3.2.5.7 (G-2R.1 drift enumeration / G-2R.2 freeze-leak
 * count), as corrected by §12.2 (NULL-cohort guard placement). No new SQL
 * objects are created here — §12.4 confirms every object this file's queries
 * need already exists from item 1's merged migration
 * (supabase/migrations/20260808000000_smi5879_snapshot_generations.sql).
 */

import { queryRows, queryScalar, nullable, type PgConnParams } from './smi5879-census.pg.ts'
import type {
  DriftRow,
  Smi5879GateCheckDbDeps,
  Smi5879RunSummary,
} from './smi5879-gate-check.types.ts'
import { DRIFT_CLASSES, MISSING_COHORT_DRIFT_CLASS } from './smi5879-gate-check.types.ts'
import type { Smi5879Purpose, Smi5879RunStatus } from './smi5879-census.types.ts'

/**
 * Assert a raw `queryRows` cell is present. Same rationale as
 * `smi5879-simulate-full.db.ts`'s identically-named private helper:
 * `tsconfig.base.json`'s `noUncheckedIndexedAccess` types every destructured
 * cell as `string | undefined` even though a row always has as many cells as
 * the `SELECT`'s column list — a genuinely missing cell means the query's
 * column count drifted from what this function destructures, worth throwing
 * on rather than letting `undefined` flow into code expecting a `string`.
 */
function requireCell(value: string | undefined, column: string): string {
  if (value === undefined) {
    throw new Error(`SMI-5879: missing '${column}' cell in query result row — column count drift?`)
  }
  return value
}

const VALID_PURPOSES: readonly Smi5879Purpose[] = ['rehearsal', 'decision', 'window']
const VALID_STATUSES: readonly Smi5879RunStatus[] = ['open', 'sealed', 'abandoned']

function isDriftClassString(value: string): value is DriftRow['drift_class'] {
  return (
    (DRIFT_CLASSES as readonly string[]).includes(value) || value === MISSING_COHORT_DRIFT_CLASS
  )
}

const NON_NEGATIVE_INTEGER_RE = /^\d+$/

/**
 * Finding #6 (adversarial review): a NULL, negative, non-integer, or
 * non-finite `count(*)` result must never be silently coerced to a "clean"
 * 0 — `Number(raw ?? '0')` did exactly that, letting a malformed DB response
 * satisfy G-2R.2's hard freeze-leak check (`freeze_leak_rows === 0`) when it
 * should instead be unevaluable. This is a DB-shape assertion, not a
 * business-logic INCONCLUSIVE (same category as `requireCell` above) — it
 * throws, matching how every other "the query returned something we don't
 * understand" case in this file already fails loudly rather than silently
 * defaulting.
 */
export function parseFreezeLeakCount(raw: string | null): number {
  if (raw === null || !NON_NEGATIVE_INTEGER_RE.test(raw)) {
    throw new Error(
      `SMI-5879: G-2R.2 freeze-leak count(*) query returned an unparseable/malformed scalar ` +
        `(raw=${raw === null ? 'null' : JSON.stringify(raw)}) — expected a non-negative integer ` +
        'string. Refusing to silently treat this as a clean freeze-leak count of 0.'
    )
  }
  return Number(raw)
}

/** Build the real, psql-backed dependency set for a given connection. */
export function createSmi5879GateCheckDbDeps(conn: PgConnParams): Smi5879GateCheckDbDeps {
  return {
    async getRunSummary(runId) {
      // Timestamps are rendered via the SAME canonical UTC/microsecond
      // to_char() format the population digest itself uses (design doc
      // §8.3.5.2.4) — guarantees reliable `new Date(...)` parsing downstream
      // regardless of the connection's DateStyle/TimeZone GUCs, rather than
      // trusting psql's default timestamptz rendering to be ISO-parseable.
      const rows = await queryRows(
        conn,
        `SELECT
           run_id, purpose, status,
           to_char(ruleset_epoch        AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           to_char(snapshot_started_at  AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           CASE WHEN snapshot_sealed_at IS NULL THEN NULL
                ELSE to_char(snapshot_sealed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
           END,
           row_count, population_digest, branch_digest
         FROM smi5879_run WHERE run_id = :'run_id';`,
        { run_id: runId }
      )
      const row = rows[0]
      if (!row) return null
      const [
        runIdRaw,
        purposeRaw,
        statusRaw,
        rulesetEpochRaw,
        startedAtRaw,
        sealedAtRaw,
        rowCountRaw,
        populationDigestRaw,
        branchDigestRaw,
      ] = row
      const purpose = requireCell(purposeRaw, 'purpose')
      if (!VALID_PURPOSES.includes(purpose as Smi5879Purpose)) {
        throw new Error(`SMI-5879: smi5879_run.purpose="${purpose}" is not a recognised value.`)
      }
      const status = requireCell(statusRaw, 'status')
      if (!VALID_STATUSES.includes(status as Smi5879RunStatus)) {
        throw new Error(`SMI-5879: smi5879_run.status="${status}" is not a recognised value.`)
      }
      const rowCount = nullable(requireCell(rowCountRaw, 'row_count'))
      const summary: Smi5879RunSummary = {
        run_id: requireCell(runIdRaw, 'run_id'),
        purpose: purpose as Smi5879Purpose,
        status: status as Smi5879RunStatus,
        ruleset_epoch: requireCell(rulesetEpochRaw, 'ruleset_epoch'),
        snapshot_started_at: requireCell(startedAtRaw, 'snapshot_started_at'),
        snapshot_sealed_at: nullable(requireCell(sealedAtRaw, 'snapshot_sealed_at')),
        row_count: rowCount === null ? null : Number(rowCount),
        population_digest: nullable(requireCell(populationDigestRaw, 'population_digest')),
        branch_digest: nullable(requireCell(branchDigestRaw, 'branch_digest')),
      }
      return summary
    },

    // Lifted verbatim from smi5879-simulate-full.db.ts's verifyDigest (per
    // task spec — the same digest re-verification semantics apply here).
    async verifyDigest(runId) {
      const rows = await queryRows(
        conn,
        `SELECT
           (population_digest = smi5879_population_digest(:'run_id')),
           (branch_digest     = smi5879_branch_digest(:'run_id'))
         FROM smi5879_run WHERE run_id = :'run_id';`,
        { run_id: runId }
      )
      const row = rows[0]
      if (!row) {
        throw new Error(`SMI-5879: no smi5879_run row for run_id=${runId} — cannot verify digest.`)
      }
      const [populationMatchesRaw, branchMatchesRaw] = row
      return {
        populationMatches: requireCell(populationMatchesRaw, 'population_matches') === 't',
        branchMatches: requireCell(branchMatchesRaw, 'branch_matches') === 't',
      }
    },

    // G-2R.2 — design doc §8.3.2.5.7. MUST be 0; a non-zero count is a hard
    // fail that no per-row exclusion can cure (the population the gate
    // closed over was incomplete).
    async countFreezeLeak(decisionRunId, windowRunId) {
      const raw = await queryScalar(
        conn,
        `SELECT count(*)
           FROM smi5879_snapshot_pre w
          WHERE w.run_id = :'window_run'
            AND NOT EXISTS (
              SELECT 1 FROM smi5879_snapshot_pre d
               WHERE d.run_id = :'decision_run' AND d.id = w.id
            );`,
        { decision_run: decisionRunId, window_run: windowRunId }
      )
      return parseFreezeLeakCount(raw)
    },

    // G-2R.1 — design doc §8.3.2.5.7, CASE statement corrected per §12.2.
    //
    // DEVIATION FROM THE queryRows CONVENTION (justified): every other query
    // in this module and its siblings uses queryRows's newline-delimited row
    // splitting. This one instead uses queryScalar + a single
    // `json_agg(row_to_json(t))::text` + JSON.parse. Reason: the drift rows
    // carry free-text fields sourced directly from GitHub-derived skill
    // metadata (`author`, `repo_url`, `name`) that can legitimately contain
    // embedded newlines — queryRows's `\n`-delimited row splitting would
    // silently corrupt row boundaries on such a value. This is safe here
    // specifically BECAUSE the drift result set is small (a bounded diff
    // between two generations over a ~3-day Δ, not a full ~314K-row
    // population load — the population load path deliberately does NOT use
    // this pattern for exactly that reason).
    //
    // §12.2's NULL-cohort guard is placed as its own WHEN branch
    // IMMEDIATELY BEFORE the DR-4/DR-5 checks — deliberately NOT as the
    // leading branch of the whole CASE. A genuine DR-0 row (d.id IS NULL)
    // or DR-1 row (w.id IS NULL) ALSO has a NULL cohort on the missing
    // side by construction (dc/wc join off d.id/w.id respectively) — if the
    // NULL-cohort guard were the very first branch, every real DR-0/DR-1 row
    // would be misclassified as "missing cohort assignment" instead of its
    // correct drift class. Placing it after DR-0..DR-3 (which never
    // reference dc/wc) and before DR-4/DR-5 (the only branches that do)
    // fixes exactly and only the gap §12.2 identifies.
    async enumerateDrift(decisionRunId, windowRunId) {
      const raw = await queryScalar(
        conn,
        `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)::text
           FROM (
             SELECT
               COALESCE(d.id, w.id) AS id,
               CASE
                 WHEN d.id IS NULL                                        THEN 'DR-0-new-row'
                 WHEN w.id IS NULL                                        THEN 'DR-1-deleted-row'
                 WHEN d.content_hash  IS DISTINCT FROM w.content_hash     THEN 'DR-2-content-drift'
                 WHEN d.security_score IS DISTINCT FROM w.security_score
                   OR d.quarantined    IS DISTINCT FROM w.quarantined     THEN 'DR-3-verdict-baseline-drift'
                 WHEN dc.cohort IS NULL OR wc.cohort IS NULL              THEN '${MISSING_COHORT_DRIFT_CLASS}'
                 WHEN dc.cohort =  'E' AND wc.cohort <> 'E'               THEN 'DR-4-cohort-move-in'
                 WHEN dc.cohort <> 'E' AND wc.cohort =  'E'               THEN 'DR-5-cohort-move-out'
                 ELSE                                                          'stable'
               END AS drift_class,
               d.content_hash    AS decision_content_hash, w.content_hash    AS window_content_hash,
               d.security_score  AS decision_score,        w.security_score  AS window_score,
               d.quarantined     AS decision_quarantined,  w.quarantined     AS window_quarantined,
               dc.cohort         AS decision_cohort,        wc.cohort         AS window_cohort,
               COALESCE(d.repo_url, w.repo_url) AS repo_url,
               COALESCE(d.author, w.author)     AS author,
               COALESCE(d.name, w.name)         AS name
             FROM      (SELECT * FROM smi5879_snapshot_pre    WHERE run_id = :'decision_run') d
             FULL JOIN (SELECT * FROM smi5879_snapshot_pre    WHERE run_id = :'window_run')   w ON w.id = d.id
             LEFT JOIN (SELECT id, cohort FROM v_smi5879_census_cohort WHERE run_id = :'decision_run') dc
                       ON dc.id = d.id
             LEFT JOIN (SELECT id, cohort FROM v_smi5879_census_cohort WHERE run_id = :'window_run')   wc
                       ON wc.id = w.id
           ) t
          WHERE t.drift_class <> 'stable';`,
        { decision_run: decisionRunId, window_run: windowRunId }
      )
      if (raw === null) return []
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (err) {
        throw new Error(
          `SMI-5879: G-2R.1 drift enumeration returned unparseable JSON: ${(err as Error).message}`
        )
      }
      if (!Array.isArray(parsed)) {
        throw new Error('SMI-5879: G-2R.1 drift enumeration JSON was not an array.')
      }
      const out: DriftRow[] = []
      for (const [i, item] of parsed.entries()) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
          throw new Error(`SMI-5879: G-2R.1 drift row ${i} is not a JSON object.`)
        }
        const rec = item as Record<string, unknown>
        const id = rec['id']
        const driftClass = rec['drift_class']
        if (typeof id !== 'string') {
          throw new Error(`SMI-5879: G-2R.1 drift row ${i} has a non-string id.`)
        }
        if (typeof driftClass !== 'string' || !isDriftClassString(driftClass)) {
          throw new Error(
            `SMI-5879: G-2R.1 drift row ${i} (id=${id}) has an unrecognised drift_class="${String(driftClass)}".`
          )
        }
        const str = (key: string): string | null => {
          const v = rec[key]
          return typeof v === 'string' ? v : null
        }
        const num = (key: string): number | null => {
          const v = rec[key]
          return typeof v === 'number' ? v : null
        }
        const bool = (key: string): boolean | null => {
          const v = rec[key]
          return typeof v === 'boolean' ? v : null
        }
        out.push({
          id,
          drift_class: driftClass,
          decision_content_hash: str('decision_content_hash'),
          window_content_hash: str('window_content_hash'),
          decision_score: num('decision_score'),
          window_score: num('window_score'),
          decision_quarantined: bool('decision_quarantined'),
          window_quarantined: bool('window_quarantined'),
          decision_cohort: str('decision_cohort'),
          window_cohort: str('window_cohort'),
          repo_url: str('repo_url'),
          author: str('author'),
          name: str('name'),
        })
      }
      return out
    },
  }
}
