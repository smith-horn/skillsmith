#!/usr/bin/env -S npx tsx
/**
 * SMI-6444: bulk disposition producer for the G-1 terminal no-verdict
 * outcome classes (`unfetchable`, `primary_not_found`). Commander factory
 * only (SMI-5127 convention) — every subcommand's implementation lives in
 * `smi5879-dispose-terminal.action*.ts`; every ledger/sidecar invariant
 * lives in the already-built, already-tested `smi5879-dispose-terminal.
 * ledger.ts` / `.sidecar.ts` core. This file owns argument parsing and exit
 * codes only.
 * @module scripts/indexer/smi5879-dispose-terminal
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *   Item 4 (sign-off checkpoint), Item 8 (`add-manual`/revoke-* subcommands,
 *   sidecar), Item 9 (test list). `init` is the coordinator-ruled sanctioned
 *   ledger-bootstrap path — the plan itself assumes an operator hand-creates
 *   the first empty ledger.
 *
 * CLI:
 *   varlock run -- npx tsx scripts/indexer/smi5879-dispose-terminal.ts \
 *     init --dispositions=<path> --run-id=<run_id>
 *
 *   varlock run -- npx tsx scripts/indexer/smi5879-dispose-terminal.ts \
 *     dispose --run-id=<run_id> --outcome-class=<unfetchable|primary_not_found> \
 *     --simulator-report=<path> --dispositions=<path> --operator=<identity> \
 *     [--seed=<seed>] [--sidecar=<path>] [--allow-dirty-worktree=<reason>] \
 *     [--confidence-pct=<n>] [--mismatch-threshold-bp=<n>] \
 *     [--stratum-threshold-bp=<n>] [--design-point-bad-draws-per-stratum=<n>] \
 *     [--fetch-concurrency=<n>] [--timeout-ms=<ms>] [--sidecar-timeout-ms=<ms>]
 *
 *   npx tsx scripts/indexer/smi5879-dispose-terminal.ts \
 *     sign-off --batch-id=<id> --dispositions=<path> --operator=<identity> [--confirm=<code>]
 *
 *   npx tsx scripts/indexer/smi5879-dispose-terminal.ts \
 *     add-manual --dispositions=<path> --id=<id> --verdict=<confirm|exclude> \
 *     --reason=<text> --operator=<identity>
 *
 *   npx tsx scripts/indexer/smi5879-dispose-terminal.ts \
 *     revoke-manual|revoke-sign-off|revoke-batch --dispositions=<path> \
 *     [--id=<id> | --batch-id=<id>] --reason=<text> --operator=<identity>
 *
 * Exit code 0 iff the invoked subcommand succeeded.
 */

import { Command, Option } from 'commander'
import { poolerSessionConnParams } from './smi5879-census.pg.ts'
import { createSmi5879DisposeTerminalDbDeps } from './smi5879-dispose-terminal.db.ts'
import { disposeAction, type DisposeOptions } from './smi5879-dispose-terminal.action.dispose.ts'
import {
  addManualAction,
  initAction,
  revokeBatchAction,
  revokeManualAction,
  revokeSignOffAction,
  signOffAction,
} from './smi5879-dispose-terminal.action.ts'
import { DEFAULT_SAMPLING_POLICY } from './smi5879-dispose-terminal.stats.ts'

function intOption(value: string): number {
  const n = Number(value)
  if (!Number.isInteger(n)) {
    throw new Error(`expected an integer, got "${value}"`)
  }
  return n
}

