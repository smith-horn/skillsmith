// A harness-model fault must never be the evidence that unlocks a C4 PASS
// (SMI-6715 governance F2). A C4 harness-error that reports a loss counts FAILED
// for the cell it is in (failures beat everything), but it is not a measured
// loss of the NAIVE arm, so it must not satisfy the control of the guarded arm.
// tallyCell exposes `controlFailures` (failures from non-error records) and
// resolveControl uses it; generate-summary goes through the same two functions.
// Shared fixtures: c4-selftest-helpers.mjs.

import { makeRecord, aggregateCell, classifyRecord } from './result-schema.mjs'
import { tallyCell } from './cell-tally.mjs'
import { resolveControl, controlFailedFlag } from './control-spec.mjs'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  copyFileSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, finish, goodPre } from './c4-selftest-helpers.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const cellOf = (candidate, target = 30) => ({
  attack: 'A3-C4',
  variant: 'v',
  candidate,
  fs: 'f',
  runner: 't',
  target,
})
const lossUf = { checked: 1, lost: 1, changed: 0, displaced: 1, deleted: 0 }
const cleanUf = { checked: 1, lost: 0, changed: 0, displaced: 0, deleted: 0 }
const rec = (cell, i, status, userFiles) =>
  makeRecord({ cell, run: i, precondition: goodPre(), outcome: { status }, userFiles })
const n = (count, fn) => Array.from({ length: count }, (_, i) => fn(i))
const classifyAs = (r) =>
  r.outcome.status === 'harness-error' && r.userFiles.lost > 0
    ? 'never-ran'
    : r.userFiles.lost > 0
      ? 'failed'
      : 'passed'

const NAIVE = cellOf('C4-naive')
const GUARDED = cellOf('C4')
const naiveErrs = n(30, (i) => rec(NAIVE, i, 'harness-error', lossUf))
const guardedClean = n(30, (i) => rec(GUARDED, i, 'kept', cleanUf))

// --- the tally exposes the control count separately ------------------------------
const tErr = tallyCell(naiveErrs, classifyAs)
check(
  'C1 naive: 30 harness-errors with a loss count failed 30 (failures beat everything)',
  tErr.failed,
  30
)
check('C1 but contribute 0 to controlFailures', tErr.controlFailures, 0)
const naiveReal = [...naiveErrs.slice(0, 29), rec(NAIVE, 29, 'kept', lossUf)]
const tReal = tallyCell(naiveReal, classifyAs)
check('C2 one real failure among the errors: controlFailures is 1', tReal.controlFailures, 1)
check('C2 and failed is 30', tReal.failed, 30)
check(
  'C3 a legacy cell: controlFailures === failed',
  (() => {
    const t = tallyCell(
      n(3, (i) =>
        makeRecord({
          cell: { attack: 'A3', variant: 'v', candidate: 'baseline', fs: 'f', runner: 't' },
          run: i,
          precondition: { hookFired: true, mutationApplied: true },
          outcome: { status: 'removed' },
          userFiles: { checked: 1, lost: 1 },
        })
      ),
      () => 'failed'
    )
    return t.controlFailures === t.failed && t.failed === 3
  })(),
  true
)
check(
  'C3 aggregateCell reports controlFailures too',
  aggregateCell(naiveErrs, () => false, { controlFailed: true, controlState: 'satisfied' })
    .controlFailures,
  0
)

