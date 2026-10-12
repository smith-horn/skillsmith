// Self-test for harness/cell-tally.mjs (SMI-6715 R2-3 and the vacuous-check
// owner decision): the shared counting and verdict used by BOTH aggregateCell()
// and results/generate-summary.mjs. The final block proves the two agree by
// running the real generator on the same records.

import { makeRecord, aggregateCell, classifyRecord } from './result-schema.mjs'
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
const cellOf = (attack, target, variant = 'v') => ({
  attack,
  variant,
  candidate: 'C4',
  fs: 'f',
  runner: 't',
  ...(target === undefined ? {} : { target }),
})
const goodUf = { checked: 1, lost: 0, changed: 0, displaced: 0, deleted: 0 }
const mk = (cell, i, over = {}) =>
  makeRecord({
    cell,
    run: i,
    precondition: goodPre(),
    outcome: { status: 'kept' },
    userFiles: { ...goodUf },
    ...over,
  })
const many = (n, cell, over) => Array.from({ length: n }, (_, i) => mk(cell, i, over))
const vacuous = (cell, i) =>
  mk(cell, i, { outcome: { status: 'kept', excludedReason: 'vacuous-check' } })
const n100 = (fn) => Array.from({ length: 100 }, (_, i) => fn(i))
const agg = (records, extra = {}) =>
  aggregateCell(records, () => false, { controlFailed: true, controlState: 'satisfied', ...extra })

// --- vacuous-check exclusion (owner decision, R6 extension) -----------------------
const A13 = cellOf('A13-C4', 110)
const base100 = many(100, A13)
const v10 = (cell) => Array.from({ length: 10 }, (_, i) => vacuous(cell, 100 + i))
const r1 = agg([...base100, ...v10(A13)])
check('V1 100 real landings + 10 vacuous is PASS', r1.verdict, 'PASS')
check('V1 the excluded count is reported', r1.excluded, 10)
check('V1 vacuous runs are not counted as passed', r1.passed, 100)
const A13b = cellOf('A13-C4', 105)
const r2 = agg([...many(95, A13b), ...Array.from({ length: 10 }, (_, i) => vacuous(A13b, 95 + i))])
check('V2 95 real + 10 vacuous is NEVER-RAN (underpowered)', r2.verdict, 'NEVER-RAN (underpowered)')
check('V2 excluded still reported', r2.excluded, 10)
const A13c = cellOf('A13-C4', 110)
check(
  'V3 control: the same 110 runs WITHOUT the exclusion (all real) is PASS',
  agg(many(110, A13c)).verdict,
  'PASS'
)
check(
  'V3 control: 110 runs where the 10 are counted as real passes would have cleared the floor (95 real)',
  agg(many(105, cellOf('A13-C4', 105))).verdict,
  'PASS'
)
// G3-2: a vacuous record whose absent check FAILED is a loss, not an exclusion:
// failures beat exclusion. (These cells run 111 records: target 111.)
const A111 = cellOf('A13-C4', 111)
const lossVac = mk(A111, 200, {
  outcome: { status: 'kept', excludedReason: 'vacuous-check' },
  userFiles: { checked: 1, lost: 1, changed: 0, displaced: 1, deleted: 0 },
})
const r3 = agg([...many(100, A111), ...v10(A111), lossVac], {})
check('V4 vacuous-with-loss IS scored as a failure (loss beats exclusion)', r3.failed, 1)
check('V4 vacuous-with-loss makes the cell FAIL', r3.verdict, 'FAIL')
check('V4 vacuous-with-loss is not counted as excluded', r3.excluded, 10)
const changedVac = (i) =>
  mk(cellOf('A13-C4', 100), i, {
    outcome: { status: 'kept', excludedReason: 'vacuous-check' },
    userFiles: { checked: 1, lost: 0, changed: 1, displaced: 0, deleted: 0 },
  })
