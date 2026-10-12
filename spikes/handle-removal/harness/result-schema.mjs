// SMI-6676 harness result schema and cell aggregation (plan §9).
//
// One JSONL record per run. Classification is deliberately three-way
// (failed / passed / never-ran) rather than boolean, per the project's
// "a control harness needs a three-way outcome" rule: a precondition that
// never fired (hook didn't fire, mutation didn't land, mount inactive,
// reuse not observed where required) must never be counted as "passed".

import { appendFileSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
// One implementation of the §9 verdict rule, shared with
// results/generate-summary.mjs. control-spec.mjs imports nothing from here, so
// there is no cycle.
import { tallyCell, cellVerdict } from './cell-tally.mjs'
import {
  QUARANTINE_PREFIX,
  MAX_REPORTED_PATHS,
  scanC4Leftovers,
  isC4Cell,
  c4Snapshot,
  c4RecordJsonSafe,
  c4UserFileExtras,
  c4Validate,
} from './result-schema.c4.mjs'

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
 * @param {string} [variant]
 * @param {{status?:string, opId?:string}} [options] - C4 only: the outcome's
 *   status and the op id the call used (see scanC4Leftovers)
 * @returns {{dirs:number|null, entries:number|null, paths:string[], scanError:string|null,
 *   expected?:{present:boolean|null, entries:number|null, path:string|null}, litter?:number|null}}
 *   (`expected` and `litter` are present for C4 variants only)
 */
export function scanQuarantineLeftovers(parentAbs, variant, options) {
  if (variant === 'C4' || variant === 'C4-naive') return scanC4Leftovers(parentAbs, options)
  // Only V2 creates a quarantine directory (`walk.mjs`: `if (variant === 'V2')`
  // guards the mkdirAt). For V0 and V1 a scan can only ever return
  // `{dirs:0, entries:0}` -- a confident zero about a mechanism that does not
  // exist, which reads identically to "this variant stranded nothing". Report
  // it as not-applicable instead, so the two cannot be confused once
  // run-vr-attacks.mjs starts iterating V0/V1/V2 over the newly-wired modules.
  if (variant != null && variant !== 'V2') {
    return { dirs: null, entries: null, paths: [], scanError: `n/a:no-quarantine-in-${variant}` }
  }
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

/** @typedef {'removed'|'kept'|'stopped'|'quarantined'|'harness-error'} Outcome */

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
  const { cell, run, outsideIntact = true, durationMs = null, fsCheck = null } = fields
  // `let`: for C4 cells all four are replaced by a validated snapshot below.
  let { precondition, outcome, userFiles } = fields

  if (!cell || typeof cell !== 'object') {
    throw new TypeError('makeRecord: cell is required')
  }
  if (typeof run !== 'number') {
    throw new TypeError('makeRecord: run (index) is required')
  }
  if (!precondition || typeof precondition !== 'object') {
    throw new TypeError('makeRecord: precondition is required')
  }
  if (!outcome || typeof outcome !== 'object') {
    throw new TypeError('makeRecord: outcome.status is required')
  }
  if (!userFiles || typeof userFiles !== 'object') {
    throw new TypeError('makeRecord: userFiles is required')
  }

  // ONE read of the two fields that pick the validation path, and the stored
  // cell is built from those same values (Sol F6e). Deciding from one read of a
  // lying getter and storing another is how a record routed to the legacy path
  // ends up labelled C4 (or the reverse).
  const [attack, candidate] = [cell.attack, cell.candidate]
  const c4 = isC4Cell({ attack, candidate })
  let cellSrc = cell
  if (c4) {
    // Snapshot BEFORE any field is read, and throw on a non-plain shape.
    cellSrc = c4Snapshot(cell, 'cell')
    precondition = c4Snapshot(precondition, 'precondition')
    outcome = c4Snapshot(outcome, 'outcome')
    userFiles = c4Snapshot(userFiles, 'userFiles')
  }
  if (!outcome.status) {
    throw new TypeError('makeRecord: outcome.status is required')
  }
  // `??` on BOTH sides. The inner test used to be truthiness, so a caller
  // passing `0`/`false`/`''` on outcome.quarantineLeft collapsed to null --
  // indistinguishable from "no scan ran" -- while the same value passed
  // top-level survived. Two paths disagreeing about one value is how a null
  // starts meaning two things at once.
  const quarantineLeft = fields.quarantineLeft ?? outcome.quarantineLeft ?? null
  if (typeof userFiles.checked !== 'number') {
    throw new TypeError('makeRecord: userFiles.checked (the denominator) is required')
  }

  return {
    cell: {
      attack: c4 ? cellSrc.attack : attack,
      variant: cellSrc.variant ?? null,
      candidate: c4 ? cellSrc.candidate : candidate,
      fs: cellSrc.fs,
      platform: cellSrc.platform ?? process.platform,
      arch: cellSrc.arch ?? process.arch,
      node: cellSrc.node ?? process.version,
      os: cellSrc.os ?? null,
      runner: cellSrc.runner ?? 'unknown',
      // C4 only: the module's intended run count, so a short run can never render PASS.
      ...(c4 ? { target: cellSrc.target ?? null } : {}),
    },
    run,
    precondition: c4
      ? precondition
      : {
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
      // C4 only: an allowlisted exclusion reason (see cell-tally.mjs) rides the outcome.
      ...(c4 && Object.hasOwn(outcome, 'excludedReason')
        ? { excludedReason: outcome.excludedReason }
        : {}),
    },
    userFiles: {
      checked: userFiles.checked,
      // C4: passed through UNCOERCED so an absent / null lost or changed reaches
      // classifyRecord (isCount rejects it) instead of being defaulted to a pass.
      lost: c4 ? userFiles.lost : (userFiles.lost ?? 0),
      changed: c4 ? userFiles.changed : (userFiles.changed ?? 0),
      // C4 only: displaced/deleted pass through UNCOERCED so a malformed value
      // reaches classifyRecord (which rejects it) instead of being defaulted.
      ...(c4 ? c4UserFileExtras(userFiles) : {}),
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
 * @param {object} record - from makeRecord(). C4 records (candidate C4/C4-naive, or
 *   attack ending -C4/-C4-OOM) get stricter clauses; see c4Validate.
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
  if (isC4Cell(record.cell)) {
    if (!c4RecordJsonSafe(record)) return 'never-ran'
    // ONE read: the values c4Validate checked are the values scored. Scoring
    // through record.userFiles.lost ([[Get]]) after validating via descriptor
    // let a Proxy validate one number and score another.
    const v = c4Validate(record)
    if (v === null) return 'never-ran'
    return v.lost + v.changed > 0 || isContradictory(record) ? 'failed' : 'passed'
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
  const t = tallyCell(records, (record) => classifyRecord(record, isContradictory))
  const { passed, failed, neverRan, excluded } = t

  const ran = records.length
  let verdict
  if (ran !== target) {
    verdict = `INCOMPLETE (ran ${ran}/${target})`
  } else {
    // DERIVED, NOT REQUESTED. This used to read `options.attack ?? null`, an
    // opt-in that no caller ever took: all 20 call sites across the harness pass
    // only `{ target }` and/or `{ controlFailed }`, so `attack` was always null,
    // `isProbabilistic(null)` was always false, and R6 never applied on this
    // path at all. The commit that introduced it claimed the rule "lives in ONE
    // place so the two deciders cannot drift" -- one IMPLEMENTATION, yes, but
    // two argument derivations, which diverged on the very cell that commit
    // headlined (A13/guardHash/V2/overlayfs: PASS from the summary generator,
    // NEVER-RAN from here). That is the same drift, moved from the body of the
    // function to its call sites, where it is harder to see. The records carry
    // the attack id already, so derive it and leave callers nothing to forget.
    const attack = options.attack ?? records[0]?.cell?.attack ?? null
    verdict = cellVerdict(t, attack, options.controlFailed, options.controlState)
  }

  return { ran, passed, failed, neverRan, excluded, verdict }
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
  if (isC4Cell(record?.cell) && !c4RecordJsonSafe(record)) {
    throw new TypeError(
      'appendJsonl: C4 record is not JSON-safe; its persisted form could classify differently'
    )
  }
  mkdirSync(path.dirname(filePath), { recursive: true })
  appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8')
}
