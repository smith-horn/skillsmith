#!/usr/bin/env tsx
/**
 * SMI-5167 (Wave 3): Purge UNRECOVERABLE quarantined skills from the prod
 * `skills` table — rows that can never be re-fetched or installed and so only
 * bloat the catalog and skew quarantine metrics.
 *
 * ── Dead-set definition (the ONLY rows this tool deletes) ──────────────────
 *   quarantined = true
 *   AND ( repo_url IS NULL
 *         OR quarantine_reason ILIKE 'repository%' )
 *
 * Rationale per cohort:
 *   - no-repo_url:   nothing to re-fetch — the source location is unknown, and a
 *                    NULL repo_url also means the skill is not installable.
 *   - repository*:   tagged "Repository deleted or not found …" / "Repository
 *                    archived …" by the stale-revalidation sweep (SMI-5165) or
 *                    the indexer — the upstream repo is gone.
 * Collectively ~8,000–8,400 rows as of 2026-05-23.
 *
 * ── Why security-scan rows are NOT purged ──────────────────────────────────
 * A `quarantine_reason ILIKE 'security scan%'` row may be a genuinely-malicious
 * skill whose repo is STILL LIVE (e.g. risk score 95–100). Deleting it would
 * drop the security record AND let the next indexer discovery re-find and
 * re-index the skill. Such rows MUST stay quarantined-in-place. The ~33
 * unreachable SMI-5161 leftovers are negligible dead-weight next to the ~7.6k
 * no-repo_url rows, so they are deliberately left untouched here.
 *
 * ── FK / cascade reasoning (verified via information_schema) ────────────────
 * The ONLY foreign keys referencing `skills.id` are:
 *   - skills_optimized.skill_id      ON DELETE CASCADE
 *   - skill_categories.skill_id      ON DELETE CASCADE
 *   - skill_transformations.skill_id ON DELETE CASCADE
 * Deleting a `skills` row therefore clears those three child tables
 * automatically. Two related tables hold the skill id as PLAIN TEXT with NO
 * foreign key:
 *   - quarantine_approvals.skill_id  → deleted EXPLICITLY here (would orphan).
 *   - audit_logs.resource            → LEFT INTACT (immutable audit trail).
 *
 * ── Rollback ───────────────────────────────────────────────────────────────
 * Before any delete (and in dry-run too), the FULL dead-set rows are written to
 * a CSV at `~/.skillsmith/backups/purge-dead-quarantines-<ISO>.csv` (override
 * with `--export <path>`). In apply mode the written row count is verified to
 * equal the selected count and the run ABORTS on mismatch (never deletes more
 * than was exported). Re-inserting that CSV restores the rows.
 *
 * ── Safety model ───────────────────────────────────────────────────────────
 *   - `--dry-run` is the DEFAULT; `--apply` is REQUIRED for any DELETE.
 *   - `--limit N` performs a staged run (deletes at most N rows).
 *   - Batched delete (BATCH=100) — each batch is its own transaction, satisfying
 *     "COMMIT between batches" and keeping each request under PostgREST's 8s
 *     statement_timeout.
 *   - ONE `audit_logs` `skill:purged` row is written summarizing the run.
 *   - This is a DESTRUCTIVE direct-to-prod operation. Per the direct-to-main SQL
 *     rule (SMI-2598) it is human-gated: run it manually, OUTSIDE the
 *     00/06/12/18 UTC indexer cron window, via a session-pooler-equivalent admin
 *     client (this script uses the service-role REST client, which is not bound
 *     by the transaction pooler's checkout timeout). Never schedule it.
 *
 * ── Usage (host tool — requires Docker container running for varlock) ───────
 *   varlock run -- npx tsx scripts/indexer/purge-dead-quarantines.ts            # dry-run + export
 *   varlock run -- npx tsx scripts/indexer/purge-dead-quarantines.ts --limit 50 # staged
 *   varlock run -- npx tsx scripts/indexer/purge-dead-quarantines.ts --apply    # DESTRUCTIVE
 *   varlock run -- npx tsx scripts/indexer/purge-dead-quarantines.ts --export /tmp/dead.csv
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createSupabaseAdminClient } from './_shared/supabase.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A dead-set `skills` row. Full columns are exported for rollback. */
export interface DeadRow {
  id: string
  author: string | null
  name: string | null
  repo_url: string | null
  skill_path: string | null
  quarantine_reason: string | null
  security_score: number | null
  security_findings: unknown
  quarantined: boolean | null
  created_at: string | null
  last_seen_at: string | null
}