const r3b = agg(n100(changedVac))
check('V4 100 vacuous runs whose check FAILED read FAIL, not NEVER-RAN', r3b.verdict, 'FAIL')
check('V4 and every one is counted failed', r3b.failed, 100)
// any other excludedReason: never-ran AND otherNeverRan
for (const bad of ['Vacuous-Check', 'vacuous', 'other', '', 7, true, { a: 1 }]) {
  const r = agg([
    ...many(100, A111),
    ...v10(A111),
    mk(A111, 300, { outcome: { status: 'kept', excludedReason: bad } }),
  ])
  check('V5 excludedReason ' + JSON.stringify(bad) + ' forbids a PASS', r.verdict, 'NEVER-RAN')
}
check(
  'V5 control: excludedReason null is an ordinary run',
  agg([
    ...many(100, A111),
    ...v10(A111),
    mk(A111, 300, { outcome: { status: 'kept', excludedReason: null } }),
  ]).verdict,
  'PASS'
)
// the exclusion is C4-only: a legacy cell's excludedReason is ignored
const legacyCell = { attack: 'A13', variant: 'v', candidate: 'baseline', fs: 'f', runner: 't' }
const legacyRecs = Array.from({ length: 100 }, (_, i) =>
  makeRecord({
    cell: legacyCell,
    run: i,
    precondition: { hookFired: true, mutationApplied: true },
    outcome: { status: 'kept', excludedReason: 'vacuous-check' },
    userFiles: { checked: 1 },
  })
)
check(
  'V6 legacy cell: excludedReason is not honoured',
  aggregateCell(legacyRecs, () => false, { controlFailed: true, controlState: 'satisfied' })
    .excluded,
  0
)

// --- cell.target (R2-3): a short run can never render PASS ------------------------
const A3 = (target) => cellOf('A3-C4', target)
check('T1 ran == target passes', agg(many(5, A3(5))).verdict, 'PASS')
check(
  'T2 ran < target is INCOMPLETE, never PASS',
  agg(many(5, A3(10))).verdict,
  'INCOMPLETE (ran 5/10)'
)
check('T3 ran > target is INCOMPLETE too', agg(many(12, A3(10))).verdict, 'INCOMPLETE (ran 12/10)')
check(
  'T4 no target recorded is INCOMPLETE, never PASS',
  agg(many(5, A3(undefined))).verdict,
  'INCOMPLETE (no target recorded)'
)
check(
  'T5 records disagreeing about the target are INCOMPLETE',
  agg([...many(3, A3(5)), ...many(2, A3(6)).map((r, i) => ({ ...r, run: 10 + i }))]).verdict,
  'INCOMPLETE (inconsistent target)'
)
for (const bad of [0, -1, 2.5, '5', null]) {
  check(
    'T6 target ' + String(bad) + ' is INCOMPLETE',
    agg(many(5, { ...A3(5), target: bad })).verdict.startsWith('INCOMPLETE'),
    true
  )
}
check(
  'T6 target NaN is refused outright by makeRecord (not JSON-safe)',
  (() => {
    try {
      mk({ ...A3(5), target: NaN }, 0)
      return false
    } catch (e) {
      return e instanceof TypeError
    }
  })(),
  true
)
const shortWithLoss = [
  ...many(3, A3(10)),
  mk(A3(10), 3, { userFiles: { checked: 1, lost: 1, changed: 0, displaced: 1, deleted: 0 } }),
]
check(
  'T7 a short run WITH a loss is still FAIL (failures beat everything)',
  agg(shortWithLoss).verdict,
  'FAIL'
)
check(
  'T8 legacy cells (no target) are unchanged',
  aggregateCell(legacyRecs.slice(0, 3), () => false, {
    controlFailed: true,
    controlState: 'satisfied',
  }).verdict.startsWith('INCOMPLETE'),
  false
)
check('T9 makeRecord stores cell.target for C4 cells', mk(A3(7), 0).cell.target, 7)
check('T9 makeRecord stores null when a C4 cell has none', mk(A3(undefined), 0).cell.target, null)
check('T9 makeRecord adds no target key to legacy cells', 'target' in legacyRecs[0].cell, false)
check(
  'T10 options.target that disagrees with the run still wins as INCOMPLETE',
  agg(many(5, A3(5)), { target: 9 }).verdict,
  'INCOMPLETE (ran 5/9)'
)

