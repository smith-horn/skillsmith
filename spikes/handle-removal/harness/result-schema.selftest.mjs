// Self-test for result-schema.mjs (SMI-6676 plan §8 step 2 "done when"):
// a dummy attack with a forced precondition miss must be reported never-ran,
// not passed -- even when its outcome otherwise looks clean.

import { makeRecord, classifyRecord, aggregateCell, formatVerdict } from './result-schema.mjs'

function baseCell() {
  return { attack: 'DUMMY', candidate: 'dummy-candidate', fs: 'dummy-fs', runner: 'self-test' }
}

let allOk = true
function check(label, actual, expected) {
  const ok = actual === expected
  allOk = allOk && ok
  console.log(
    `[result-schema self-test] ${label}: expected ${expected}, got ${actual} -- ${ok ? 'PASS' : 'FAIL'}`
  )
}

// Case 1: precondition false (hook never fired) but everything else looks
// like a clean pass. Must classify as never-ran, not passed.
const neverRanRecord = makeRecord({
  cell: baseCell(),
  run: 0,
  precondition: {
    hookFired: false, // <-- the forced miss
    mutationApplied: null,
    reuseObserved: null,
    mountActiveAtWalk: null,
    controlExpected: true,
  },
  outcome: { status: 'removed' },
  userFiles: { checked: 3, lost: 0, changed: 0 },
})
check('forced precondition miss', classifyRecord(neverRanRecord), 'never-ran')

// Case 2: a harness-error outcome is also never-ran regardless of preconditions.
const harnessErrorRecord = makeRecord({
  cell: baseCell(),
  run: 1,
  precondition: { hookFired: true, controlExpected: true },
  outcome: { status: 'harness-error', reason: 'fixture build threw' },
  userFiles: { checked: 0, lost: 0, changed: 0 },
})
check('harness-error outcome', classifyRecord(harnessErrorRecord), 'never-ran')

// Case 3: every precondition true, no bytes lost/changed -> passed.
const passedRecord = makeRecord({
  cell: baseCell(),
  run: 2,
  precondition: { hookFired: true, mutationApplied: true, controlExpected: true },
  outcome: { status: 'stopped', reason: 'mount-inside' },
  userFiles: { checked: 3, lost: 0, changed: 0 },
})
check('clean run', classifyRecord(passedRecord), 'passed')

// Case 4: preconditions true, but a user byte was lost -> failed.
const failedRecord = makeRecord({
  cell: baseCell(),
  run: 3,
  precondition: { hookFired: true, mutationApplied: true, controlExpected: true },
  outcome: { status: 'removed' },
  userFiles: { checked: 3, lost: 1, changed: 0 },
})
check('lost bytes', classifyRecord(failedRecord), 'failed')

// Case 5: an attack-specific contradiction predicate (e.g. "removed after a
// mismatch" for A12-style stop-rule attacks) marks a run failed even with
// 0 bytes lost.
const contradictoryRecord = makeRecord({
  cell: baseCell(),
  run: 4,
  precondition: { hookFired: true, controlExpected: true },
  outcome: { status: 'removed', reason: 'continued-past-injected-error' },
  userFiles: { checked: 3, lost: 0, changed: 0 },
})
const isContradictory = (r) =>
  r.outcome.status === 'removed' && r.outcome.reason === 'continued-past-injected-error'
check(
  'contradictory outcome (A12-shaped)',
  classifyRecord(contradictoryRecord, isContradictory),
  'failed'
)

// Case 6: aggregateCell counts correctly and never reports PASS when any
// run never-ran, and reports NEVER-RAN (control) when the paired control
// cell did not itself demonstrate a failure.
const cell = [neverRanRecord, passedRecord, passedRecord]
const agg = aggregateCell(cell, () => false, { target: 3, controlFailed: true })
check('aggregateCell.ran', agg.ran, 3)
check('aggregateCell.passed', agg.passed, 2)
check('aggregateCell.neverRan', agg.neverRan, 1)
check('aggregateCell.verdict (has a never-ran)', agg.verdict, 'NEVER-RAN')

const cleanCell = [passedRecord, passedRecord]
const aggControlMissing = aggregateCell(cleanCell, () => false, { target: 2, controlFailed: false })
check(
  'aggregateCell verdict when control never failed',
  aggControlMissing.verdict,
  'NEVER-RAN (control)'
)

const aggControlFailed = aggregateCell(cleanCell, () => false, { target: 2, controlFailed: true })
check('aggregateCell verdict, clean cell + control failed', aggControlFailed.verdict, 'PASS')
console.log(formatVerdict('DUMMY/dummy-candidate/dummy-fs', aggControlFailed))

if (!allOk) {
  console.error('[result-schema self-test] FAIL')
  process.exit(1)
}
console.log('[result-schema self-test] all cases passed')
process.exit(0)
