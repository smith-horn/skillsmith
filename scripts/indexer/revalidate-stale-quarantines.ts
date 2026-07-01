#!/usr/bin/env tsx
/**
 * SMI-5165/5437: Re-validate stale-quarantined skills. `processRow` is the shared
 * row-processor for the SMI-5166 recheck cron (recheck.ts imports it + retagUnreachable).
 * SMI-5437 Wave 2: processRow now runs sibling re-scan before clearing quarantined=true rows.
 *
 * Safety: `--dry-run` is DEFAULT (`--apply` writes); CAS guards prevent double-flip;
 * run OUTSIDE the 00/06/12/18 UTC indexer cron window.
 *
 * Usage: varlock run -- npx tsx scripts/indexer/revalidate-stale-quarantines.ts [--apply] [--limit N]
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createSupabaseAdminClient } from './_shared/supabase.ts'
import { buildGitHubHeaders } from './_shared/github-auth.ts'
import {
  scanSkillContent,
  shouldQuarantine,
  summarizeFindings,
} from './_shared/security-scanner-edge.ts'
import { newRateLimitTelemetry, type RateLimitTelemetry } from './_shared/rate-limit.ts'
import { parseSkillMdUrl, fetchSkillMd } from './_shared/skill-md-fetch.ts'
import {
  runSiblingRescan,
  buildSiblingQuarantineReason,
  writeSiblingRequarantine,
  writeSiblingRecovery,
} from './revalidate-stale-quarantines.sibling.ts'

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
  /** SMI-5166: present only for recheck candidates (loadRecheckCandidates selects them). Absent (undefined) for the Wave-1 loadCandidates cohort, which preserves clear-path behavior. */
  quarantined?: boolean
  last_seen_at?: string
}

/** Per-row outcome of the stale-revalidation sweep. */
export type StaleOutcome =
  | 'cleared'
  | 'live-touched'
  | 'kept-security'
  | 'requarantined'
  | 'repo-gone'
  | 'parse-failed'
  | 'fetch-error'
  | 'cas-skipped'
  | 'error'
  | 'sibling-requarantined' // SMI-5437 W2: additive with requarantined + sibling_requarantined
  | 'sibling-recovered' //     SMI-5437 W2: additive with cleared + sibling_recovered
  | 'deferred-cap' //          SMI-5445 C2: PASS-3 row that would have cleared but hit the per-run sibling-clear cap

interface RowResult {
  row: StaleQuarantinedRow
  outcome: StaleOutcome
  score?: number
}

interface SweepCounts {
  total: number
  cleared: number
  liveTouched: number
  keptSecurity: number
  repoGone: number
  parseFailed: number
  fetchErrors: number
  casSkipped: number
  errors: number
}
/** Above this fraction of transient fetch errors the run is throttled; repo-gone counts unreliable. */
const MAX_FETCH_ERROR_RATE = 0.1

// ---------------------------------------------------------------------------
// Per-row logic
// ---------------------------------------------------------------------------

/**
 * Re-tag a quarantined row whose upstream repo/path is unreachable.
 * Exported (SMI-5357) for reuse by dequarantine-false-positives.ts;
 * auditMeta defaults keep the two existing callers in this file byte-stable.
 */