check(
  'V4 an unrecognised excludedReason on a run that lost bytes stays failed',
  agg(
    n100((i) =>
      mk(cellOf('A13-C4', 100), i, {
        outcome: { status: 'kept', excludedReason: 'mystery' },
        userFiles: { checked: 1, lost: 1, changed: 0, displaced: 1, deleted: 0 },
      })
    )
  ).verdict,
  'FAIL'
)

// --- 'not-run' is a known non-landing status; any other unknown status is a fault ---
const ANR = cellOf('A13-C4', 101)
const odd = (i, status, mutationApplied) =>
  mk(ANR, 700 + i, {
    precondition: { ...goodPre(), mutationApplied },
    outcome: { status },
    userFiles: { checked: 0, lost: 0, changed: 0 },
  })
const clean100n = many(100, ANR)
check(
  'N1 100 passes + 1 not-run with mutationApplied:false is PASS (leaves the denominator)',
  agg([...clean100n, odd(0, 'not-run', false)]).verdict,
  'PASS'
)
check(
  'N1 the not-run record is a never-ran, not a pass',
  agg([...clean100n, odd(0, 'not-run', false)]).neverRan,
  1
)
check(
  'N2 not-run with mutationApplied:true is a fault (NEVER-RAN)',
  agg([...clean100n, odd(0, 'not-run', true)]).verdict,
  'NEVER-RAN'
)
for (const typo of ['quarantine', 'Kept', 'removed', 'notrun', 'harness_error']) {
  check(
    'N3 unknown status ' + JSON.stringify(typo) + ' + mutationApplied:false is NOT a non-landing',
    agg([...clean100n, odd(0, typo, false)]).verdict,
    'NEVER-RAN'
  )
}
check(
  'N3 control: a known non-error status with mutationApplied:false still leaves the denominator',
  agg([...clean100n, odd(0, 'kept', false)]).verdict,
  'PASS'
)
check(
  'N4 classifyRecord: not-run is never-ran',
  classifyRecord(odd(0, 'not-run', false)),
  'never-ran'
)
// legacy unchanged: an unknown status with mutationApplied:false is still a non-landing there
const legacyOdd = [
  ...Array.from({ length: 100 }, (_, i) =>
    makeRecord({
      cell: { attack: 'A13', variant: 'v', candidate: 'baseline', fs: 'f', runner: 't' },
      run: i,
      precondition: { hookFired: true, mutationApplied: true },
      outcome: { status: 'kept' },
      userFiles: { checked: 1 },
    })
  ),
  makeRecord({
    cell: { attack: 'A13', variant: 'v', candidate: 'baseline', fs: 'f', runner: 't' },
    run: 100,
    precondition: { hookFired: true, mutationApplied: false },
    outcome: { status: 'quarantine' },
    userFiles: { checked: 1 },
  }),
]
check(
  'N5 legacy cell: unknown status + mutationApplied:false is unchanged (non-landing, PASS)',
  aggregateCell(legacyOdd, () => false, { controlFailed: true, controlState: 'satisfied' }).verdict,
  'PASS'
)

// --- harness-error with a measured loss: failures beat everything ----------------
const AHE = cellOf('A8-C4', 101)
const heRec = (i, userFiles) =>
  mk(AHE, 900 + i, { outcome: { status: 'harness-error', reason: 'x' }, userFiles })
