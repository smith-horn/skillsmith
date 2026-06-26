#!/usr/bin/env tsx
/**
 * SMI-5161: Sweep all table-wide `security_scan` quarantines, re-validating each
 * against the FIXED edge scanner (SMI-4960) and clearing only true false
 * positives (riskScore < QUARANTINE_THRESHOLD).
 *
 * Why re-validate instead of a blind SQL clear: SMI-5155 cleared 55
 * leaderboard-scoped rows that were already A0-verified clean by the core
 * scanner. The remaining ~283 table-wide rows are NOT pre-verified — a blind
 * clear could un-quarantine a genuinely malicious skill. So each row's live
 * SKILL.md is re-fetched and re-scanned; only rows the fixed scanner now passes
 * are cleared. Rows that still trip the scanner stay quarantined and are
 * emitted to a manual-review list. Rows whose content can't be fetched (repo
 * deleted/moved) stay quarantined (`fetch-failed`).
 *
 * Safety: `--dry-run` is the DEFAULT; `--apply` performs writes. Each clear is
 * a conditional (CAS) update gated on `quarantined = true`, so a concurrent
 * indexer run cannot be clobbered. Every clear writes an `audit_logs`
 * `quarantine:cleared` row carrying the pre-state for rollback. Run OUTSIDE the
 * 00/06/12/18 UTC indexer cron window.
 *
 * Usage (host tool — requires Docker container running for varlock):
 *   varlock run -- npx tsx scripts/indexer/dequarantine-false-positives.ts          # dry-run
 *   varlock run -- npx tsx scripts/indexer/dequarantine-false-positives.ts --apply  # live
 *   varlock run -- npx tsx scripts/indexer/dequarantine-false-positives.ts --limit 10
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createSupabaseAdminClient } from './_shared/supabase.ts'
import { buildGitHubHeaders } from './_shared/github-auth.ts'
import {
  scanSkillContent,
  shouldQuarantine,
  type EdgeScanResult,
} from './_shared/security-scanner-edge.ts'
import { parseSkillMdUrl, fetchSkillMd } from './_shared/skill-md-fetch.ts'
// SMI-5357: retagUnreachable is shared with the stale-revalidation sweep so
// both callers write a `Repository`-prefixed reason that feeds the purge predicate.
import { retagUnreachable } from './revalidate-stale-quarantines.ts'

// Re-export so existing consumers (tests, siblings) keep their import paths.
export { parseSkillMdUrl, type ParsedSkillUrl } from './_shared/skill-md-fetch.ts'

/** A prod `skills` row narrowed to the columns the sweep reads. */
export interface QuarantinedRow {
  id: string
  author: string | null
  name: string
  repo_url: string | null
  skill_path: string | null
  quarantine_reason: string | null
  security_findings: unknown
}

/** Per-row outcome of the sweep. */
export type SweepOutcome =
  | 'cleared'
  | 'kept'
  | 'fetch-failed'
  | 'repo-gone'
  | 'parse-failed'
  | 'cas-skipped'
  | 'error'

/** A row is a false positive (clearable) when the fixed scanner no longer quarantines it. */
export function isFalsePositive(scan: EdgeScanResult): boolean {
  return !shouldQuarantine(scan)
}

/** Count `security_scan` findings on a row's stored JSONB (for reporting). */
export function countFindings(findings: unknown): number {
  return Array.isArray(findings) ? findings.length : 0
}

/**
 * Per-outcome tallies returned by {@link runSweep}. Exported (SMI-5356) so the
 * `dequarantine` indexer run-type can carry these on its `indexer:run` audit row
 * and surface them in the workflow step summary.
 */
export interface SweepCounts {
  total: number
  cleared: number
  kept: number
  fetchFailed: number
  /** SMI-5357: rows re-tagged Repository-prefixed for the purge sweep (SKILL.md 404). */
  repoGone: number
  parseFailed: number
  casSkipped: number
  errors: number
}

interface RowResult {
  row: QuarantinedRow
  outcome: SweepOutcome
  score?: number
}