/** Which arm of the dead-set predicate a row matched. */
export type DeadCohort = 'no-repo-url' | 'repository'

/** Ordered CSV header — the column order `toCsvRow` must emit. */
export const CSV_COLUMNS: readonly (keyof DeadRow)[] = [
  'id',
  'author',
  'name',
  'repo_url',
  'skill_path',
  'quarantine_reason',
  'security_score',
  'security_findings',
  'quarantined',
  'created_at',
  'last_seen_at',
]

interface PurgeCounts {
  total: number
  byCohort: Record<DeadCohort, number>
  deleted: number
  approvalsDeleted: number
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Human-readable description of the dead-set predicate, kept in lock-step with
 * `applyDeadSetFilter`. Surfaced in the run banner so the operator can confirm
 * what is being targeted before applying.
 */
export function describeDeadSet(): string {
  return "quarantined = true AND (repo_url IS NULL OR quarantine_reason ILIKE 'repository%')"
}

/**
 * Classify which arm of the dead-set predicate a row matched. Evaluated in
 * predicate order (no-repo_url wins over a reason match) so cohort counts are a
 * partition of the selected set, not overlapping tallies.
 */
export function classifyCohort(row: Pick<DeadRow, 'repo_url' | 'quarantine_reason'>): DeadCohort {
  if (row.repo_url === null || row.repo_url === undefined) return 'no-repo-url'
  // Any selected row with a repo_url matched the `repository%` arm (the only
  // reason-based arm of the dead set).
  return 'repository'
}

/** RFC-4180 escape a single CSV field. */
export function escapeCsvField(value: unknown): string {
  let str: string
  if (value === null || value === undefined) str = ''
  else if (typeof value === 'object') str = JSON.stringify(value)
  else str = String(value)
  // Quote when the field contains a comma, double-quote, CR, or LF; double up
  // any embedded double-quotes.
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

/** Serialize one dead row to a CSV line in `CSV_COLUMNS` order (no trailing newline). */
export function toCsvRow(row: DeadRow): string {
  return CSV_COLUMNS.map((col) => escapeCsvField(row[col])).join(',')
}

/**
 * Build the full CSV document for the export.
 *
 * Returns both the rendered `csv` and the `rowCount` of serialized data rows.
 * `rowCount` is the source of truth for the export-integrity guard — a quoted
 * field may legally contain a newline, so counting physical `\n` characters
 * would over-count rows. Counting serialized rows directly is newline-safe.
 */
export function buildCsv(rows: DeadRow[]): { csv: string; rowCount: number } {
  const header = CSV_COLUMNS.join(',')
  const lines = rows.map(toCsvRow)
  return { csv: [header, ...lines].join('\n') + '\n', rowCount: lines.length }
}

/** Count the dead set into a per-cohort partition. */
export function countByCohort(rows: DeadRow[]): Record<DeadCohort, number> {
  const byCohort: Record<DeadCohort, number> = {
    'no-repo-url': 0,
    repository: 0,
  }
  for (const row of rows) byCohort[classifyCohort(row)]++
  return byCohort
}

/** Default export path under `~/.skillsmith/backups/`, stamped with an ISO timestamp. */
export function defaultExportPath(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return join(homedir(), '.skillsmith', 'backups', `purge-dead-quarantines-${stamp}.csv`)
}

// ---------------------------------------------------------------------------
// DB access
// ---------------------------------------------------------------------------

/**
 * Apply the dead-set predicate to a Supabase query builder. Kept as a single
 * function so the script and any future caller filter identically.
 *
 * `.or()` covers the three OR arms; the standalone `.eq('quarantined', true)`
 * is the AND clause. PostgREST `ilike` patterns use `*` as the wildcard.
 */
export function applyDeadSetFilter<T>(query: T): T {
  // The Supabase builder is fluent; cast through a minimal recursive shape so
  // this helper stays decoupled from the full generic SupabaseQueryBuilder type.
  interface DeadSetBuilder {
    eq: (col: string, val: unknown) => DeadSetBuilder
    or: (filter: string) => DeadSetBuilder
  }
  const q = query as unknown as DeadSetBuilder
  return q
    .eq('quarantined', true)
    .or('repo_url.is.null,quarantine_reason.ilike.repository*') as unknown as T
}

const SELECT_COLUMNS =
  'id, author, name, repo_url, skill_path, quarantine_reason, security_score, ' +
  'security_findings, quarantined, created_at, last_seen_at'

const PAGE_SIZE = 1000

/**
 * Load the full dead set, paging past PostgREST's `max-rows` cap. Ordered by
 * `id` (the primary key, always unique and non-null) so `.range()` page
 * boundaries are stable across requests.
 */
export async function loadDeadSet(db: SupabaseClient, limit?: number): Promise<DeadRow[]> {
  const out: DeadRow[] = []
  for (let page = 0; ; page++) {
    const from = page * PAGE_SIZE
    // On a staged (`--limit`) run, cap the page window to the remaining quota so
    // we never pull more rows from prod than requested.
    const remaining = limit === undefined ? PAGE_SIZE : Math.min(PAGE_SIZE, limit - out.length)
    const to = from + remaining - 1
    let query = db.from('skills').select(SELECT_COLUMNS)
    query = applyDeadSetFilter(query)
    const { data, error } = await query.order('id', { ascending: true }).range(from, to)

    if (error) throw new Error(`Failed to load dead set (page ${page}): ${error.message}`)
    const rows = (data ?? []) as unknown as DeadRow[]
    out.push(...rows)

    if (limit !== undefined && out.length >= limit) return out.slice(0, limit)
    // A short page means the dead set is exhausted; a full `remaining`-sized page
    // means there may be more (only when not limit-capped, since a limit-capped
    // full page is caught by the check above).
    if (rows.length < remaining) break
  }
  return out
}

/**
 * Rows deleted per request. Kept small because PostgREST encodes `.in('id', […])`
 * into the request URL — ~300+ ids overflow the gateway URL limit (400 Bad
 * Request, verified against prod). 100 keeps the URL well under the limit while
 * each batch stays a single fast transaction under the 8s statement_timeout.
 */
export const DELETE_BATCH = 100

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Batched `.in()` delete with retry on transient failures — both PostgREST
 * `error` results AND thrown network errors ("TypeError: fetch failed"). The
 * live SMI-5167 run died on a thrown fetch error mid-run (the bare `if (error)`
 * check never saw it), so both paths are retried with backoff before giving up.
 * Each batch is its own transaction; re-running the tool is idempotent (it
 * re-selects the remaining dead set), so a hard failure here is recoverable.
 */
export async function deleteInBatches(
  db: SupabaseClient,
  table: string,
  column: string,
  ids: string[],
  onProgress?: (done: number) => void,
  retries = 3
): Promise<number> {
  let deleted = 0
  for (let i = 0; i < ids.length; i += DELETE_BATCH) {
    const batch = ids.slice(i, i + DELETE_BATCH)
    let lastErr = ''
    let done = false
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const { data, error } = await db.from(table).delete().in(column, batch).select(column)
        if (!error) {
          deleted += (data ?? []).length
          done = true
          break
        }
        lastErr = error.message
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e)
      }
      if (attempt < retries) await sleep(500 * 2 ** attempt)
    }
    if (!done) {
      throw new Error(
        `${table} delete failed (batch @${i}) after ${retries + 1} attempts: ${lastErr}`
      )
    }
    onProgress?.(deleted)
  }
  return deleted
}

