// Self-test for result-schema.mjs (SMI-6676 plan §8 step 2 "done when"):
// a dummy attack with a forced precondition miss must be reported never-ran,
// not passed -- even when its outcome otherwise looks clean.

import {
  makeRecord,
  classifyRecord,
  aggregateCell,
  formatVerdict,
  scanQuarantineLeftovers,
} from './result-schema.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

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

// ---------------------------------------------------------------------------
// scanQuarantineLeftovers: all five directions, pinned.
//
// The POSITIVE direction (entries > 0) had never fired in any real run when
// these were added -- 16,134 records, every one zero. An instrument that has
// only ever returned zero cannot distinguish "nothing was stranded" from
// "cannot detect stranding", so the zero it reports is worth nothing until
// something makes it report non-zero. That is what case Q1 is for.
// ---------------------------------------------------------------------------

const qTmp = mkdtempSync(path.join(tmpdir(), 's6676-selftest-q-'))

// Q1 (the red direction): a real stranded entry must be COUNTED.
const qStranded = path.join(qTmp, 'stranded')
mkdirSync(path.join(qStranded, '.skillsmith-rm-deadbeef', 'leftover'), { recursive: true })
writeFileSync(path.join(qStranded, '.skillsmith-rm-deadbeef', 'leftover', 'f.txt'), 'x')
const q1 = scanQuarantineLeftovers(qStranded)
check('Q1 stranded entry counted', q1.entries, 1)
check('Q1 stranded dir counted', q1.dirs, 1)
check('Q1 path reported', q1.paths[0], '.skillsmith-rm-deadbeef/leftover')
check('Q1 no scan error', q1.scanError, null)

// Q2: a clean parent is a real zero, distinguishable from Q1.
const qClean = path.join(qTmp, 'clean')
mkdirSync(qClean, { recursive: true })
const q2 = scanQuarantineLeftovers(qClean)
check('Q2 clean parent, no dirs', q2.dirs, 0)
check('Q2 clean parent, no entries', q2.entries, 0)
check('Q2 clean parent, no error', q2.scanError, null)

// Q3: an EMPTY quarantine directory is litter, not lost data -- dirs without
// entries. Collapsing the two would make every stopped run look like a loss.
const qEmpty = path.join(qTmp, 'empty')
mkdirSync(path.join(qEmpty, '.skillsmith-rm-cafe'), { recursive: true })
const q3 = scanQuarantineLeftovers(qEmpty)
check('Q3 empty quarantine dir counted', q3.dirs, 1)
check('Q3 empty quarantine has no entries', q3.entries, 0)

// Q4: a parent that cannot be read reports null, NEVER 0 -- "could not look"
// must not read as "nothing there".
const q4 = scanQuarantineLeftovers(path.join(qTmp, 'does-not-exist'))
check('Q4 missing parent: dirs null not 0', q4.dirs, null)
check('Q4 missing parent: entries null not 0', q4.entries, null)
check('Q4 missing parent: errno reported', q4.scanError, 'ENOENT')

// Q5: V0/V1 create no quarantine directory at all (walk.mjs guards the mkdirAt
// on variant === 'V2'), so a zero there would be a confident statement about a
// mechanism that does not exist.
const q5 = scanQuarantineLeftovers(qStranded, 'V0')
check('Q5 V0 is not-applicable, not zero', q5.scanError, 'n/a:no-quarantine-in-V0')
check('Q5 V0 dirs null', q5.dirs, null)
const q5b = scanQuarantineLeftovers(qStranded, 'V2')
check('Q5 V2 still scans (entries found)', q5b.entries, 1)

// Q6 (the mutation the AUTHOR's own red-tests missed). Every fixture above
// holds at most ONE entry in the parent, so none of them exercises iteration
// or the discriminating power of the prefix filter. A scanner mutated to
// `names.sort().slice(0, 1)` passes all fifteen assertions above -- and then
// returns a confident zero on every real A13-VR run forever, because the
// racer's own `.racer-ready` marker sorts before `.skillsmith-` and would be
// the only name ever examined. That is the hiding direction, and it is the
// shape a reviewer found after two author-chosen mutations had both been
// caught: the author picks the mutation, so the author's blind spot picks it
// too (SMI-6497).
//
// This fixture is the real parent's shape: a non-quarantine sibling that sorts
// BEFORE the quarantine directory, plus one that sorts after.
const qReal = path.join(qTmp, 'real-shaped')
mkdirSync(path.join(qReal, '.skillsmith-rm-beef', 'leftover'), { recursive: true })
writeFileSync(path.join(qReal, '.skillsmith-rm-beef', 'leftover', 'f.txt'), 'x')
writeFileSync(path.join(qReal, '.racer-ready'), '') // sorts BEFORE .skillsmith-
mkdirSync(path.join(qReal, 'tree')) // sorts after
const q6 = scanQuarantineLeftovers(qReal)
check('Q6 finds quarantine past an earlier-sorting sibling', q6.entries, 1)
check('Q6 counts the quarantine dir', q6.dirs, 1)
check('Q6 does not count non-quarantine siblings', q6.paths.length, 1)
check('Q6 names the right path', q6.paths[0], '.skillsmith-rm-beef/leftover')

// Q7: two quarantine directories must BOTH be counted -- iteration, not just
// first-match.
const qTwo = path.join(qTmp, 'two')
mkdirSync(path.join(qTwo, '.skillsmith-rm-aaa', 'x'), { recursive: true })
mkdirSync(path.join(qTwo, '.skillsmith-rm-bbb', 'y'), { recursive: true })
const q7 = scanQuarantineLeftovers(qTwo)
check('Q7 counts BOTH quarantine dirs', q7.dirs, 2)
check('Q7 counts entries across both', q7.entries, 2)

rmSync(qTmp, { recursive: true, force: true })

if (!allOk) {
  console.error('[result-schema self-test] FAIL')
  process.exit(1)
}
console.log('[result-schema self-test] all cases passed')
process.exit(0)
