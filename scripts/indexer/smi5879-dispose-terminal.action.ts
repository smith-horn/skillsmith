/**
 * SMI-6444 bulk disposition producer CLI — action implementations for the
 * "simple" subcommands (`init`, `add-manual`, `sign-off`, `revoke-manual`,
 * `revoke-sign-off`, `revoke-batch`): thin wrappers around the already-built,
 * already-tested locked ledger core (`smi5879-dispose-terminal.ledger.ts`).
 * Every mutation-shaped invariant (the lock, the five-step write protocol,
 * conflict/provenance rules) lives in that module — this file's only job is
 * argument plumbing, printing, and exit-code mapping (SMI-5127 convention:
 * `smi5879-dispose-terminal.ts` keeps only the commander factory).
 *
 * The two `dispose` outcome-class flows (`unfetchable`/`primary_not_found`)
 * are large enough to need their own siblings —
 * `smi5879-dispose-terminal.action.dispose.ts` (shared setup: population/
 * report load, provenance resolution, outcome-class dispatch),
 * `smi5879-dispose-terminal.action.unfetchable.ts`, and
 * `smi5879-dispose-terminal.action.primary-not-found.ts`.
 * @module scripts/indexer/smi5879-dispose-terminal.action
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *   Item 8's `add-manual`/revocation subcommands; the coordinator ruling
 *   (this task's own dispatch prompt) for `init`, the only sanctioned
 *   ledger-bootstrap path — not specified by the plan itself, since the plan
 *   assumes an operator hand-creates the very first empty ledger file.
 */

import {
  LEDGER_LOCK_CONTEXT_LINE,
  LEDGER_LOCK_LABEL,
  addManualEntry,
  defaultLedgerIoDeps,
  revokeBatchSignOff,
  revokeDispositionBatch,
  revokeManualEntry,
  serializeLedger,
  signOffDispositionBatch,
  type LedgerCommandResult,
  type LedgerIoDeps,
  type SignOffSummary,
} from './smi5879-dispose-terminal.ledger.ts'
import { acquireWithContext, writeFileAtomically } from './smi5879-dispose-terminal.io.ts'
import { validateDispositionLedgerShape } from './smi5879-gate-check.ledger-validation.ts'
import type { DispositionVerdict, Smi5879DispositionLedger } from './smi5879-gate-check.types.ts'

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

export interface CliActionDeps {
  ledgerDeps?: Partial<LedgerIoDeps>
  /** ISO 8601 source — injected for deterministic tests, defaults to real time. */
  now?: () => string
  log?: (msg: string) => void
}

export function defaultNow(): string {
  return new Date().toISOString()
}

/** Resolve the injected logger, defaulting to stdout — shared by every
 *  action module so the default sink can never drift between subcommands. */
export function logOf(deps: CliActionDeps): (msg: string) => void {
  return deps.log ?? ((msg: string) => console.log(msg))
}

/** Print a `LedgerCommandResult` and map it to a process exit code — 0 on any
 *  success (including a deliberate `written:false` preview), 1 on refusal. */
export function printLedgerResult<T>(
  result: LedgerCommandResult<T>,
  deps: CliActionDeps,
  onSuccess: (result: T, log: (msg: string) => void) => void
): number {
  const log = logOf(deps)
  if (!result.ok) {
    log(`REFUSED [${result.code}]: ${result.reason}`)
    return 1
  }
  onSuccess(result.result, log)
  return 0
}

export interface LedgerPathOptions {
  dispositions: string
  timeoutMs?: number
}

function lockedCallOptions(
  opts: LedgerPathOptions,
  deps: CliActionDeps
): { ledgerPath: string; timeoutMs?: number; deps?: Partial<LedgerIoDeps> } {
  return {
    ledgerPath: opts.dispositions,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(deps.ledgerDeps !== undefined ? { deps: deps.ledgerDeps } : {}),
  }
}

// ---------------------------------------------------------------------------
// init — the only sanctioned ledger-bootstrap path (coordinator ruling)
// ---------------------------------------------------------------------------

export type InitLedgerResult =
  | { ok: true; ledger: Smi5879DispositionLedger }
  | { ok: false; code: 'invalid_input' | 'ledger_already_exists'; reason: string }