const cleanHE = many(100, AHE)
const heVerdict = (uf) => agg([...cleanHE, heRec(0, uf)])
check(
  'E1 harness-error + lost 1 is FAIL, not NEVER-RAN',
  heVerdict({ checked: 1, lost: 1, changed: 0 }).verdict,
  'FAIL'
)
check(
  'E1 and is counted in the failed column',
  heVerdict({ checked: 1, lost: 1, changed: 0 }).failed,
  1
)
check(
  'E2 harness-error + changed 1 is FAIL',
  heVerdict({ checked: 1, lost: 0, changed: 1 }).verdict,
  'FAIL'
)
check('E2 and is counted failed', heVerdict({ checked: 1, lost: 0, changed: 1 }).failed, 1)
check(
  'E3 harness-error with lost 0 changed 0 stays NEVER-RAN',
  heVerdict({ checked: 0, lost: 0, changed: 0 }).verdict,
  'NEVER-RAN'
)
check('E3 and is not counted failed', heVerdict({ checked: 0, lost: 0, changed: 0 }).failed, 0)
for (const [label, uf] of [
  ['lost as a string', { checked: 1, lost: '1', changed: 0 }],
  ['lost null', { checked: 1, lost: null, changed: 0 }],
  ['lost fractional', { checked: 1, lost: 0.5, changed: 0 }],
  ['changed negative', { checked: 1, lost: 1, changed: -1 }],
  ['lost missing', { checked: 1, changed: 1 }],
]) {
  const r = heVerdict(uf)
  check(
    'E4 harness-error with malformed counts (' + label + ') is NEVER-RAN',
    r.verdict,
    'NEVER-RAN'
  )
  check('E4 and is not counted failed (' + label + ')', r.failed, 0)
}
const legacyHELoss = [
  ...Array.from({ length: 100 }, (_, i) =>
    makeRecord({
      cell: { attack: 'A13', variant: 'v', candidate: 'baseline', fs: 'f', runner: 't' },
      run: i,
      precondition: { hookFired: true, mutationApplied: true },
      outcome: { status: 'kept' },
      userFiles: { checked: 1 },
    })
  ),
  makeRecord({
    cell: { attack: 'A13', variant: 'v', candidate: 'baseline', fs: 'f', runner: 't' },
    run: 100,
    precondition: { hookFired: true, mutationApplied: true },
    outcome: { status: 'harness-error' },
    userFiles: { checked: 1, lost: 1 },
  }),
]
const legacyHEagg = aggregateCell(legacyHELoss, () => false, {
  controlFailed: true,
  controlState: 'satisfied',
})
check('E5 legacy harness-error with lost 1 is unchanged: not counted failed', legacyHEagg.failed, 0)
check(
  'E5 legacy harness-error with lost 1 is unchanged: NEVER-RAN',
  legacyHEagg.verdict,
  'NEVER-RAN'
)

// --- G3-1: a harness-error is never a non-landing -------------------------------
const A101 = cellOf('A13-C4', 101)
const noLand = (i, status) =>
  mk(A101, 500 + i, {
    precondition: { ...goodPre(), mutationApplied: false },
    outcome: { status },
    userFiles: { checked: 0, lost: 0, changed: 0 },
  })
const clean100 = many(100, A101)
check(
  'H1 100 passed + 1 harness-error carrying mutationApplied:false is NOT a PASS',
  agg([...clean100, noLand(0, 'harness-error')]).verdict,
  'NEVER-RAN'
)
check(
  'H1 positive control: 100 passed + 1 genuine non-landing is PASS',
  agg([...clean100, noLand(0, 'kept')]).verdict,
  'PASS'
)
check(
  'H1 a harness-error with mutationApplied:true is not a PASS either',
  agg([
    ...clean100,
    mk(A101, 600, {
      outcome: { status: 'harness-error' },
      userFiles: { checked: 0, lost: 0, changed: 0 },
    }),
  ]).verdict,
  'NEVER-RAN'
)
// legacy output is unchanged: the old rule still applies to non-C4 cells
const legacyHE = Array.from({ length: 101 }, (_, i) =>
  makeRecord({
    cell: { attack: 'A13', variant: 'v', candidate: 'baseline', fs: 'f', runner: 't' },
    run: i,
    precondition: { hookFired: true, mutationApplied: i < 100 },
    outcome: { status: i < 100 ? 'kept' : 'harness-error' },
    userFiles: { checked: 1 },
  })
)
check(
  'H2 legacy cell: harness-error with mutationApplied:false is still a non-landing (unchanged)',
  aggregateCell(legacyHE, () => false, { controlFailed: true, controlState: 'satisfied' }).verdict,
  'PASS'
)