export async function retagUnreachable(
  row: StaleQuarantinedRow,
  reason: string,
  eventType: 'quarantine:repo_gone',
  db: SupabaseClient,
  auditMeta: { smi: string; sweep: string; action: string } = {
    smi: 'SMI-5165',
    sweep: 'stale-revalidation',
    action: 'revalidate_stale_quarantines',
  }
): Promise<void> {
  const now = new Date().toISOString()
  // SMI-5166 E9: CAS-gate on quarantined=true — a 404 on a live row must NOT retag
  // it (maintenance ages it out). Audit insert gated on rows-affected.
  const { data: retagged } = await db
    .from('skills')
    .update({ quarantine_reason: reason, last_seen_at: now })
    .eq('id', row.id)
    .eq('quarantined', true)
    .select('id')

  if (!retagged || retagged.length === 0) return

  await db.from('audit_logs').insert({
    event_type: eventType,
    actor: 'system',
    resource: row.id,
    action: auditMeta.action,
    result: 'success',
    metadata: {
      smi: auditMeta.smi,
      sweep: auditMeta.sweep,
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
 * Process a single stale-quarantined row (SMI-5437 Wave 2: extended with sibling rescan).
 * Decision tree: parse → fetch SKILL.md → scan SKILL.md → (live? CAS touch) →
 * sibling rescan (quarantined=true clean only) → CAS clear | requarantined | fetch-error.
 *
 * SMI-5445 C2: `clearBudget` is an optional mutable budget bounding how many
 * sibling-quarantine clears may happen per recheck run. It is checked AND
 * decremented synchronously (before any DB await) on the sibling-recovery path; on
 * `remaining <= 0` processRow returns 'deferred-cap' WITHOUT writing (row stays
 * quarantined, retried next run). The synchronous check-then-decrement is race-free
 * in Node.js even under Promise.all batching — all checks run before the first async
 * I/O resumes, so two rows can't both claim the last slot.
 */
export async function processRow(
  row: StaleQuarantinedRow,
  headers: Record<string, string>,
  apply: boolean,
  db: SupabaseClient,
  telemetry: RateLimitTelemetry = newRateLimitTelemetry(),
  clearBudget?: { remaining: number }
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
    // Genuinely risky. Already-quarantined rows re-tag; a LIVE row (quarantined ===
    // false, routed via recheck.ts pass-1) is re-quarantined — SMI-5377 (the prior
    // code CAS-gated on quarantined=true and never set it, so live rows no-oped).
    const wasLive = row.quarantined === false
    if (apply) {
      const summary = summarizeFindings(scan.findings) || 'security scan'
      const now = new Date().toISOString()
      // Match by id only + set quarantined:true explicitly. Fail-closed/race-safe:
      // the demanded end-state is unconditionally quarantined; the rows-affected check
      // below only needs to guard a row deleted in the interim.
      const { data: updated, error: updateErr } = await db
        .from('skills')
        .update({
          quarantined: true,
          quarantine_reason: summary,
          security_score: scan.riskScore,
          security_findings: scan.findings,
          last_scanned_at: now,
        })
        .eq('id', row.id)
        .select('id')
      if (updateErr) {
        console.error(`  ERROR re-quarantining ${row.author}/${row.name}: ${updateErr.message}`)
        return { row, outcome: 'error', score: scan.riskScore }
      }

      // Audit: live→malicious is a distinct event from a stale re-tag.
      if (updated && updated.length > 0) {
        await db.from('audit_logs').insert({
          event_type: wasLive ? 'quarantine:requarantined' : 'quarantine:retagged',
          actor: 'system',
          resource: row.id,
          action: 'revalidate_stale_quarantines',
          result: 'success',
          metadata: {
            smi: wasLive ? 'SMI-5377' : 'SMI-5165',
            sweep: 'stale-revalidation',
            skill_id: row.id,
            author: row.author,
            name: row.name,
            repo_url: row.repo_url,
            new_score: scan.riskScore,
            new_reason: summary,
            prev_quarantine_reason: row.quarantine_reason,
            prev_quarantined: row.quarantined ?? null,
          },
        })
      }
    }
    return { row, outcome: wasLive ? 'requarantined' : 'kept-security', score: scan.riskScore }
  }

  // Scanner passes. quarantined===false → CAS last_seen_at touch; quarantined===undefined
  // (runSweep CLI) intentionally falls to the fail-closed sibling rescan below (SMI-5437; E4).
  const now = new Date().toISOString()
  if (row.quarantined === false) {
    if (!apply) return { row, outcome: 'live-touched', score: scan.riskScore }
    // E1: CAS guards against a row quarantined by maintenance between load and write.
    const { data: touched, error: touchErr } = await db
      .from('skills')
      .update({ last_seen_at: now })
      .eq('id', row.id)
      .eq('quarantined', false)
      .select('id')
    if (touchErr) {
      console.error(`  ERROR touching ${row.author}/${row.name}: ${touchErr.message}`)
      return { row, outcome: 'error', score: scan.riskScore }
    }
    if (!touched || touched.length === 0)
      return { row, outcome: 'cas-skipped', score: scan.riskScore }
    return { row, outcome: 'live-touched', score: scan.riskScore }
  }

  // SMI-5437 Wave 2: sibling re-scan for quarantined=true rows with clean SKILL.md.
  // SMI-5445 C1: pass the fresh SKILL.md scan so runSiblingRescan can compute the
  // collective merged score (root + siblings) and apply the symmetric recovery gate.
  // Fail-closed: transient fetch → 'fetch-error' (quarantine stays, retry next cycle).
  const sibRescan = await runSiblingRescan(
    parsed.owner,
    parsed.repo,
    parsed.ref ?? 'main',
    parsed.dir,
    telemetry,
    scan
  )
  if (sibRescan.status === 'unknown') {
    // Transient: can't verify sibling state; don't change quarantine status.
    return { row, outcome: 'fetch-error' }
  }
  if (sibRescan.status === 'malicious') {
    if (apply) {
      const sibReason = buildSiblingQuarantineReason(sibRescan, parsed.owner, row.name)
      const writeResult = await writeSiblingRequarantine(db, row, sibRescan, sibReason)
      if (writeResult === 'error') {
        console.error(`  ERROR requarantining sibling ${row.author}/${row.name}`)
        return { row, outcome: 'error', score: scan.riskScore }
      }
    }
    // Additive: recheck.ts increments both requarantined + sibling_requarantined.
    return { row, outcome: 'sibling-requarantined', score: scan.riskScore }
  }
  // sibRescan.status === 'clean'. Additive: recheck.ts increments both cleared + sibling_recovered.
  if (!apply) return { row, outcome: 'sibling-recovered', score: scan.riskScore }

  // SMI-5445 C2: enforce the per-run sibling-clear cap BEFORE the DB write (see the
  // processRow doc comment for the race-free rationale). Exhausted budget → the row
  // stays quarantined=true, no DB/audit write, outcome 'deferred-cap' (retried next run).
  if (clearBudget !== undefined) {
    if (clearBudget.remaining <= 0) {
      console.warn(
        `[processRow] sibling-clear budget exhausted — deferring ${row.author ?? '?'}/${row.name} to next run`
      )
      return { row, outcome: 'deferred-cap', score: scan.riskScore }
    }
    clearBudget.remaining-- // synchronous decrement before any DB await (race-free)
  }

  // SMI-5445: the CAS clear + forensic-persist audit write lives in
  // writeSiblingRecovery (revalidate-stale-quarantines.sibling.ts) to keep this
  // file under the 500-line gate. It preserves the `.eq('quarantined', true)` CAS
  // guard and the fail-closed semantics. M4 forensic findings, M3 merged_score,
  // and M2 was_security_quarantine are set inside the helper.
  const writeResult = await writeSiblingRecovery(db, row, sibRescan, scan.riskScore)
  if (writeResult === 'error') {
    console.error(`  ERROR updating ${row.author}/${row.name}`)
    return { row, outcome: 'error', score: scan.riskScore }
  }
  if (writeResult === 'cas-skipped') return { row, outcome: 'cas-skipped', score: scan.riskScore }

  return { row, outcome: 'sibling-recovered', score: scan.riskScore }
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
    liveTouched: 0,
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
        case 'sibling-recovered': // SMI-5437 W2: sibling rescan clean
          counts.cleared++
          console.log(`  CLEAR  ${tag} [sibling-clean] (score ${r.score})`)
          break
        case 'sibling-requarantined': // SMI-5437 W2: sibling still/newly malicious
          keptRows.push(r)
          console.warn(`  KEEP   ${tag} — sibling malicious`)
          break
        case 'live-touched':
          counts.liveTouched++
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
        default:
          // 'requarantined' can't arise here (loadCandidates filters quarantined=true);
          // guard so a future filter change can never silently drop an outcome.
          console.warn(`  WARN   ${tag} — unhandled outcome ${r.outcome}`)
      }
    }
  }

  if (keptRows.length > 0)
    for (const r of keptRows)
      console.log(`  KEEP   ${r.row.author}/${r.row.name} (score ${r.score})`)

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
      `  live-touched:    ${counts.liveTouched}\n` +
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
