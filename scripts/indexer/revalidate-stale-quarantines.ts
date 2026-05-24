#!/usr/bin/env tsx
/**
 * SMI-5165: One-time sweep to re-validate stale-quarantined skills.
 *
 * Candidate cohort: rows where `quarantined = true` AND `repo_url ILIKE
 * 'https://github.com/%'` AND (`quarantine_reason IS NULL` OR
 * `quarantine_reason = 'stale'`). These were quarantined by the stale-
 * reconciliation path (not by the security scanner), so a security re-scan was
 * never performed. Many are false-positives: the repo still exists and the
 * SKILL.md passes the FIXED scanner (SMI-4960).
 *
 * Decision tree per row:
 *   1. parse-failed  — `repo_url` is not a parseable GitHub URL.
 *                      KEEP quarantined; in apply mode re-tag
 *                      `quarantine_reason` = "Repository deleted or not found:
 *                      <repo_url>" so it won't be re-swept.
 *   2. repo-gone     — GitHub Contents API returns non-200 (repo deleted/moved,
 *                      private, or SKILL.md path drifted).
 *                      KEEP quarantined; in apply mode re-tag reason + set
 *                      `last_seen_at` = now so it isn't re-swept next run.
 *   3. kept-security — SKILL.md fetched but `shouldQuarantine(scan)` = true.
 *                      KEEP quarantined; in apply mode re-tag reason with real
 *                      security-finding summary + update `security_score`,
 *                      `security_findings`, `last_scanned_at`.
 *   4. cleared       — SKILL.md fetched and scanner passes (riskScore < 40).
 *                      CAS update gated on `.eq('quarantined', true)` setting
 *                      `quarantined=false, quarantine_reason=null,
 *                      security_findings=[], security_score, last_scanned_at,
 *                      last_seen_at`. Audit log row written for rollback.
 *
 * Safety model:
 *   - `--dry-run` is the DEFAULT; `--apply` performs writes.
 *   - Every clear is a CAS update (gated on `quarantined = true`), so a
 *     concurrent indexer run cannot be double-flipped.
 *   - Every `cleared` row writes an `audit_logs` `quarantine:cleared` row
 *     carrying pre-state for rollback.
 *   - Every `repo-gone`/`parse-failed` re-tag in apply mode writes a
 *     `quarantine:repo_gone` audit row.
 *   - Run OUTSIDE the 00/06/12/18 UTC indexer cron window.
 *
 * Usage (host tool — requires Docker container running for varlock):
 *   varlock run -- npx tsx scripts/indexer/revalidate-stale-quarantines.ts           # dry-run
 *   varlock run -- npx tsx scripts/indexer/revalidate-stale-quarantines.ts --apply   # live
 *   varlock run -- npx tsx scripts/indexer/revalidate-stale-quarantines.ts --limit 50
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createSupabaseAdminClient } from './_shared/supabase.ts'
import { buildGitHubHeaders } from './_shared/github-auth.ts'
import {
  scanSkillContent,
  shouldQuarantine,
  summarizeFindings,
} from './_shared/security-scanner-edge.ts'
import { parseSkillMdUrl, fetchSkillMd } from './_shared/skill-md-fetch.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A stale-quarantined `skills` row narrowed to the columns this sweep reads. */
export interface StaleQuarantinedRow {
  id: string
  author: string | null
  name: string
  repo_url: string | null
  skill_path: string | null
  quarantine_reason: string | null
  security_findings: unknown
}

/** Per-row outcome of the stale-revalidation sweep. */
export type StaleOutcome =
  | 'cleared'
  | 'kept-security'
  | 'repo-gone'
  | 'parse-failed'
  | 'fetch-error'
  | 'cas-skipped'
  | 'error'

interface RowResult {
  row: StaleQuarantinedRow
  outcome: StaleOutcome
  score?: number
}