// defence in depth: even a classifier that calls a harness-error 'failed' (plain or
// with an excludedReason) must not turn it into control evidence
// (malformed counts, so the harness-error-with-loss rule does not apply first)
const noCounts = rec(NAIVE, 97, 'harness-error', { checked: 1, displaced: 0, deleted: 0 })
const forcedFailed = tallyCell([noCounts], () => 'failed')
check(
  'C4 a harness-error forced to failed still adds no control evidence',
  forcedFailed.controlFailures,
  0
)
check('C4 (and is still counted failed for its own cell)', forcedFailed.failed, 1)
const withReason = rec(NAIVE, 99, 'harness-error', { checked: 1, displaced: 0, deleted: 0 })
withReason.outcome.excludedReason = 'vacuous-check'
check(
  'C4 same for a harness-error carrying an excludedReason',
  tallyCell([withReason], () => 'failed').controlFailures,
  0
)
check(
  'C4 positive control: a real failure under excludedReason does count',
  (() => {
    const r = rec(NAIVE, 98, 'kept', lossUf)
    r.outcome.excludedReason = 'vacuous-check'
    return tallyCell([r], () => 'failed').controlFailures
  })(),
  1
)

// --- resolveControl uses it --------------------------------------------------------
const rowOf = (records, candidate) => ({
  attack: 'A3-C4',
  variant: 'v',
  candidate,
  fs: 'f',
  ...tallyCell(records, classifyAs),
})
const guardedRow = rowOf(guardedClean, 'C4')
check(
  'D1 naive cell of 30 harness-errors (each lost 1), no real failure: the control reads DID-NOT-FAIL',
  resolveControl(guardedRow, [guardedRow, rowOf(naiveErrs, 'C4-naive')]).state,
  'did-not-fail'
)
check(
  'D2 naive cell with one real failure: the control is satisfied',
  resolveControl(guardedRow, [guardedRow, rowOf(naiveReal, 'C4-naive')]).state,
  'satisfied'
)
// F3 (fail closed): a C4-naive control row with no controlFailures is NOT trusted
// through its `failed`; it counts 0 and the detail says so.
const naiveNoCf = { attack: 'A3-C4', variant: 'v', candidate: 'C4-naive', fs: 'f', failed: 2 }
const missingCf = resolveControl(
  { attack: 'A3-C4', variant: 'v', candidate: 'C4', fs: 'f', failed: 0 },
  [naiveNoCf]
)
check(
  'D3 a C4-naive row missing controlFailures fails closed (did-not-fail)',
  missingCf.state,
  'did-not-fail'
)
check('D3 and says why', /controlFailures missing/.test(missingCf.detail), true)
check(
  'D3 control: the same row WITH controlFailures 2 is satisfied',
  resolveControl({ attack: 'A3-C4', variant: 'v', candidate: 'C4', fs: 'f', failed: 0 }, [
    { ...naiveNoCf, controlFailures: 2 },
  ]).state,
  'satisfied'
)
check(
  'D3 legacy rows without controlFailures keep the `failed` fallback',
  resolveControl({ attack: 'A13', variant: 'x', candidate: 'V2', fs: 'f', failed: 0 }, [
    { attack: 'A3', variant: 'y', candidate: 'baseline', fs: 'f', failed: 2 },
  ]).state,
  'satisfied'
)

// F3: control evidence = a GENUINE scored failure: the record passes the C4
// validation (every precondition strictly true, valid counts) AND has a known
// non-error status. Anything else still counts failed for its own cell (a
// measured loss beats everything) but never counts toward a control.
const naiveRec = (i, status, over = {}) =>
  makeRecord({
    cell: NAIVE,
    run: i,
    precondition: over.pre ?? goodPre(),
    outcome: { status },
    userFiles: over.uf ?? lossUf,
  })
