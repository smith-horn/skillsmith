#!/usr/bin/env node
// SMI-6676: the case table for verdictFor(), the one function every §9 verdict
// in results/SUMMARY.md passes through.
//
// WHY THIS FILE EXISTS. R6 shipped verdictFor() with no test of any kind --
// a grep across the whole spike for `verdictFor`, `LANDED_FLOOR`,
// `isProbabilistic`, `PROBABILISTIC_ATTACKS` or `underpowered` matched only the
// two source files that define them. "All six suites pass" was true of that
// commit and told you nothing, because the one thing it added was the one thing
// no suite constrained. Per SMI-6598 a test never run against the unfixed code
// is unverified, so every case below was confirmed to FAIL against the code as
// it stood before its fix -- the reverts are named in each section.
//
// The through-line of every case here: a verdict may never be LESS alarming
// than the evidence supports. Each fix moved some cell toward a more alarming
// label, and each case pins that direction.

import {
  verdictFor,
  isProbabilistic,
  LANDED_FLOOR,
  PROBABILISTIC_ATTACKS,
} from './control-spec.mjs'
import { aggregateCell } from './result-schema.mjs'

let allOk = true
function check(label, actual, expected) {
  const ok = actual === expected
  allOk = allOk && ok
  console.log(
    `[verdict-rule] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} -- ${ok ? 'PASS' : 'FAIL'}`
  )
}
function throws(label, fn) {
  let threw = false
  try {
    fn()
  } catch {
    threw = true
  }
  check(label, threw, true)
}

// --- 1. FAILURES BEAT EVERYTHING -----------------------------------------
// Revert: move `if (row.failed > 0) return 'FAIL'` back below the never-ran and
// floor clauses. Cases 1a-1d all flip to a non-FAIL label.
//
// 1a is the shipped defect: 14 cells in results/SUMMARY.md carried 3,076
// records of measured user-file loss under a NEVER-RAN label.
check(
  '1a deterministic attack, failures AND never-runs -> FAIL',
  verdictFor({ attack: 'A7', passed: 98, failed: 1, neverRan: 1 }, true, 'satisfied'),
  'FAIL'
)
check(
  '1b the real masked cell (A13-WARMARM arm-A V2 overlayfs) -> FAIL',
  verdictFor(
    { attack: 'A13-WARMARM', passed: 1789, failed: 489, neverRan: 2522 },
    undefined,
    'none'
  ),
  'FAIL'
)
// The label must not flip on set membership when the evidence is identical.
// Before the fix these two returned NEVER-RAN and FAIL respectively.
check(
  '1c same counts, probabilistic id -> FAIL',
  verdictFor({ attack: 'A13', passed: 1789, failed: 489, neverRan: 2522 }, undefined, 'none'),
  'FAIL'
)
check(
  '1d probabilistic, failures below the floor -> FAIL, not underpowered',
  verdictFor({ attack: 'A13', passed: 50, failed: 39, neverRan: 211 }, true, 'satisfied'),
  'FAIL'
)
// A failure outranks a missing control too -- the cell lost data either way.
check(
  '1e failures with a control that did not fail -> FAIL',
  verdictFor({ attack: 'A3', passed: 10, failed: 5, neverRan: 0 }, false, 'did-not-fail'),
  'FAIL'
)

// --- 2. A ROW WITH NO COUNTS CERTIFIES NOTHING ---------------------------
// Revert: delete the Number.isInteger guard. 2a returned 'PASS' -- NaN from
// `undefined + undefined` skipped both the failure clause and the floor.
throws('2a undefined counts throw rather than PASS', () => verdictFor({ attack: 'A13' }, true))
throws('2b string counts throw', () =>
  verdictFor({ attack: 'A13', passed: '0', failed: '5', neverRan: '0' }, true)
)
throws('2c float counts throw', () =>
  verdictFor({ attack: 'A13', passed: 1.5, failed: 0, neverRan: 0 }, true)
)
throws('2d null neverRan throws', () =>
  verdictFor({ attack: 'A13', passed: 150, failed: 0, neverRan: null }, true)
)

// --- 3. AN UNSPECIFIED CONTROL IS NOT A PASS -----------------------------
// Revert: delete the `controlState === 'unspecified'` clause. 3a returned a
// bare 'PASS', indistinguishable from a control-verified one. resolveControl()
// invents that state precisely so a missing CONTROL_SPEC row is never counted
// as satisfied.
check(
  '3a unspecified control -> not a bare PASS',
  verdictFor({ attack: 'A13', passed: 150, failed: 0, neverRan: 0 }, true, 'unspecified'),
  'NEVER-RAN (control unspecified)'
)
check(
  '3b external control still reports its own label',
  verdictFor({ attack: 'A3', passed: 30, failed: 0, neverRan: 0 }, undefined, 'external'),
  'PASS (control unverified)'
)
check(
  '3c a satisfied control still PASSes',
  verdictFor({ attack: 'A3', passed: 30, failed: 0, neverRan: 0 }, true, 'satisfied'),
  'PASS'
)