// --- G3-4: failures win over a short run in aggregateCell too ---------------------
const lostRec = (i) =>
  mk(cellOf('A3-C4', 100), i, {
    userFiles: { checked: 1, lost: 1, changed: 0, displaced: 1, deleted: 0 },
  })
check(
  'I1 5 runs that lost bytes with options.target 100 is FAIL, not INCOMPLETE',
  aggregateCell(
    Array.from({ length: 5 }, (_, i) => lostRec(i)),
    () => false,
    {
      controlFailed: true,
      controlState: 'satisfied',
      target: 100,
    }
  ).verdict,
  'FAIL'
)
check(
  'I1 positive control: 5 clean runs with options.target 100 is still INCOMPLETE',
  aggregateCell(many(5, cellOf('A3-C4', 100)), () => false, {
    controlFailed: true,
    controlState: 'satisfied',
    target: 100,
  }).verdict,
  'INCOMPLETE (ran 5/100)'
)

// --- aggregateCell and generate-summary agree (one shared function) ---------------
const sandbox = mkdtempSync(path.join(tmpdir(), 's6715-tally-'))
mkdirSync(path.join(sandbox, 'results', 'raw'), { recursive: true })
copyFileSync(
  path.join(HERE, '..', 'results', 'generate-summary.mjs'),
  path.join(sandbox, 'results', 'generate-summary.mjs')
)
symlinkSync(HERE, path.join(sandbox, 'harness'))
const scenarios = [
  ['A13-C4', 110, [...base100, ...v10(A13)]],
  ['A3-C4', 10, many(5, cellOf('A3-C4', 10))],
  ['A4-C4', undefined, many(4, cellOf('A4-C4', undefined))],
  ['A7-C4', 5, many(5, cellOf('A7-C4', 5))],
  [
    'A8-C4',
    5,
    [
      ...many(4, cellOf('A8-C4', 5)),
      mk(cellOf('A8-C4', 5), 4, {
        outcome: { status: 'harness-error' },
        userFiles: { checked: 1, lost: 1, changed: 0 },
      }),
    ],
  ],
]
const lines = []
const expected = {}
for (const [attack, , recs] of scenarios) {
  expected[attack] = agg(recs).verdict
  for (const r of recs) lines.push(JSON.stringify(r))
  // A control cell so the summary resolves the control the same way agg() was told to.
  const ctl = recs.map((r, i) => ({
    ...JSON.parse(JSON.stringify(r)),
    cell: { ...JSON.parse(JSON.stringify(r.cell)), candidate: 'C4-naive' },
    userFiles: { checked: 1, lost: 1, changed: 0, displaced: 1, deleted: 0 },
    run: i,
  }))
  for (const r of ctl) lines.push(JSON.stringify(r))
}
writeFileSync(path.join(sandbox, 'results', 'raw', 'x.jsonl'), lines.join('\n') + '\n')
const gen = spawnSync('node', [path.join(sandbox, 'results', 'generate-summary.mjs')], {
  encoding: 'utf8',
})
check('G0 the generator ran', gen.status, 0)
const summary = readFileSync(path.join(sandbox, 'results', 'SUMMARY.md'), 'utf8')
for (const [attack] of scenarios) {
  const row = summary
    .split('\n')
    .find((l) => l.startsWith('| ' + attack + ' |') && l.includes('| C4 |'))
  const verdict = row ? row.split('|').slice(-2)[0].trim() : 'ROW-MISSING'
  check(
    'G1 ' + attack + ': generate-summary verdict === aggregateCell verdict',
    verdict,
    expected[attack]
  )
}
check(
  'G2 the summary names the excluded runs',
  summary.includes('## Cells with excluded runs'),
  true
)
check(
  'G2 and shows the excluded count in the row',
  /\| A13-C4 \|.*\| 110 \| 10 \|/.test(summary),
  true
)
rmSync(sandbox, { recursive: true, force: true })
finish()