const cfOf = (r) => tallyCell([r], classifyRecord)
for (const [label, r] of [
  ['an unknown status', naiveRec(0, 'quarantine')],
  ['hookFired false', naiveRec(1, 'kept', { pre: { ...goodPre(), hookFired: false } })],
  ['traceMatched false', naiveRec(2, 'kept', { pre: { ...goodPre(), traceMatched: false } })],
  ['mutationApplied false', naiveRec(3, 'kept', { pre: { ...goodPre(), mutationApplied: false } })],
  ['controlExpected false', naiveRec(4, 'kept', { pre: { ...goodPre(), controlExpected: false } })],
  [
    'displaced + deleted !== lost',
    naiveRec(5, 'kept', { uf: { checked: 1, lost: 2, changed: 0, displaced: 1, deleted: 0 } }),
  ],
  [
    'lost + changed > checked',
    naiveRec(6, 'kept', { uf: { checked: 1, lost: 2, changed: 0, displaced: 2, deleted: 0 } }),
  ],
  ['status not-run with a loss', naiveRec(7, 'not-run')],
  ['status harness-error with a loss', naiveRec(8, 'harness-error')],
]) {
  const t = cfOf(r)
  check('F3 ' + label + ': still counted failed for its own cell', t.failed, 1)
  check('F3 ' + label + ': adds nothing to controlFailures', t.controlFailures, 0)
}
// even a classifier that wrongly calls it failed: 'not-run' is not a genuine status
check(
  'F3 a not-run record forced to failed by the classifier adds no control evidence',
  tallyCell(
    [naiveRec(12, 'not-run', { uf: { checked: 1, displaced: 0, deleted: 0 } })],
    () => 'failed'
  ).controlFailures,
  0
)
for (const st of ['quarantined', 'kept', 'stopped']) {
  check(
    'F3 positive control: a genuine ' + st + ' failure counts as control evidence',
    cfOf(naiveRec(10, st)).controlFailures,
    1
  )
}
check(
  'F3 positive control: changed-only genuine failure counts',
  cfOf(naiveRec(11, 'kept', { uf: { checked: 1, lost: 0, changed: 1, displaced: 0, deleted: 0 } }))
    .controlFailures,
  1
)

// --- the real generator goes through the same path --------------------------------
const sandbox = mkdtempSync(path.join(tmpdir(), 's6715-control-'))
mkdirSync(path.join(sandbox, 'results', 'raw'), { recursive: true })
copyFileSync(
  path.join(HERE, '..', 'results', 'generate-summary.mjs'),
  path.join(sandbox, 'results', 'generate-summary.mjs')
)
symlinkSync(HERE, path.join(sandbox, 'harness'))
const gen = (records) => {
  writeFileSync(
    path.join(sandbox, 'results', 'raw', 'x.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  )
  const r = spawnSync('node', [path.join(sandbox, 'results', 'generate-summary.mjs')], {
    encoding: 'utf8',
  })
  const lines = readFileSync(path.join(sandbox, 'results', 'SUMMARY.md'), 'utf8').split('\n')
  const verdictOf = (candidate) => {
    const row = lines.find((l) => l.startsWith('| A3-C4 |') && l.includes('| ' + candidate + ' |'))
    return row ? row.split('|').slice(-2)[0].trim() : 'ROW-MISSING'
  }
  return { status: r.status, verdictOf }
}
const g1 = gen([...guardedClean, ...naiveErrs])
check('G1 the generator ran', g1.status, 0)
check(
  'G1 summary: a clean C4 cell whose only control evidence is harness errors is NEVER-RAN (control)',
  g1.verdictOf('C4'),
  'NEVER-RAN (control)'
)
check(
  'G1 summary: the naive cell itself is FAIL (its errors are failures)',
  g1.verdictOf('C4-naive'),
  'FAIL'
)
const g2 = gen([...guardedClean, ...naiveReal])
check('G2 summary: one real naive failure unlocks the PASS', g2.verdictOf('C4'), 'PASS')
// a C4 cell with a harness-error + loss still FAILs
const guardedErr = [
  ...n(29, (i) => rec(GUARDED, i, 'kept', cleanUf)),
  rec(GUARDED, 29, 'harness-error', lossUf),
]
const g3 = gen([...guardedErr, ...naiveReal])
check('G3 summary: a C4 cell with a harness-error + loss still FAILs', g3.verdictOf('C4'), 'FAIL')
check(
  'G3 and the same through the shared verdict function',
  aggregateCell(guardedErr, () => false, {
    controlFailed: controlFailedFlag('satisfied'),
    controlState: 'satisfied',
  }).verdict,
  'FAIL'
)
rmSync(sandbox, { recursive: true, force: true })
finish()
