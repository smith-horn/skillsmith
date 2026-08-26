#!/usr/bin/env tsx
/**
 * SMI-5898 Wave 2 Step 4: merge duplicate `skills` rows sharing a
 * `repo_url_canonical` value (case-only GitHub repo renames — the entire
 * remaining duplicate-row gap the design doc's B.1 measurement identified).
 * See docs/internal/implementation/smi-5898-wave5-b3-repo-url-canonical.md
 * ("Duplicate merge") and docs/internal/implementation/smi-5898-wave5-design-proposal.md
 * (§B.3.2 merge rules, §B.3.3 report + guardrail). Types + per-group
 * query/mutation logic live in the sibling `merge-duplicate-skills.helpers.ts`
 * (this file's own 500-line-standard split); this file is orchestration +
 * the CLI entrypoint.
 *
 * Must complete before Step 5 (CREATE UNIQUE INDEX CONCURRENTLY on
 * repo_url_canonical) — the index build fails on any remaining duplicate.
 *
 * Why a psql shell-out, not the `pg` npm client, not supabase-js: the design
 * doc requires `--apply` to run the ENTIRE merge — `skills` DELETE plus all
 * six dependent-table mutations — in one transaction (`SET LOCAL
 * lock_timeout = '3s'`, R4 guardrail re-checked inside that same
 * transaction). PostgREST/supabase-js has no cross-call transaction — each
 * `.from(...)` call is its own implicit transaction. The `pg` npm client
 * would give real transactions, but IS NOT AN INSTALLED DEPENDENCY and
 * cannot become one from inside a worktree: a worktree's `node_modules` is
 * bind-mounted READ-ONLY from the main checkout (SMI-4689/5560/5626/5650),
 * so `npm install` inside a worktree container cannot write it — the same
 * constraint `scripts/indexer/smi5879-census.pg.ts`'s own header documents
 * hitting first. This script reuses that exact module's `queryRows`/
 * `queryScalar`/`runPsql` helpers (shell out to `psql`, already on the dev
 * image's PATH) instead — `runPsql` accepts a full multi-statement script
 * (BEGIN ... COMMIT) in one call, giving the same atomicity guarantee
 * without a new dependency.
 *
 * Safety: `--dry-run` is the DEFAULT; `--apply` performs writes (mirrors
 * `dequarantine-false-positives.ts`'s convention). Gated by the SMI-5879
 * run-gate (`assertRunAllowed('merge')` + `assertFreezeMarkerClear`) same as
 * every other one-time `skills`-table writer in this family. `--apply`
 * refuses to run if the reversal manifest cannot be written to disk FIRST.
 * Per-group survivor/loser ids are captured via a fresh read immediately
 * before the apply script is built and executed; the R4 guardrail is
 * re-checked with a LIVE read INSIDE the transaction (not the JS-captured
 * snapshot), so a group that grew between dry-run and apply cannot slip
 * past the guardrail. The narrower case of a captured group's *membership*
 * changing between that read and COMMIT is not separately re-validated
 * inside the transaction — this is safe by construction of the wider
 * workflow, not this script alone: Step 3 pauses every `skills` writer
 * before Step 4 runs, so nothing should be touching `repo_url_canonical`
 * during this window at all.
 *
 * Reversal manifest scope (plan-review finding, corrects the design doc's
 * original "losers only" scope): captures full before-images of every
 * LOSER row (all seven tables) AND every SURVIVOR-side row in the six
 * dependent tables that already exists before the merge touches it — a
 * union-insert into skill_categories doesn't modify a survivor's existing
 * rows, but outreach_suppressions/quarantine_approvals re-point + recompute
 * genuinely can, and capturing broadly (rather than reasoning per-table
 * about which specific rows change) is the safer choice for something this
 * rarely exercised.
 *
 * Usage (host tool — requires Docker container running for varlock, and a
 * writer-pause already in effect per the plan's Step 3 — this script does
 * NOT pause writers itself):
 *   varlock run -- npx tsx scripts/indexer/merge-duplicate-skills.ts          # dry-run
 *   varlock run -- npx tsx scripts/indexer/merge-duplicate-skills.ts --apply  # live
 */