/**
 * Delete the dead rows from `skills` in batches. The three CASCADE child tables
 * clear automatically. Returns the number of skill rows confirmed deleted.
 */
async function deleteSkillRows(db: SupabaseClient, ids: string[]): Promise<number> {
  return deleteInBatches(db, 'skills', 'id', ids, (done) =>
    console.log(`  deleted ${done}/${ids.length} skills`)
  )
}

/**
 * Explicitly delete `quarantine_approvals` rows for the purged ids (no FK, so
 * they would otherwise orphan). Returns the number of approval rows deleted.
 */
async function deleteApprovals(db: SupabaseClient, ids: string[]): Promise<number> {
  return deleteInBatches(db, 'quarantine_approvals', 'skill_id', ids)
}

/** Write the CSV export, creating the parent directory if needed. */
export async function writeExport(path: string, csv: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, csv, 'utf-8')
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

interface PurgeOptions {
  apply: boolean
  limit?: number
  exportPath?: string
}

/** Run the purge (dry-run by default). Returns the run counts. */
export async function runPurge(opts: PurgeOptions): Promise<PurgeCounts> {
  const db = createSupabaseAdminClient()
  const exportPath = opts.exportPath ?? defaultExportPath()

  if (opts.apply) {
    console.log(
      '\n' +
        '============================================================\n' +
        '  ⚠️  APPLY MODE — DESTRUCTIVE PERMANENT DELETE AGAINST PROD\n' +
        '============================================================'
    )
  } else {
    console.log('\n🔍 DRY-RUN — no rows will be deleted')
  }
  console.log(`Dead-set predicate: ${describeDeadSet()}`)
  if (opts.limit !== undefined) console.log(`Limit: ${opts.limit} row(s)`)

  const rows = await loadDeadSet(db, opts.limit)
  const byCohort = countByCohort(rows)
  const counts: PurgeCounts = {
    total: rows.length,
    byCohort,
    deleted: 0,
    approvalsDeleted: 0,
  }

  // Export FIRST (in dry-run too) so the operator can inspect the rollback file.
  const { csv, rowCount } = buildCsv(rows)
  await writeExport(exportPath, csv)

  console.log(
    `\nSelected ${rows.length} dead row(s):\n` +
      `  no-repo-url:   ${byCohort['no-repo-url']}\n` +
      `  repository*:   ${byCohort.repository}\n`
  )
  console.log(`Rollback CSV written: ${exportPath}`)

  if (!opts.apply) {
    console.log('\nDry-run only — re-run with --apply to perform the (irreversible) purge.\n')
    return counts
  }

  // Guard: the export must contain exactly the selected rows before we delete.
  // `rowCount` counts serialized rows (newline-safe — a quoted field may legally
  // contain a `\n`), so this never over- or under-counts.
  if (rowCount !== rows.length) {
    throw new Error(
      `Export integrity check failed: wrote ${rowCount} row(s) but selected ${rows.length}. ` +
        'Aborting before any delete.'
    )
  }

  const ids = rows.map((r) => r.id)
  counts.deleted = await deleteSkillRows(db, ids)
  counts.approvalsDeleted = await deleteApprovals(db, ids)

  await db.from('audit_logs').insert({
    event_type: 'skill:purged',
    actor: 'system',
    resource: 'skills',
    action: 'purge_dead_quarantines',
    result: 'success',
    metadata: {
      smi: 'SMI-5167',
      total_purged: counts.deleted,
      approvals_deleted: counts.approvalsDeleted,
      by_cohort: byCohort,
      export_path: exportPath,
    },
  })

  console.log(
    `\n── Summary ──\n` +
      `  selected:          ${counts.total}\n` +
      `  skills deleted:    ${counts.deleted}\n` +
      `  approvals deleted: ${counts.approvalsDeleted}\n` +
      `  export:            ${exportPath}\n`
  )
  return counts
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

/** Parse `--export <path>` / `--export=<path>` from argv. */
function parseExportArg(argv: string[]): string | undefined {
  const idx = argv.findIndex((a) => a === '--export' || a.startsWith('--export='))
  if (idx === -1) return undefined
  const eq = argv[idx].split('=')[1]
  return eq ?? argv[idx + 1]
}

/** Parse `--limit <n>` / `--limit=<n>` from argv. */
function parseLimitArg(argv: string[]): number | undefined {
  const idx = argv.findIndex((a) => a === '--limit' || a.startsWith('--limit='))
  if (idx === -1) return undefined
  const raw = argv[idx].split('=')[1] ?? argv[idx + 1]
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

/** CLI entrypoint (skipped when imported by tests). */
async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  await runPurge({
    apply,
    limit: parseLimitArg(process.argv),
    exportPath: parseExportArg(process.argv),
  })
}

// Run only when invoked directly (not when imported by the test suite).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