/**
 * Lock-holding create of a brand-new, empty ledger. REFUSES outright if the
 * file already exists — this is a bootstrap operation, not an upsert; every
 * subsequent mutation goes through `stage`/`sign-off`/`add-manual`/
 * `revoke-*`, none of which can create a ledger from nothing. Takes the SAME
 * lock every other mutating subcommand takes, so a concurrent `init` racing
 * a concurrent `init` (or any other subcommand that would otherwise see
 * "not found") can never produce two independently-created files.
 */
export function initLedger(params: {
  ledgerPath: string
  runId: string
  timeoutMs?: number
  deps?: Partial<LedgerIoDeps>
}): InitLedgerResult {
  if (params.runId.trim().length === 0) {
    return { ok: false, code: 'invalid_input', reason: 'init: run-id must be non-empty' }
  }
  const deps: LedgerIoDeps = { ...defaultLedgerIoDeps, ...params.deps }
  const release = acquireWithContext(
    () =>
      deps.acquireLock(params.ledgerPath, {
        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
        label: LEDGER_LOCK_LABEL,
      }),
    LEDGER_LOCK_CONTEXT_LINE
  )
  try {
    if (deps.fileExists(params.ledgerPath)) {
      return {
        ok: false,
        code: 'ledger_already_exists',
        reason:
          `init: a disposition ledger already exists at ${params.ledgerPath} — init is the ` +
          'sanctioned bootstrap for a NEW ledger only; every other mutation goes through ' +
          'stage/sign-off/add-manual/revoke-*.',
      }
    }
    const ledger: Smi5879DispositionLedger = { run_id: params.runId, entries: [] }
    // Round-trip through the SAME shape validator every other write
    // re-validates through (the locked five-step protocol's step 2), so init
    // can never write something this tool would then refuse to load itself.
    const shapeCheck = validateDispositionLedgerShape(JSON.parse(serializeLedger(ledger)))
    if (!shapeCheck.ok) {
      throw new Error(
        `smi5879-dispose-terminal init: a freshly-built empty ledger failed its own shape ` +
          `validation (${shapeCheck.reason}) — this is a producer bug, not a user error.`
      )
    }
    writeFileAtomically(deps, params.ledgerPath, serializeLedger(ledger))
    return { ok: true, ledger }
  } finally {
    release()
  }
}

export interface InitOptions {
  dispositions: string
  runId: string
  timeoutMs?: number
}

export function initAction(opts: InitOptions, deps: CliActionDeps = {}): number {
  const log = logOf(deps)
  const result = initLedger({
    ledgerPath: opts.dispositions,
    runId: opts.runId,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(deps.ledgerDeps !== undefined ? { deps: deps.ledgerDeps } : {}),
  })
  if (!result.ok) {
    log(`REFUSED [${result.code}]: ${result.reason}`)
    return 1
  }
  log(
    `Initialized empty disposition ledger for run_id="${result.ledger.run_id}" at ${opts.dispositions}.`
  )
  return 0
}

// ---------------------------------------------------------------------------
// add-manual
// ---------------------------------------------------------------------------

export interface AddManualOptions extends LedgerPathOptions {
  id: string
  verdict: DispositionVerdict
  reason: string
  operator: string
}

export function addManualAction(opts: AddManualOptions, deps: CliActionDeps = {}): number {
  const result = addManualEntry({
    ...lockedCallOptions(opts, deps),
    params: {
      id: opts.id,
      verdict: opts.verdict,
      reason: opts.reason,
      operator: opts.operator,
      now: (deps.now ?? defaultNow)(),
    },
  })
  return printLedgerResult(result, deps, ({ entry }, log) =>
    log(`Recorded manual disposition: id="${entry.id}" verdict=${entry.verdict}.`)
  )
}

// ---------------------------------------------------------------------------
// sign-off — display-only without --confirm (plan Item 4)
// ---------------------------------------------------------------------------

export interface SignOffOptions extends LedgerPathOptions {
  batchId: string
  operator: string
  confirm?: string
}

