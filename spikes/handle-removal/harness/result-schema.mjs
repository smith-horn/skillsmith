// SMI-6676 harness result schema and cell aggregation (plan §9).
//
// One JSONL record per run. Classification is deliberately three-way
// (failed / passed / never-ran) rather than boolean, per the project's
// "a control harness needs a three-way outcome" rule: a precondition that
// never fired (hook didn't fire, mutation didn't land, mount inactive,
// reuse not observed where required) must never be counted as "passed".

import { appendFileSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'

/**
 * Anything the removal machinery creates beside a tree it is removing is
 * named with this prefix -- V2's own private quarantine directory
 * (`.skillsmith-rm-<opId>`, walk.mjs) and C4's trash root
 * (`.skillsmith-trash`, quarantine.mjs). Matching on the PREFIX rather than
 * either exact name is deliberate: a leftover from a naming scheme this
 * scanner has not been told about must still be counted, not silently
 * reported as zero.
 */
const QUARANTINE_PREFIX = '.skillsmith-'

const MAX_REPORTED_PATHS = 8

/**
 * Looks in `parentAbs` -- the directory that held the removed tree, and the
 * directory V2 puts its quarantine beside -- for anything the removal left
 * behind, and reports WHAT IS THERE rather than inferring it from an outcome
 * reason code.
 *
 * Why this measurement and not another:
 *
 *  - `entries` counts the IMMEDIATE names inside each quarantine directory,
 *    not files recursively and not bytes. One stranded directory holding
 *    fifty files is one stranding event -- one name a caller, or a
 *    doctor-style scan, would fail to find where it expects it -- not fifty.
 *    walk.mjs's own `*-left-in-quarantine` reasons are per-entry for the same
 *    reason, and §4.1 step 6 bounds it at one.
 *  - `dirs` is reported separately because an EMPTY leftover quarantine
 *    directory is a different and much milder fact: removeVR only rmdir's Q
 *    on a clean run, so any stop leaves an empty `.skillsmith-rm-<opId>`
 *    behind. That is litter, not stranded user data, and collapsing the two
 *    into one number would make a stop look like a loss.
 *  - `paths` (bounded) is carried so a non-zero count is diagnosable from the
 *    record alone, without re-running anything.
 *  - `scanError` exists so a scan that could not run is never indistinguish-
 *    able from a scan that found nothing: on failure `dirs`/`entries` are
 *    null, not 0.
 *
 * Call it AFTER the removal returns and after any concurrent racer has been
 * joined, and BEFORE the fixture root is torn down.
 *
 * @param {string} parentAbs
 * @returns {{dirs:number|null, entries:number|null, paths:string[], scanError:string|null}}
 */
export function scanQuarantineLeftovers(parentAbs) {
  let names
  try {
    names = readdirSync(parentAbs)
  } catch (err) {
    return { dirs: null, entries: null, paths: [], scanError: err.code ?? String(err) }
  }
  let dirs = 0
  let entries = 0
  const paths = []
  for (const name of names.sort()) {
    if (!name.startsWith(QUARANTINE_PREFIX)) continue
    dirs += 1
    let inner
    try {
      inner = readdirSync(path.join(parentAbs, name))
    } catch (err) {
      // A quarantine directory we cannot list is NOT evidence of zero
      // leftovers -- fail the whole scan rather than under-report.
      return { dirs: null, entries: null, paths: [], scanError: err.code ?? String(err) }
    }
    entries += inner.length
    for (const child of inner.sort()) {
      if (paths.length < MAX_REPORTED_PATHS) paths.push(`${name}/${child}`)
    }
  }
  return { dirs, entries, paths, scanError: null }
}

/** @typedef {'removed'|'kept'|'stopped'|'harness-error'} Outcome */

/**
 * Builds a normalized run record. Callers fill in `cell`, `precondition`,
 * `outcome` and `userFiles`; everything else defaults.
 *
 * `quarantineLeft` may be supplied either as a top-level field (preferred) or
 * on `outcome.quarantineLeft`, which is hoisted out here and never copied into
 * `record.outcome`. The second path exists because the field is produced by an
 * ATTACK MODULE (only it knows which directory held the tree) while makeRecord
 * is called by a RUNNER, and `outcome` is the one object every runner already
 * forwards. Without it the field stayed `null` on all 47,240 records ever
 * written, which made "zero stranding" a claim about `outcome.reason` -- a
 * proxy -- rather than about what was actually left on disk.
 *
 * @param {object} fields
 * @returns {object}
 */
export function makeRecord(fields) {
  const {
    cell,
    run,
    precondition,
    outcome,
    userFiles,
    outsideIntact = true,
    durationMs = null,
    fsCheck = null,
  } = fields
  const quarantineLeft =
    fields.quarantineLeft ?? (outcome && outcome.quarantineLeft ? outcome.quarantineLeft : null)

  if (!cell || typeof cell !== 'object') {
    throw new TypeError('makeRecord: cell is required')
  }
  if (typeof run !== 'number') {
    throw new TypeError('makeRecord: run (index) is required')
  }
  if (!precondition || typeof precondition !== 'object') {
    throw new TypeError('makeRecord: precondition is required')
  }
  if (!outcome || typeof outcome !== 'object' || !outcome.status) {
    throw new TypeError('makeRecord: outcome.status is required')
  }
  if (!userFiles || typeof userFiles !== 'object') {
    throw new TypeError('makeRecord: userFiles is required')
  }
  if (typeof userFiles.checked !== 'number') {
    throw new TypeError('makeRecord: userFiles.checked (the denominator) is required')
  }

  return {
    cell: {
      attack: cell.attack,
      variant: cell.variant ?? null,
      candidate: cell.candidate,
      fs: cell.fs,
      platform: cell.platform ?? process.platform,
      arch: cell.arch ?? process.arch,
      node: cell.node ?? process.version,
      os: cell.os ?? null,
      runner: cell.runner ?? 'unknown',
    },
    run,
    precondition: {
      hookFired: precondition.hookFired ?? null,
      mutationApplied: precondition.mutationApplied ?? null,
      reuseObserved: precondition.reuseObserved ?? null,
      mountActiveAtWalk: precondition.mountActiveAtWalk ?? null,
      controlExpected: precondition.controlExpected ?? null,
      ...precondition,
    },
    outcome: {
      status: outcome.status,
      reason: outcome.reason ?? null,
      path: outcome.path ?? null,
      entry: outcome.entry ?? null,
      errno: outcome.errno ?? null,
    },
    userFiles: {
      checked: userFiles.checked,
      lost: userFiles.lost ?? 0,
      changed: userFiles.changed ?? 0,
    },
    outsideIntact,
    quarantineLeft,
    durationMs,
    fsCheck,
    ts: new Date().toISOString(),
  }
}

/**
 * Classifies one record per plan §9.
 *
 * A record is "never-ran" whenever any of its stated preconditions is
 * explicitly false, or the harness itself errored. Only among records whose
 * preconditions all held do we ask whether the run failed or passed.
 *
 * @param {object} record - from makeRecord()
 * @param {(record: object) => boolean} [isContradictory] - attack-specific
 *   predicate for "an outcome contradicting the pass criterion" (e.g.
 *   `removed` after an identity mismatch, or anything removed after an
 *   injected error). Defaults to never contradictory (userFiles is then the
 *   sole failure signal).
 * @returns {'failed'|'passed'|'never-ran'}
 */
export function classifyRecord(record, isContradictory = () => false) {
  if (record.outcome.status === 'harness-error') {
    return 'never-ran'
  }

  const preconditionEntries = Object.entries(record.precondition).filter(
    ([key]) => key !== 'controlExpected'
  )
  for (const [, value] of preconditionEntries) {
    if (value === false) {
      return 'never-ran'
    }
  }

  const bytesLost = record.userFiles.lost + record.userFiles.changed > 0
  if (bytesLost || isContradictory(record)) {
    return 'failed'
  }

  return 'passed'
}

/**
 * Aggregates a cell's records into run/passed/failed/never-ran counts and a
 * verdict. A cell is PASS only when every run happened (ran === target),
 * nothing was never-ran, nothing failed, AND the paired control cell (passed
 * separately, already classified the same way) recorded at least one
 * failure -- an attack whose control never demonstrates the loss it is
 * supposed to demonstrate proves nothing about the candidate under test.
 *
 * @param {object[]} records - classified via classifyRecord
 * @param {(record: object) => boolean} isContradictory
 * @param {object} [options]
 * @param {number} [options.target] - expected run count; defaults to records.length
 * @param {boolean} [options.controlFailed] - whether this cell's paired
 *   control cell recorded >= 1 failure. Omit for a control cell itself.
 * @returns {{ran:number, passed:number, failed:number, neverRan:number, verdict:string}}
 */
export function aggregateCell(records, isContradictory = () => false, options = {}) {
  const target = options.target ?? records.length
  let passed = 0
  let failed = 0
  let neverRan = 0

  for (const record of records) {
    const cls = classifyRecord(record, isContradictory)
    if (cls === 'passed') passed += 1
    else if (cls === 'failed') failed += 1
    else neverRan += 1
  }

  const ran = records.length
  let verdict
  if (ran !== target) {
    verdict = `INCOMPLETE (ran ${ran}/${target})`
  } else if (neverRan > 0) {
    verdict = 'NEVER-RAN'
  } else if (failed > 0) {
    verdict = 'FAIL'
  } else if (options.controlFailed === false) {
    verdict = 'NEVER-RAN (control)'
  } else {
    verdict = 'PASS'
  }

  return { ran, passed, failed, neverRan, verdict }
}

/**
 * Formats a cell verdict for a report line, per §9: "Print ran/passed/
 * failed/never-ran beside every verdict."
 */
export function formatVerdict(label, agg) {
  return `${agg.verdict}\t${label}\tran=${agg.ran} passed=${agg.passed} failed=${agg.failed} never-ran=${agg.neverRan}`
}

/**
 * Appends one record as a JSONL line, creating the parent directory if
 * needed. `filePath` should live under results/raw/ (gitignored).
 */
export function appendJsonl(filePath, record) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8')
}