import { createSupabaseAdminClient } from './_shared/supabase.ts'
import { assertRunAllowed, assertFreezeMarkerClear } from './run-gate.ts'
import { type PgConnParams, poolerSessionConnParams, runPsql } from './smi5879-census.pg.ts'
import {
  GUARDRAIL_MAX_LOSERS,
  type MergeCounts,
  type TableMovement,
  type QuarantineApprovalDelta,
  findDuplicateGroups,
  assertGuardrail,
  allLoserIds,
  allSurvivorIds,
  buildReversalManifest,
  writeReversalManifest,
  planGroup,
  isCompleteForIds,
  suppressedSkillCount,
  groupHadSuppression,
  buildGroupMutationSql,
} from './merge-duplicate-skills.helpers.ts'

export type {
  SkillRow,
  DuplicateGroup,
  TableMovement,
  QuarantineApprovalDelta,
  ReversalManifest,
  MergeCounts,
} from './merge-duplicate-skills.helpers.ts'
export {
  GUARDRAIL_MAX_LOSERS,
  findDuplicateGroups,
  assertGuardrail,
  buildReversalManifest,
  writeReversalManifest,
} from './merge-duplicate-skills.helpers.ts'

/** Full merge run: dry-run (default) or apply. Returns the counts for reporting. */
export async function runMerge(
  conn: PgConnParams,
  db: ReturnType<typeof createSupabaseAdminClient>,
  opts: { apply: boolean; manifestPath: string }
): Promise<MergeCounts> {
  const groups = await findDuplicateGroups(conn)
  assertGuardrail(groups)

  console.log(
    `\n${opts.apply ? '🔧 APPLY' : '🔍 DRY-RUN'} — ${groups.length} duplicate group(s), ${groups.reduce((s, g) => s + g.losers.length, 0)} row(s) to merge\n`
  )
  for (const g of groups) {
    console.log(`  ${g.repoUrlCanonical}`)
    console.log(`    survivor: ${g.survivor.id} (${g.survivor.author}/${g.survivor.name})`)
    for (const l of g.losers) console.log(`    loser:    ${l.id} (${l.author}/${l.name})`)
  }

  const allTouchedIds = [...allSurvivorIds(groups), ...allLoserIds(groups)]
  const suppressionCountBefore = await suppressedSkillCount(conn, allTouchedIds)

  const manifest = await buildReversalManifest(conn, groups)
  writeReversalManifest(manifest, opts.manifestPath)
  console.log(`\nReversal manifest written: ${opts.manifestPath}`)

  // "Before" is always the survivor's OWN current rows. "After" (prospective,
  // computed here BEFORE any mutation) simulates the post-re-point union for
  // dry-run — a read-only query, safe to run without touching anything.
  // Apply overwrites isCompleteAfter with a real post-mutation read below.
  const isCompleteBefore = new Map<string, boolean | null>()
  const isCompleteAfter = new Map<string, boolean | null>()
  const groupHadSuppressionMap = new Map<string, boolean>()
  for (const g of groups) {
    isCompleteBefore.set(g.survivor.id, await isCompleteForIds(conn, [g.survivor.id]))
    isCompleteAfter.set(
      g.survivor.id,
      await isCompleteForIds(conn, [g.survivor.id, ...g.losers.map((l) => l.id)])
    )
    groupHadSuppressionMap.set(g.survivor.id, await groupHadSuppression(conn, g))
  }

  const movements: TableMovement[] = []
  console.log(`\n── Per-table movement plan ──`)
  for (const g of groups) {
    const groupMovements = await planGroup(conn, g)
    movements.push(...groupMovements)
    console.log(`  ${g.repoUrlCanonical}`)
    for (const m of groupMovements) {
      console.log(
        `    ${m.table.padEnd(22)} rePointed=${m.rePointed} discarded=${m.discarded} skippedOnConflict=${m.skippedOnConflict}`
      )
    }
  }

  if (opts.apply) {
    // Re-derive with a LIVE read and re-check the guardrail INSIDE the same
    // logical operation — see the file header's atomicity note for why the
    // per-group snapshot itself isn't independently re-validated here.
    const liveGroups = await findDuplicateGroups(conn)
    assertGuardrail(liveGroups)

    const guardrailCheck = `
DO $$
DECLARE n int;
BEGIN
  SELECT COALESCE(sum(c) - count(*), 0) INTO n
  FROM (SELECT count(*) c FROM skills WHERE repo_url_canonical IS NOT NULL GROUP BY repo_url_canonical HAVING count(*) > 1) g;
  IF n > ${GUARDRAIL_MAX_LOSERS} THEN
    RAISE EXCEPTION 'ABORT: merge would remove % rows (guardrail ${GUARDRAIL_MAX_LOSERS})', n;
  END IF;
END $$;
`
    const mutationBlocks = groups
      .map((g) => buildGroupMutationSql(g, groupHadSuppressionMap.get(g.survivor.id) ?? false))
      .join('\n')
    const script = `
BEGIN;
SET LOCAL lock_timeout = '3s';
${guardrailCheck}
${mutationBlocks}
COMMIT;
`
    await runPsql(conn, script)

    // Real post-mutation read, replacing the pre-mutation simulation above —
    // by now every loser's quarantine_approvals row already carries the
    // survivor's id, so querying [survivorId] alone is the true after-state.
    for (const g of groups) {
      isCompleteAfter.set(g.survivor.id, await isCompleteForIds(conn, [g.survivor.id]))
    }
  }

  const isCompleteDeltas: QuarantineApprovalDelta[] = []
  for (const g of groups) {
    const before = isCompleteBefore.get(g.survivor.id) ?? false
    const after = isCompleteAfter.get(g.survivor.id) ?? false
    if ((before ?? false) !== (after ?? false)) {
      isCompleteDeltas.push({
        skillId: g.survivor.id,
        before: before ?? false,
        after: after ?? false,
      })
    }
  }

  // Informational only, post-commit — the authoritative, transaction-rolling-back
  // check is the per-group in-transaction assertion buildGroupMutationSql emits
  // (see groupHadSuppression's doc comment for why a global count comparison is
  // unsound and was removed as the enforcement mechanism here).
  const suppressionCountAfter = opts.apply
    ? await suppressedSkillCount(conn, allSurvivorIds(groups))
    : suppressionCountBefore

  if (opts.apply) {
    await db.from('audit_logs').insert({
      event_type: 'skills:merge_duplicates',
      actor: 'system',
      resource: 'skills',
      action: 'merge_duplicate_skills',
      result: 'success',
      metadata: {
        smi: 'SMI-5898',
        groups: groups.length,
        losersRemoved: allLoserIds(groups).length,
        manifestPath: opts.manifestPath,
      },
    })
  }

  console.log(
    `\n── Summary ──\n` +
      `  groups:              ${groups.length}\n` +
      `  ${opts.apply ? 'removed' : 'would-remove'}:            ${allLoserIds(groups).length}\n` +
      `  is_complete deltas:  ${isCompleteDeltas.length}\n` +
      `  suppression before:  ${suppressionCountBefore}\n` +
      `  suppression after:   ${opts.apply ? suppressionCountAfter : '(unchanged — dry-run)'}\n`
  )
  if (!opts.apply) console.log('Dry-run only — re-run with --apply to perform the merge.\n')

  return {
    groups: groups.length,
    losersRemoved: allLoserIds(groups).length,
    tableMovements: movements,
    isCompleteDeltas,
    suppressionCountBefore,
    suppressionCountAfter,
  }
}

async function main(): Promise<void> {
  assertRunAllowed('merge')
  const db = createSupabaseAdminClient()
  await assertFreezeMarkerClear(db, 'merge')

  const apply = process.argv.includes('--apply')
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const manifestPath = `docs/internal/reports/smi-5898-merge-reversal-manifest-${timestamp}.json`

  const conn = poolerSessionConnParams()
  await runMerge(conn, db, { apply, manifestPath })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
