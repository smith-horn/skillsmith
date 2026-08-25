/**
 * Console-output helpers for smi5879-simulate-full.ts's CLI entrypoint
 * (`printSummary`/`dryRun`) — split out per CLAUDE.md's <500-line-per-file
 * convention (SMI-6015 PAT-sharded fetch plan Wave 1's shard-aware report
 * path defaulting pushed the combined file over budget). Pure
 * reporting/pre-flight helpers, called by `main()`, which stays in
 * smi5879-simulate-full.ts itself — the `import.meta.url ===
 * file://${process.argv[1]}` entrypoint check depends on `main()` and its
 * invocation staying in the file operators actually run
 * (`npx tsx scripts/indexer/smi5879-simulate-full.ts`), so only these two
 * side helpers move here, not `main()` itself.
 * @module scripts/indexer/smi5879-simulate-full.output
 */

import { buildGitHubHeaders } from './_shared/github-auth.ts'
import { poolerSessionConnParams, runPsql } from './smi5879-census.pg.ts'
import { assertPatTokenSource } from './smi5879-simulate-full.helpers.ts'
import { ALL_SIMULATED_COHORTS } from './smi5879-simulate-full.types.ts'
import type { CliArgs } from './smi5879-simulate-full.cli.ts'
import type { Smi5879SimulateFullReport } from './smi5879-simulate-full.types.ts'

export function printSummary(report: Smi5879SimulateFullReport): void {
  console.log(
    `\n── Simulation Summary (${report.run_id}) ──\n` +
      `  report_kind:       ${report.report_kind}\n` +
      `  token_source:      ${report.token_source}\n` +
      `  baseline_commit:   ${report.baseline_commit}\n` +
      `  sweep:             ${report.sweep.passes_run} pass(es), hard_stopped=${report.sweep.hard_stopped ?? 'none'}\n` +
      ALL_SIMULATED_COHORTS.map(
        (c) =>
          `  coverage.${c}:       ${report.coverage[c].status} (${report.coverage[c].scanned}/${report.coverage[c].total}, unevaluable=${report.coverage[c].unevaluable}, unfetchable=${report.coverage[c].unfetchable})`
      ).join('\n') +
      `\n  counts: ${JSON.stringify(report.counts)}\n`
  )
}

export async function dryRun(args: CliArgs): Promise<void> {
  console.log(
    `[DRY-RUN] run-id=${args.runId} purpose=${args.purpose} baseline-commit=${args.baselineCommit}`
  )
  assertPatTokenSource()
  const conn = poolerSessionConnParams()
  await runPsql(conn, 'SELECT 1;')
  console.log('[DRY-RUN] DB connectivity OK (session pooler).')
  const headers = await buildGitHubHeaders('skillsmith-smi5879-simulate/1.0')
  console.log(
    `[DRY-RUN] GitHub auth headers built (Authorization present: ${'Authorization' in headers}).`
  )
  console.log(
    '[DRY-RUN] No generation claimed, no GitHub fetches performed, no checkpoint/report written. ' +
      'Re-run with --apply to perform the real simulation.'
  )
}