interface SweepCounts {
  total: number
  cleared: number
  keptSecurity: number
  repoGone: number
  parseFailed: number
  fetchErrors: number
  casSkipped: number
  errors: number
}

/**
 * If transient fetch failures (rate limits / 5xx) exceed this fraction of all
 * rows, the run is being throttled and its `repo-gone` classifications can't be
 * trusted — abort rather than under-recover or (in apply) under-process.
 */
const MAX_FETCH_ERROR_RATE = 0.1

// ---------------------------------------------------------------------------
// Per-row logic
// ---------------------------------------------------------------------------

/** Re-tag a stale row in apply mode (parse-failed or repo-gone). */
async function retagUnreachable(
  row: StaleQuarantinedRow,
  reason: string,
  eventType: 'quarantine:repo_gone',
  db: SupabaseClient
): Promise<void> {
  const now = new Date().toISOString()
  await db
    .from('skills')
    .update({ quarantine_reason: reason, last_seen_at: now })
    .eq('id', row.id)
    .eq('quarantined', true)

  await db.from('audit_logs').insert({
    event_type: eventType,
    actor: 'system',
    resource: row.id,
    action: 'revalidate_stale_quarantines',
    result: 'success',
    metadata: {
      smi: 'SMI-5165',
      sweep: 'stale-revalidation',
      skill_id: row.id,
      author: row.author,
      name: row.name,
      repo_url: row.repo_url,
      prev_quarantine_reason: row.quarantine_reason,
      prev_security_findings: row.security_findings,
      new_reason: reason,
    },
  })
}

/**
 * Process a single stale-quarantined row:
 * parse → fetch → scan → clear | keep-security | repo-gone | parse-failed.
 */
export async function processRow(
  row: StaleQuarantinedRow,
  headers: Record<string, string>,
  apply: boolean,
  db: SupabaseClient
): Promise<RowResult> {
  // Step 1: parse the repo URL into a GitHub Contents API URL.
  const parsed = parseSkillMdUrl(row.repo_url, row.skill_path)
  if (!parsed) {
    const reason = `Repository deleted or not found: ${row.repo_url ?? '(no url)'}`
    if (apply) await retagUnreachable(row, reason, 'quarantine:repo_gone', db)
    return { row, outcome: 'parse-failed' }
  }

  // Step 2: fetch SKILL.md from GitHub.
  const fetched = await fetchSkillMd(parsed, headers)
  if (fetched.kind === 'transient') {
    // Rate-limited / network / 5xx — NEVER re-tag as gone. A false "repo-gone"
    // here would feed a live skill into the destructive purge. Leave the row
    // untouched; a later re-run retries it.
    return { row, outcome: 'fetch-error' }
  }
  if (fetched.kind === 'not-found') {
    const reason = `Repository deleted or not found: ${row.repo_url ?? '(no url)'}`
    if (apply) await retagUnreachable(row, reason, 'quarantine:repo_gone', db)
    return { row, outcome: 'repo-gone' }
  }

  // Step 3: run the fixed edge scanner.
  const scan = await scanSkillContent(fetched.content)

  if (shouldQuarantine(scan)) {
    // Row is genuinely risky — keep quarantined, re-tag with real findings so it
    // leaves the stale candidate set (won't be re-fetched every run).
    if (apply) {
      const summary = summarizeFindings(scan.findings) || 'security scan'
      const now = new Date().toISOString()
      await db
        .from('skills')
        .update({
          quarantine_reason: summary,
          security_score: scan.riskScore,
          security_findings: scan.findings,
          last_scanned_at: now,
        })
        .eq('id', row.id)
        .eq('quarantined', true)

      // Audit the security re-tag for parity with the cleared/repo-gone paths.
      await db.from('audit_logs').insert({
        event_type: 'quarantine:retagged',
        actor: 'system',
        resource: row.id,
        action: 'revalidate_stale_quarantines',
        result: 'success',
        metadata: {
          smi: 'SMI-5165',
          sweep: 'stale-revalidation',
          skill_id: row.id,
          author: row.author,
          name: row.name,
          repo_url: row.repo_url,
          new_score: scan.riskScore,
          new_reason: summary,
          prev_quarantine_reason: row.quarantine_reason,
        },
      })
    }
    return { row, outcome: 'kept-security', score: scan.riskScore }
  }

  // Step 4: scanner passes — clear the quarantine.
  if (!apply) return { row, outcome: 'cleared', score: scan.riskScore }

  const now = new Date().toISOString()
  const { data: updated, error } = await db
    .from('skills')
    .update({
      quarantined: false,
      quarantine_reason: null,
      security_findings: [],
      security_score: scan.riskScore,
      last_scanned_at: now,
      last_seen_at: now,
    })
    .eq('id', row.id)
    .eq('quarantined', true)
    .select('id')

  if (error) {
    console.error(`  ERROR updating ${row.author}/${row.name}: ${error.message}`)
    return { row, outcome: 'error', score: scan.riskScore }
  }
  if (!updated || updated.length === 0)
    return { row, outcome: 'cas-skipped', score: scan.riskScore }

  await db.from('audit_logs').insert({
    event_type: 'quarantine:cleared',
    actor: 'system',
    resource: row.id,
    action: 'revalidate_stale_quarantines',
    result: 'success',
    metadata: {
      smi: 'SMI-5165',
      sweep: 'stale-revalidation',
      skill_id: row.id,
      author: row.author,
      name: row.name,
      repo_url: row.repo_url,
      new_score: scan.riskScore,
      prev_quarantine_reason: row.quarantine_reason,
      prev_security_findings: row.security_findings,
    },
  })

  return { row, outcome: 'cleared', score: scan.riskScore }
}

