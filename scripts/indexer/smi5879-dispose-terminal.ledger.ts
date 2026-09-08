/**
 * SMI-6444's locked ledger-mutation core: the five-step atomic write protocol
 * every mutating subcommand (`stage`, `sign-off`, `add-manual`,
 * `revoke-manual`, `revoke-sign-off`, `revoke-batch`) shares, plus one thin
 * per-subcommand wrapper composing it with the matching pure mutation from
 * `smi5879-dispose-terminal.ledger.mutations.ts`.
 *
 * This module owns NO CLI surface — argument parsing, output rendering, and
 * exit codes belong to the commander layer built on top of it.
 * @module scripts/indexer/smi5879-dispose-terminal.ledger
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *   Item 8 — the lock (`acquireOwnedLock`, imported from the
 *   `@skillsmith/core/config/owned-lock` SUBPATH, never the root barrel,
 *   which pulls native modules) and the exact five-step write sequence:
 *
 *     1. Read the current on-disk ledger and record its digest
 *        (`initialDigest`).
 *     2. Mutate an in-memory copy; write the result to a sibling temp file;
 *        fully re-parse/re-validate the TEMP FILE'S OWN CONTENT (never a
 *        digest comparison — that is step 4).
 *     3. Immediately before renaming — as late as possible — re-read and
 *        re-hash the on-disk ledger AT ITS DESTINATION PATH (not the temp
 *        file, not the in-memory copy).
 *     4. Require that freshly-read destination digest equals `initialDigest`;
 *        refuse if it does not. No auto-retry.
 *     5. Only then `renameSync` the validated temp file into place.
 *
 *   Step 2 is expected to produce content that DIFFERS from `initialDigest` —
 *   that is the whole point of a mutation. Only a changed DESTINATION file
 *   refuses (the round-5 wording bug this sequence exists to state
 *   unambiguously).
 */

import { acquireWithContext, defaultFileIoDeps, sha256 } from './smi5879-dispose-terminal.io.ts'
import {
  validateDispositionLedger,
  validateDispositionLedgerShape,
} from './smi5879-gate-check.ledger-validation.ts'
import type { Smi5879DispositionLedger } from './smi5879-gate-check.types.ts'
import { addManual, signOff, stageBatch } from './smi5879-dispose-terminal.ledger.mutations.ts'
import {
  revokeBatch,
  revokeManual,
  revokeSignOff,
} from './smi5879-dispose-terminal.ledger.revocations.ts'
import {
  refuse,
  type AddManualParams,
  type AddManualResult,
  type LedgerCommandResult,
  type LedgerIoDeps,
  type LedgerMutationOutcome,
  type LedgerRefusal,
  type RevokeBatchParams,
  type RevokeBatchResult,
  type RevokeManualParams,
  type RevokeManualResult,
  type RevokeSignOffParams,
  type RevokeSignOffResult,
  type SignOffParams,
  type SignOffResult,
  type StageBatchParams,
  type StageBatchResult,
} from './smi5879-dispose-terminal.ledger.types.ts'

export * from './smi5879-dispose-terminal.ledger.types.ts'
export { sha256 } from './smi5879-dispose-terminal.io.ts'
export { computeEntryIdsDigest } from './smi5879-dispose-terminal.ledger.helpers.ts'
export { addManual, signOff, stageBatch } from './smi5879-dispose-terminal.ledger.mutations.ts'
export {
  revokeBatch,
  revokeManual,
  revokeSignOff,
} from './smi5879-dispose-terminal.ledger.revocations.ts'

/** Label the `StuckLockError` message reports for the ledger lock. */
export const LEDGER_LOCK_LABEL = 'smi5879 disposition ledger'

/** The one line of context this producer adds to a propagating
 *  `StuckLockError` (plan Item 8 — the error itself is otherwise untouched:
 *  same class, same `lockPath`/`reclaimPath`/`reason`, same unstick recipe). */
export const LEDGER_LOCK_CONTEXT_LINE =
  'Context: another dispose/sign-off/add-manual/revoke-* invocation holds the ledger lock; retry after it completes.'