export function createDisposeTerminalCli(): Command {
  const program = new Command('smi5879-dispose-terminal').description(
    'SMI-6444 bulk disposition producer for the G-1 terminal no-verdict outcome classes ' +
      '(unfetchable, primary_not_found).'
  )

  program
    .command('init')
    .description(
      'Bootstrap a brand-new, empty disposition ledger. Refuses if the file already exists.'
    )
    .requiredOption('--dispositions <path>', 'Disposition ledger file path')
    .requiredOption('--run-id <run_id>', 'The generation run_id this ledger disposes rows for')
    .option('--timeout-ms <ms>', 'Lock-acquire timeout, ms', intOption)
    .action((opts) => {
      process.exitCode = initAction({
        dispositions: opts.dispositions,
        runId: opts.runId,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      })
    })

  program
    .command('dispose')
    .description(
      'Stage a bulk disposition batch for every --outcome-class candidate row in a simulator report.'
    )
    .requiredOption(
      '--run-id <run_id>',
      'The sealed, digest-verified generation to dispose rows for'
    )
    .addOption(
      new Option('--outcome-class <class>', 'Which terminal outcome class to dispose')
        .choices(['unfetchable', 'primary_not_found'])
        .makeOptionMandatory(true)
    )
    .requiredOption('--simulator-report <path>', 'Path to the simulator report JSON')
    .requiredOption('--dispositions <path>', 'Disposition ledger file path')
    .requiredOption('--operator <identity>', 'Who is running this staging pass')
    .option('--seed <seed>', 'Sampling seed — required for --outcome-class=primary_not_found')
    .option(
      '--sidecar <path>',
      '.sample.json sidecar path — required for --outcome-class=primary_not_found'
    )
    .option(
      '--confidence-pct <n>',
      `One-sided confidence, integer percent (default ${DEFAULT_SAMPLING_POLICY.confidencePct})`,
      intOption
    )
    .option(
      '--mismatch-threshold-bp <n>',
      `Population-arm acceptance threshold, bp (default ${DEFAULT_SAMPLING_POLICY.mismatchThresholdBp})`,
      intOption
    )
    .option(
      '--stratum-threshold-bp <n>',
      `Per-stratum acceptance threshold, bp (default ${DEFAULT_SAMPLING_POLICY.stratumThresholdBp})`,
      intOption
    )
    .option(
      '--design-point-bad-draws-per-stratum <n>',
      `Sizing robustness target (default ${DEFAULT_SAMPLING_POLICY.designPointBadDrawsPerStratum})`,
      intOption
    )
    .option(
      '--fetch-concurrency <n>',
      'Bounded concurrency for the live primary_not_found re-fetch',
      intOption
    )
    .option(
      '--allow-dirty-worktree <reason>',
      'Override the dirty-worktree refusal; the reason is recorded in the batch'
    )
    .option('--timeout-ms <ms>', 'Ledger lock-acquire timeout, ms', intOption)
    .option('--sidecar-timeout-ms <ms>', 'Sidecar lock-acquire timeout, ms', intOption)
    .action(async (opts) => {
      const disposeOpts: DisposeOptions = {
        dispositions: opts.dispositions,
        runId: opts.runId,
        outcomeClass: opts.outcomeClass,
        simulatorReport: opts.simulatorReport,
        operator: opts.operator,
        ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
        ...(opts.sidecar !== undefined ? { sidecar: opts.sidecar } : {}),
        ...(opts.confidencePct !== undefined ? { confidencePct: opts.confidencePct } : {}),
        ...(opts.mismatchThresholdBp !== undefined
          ? { mismatchThresholdBp: opts.mismatchThresholdBp }
          : {}),
        ...(opts.stratumThresholdBp !== undefined
          ? { stratumThresholdBp: opts.stratumThresholdBp }
          : {}),
        ...(opts.designPointBadDrawsPerStratum !== undefined
          ? { designPointBadDrawsPerStratum: opts.designPointBadDrawsPerStratum }
          : {}),
        ...(opts.fetchConcurrency !== undefined ? { fetchConcurrency: opts.fetchConcurrency } : {}),
        ...(opts.allowDirtyWorktree !== undefined
          ? { allowDirtyWorktree: opts.allowDirtyWorktree }
          : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.sidecarTimeoutMs !== undefined ? { sidecarTimeoutMs: opts.sidecarTimeoutMs } : {}),
      }
      const db = createSmi5879DisposeTerminalDbDeps(poolerSessionConnParams())
      process.exitCode = await disposeAction(disposeOpts, { db })
    })

  program
    .command('sign-off')
    .description(
      'Without --confirm: display the batch summary + confirmation code, write nothing, exit ' +
        'non-zero. With --confirm=<code>: sign iff every check passes.'
    )
    .requiredOption('--batch-id <id>', 'The staged batch to sign off')
    .requiredOption('--dispositions <path>', 'Disposition ledger file path')
    .requiredOption('--operator <identity>', 'Who is signing')
    .option('--confirm <code>', 'The confirmation code from a prior display pass')
    .option('--timeout-ms <ms>', 'Lock-acquire timeout, ms', intOption)
    .action((opts) => {
      process.exitCode = signOffAction({
        batchId: opts.batchId,
        dispositions: opts.dispositions,
        operator: opts.operator,
        ...(opts.confirm !== undefined ? { confirm: opts.confirm } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      })
    })

  program
    .command('add-manual')
    .description('Append one operator-authored disposition entry, under the ledger lock.')
    .requiredOption('--dispositions <path>', 'Disposition ledger file path')
    .requiredOption('--id <id>', 'The row id to dispose')
    .addOption(
      new Option('--verdict <verdict>', 'confirm | exclude')
        .choices(['confirm', 'exclude'])
        .makeOptionMandatory(true)
    )
    .requiredOption('--reason <text>', 'Free-text rationale')
    .requiredOption('--operator <identity>', 'Who is recording this')
    .option('--timeout-ms <ms>', 'Lock-acquire timeout, ms', intOption)
    .action((opts) => {
      process.exitCode = addManualAction({
        dispositions: opts.dispositions,
        id: opts.id,
        verdict: opts.verdict,
        reason: opts.reason,
        operator: opts.operator,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      })
    })

  program
    .command('revoke-manual')
    .description('Tombstone one active manual disposition entry. Never revocable for a bulk entry.')
    .requiredOption('--dispositions <path>', 'Disposition ledger file path')
    .requiredOption('--id <id>', 'The row id to revoke')
    .requiredOption('--reason <text>', 'Why this is being revoked')
    .requiredOption('--operator <identity>', 'Who is revoking')
    .option('--timeout-ms <ms>', 'Lock-acquire timeout, ms', intOption)
    .action((opts) => {
      process.exitCode = revokeManualAction({
        dispositions: opts.dispositions,
        id: opts.id,
        reason: opts.reason,
        operator: opts.operator,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      })
    })

  program
    .command('revoke-sign-off')
    .description(
      'Clear a batch sign-off (archived, not deleted); reverts the batch to staged-unsigned.'
    )
    .requiredOption('--dispositions <path>', 'Disposition ledger file path')
    .requiredOption('--batch-id <id>', 'The signed batch to revoke sign-off on')
    .requiredOption('--reason <text>', 'Why this is being revoked')
    .requiredOption('--operator <identity>', 'Who is revoking')
    .option('--timeout-ms <ms>', 'Lock-acquire timeout, ms', intOption)
    .action((opts) => {
      process.exitCode = revokeSignOffAction({
        dispositions: opts.dispositions,
        batchId: opts.batchId,
        reason: opts.reason,
        operator: opts.operator,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      })
    })

  program
    .command('revoke-batch')
    .description(
      'Terminal: remove every ledger entry this batch generated and mark the batch revoked.'
    )
    .requiredOption('--dispositions <path>', 'Disposition ledger file path')
    .requiredOption('--batch-id <id>', 'The batch to revoke')
    .requiredOption('--reason <text>', 'Why this is being revoked')
    .requiredOption('--operator <identity>', 'Who is revoking')
    .option('--timeout-ms <ms>', 'Lock-acquire timeout, ms', intOption)
    .action((opts) => {
      process.exitCode = revokeBatchAction({
        dispositions: opts.dispositions,
        batchId: opts.batchId,
        reason: opts.reason,
        operator: opts.operator,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      })
    })

  return program
}

// Run only when invoked directly (not when imported by the test suite).
if (import.meta.url === `file://${process.argv[1]}`) {
  createDisposeTerminalCli()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      console.error(err)
      process.exit(1)
    })
}