// ---------------------------------------------------------------------------
// Sweep orchestration
// ---------------------------------------------------------------------------

/** PostgREST caps a single response at 1000 rows; the candidate set is larger. */
const PAGE_SIZE = 1000

/**
 * Load all stale-quarantined candidates, paging past PostgREST's max-rows cap.
 *
 * Candidate set: `quarantined = true` AND `repo_url ILIKE 'https://github.com/%'`
 * AND (`quarantine_reason IS NULL` OR `quarantine_reason = 'stale'`).
 * `quarantine_reason IS NULL` covers legacy rows quarantined before the reason
 * column was populated; `'stale'` is what the stale-reconciliation path writes.
 *
 * Ordered by `id` (stable PK) so page boundaries are consistent. ALL rows are
 * collected before the caller processes them, so apply-mode mutations (which
 * drop rows out of the candidate set) cannot shift later page offsets.
 */
export async function loadCandidates(
  db: SupabaseClient,
  limit?: number
): Promise<StaleQuarantinedRow[]> {
  const out: StaleQuarantinedRow[] = []
  for (let page = 0; ; page++) {
    const remaining = limit === undefined ? PAGE_SIZE : Math.min(PAGE_SIZE, limit - out.length)
    if (remaining <= 0) break
    const from = page * PAGE_SIZE
    const { data, error } = await db
      .from('skills')
      .select('id, author, name, repo_url, skill_path, quarantine_reason, security_findings')
      .eq('quarantined', true)
      .ilike('repo_url', 'https://github.com/%')
      .or('quarantine_reason.is.null,quarantine_reason.eq.stale')
      .order('id', { ascending: true })
      .range(from, from + remaining - 1)
    if (error)
      throw new Error(`Failed to load stale-quarantined rows (page ${page}): ${error.message}`)
    const rows = (data ?? []) as StaleQuarantinedRow[]
    out.push(...rows)
    if (limit !== undefined && out.length >= limit) return out.slice(0, limit)
    if (rows.length < remaining) break
  }
  return out
}