/** Process a single quarantined row: parse → fetch → scan → (optionally) clear. */
export async function processRow(
  row: QuarantinedRow,
  headers: Record<string, string>,
  apply: boolean,
  db: SupabaseClient
): Promise<RowResult> {
  const parsed = parseSkillMdUrl(row.repo_url, row.skill_path)
  if (!parsed) return { row, outcome: 'parse-failed' }

  const fetched = await fetchSkillMd(parsed, headers)
  if (fetched.kind === 'transient') {
    // Rate-limited / network / 5xx — never re-tag; a later re-run retries.
    return { row, outcome: 'fetch-failed' }
  }
  if (fetched.kind === 'not-found') {
    // SKILL.md returned 404: repo deleted, renamed, or path drifted. Re-tag with
    // a `Repository`-prefixed reason so `purge-dead-quarantines` picks it up via
    // the `ILIKE 'repository%'` predicate. `security_findings` is preserved —
    // we are NOT clearing the quarantine, only re-categorizing it.
    const reason = `Repository skill path unreachable (SKILL.md 404): ${parsed.apiUrl}`
    if (apply) {
      await retagUnreachable(row, reason, 'quarantine:repo_gone', db, {
        smi: 'SMI-5357',
        sweep: 'dequarantine',
        // `action` is the snake_case OPERATION (so a GROUP BY action keeps every
        // row from this sweep together, clears + repo-gones alike); the
        // colon-namespaced 'quarantine:repo_gone' is the event_type (arg 3).
        action: 'dequarantine_false_positives',
      })
    }
    return { row, outcome: 'repo-gone' }
  }

  const scan = await scanSkillContent(fetched.content)
  if (!isFalsePositive(scan)) return { row, outcome: 'kept', score: scan.riskScore }

  if (!apply) return { row, outcome: 'cleared', score: scan.riskScore }

  // CAS clear: only flip rows still quarantined, so a concurrent indexer that
  // already cleared/re-quarantined this row is never clobbered.
  const { data: updated, error } = await db
    .from('skills')
    .update({
      quarantined: false,
      quarantine_reason: null,
      security_findings: [],
      security_score: scan.riskScore,
      last_scanned_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
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
    action: 'dequarantine_false_positives',
    result: 'success',
    metadata: {
      smi: 'SMI-5161',
      sweep: 'table-wide',
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

/** Run the full sweep over every `security_scan`-quarantined row. */
export async function runSweep(opts: { apply: boolean; limit?: number }): Promise<SweepCounts> {
  const db = createSupabaseAdminClient()
  const headers = await buildGitHubHeaders()

  let query = db
    .from('skills')
    .select('id, author, name, repo_url, skill_path, quarantine_reason, security_findings')
    .eq('quarantined', true)
    .filter('quarantine_reason', 'ilike', 'security scan%')
    .order('author', { ascending: true })
  if (opts.limit) query = query.limit(opts.limit)

  const { data, error } = await query
  if (error) throw new Error(`Failed to load quarantined rows: ${error.message}`)
  const rows = (data ?? []) as QuarantinedRow[]

  const counts: SweepCounts = {
    total: rows.length,
    cleared: 0,
    kept: 0,
    fetchFailed: 0,
    repoGone: 0,
    parseFailed: 0,
    casSkipped: 0,
    errors: 0,
  }
  const kept: RowResult[] = []
  const unreachable: RowResult[] = []

  console.log(
    `\n${opts.apply ? '🔧 APPLY' : '🔍 DRY-RUN'} — re-validating ${rows.length} security_scan quarantines (threshold=40)\n`
  )

  // Small concurrency to be polite to the GitHub API and stay well under limits.
  const BATCH = 5
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const results = await Promise.all(batch.map((r) => processRow(r, headers, opts.apply, db)))
    for (const r of results) {
      const tag = `${r.row.author}/${r.row.name}`
      switch (r.outcome) {
        case 'cleared':
          counts.cleared++
          console.log(
            `  ✅ CLEAR  ${tag} (score ${r.score}, was ${countFindings(r.row.security_findings)} findings)`
          )
          break
        case 'kept':
          counts.kept++
          kept.push(r)
          break
        case 'cas-skipped':
          counts.casSkipped++
          break
        case 'fetch-failed':
          counts.fetchFailed++
          unreachable.push(r)
          break
        case 'repo-gone':
          // Re-tagged with Repository-prefixed reason; purge sweep can now dispose.
          counts.repoGone++
          unreachable.push(r)
          break
        case 'parse-failed':
          counts.parseFailed++
          unreachable.push(r)
          break
        case 'error':
          counts.errors++
          console.error(`  ❌ ERROR  ${tag} — left quarantined (DB update failed)`)
          break
      }
    }
  }

  if (kept.length > 0) {
    console.log(`\n⚠️  Still quarantined (manual review — score ≥ 40 under fixed scanner):`)
    for (const r of kept) console.log(`  • ${r.row.author}/${r.row.name} (score ${r.score})`)
  }

  if (unreachable.length > 0) {
    console.log(`\n🔌 Left quarantined (SKILL.md unreachable — repo deleted/moved or path drift):`)
    for (const r of unreachable) {
      console.log(
        `  • ${r.row.author}/${r.row.name} [${r.outcome}] ${r.row.repo_url ?? '(no url)'}`
      )
    }
  }

  console.log(
    `\n── Summary ──\n` +
      `  total:        ${counts.total}\n` +
      `  ${opts.apply ? 'cleared' : 'would-clear'}:  ${counts.cleared}\n` +
      `  kept (≥40):   ${counts.kept}\n` +
      `  repo-gone:    ${counts.repoGone}${opts.apply ? ' (re-tagged for purge)' : ' (would re-tag)'}\n` +
      `  fetch-failed: ${counts.fetchFailed}\n` +
      `  parse-failed: ${counts.parseFailed}\n` +
      `  cas-skipped:  ${counts.casSkipped}\n` +
      `  errors:       ${counts.errors}\n`
  )
  if (!opts.apply) console.log('Dry-run only — re-run with --apply to perform the clears.\n')

  return counts
}

/** CLI entrypoint (skipped when imported by tests). */
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