/** Canonical on-disk rendering. Stable for a given object, so this
 *  invocation's own write is byte-reproducible on the next read. */
export function serializeLedger(ledger: Smi5879DispositionLedger): string {
  return `${JSON.stringify(ledger, null, 2)}\n`
}

/** The production I/O surface — the shared default, unchanged. Re-exported
 *  under a ledger-specific name so a caller wiring a partial override reads
 *  as overriding the LEDGER's I/O, not the sidecar's. */
export const defaultLedgerIoDeps: LedgerIoDeps = defaultFileIoDeps

interface ParsedLedgerFile {
  ok: true
  ledger: Smi5879DispositionLedger
  digest: string
}

/** Read + parse + shape-validate + consistency-validate one ledger file.
 *  Used for both the initial read (step 1) and the temp file's own
 *  re-validation (step 2), so the two can never diverge in strictness. */
function readAndValidate(
  deps: LedgerIoDeps,
  path: string,
  what: 'ledger' | 'temp'
): ParsedLedgerFile | { ok: false; code: 'unreadable' | 'shape' | 'conflict'; reason: string } {
  let raw: string
  try {
    raw = deps.readFile(path)
  } catch (error) {
    return {
      ok: false,
      code: 'unreadable',
      reason: `${what} at ${path} could not be read: ${String(error)}`,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      ok: false,
      code: 'unreadable',
      reason: `${what} at ${path} is not valid JSON: ${String(error)}`,
    }
  }
  const shape = validateDispositionLedgerShape(parsed)
  if (!shape.ok) {
    return {
      ok: false,
      code: 'shape',
      reason: `${what} at ${path} failed shape validation: ${shape.reason}`,
    }
  }
  const validation = validateDispositionLedger(shape.value)
  if (!validation.valid) {
    return {
      ok: false,
      code: 'conflict',
      reason: `${what} at ${path} has more than one active entry for id(s): ${validation.conflictingIds.join(', ')}`,
    }
  }
  return { ok: true, ledger: shape.value, digest: sha256(raw) }
}

export interface RunLockedLedgerMutationParams<T> {
  ledgerPath: string
  /** Forwarded to the lock; production callers omit it. */
  timeoutMs?: number
  deps?: Partial<LedgerIoDeps>
  mutate: (ledger: Smi5879DispositionLedger) => LedgerMutationOutcome<T>
}

/**
 * Run one mutation under the ledger lock, following the five-step protocol in
 * this module's docstring exactly. A `StuckLockError` propagates (with one
 * added context line); every other failure mode is a typed refusal, never a
 * silent retry.
 */
export function runLockedLedgerMutation<T>(
  params: RunLockedLedgerMutationParams<T>
): LedgerCommandResult<T> {
  const deps: LedgerIoDeps = { ...defaultLedgerIoDeps, ...params.deps }
  const { ledgerPath } = params
  const release = acquireWithContext(
    () =>
      deps.acquireLock(ledgerPath, {
        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
        label: LEDGER_LOCK_LABEL,
      }),
    LEDGER_LOCK_CONTEXT_LINE
  )
  try {
    // --- step 1: read the current on-disk ledger, record its digest ---------
    if (!deps.fileExists(ledgerPath)) {
      return refuse(
        'ledger_not_found',
        `no disposition ledger at ${ledgerPath} — this tool mutates an existing ledger, it does not create one`
      )
    }
    const initial = readAndValidate(deps, ledgerPath, 'ledger')
    if (!initial.ok) {
      const code =
        initial.code === 'unreadable'
          ? 'ledger_unreadable'
          : initial.code === 'shape'
            ? 'ledger_invalid_shape'
            : 'ledger_conflicting_entries'
      return refuse(code, initial.reason)
    }

    const outcome = params.mutate(initial.ledger)
    if (!outcome.ok) return outcome
    if (!outcome.write) {
      return { ok: true, written: false, result: outcome.result, ledger: initial.ledger }
    }

    const committed = commitLedger(deps, ledgerPath, outcome.ledger, initial.digest)
    if (!committed.ok) return committed
    return { ok: true, written: true, result: outcome.result, ledger: outcome.ledger }
  } finally {
    release()
  }
}