/** Run the full stale-revalidation sweep. */
export async function runSweep(opts: { apply: boolean; limit?: number }): Promise<SweepCounts> {
  const db = createSupabaseAdminClient()
  const headers = await buildGitHubHeaders()

  const rows = await loadCandidates(db, opts.limit)

  const counts: SweepCounts = {
    total: rows.length,
    cleared: 0,
    keptSecurity: 0,
    repoGone: 0,
    parseFailed: 0,
    fetchErrors: 0,
    casSkipped: 0,
    errors: 0,
  }
  const keptRows: RowResult[] = []
  const goneRows: RowResult[] = []

  console.log(
    `\n${opts.apply ? '[APPLY]' : '[DRY-RUN]'} — re-validating ${rows.length} stale quarantines (threshold=40)\n`
  )

  // Small concurrency to stay polite to the GitHub API.
  const BATCH = 5
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const results = await Promise.all(batch.map((r) => processRow(r, headers, opts.apply, db)))
    for (const r of results) {
      const tag = `${r.row.author}/${r.row.name}`
      switch (r.outcome) {
        case 'cleared':
          counts.cleared++
          console.log(`  CLEAR  ${tag} (score ${r.score})`)
          break
        case 'kept-security':
          counts.keptSecurity++
          keptRows.push(r)
          break
        case 'repo-gone':
          counts.repoGone++
          goneRows.push(r)
          break
        case 'parse-failed':
          counts.parseFailed++
          goneRows.push(r)
          break
        case 'fetch-error':
          counts.fetchErrors++
          break
        case 'cas-skipped':
          counts.casSkipped++
          break
        case 'error':
          counts.errors++
          console.error(`  ERROR  ${tag} — left quarantined (DB update failed)`)
          break
      }
    }
  }

  if (keptRows.length > 0) {
    console.log(`\nStill quarantined — genuine security findings (score >= 40):`)
    for (const r of keptRows) console.log(`  * ${r.row.author}/${r.row.name} (score ${r.score})`)
  }

  if (goneRows.length > 0) {
    console.log(`\nLeft quarantined — repo/SKILL.md unreachable:`)
    for (const r of goneRows)
      console.log(
        `  * ${r.row.author}/${r.row.name} [${r.outcome}] ${r.row.repo_url ?? '(no url)'}`
      )
  }

  const clearedLabel = opts.apply ? 'cleared' : 'would-clear'
  console.log(
    `\n── Summary ──\n` +
      `  total:           ${counts.total}\n` +
      `  ${clearedLabel}:       ${counts.cleared}\n` +
      `  kept-security:   ${counts.keptSecurity}\n` +
      `  repo-gone:       ${counts.repoGone}\n` +
      `  parse-failed:    ${counts.parseFailed}\n` +
      `  fetch-error:     ${counts.fetchErrors}\n` +
      `  cas-skipped:     ${counts.casSkipped}\n` +
      `  errors:          ${counts.errors}\n`
  )

  // Throttle guard: transient errors never re-tag (safe), but a high rate means
  // many rows were skipped and the repo-gone tally is incomplete — re-run later.
  if (counts.total > 0 && counts.fetchErrors / counts.total > MAX_FETCH_ERROR_RATE) {
    console.warn(
      `\n⚠️  ${counts.fetchErrors}/${counts.total} rows hit transient fetch errors ` +
        `(> ${MAX_FETCH_ERROR_RATE * 100}%). The run was likely throttled; ` +
        `those rows were left untouched. Re-run when GitHub is not rate-limiting.`
    )
  }
  if (!opts.apply) console.log('Dry-run only — re-run with --apply to perform writes.\n')

  return counts
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

/** Parse CLI arguments and run the sweep. Skipped when imported by tests. */
async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const limitArg = process.argv.find((a) => a.startsWith('--limit'))
  const limit = limitArg
    ? Number(limitArg.split('=')[1] ?? process.argv[process.argv.indexOf(limitArg) + 1])
    : undefined
  await runSweep({ apply, limit: Number.isFinite(limit) ? limit : undefined })
}

// Run only when invoked directly (not when imported by the test suite).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