function printSignOffSummary(summary: SignOffSummary, log: (msg: string) => void): void {
  log(
    `Batch ${summary.batch_id} (${summary.outcome_class}, run_id=${summary.run_id})\n` +
      `  population=${summary.population_count} entries=${summary.entry_count} verified=${summary.verified_count}\n` +
      `  mismatched=${summary.total_mismatched} unavailable=${summary.total_unavailable}\n` +
      (summary.mismatched_ids_preview.length > 0
        ? `  mismatched (first ${summary.mismatched_ids_preview.length}): ${summary.mismatched_ids_preview.join(', ')}\n`
        : '') +
      `  already_signed=${summary.already_signed} stage_digest_matches_stored=${summary.stage_digest_matches_stored}\n` +
      `  Confirmation code: ${summary.confirmation_code}`
  )
}

/**
 * Without `--confirm`: recomputes and prints the summary + confirmation
 * code, writes nothing, exits non-zero (a preview is never a success exit —
 * it did not accomplish the invocation's stated purpose, signing).
 * With `--confirm=<code>`: signs iff every check in
 * `signOffDispositionBatch` passes.
 */
export function signOffAction(opts: SignOffOptions, deps: CliActionDeps = {}): number {
  const log = logOf(deps)
  const result = signOffDispositionBatch({
    ...lockedCallOptions(opts, deps),
    params: {
      batchId: opts.batchId,
      operator: opts.operator,
      ...(opts.confirm !== undefined ? { confirmCode: opts.confirm } : {}),
      now: (deps.now ?? defaultNow)(),
    },
  })
  if (!result.ok) {
    log(`REFUSED [${result.code}]: ${result.reason}`)
    return 1
  }
  printSignOffSummary(result.result.summary, log)
  if (result.result.kind === 'preview') {
    log('Preview only — nothing written. Re-run with --confirm=<code> from this output to sign.')
    return 1
  }
  log(`Signed off batch "${result.result.batch.batch_id}" as "${opts.operator}".`)
  return 0
}

// ---------------------------------------------------------------------------
// revoke-manual / revoke-sign-off / revoke-batch
// ---------------------------------------------------------------------------

export interface RevokeManualOptions extends LedgerPathOptions {
  id: string
  reason: string
  operator: string
}

export function revokeManualAction(opts: RevokeManualOptions, deps: CliActionDeps = {}): number {
  const result = revokeManualEntry({
    ...lockedCallOptions(opts, deps),
    params: {
      id: opts.id,
      reason: opts.reason,
      operator: opts.operator,
      now: (deps.now ?? defaultNow)(),
    },
  })
  return printLedgerResult(result, deps, ({ entry }, log) =>
    log(`Revoked manual entry: id="${entry.id}".`)
  )
}

export interface RevokeSignOffOptions extends LedgerPathOptions {
  batchId: string
  reason: string
  operator: string
}

export function revokeSignOffAction(opts: RevokeSignOffOptions, deps: CliActionDeps = {}): number {
  const result = revokeBatchSignOff({
    ...lockedCallOptions(opts, deps),
    params: {
      batchId: opts.batchId,
      reason: opts.reason,
      operator: opts.operator,
      now: (deps.now ?? defaultNow)(),
    },
  })
  return printLedgerResult(result, deps, ({ batch }, log) =>
    log(`Revoked sign-off on batch "${batch.batch_id}" — reverted to staged-unsigned.`)
  )
}

export interface RevokeBatchOptions extends LedgerPathOptions {
  batchId: string
  reason: string
  operator: string
}

export function revokeBatchAction(opts: RevokeBatchOptions, deps: CliActionDeps = {}): number {
  const result = revokeDispositionBatch({
    ...lockedCallOptions(opts, deps),
    params: {
      batchId: opts.batchId,
      reason: opts.reason,
      operator: opts.operator,
      now: (deps.now ?? defaultNow)(),
    },
  })
  return printLedgerResult(result, deps, ({ batch, removedEntryIds }, log) =>
    log(
      `Revoked batch "${batch.batch_id}" — removed ${removedEntryIds.length} ledger entr${removedEntryIds.length === 1 ? 'y' : 'ies'}.`
    )
  )
}