/** Steps 2-5, factored out so the ordering reads as one linear sequence. */
function commitLedger(
  deps: LedgerIoDeps,
  ledgerPath: string,
  next: Smi5879DispositionLedger,
  initialDigest: string
): { ok: true } | LedgerRefusal {
  const tempPath = deps.tempPathFor(ledgerPath)
  let renamed = false
  try {
    // --- step 2: write the temp file, then re-validate ITS OWN CONTENT ------
    deps.writeFile(tempPath, serializeLedger(next))
    const reread = readAndValidate(deps, tempPath, 'temp')
    if (!reread.ok) {
      return refuse(
        'temp_validation_failed',
        `the mutated ledger failed its own re-validation before rename, so nothing was written: ${reread.reason}`
      )
    }

    // --- step 3: re-read + re-hash the DESTINATION file, as late as possible -
    const destination = deps.readFile(ledgerPath)
    const destinationDigest = sha256(destination)

    // --- step 4: destination must be byte-identical to what step 1 read -----
    if (destinationDigest !== initialDigest) {
      return refuse(
        'ledger_changed',
        `ledger changed since this command started — re-run it (${ledgerPath} was ${initialDigest} at read time, ${destinationDigest} immediately before rename)`
      )
    }

    // --- step 5: only now, rename into place --------------------------------
    deps.rename(tempPath, ledgerPath)
    renamed = true
    return { ok: true }
  } finally {
    if (!renamed) deps.removeFile(tempPath)
  }
}

// ---------------------------------------------------------------------------
// Per-subcommand wrappers
// ---------------------------------------------------------------------------

interface CommandOptions {
  ledgerPath: string
  timeoutMs?: number
  deps?: Partial<LedgerIoDeps>
}

function lockedOptions<T>(
  opts: CommandOptions,
  mutate: (ledger: Smi5879DispositionLedger) => LedgerMutationOutcome<T>
): RunLockedLedgerMutationParams<T> {
  return {
    ledgerPath: opts.ledgerPath,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.deps !== undefined ? { deps: opts.deps } : {}),
    mutate,
  }
}

export function addManualEntry(
  opts: CommandOptions & { params: AddManualParams }
): LedgerCommandResult<AddManualResult> {
  return runLockedLedgerMutation(lockedOptions(opts, (ledger) => addManual(ledger, opts.params)))
}

export function stageDispositionBatch(
  opts: CommandOptions & { params: StageBatchParams }
): LedgerCommandResult<StageBatchResult> {
  return runLockedLedgerMutation(lockedOptions(opts, (ledger) => stageBatch(ledger, opts.params)))
}

export function signOffDispositionBatch(
  opts: CommandOptions & { params: SignOffParams }
): LedgerCommandResult<SignOffResult> {
  return runLockedLedgerMutation(lockedOptions(opts, (ledger) => signOff(ledger, opts.params)))
}

export function revokeManualEntry(
  opts: CommandOptions & { params: RevokeManualParams }
): LedgerCommandResult<RevokeManualResult> {
  return runLockedLedgerMutation(lockedOptions(opts, (ledger) => revokeManual(ledger, opts.params)))
}

export function revokeBatchSignOff(
  opts: CommandOptions & { params: RevokeSignOffParams }
): LedgerCommandResult<RevokeSignOffResult> {
  return runLockedLedgerMutation(
    lockedOptions(opts, (ledger) => revokeSignOff(ledger, opts.params))
  )
}

export function revokeDispositionBatch(
  opts: CommandOptions & { params: RevokeBatchParams }
): LedgerCommandResult<RevokeBatchResult> {
  return runLockedLedgerMutation(lockedOptions(opts, (ledger) => revokeBatch(ledger, opts.params)))
}