// --- 4. R6 DROPS NON-LANDINGS, NOT EVERY FALSE PRECONDITION --------------
// Revert: drop `otherNeverRan` and ignore neverRan whenever probabilistic.
// 4a returned 'PASS' -- a cell where the harness errored on 200 of 300 runs.
check(
  '4a never-runs with another cause disqualify, even probabilistic',
  verdictFor(
    { attack: 'A13', passed: 100, failed: 0, neverRan: 200, otherNeverRan: 200 },
    true,
    'satisfied'
  ),
  'NEVER-RAN'
)
check(
  '4b non-landings alone do not disqualify (this is R6)',
  verdictFor(
    { attack: 'A13', passed: 117, failed: 0, neverRan: 183, otherNeverRan: 0 },
    true,
    'satisfied'
  ),
  'PASS'
)
// An unmeasured split must fail SAFE. Omitting otherNeverRan defaults it to
// neverRan, so a caller that has not measured the split cannot claim R6.
check(
  '4c omitted split defaults to strict, not lenient',
  verdictFor({ attack: 'A13', passed: 117, failed: 0, neverRan: 183 }, true, 'satisfied'),
  'NEVER-RAN'
)

// --- 5. THE FLOOR STILL STOPS A CELL PASSING ON THIN EVIDENCE ------------
check(
  '5a probabilistic, clean, under the floor -> underpowered',
  verdictFor(
    { attack: 'A13', passed: LANDED_FLOOR - 1, failed: 0, neverRan: 5, otherNeverRan: 0 },
    true,
    'satisfied'
  ),
  'NEVER-RAN (underpowered)'
)
check(
  '5b exactly at the floor -> PASS',
  verdictFor(
    { attack: 'A13', passed: LANDED_FLOOR, failed: 0, neverRan: 5, otherNeverRan: 0 },
    true,
    'satisfied'
  ),
  'PASS'
)
check(
  '5c a deterministic attack is never underpowered',
  verdictFor({ attack: 'A3', passed: 3, failed: 0, neverRan: 0 }, true, 'satisfied'),
  'PASS'
)

// --- 6. MEMBERSHIP IS EXACT, AND A MISS IS NOW SAFE ----------------------
check('6a A13 is probabilistic', isProbabilistic('A13'), true)
check('6b lowercase misses', isProbabilistic('a13'), false)
check('6c trailing space misses', isProbabilistic('A13 '), false)
check('6d null misses', isProbabilistic(null), false)
// A miss used to convert a FAIL into a NEVER-RAN. After the hoist it cannot:
// the worst a miss can now do is refuse to grant R6's benefit.
check(
  '6e a membership miss can no longer mask a failure',
  verdictFor({ attack: 'A13-TYPO', passed: 10, failed: 3, neverRan: 5 }, true, 'satisfied'),
  'FAIL'
)
// Guards the set's own contents against a silent edit.
check(
  '6f the set is exactly the three ids R6 names',
  [...PROBABILISTIC_ATTACKS].sort().join(','),
  'A13,A13-TIMING,A13-VR'
)

// --- 7. aggregateCell DERIVES THE ATTACK RATHER THAN ASKING FOR IT -------
// Revert: `const attack = options.attack ?? null`. 7a returned 'NEVER-RAN'
// while the summary generator returned 'PASS' for the same cell -- the two
// deciders disagreeing on the headline result of the commit that claimed they
// could not.
const cellRecords = []
for (let i = 0; i < 300; i += 1) {
  const landed = i < 117
  cellRecords.push({
    cell: { attack: 'A13', variant: 'guardHash', candidate: 'V2', fs: 'overlayfs' },
    precondition: { mutationApplied: landed },
    outcome: { status: landed ? 'removed' : 'kept' },
    userFiles: { checked: 4, lost: 0, changed: 0 },
  })
}
const agg = aggregateCell(cellRecords, () => false, {
  target: 300,
  controlFailed: true,
  controlState: 'satisfied',
})
check('7a attack derived from records -> R6 applies', agg.verdict, 'PASS')
check('7b landed subset counted correctly', agg.passed, 117)
check('7c non-landings counted as never-ran', agg.neverRan, 183)
// An explicit option still wins, so a caller can override a mislabelled record.
const aggOverride = aggregateCell(cellRecords, () => false, {
  target: 300,
  attack: 'A3',
  controlFailed: true,
  controlState: 'satisfied',
})
check('7d explicit options.attack still wins', aggOverride.verdict, 'NEVER-RAN')

if (!allOk) {
  console.error('[verdict-rule] FAIL')
  process.exit(1)
}
console.log('[verdict-rule] all cases passed')
process.exit(0)
