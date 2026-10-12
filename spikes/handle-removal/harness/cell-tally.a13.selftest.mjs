// A13 cross-label completeness self-test (SMI-6715, Sol round 2): A13 records
// carry cell.target = the whole race's run count, but the runs are routed into
// A13-C4 (scored) and A13-C4-OOM (record-only). cell.targetScope =
// 'across-a13-labels' says completeness is counted over BOTH labels (same
// candidate, fs, variant, dirs), and the 100-landing floor applies to the
// scored A13-C4 subset only. Shared fixtures: c4-selftest-helpers.mjs.

import { makeRecord, aggregateCell } from './result-schema.mjs'
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
import { resolveControl } from './control-spec.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCOPE = 'across-a13-labels'
const cellOf = (attack, over = {}) => ({
  attack,
  variant: 'race',
  candidate: 'C4',
  fs: 'f',
  runner: 't',
  target: 300,
  targetScope: SCOPE,
  ...over,
})
const uf = { checked: 1, lost: 0, changed: 0, displaced: 0, deleted: 0 }
// A landed run is clean; a non-landing is a run whose racer did not land.
const landed = (cell, i, extra = {}) =>
  makeRecord({
    cell,
    run: i,
    precondition: goodPre(),
    outcome: { status: 'kept' },
    userFiles: { ...uf },
    ...extra,
  })
const missed = (cell, i) =>
  makeRecord({
    cell,
    run: i,
    precondition: { ...goodPre(), mutationApplied: false },
    outcome: { status: 'kept' },
    userFiles: { ...uf },
  })
const n = (count, fn) => Array.from({ length: count }, (_, i) => fn(i))
const agg = (records, universe, extra = {}) =>
  aggregateCell(records, () => false, {
    controlFailed: true,
    controlState: 'satisfied',
    universe,
    ...extra,
  })

const A = cellOf('A13-C4')
const O = cellOf('A13-C4-OOM')
const scoredOf = (landings, misses) => [
  ...n(landings, (i) => landed(A, i)),
  ...n(misses, (i) => missed(A, landings + i)),
]
const oomOf = (count) => n(count, (i) => landed(O, 1000 + i))

// 220 + 80 = 300 with 120 clean landings -> PASS
const scored220 = scoredOf(120, 100)
const oom80 = oomOf(80)
const all300 = [...scored220, ...oom80]
const r1 = agg(scored220, all300)
check('A1 220 scored + 80 OOM = 300 with 120 clean landings is PASS', r1.verdict, 'PASS')
check('A1 the scored cell counts only its own runs', r1.ran, 220)
check('A1 the floor counted the scored landings only', r1.passed, 120)
// 220 + 70 = 290 -> INCOMPLETE
const r2 = agg(scored220, [...scored220, ...oomOf(70)])
check(
  'A2 220 + 70 = 290 is INCOMPLETE across the labels',
  r2.verdict,
  'INCOMPLETE (ran 290/300 across A13 labels)'
)
// without the universe a scoped cell cannot prove completeness: it fails safe
check(
  'A3 no universe supplied: INCOMPLETE, never PASS',
  agg(scored220).verdict.startsWith('INCOMPLETE'),
  true
)
// OOM landings must not rescue an underpowered scored cell
const scored90 = scoredOf(90, 130)
const rUnder = agg(scored90, [...scored90, ...oomOf(80), ...n(0, () => null)])
check(
  'A4 90 scored landings + 100 OOM landings is underpowered, not PASS',
  agg(scoredOf(90, 130), [...scoredOf(90, 130), ...oomOf(80)]).verdict,
  'NEVER-RAN (underpowered)'
)
void rUnder
// the OOM cell stays RECORD-ONLY whatever the group says
check(
  'A5 the OOM cell is RECORD-ONLY when the group is complete',
  agg(oom80, all300).verdict,
  'RECORD-ONLY'
)
check(
  'A5 the OOM cell is RECORD-ONLY even when the group is incomplete',
  agg(oom80, [...scored220.slice(0, 5), ...oom80]).verdict,
  'RECORD-ONLY'
)
const oomLoss = [
  ...oom80.slice(1),
  landed(O, 5000, { userFiles: { checked: 1, lost: 1, changed: 0, displaced: 1, deleted: 0 } }),
]
check(
  'A5 OOM losses are named, not scored',
  agg(oomLoss, [...scored220, ...oomLoss]).verdict,
  'RECORD-ONLY (1 lost)'
)
// an OOM-only candidate (no scored cell at all) is handled
check(
  'A6 an OOM-only candidate is RECORD-ONLY, not INCOMPLETE',
  agg(oom80, oom80).verdict,
  'RECORD-ONLY'
)
// the group is keyed on candidate, fs, variant and dirs
const other = (over) => n(80, (i) => landed(cellOf('A13-C4-OOM', over), 2000 + i))
check(
  "A7 other candidate's OOM records do not complete the group",
  agg(scored220, [...scored220, ...other({ candidate: 'C4-naive' })]).verdict.startsWith(
    'INCOMPLETE'
  ),
  true
)
check(
  'A7 other fs does not complete the group',
  agg(scored220, [...scored220, ...other({ fs: 'g' })]).verdict.startsWith('INCOMPLETE'),
  true
)
check(
  'A7 other variant does not complete the group',
  agg(scored220, [...scored220, ...other({ variant: 'other' })]).verdict.startsWith('INCOMPLETE'),
  true
)
check(
  'A7 other dirs does not complete the group',
  agg(scored220, [...scored220, ...other({ dirs: 20 })]).verdict.startsWith('INCOMPLETE'),
  true
)
const D = (attack) => cellOf(attack, { dirs: 10 })
const dScored = [
  ...n(120, (i) => landed(D('A13-C4'), i)),
  ...n(100, (i) => missed(D('A13-C4'), 120 + i)),
]
const dOom = n(80, (i) => landed(D('A13-C4-OOM'), 1000 + i))
check(
  'A7 positive control: the same dirs completes the group',
  agg(dScored, [...dScored, ...dOom]).verdict,
  'PASS'
)
check('A7 dirs is stored on the record only when present', 'dirs' in landed(A, 0).cell, false)
check('A7 dirs round-trips when present', landed(D('A13-C4'), 0).cell.dirs, 10)
check('A7 targetScope is stored', landed(A, 0).cell.targetScope, SCOPE)
// any other scope is inconsistent
for (const bad of ['across-all', '', 'ACROSS-A13-LABELS', 7]) {
  const rs = n(220, (i) => landed(cellOf('A13-C4', { targetScope: bad }), i))
  check(
    'A8 targetScope ' + JSON.stringify(bad) + ' is INCOMPLETE (inconsistent target)',
    agg(rs, rs).verdict,
    'INCOMPLETE (inconsistent target)'
  )
}
const mixed = [
  ...scored220.slice(0, 100),
  ...n(100, (i) => landed(cellOf('A13-C4', { targetScope: undefined }), 500 + i)),
]
check(
  'A8 a mix of scoped and unscoped records is inconsistent',
  agg(mixed, mixed).verdict,
  'INCOMPLETE (inconsistent target)'
)
const notA13 = n(300, (i) => landed(cellOf('A3-C4'), i))
check(
  'A8 the scope on a non-A13 attack is inconsistent',
  agg(notA13, notA13).verdict,
  'INCOMPLETE (inconsistent target)'
)
// unscoped target behaviour is unchanged
check(
  'A9 unscoped 220/300 is still INCOMPLETE as before',
  agg(n(220, (i) => landed(cellOf('A13-C4', { targetScope: undefined }), i))).verdict,
  'INCOMPLETE (ran 220/300)'
)

// dirs: a different directory count is a different cell, and controls match on it
const dRow = (dirs, candidate, failed) => ({
  attack: 'A13-C4',
  variant: 'race',
  candidate,
  fs: 'f',
  failed,
  dirs,
})
check(
  'D1 a naive control at other dirs does not satisfy this cell',
  resolveControl(dRow(10, 'C4', 0), [dRow(20, 'C4-naive', 5)]).state,
  'absent'
)
check(
  'D1 positive control: the same dirs does',
  resolveControl(dRow(10, 'C4', 0), [dRow(10, 'C4-naive', 5)]).state,
  'satisfied'
)
check(
  'D1 legacy rows without dirs still match each other',
  resolveControl({ ...dRow(0, 'C4', 0), dirs: undefined }, [
    { ...dRow(0, 'C4-naive', 5), dirs: undefined },
  ]).state,
  'satisfied'
)

// --- generate-summary computes the same verdicts (one shared function) ------------
const sandbox = mkdtempSync(path.join(tmpdir(), 's6715-a13-'))
mkdirSync(path.join(sandbox, 'results', 'raw'), { recursive: true })
copyFileSync(
  path.join(HERE, '..', 'results', 'generate-summary.mjs'),
  path.join(sandbox, 'results', 'generate-summary.mjs')
)
symlinkSync(HERE, path.join(sandbox, 'harness'))
// the naive arm is the control: it must lose bytes for the C4 cell's control to bite
const naive = (over) => cellOf('A13-C4', { candidate: 'C4-naive', ...over })
const naiveRecs = n(5, (i) =>
  landed(naive({ target: 5, targetScope: undefined }), i, {
    userFiles: { checked: 1, lost: 1, changed: 0, displaced: 1, deleted: 0 },
  })
)
const lines = [...all300, ...naiveRecs].map((r) => JSON.stringify(r))
writeFileSync(path.join(sandbox, 'results', 'raw', 'x.jsonl'), lines.join('\n') + '\n')
const gen = spawnSync('node', [path.join(sandbox, 'results', 'generate-summary.mjs')], {
  encoding: 'utf8',
})
check('S0 the generator ran', gen.status, 0)
const summary = readFileSync(path.join(sandbox, 'results', 'SUMMARY.md'), 'utf8')
const verdictOf = (attack, candidate) => {
  const row = summary
    .split('\n')
    .find((l) => l.startsWith('| ' + attack + ' |') && l.includes('| ' + candidate + ' |'))
  return row ? row.split('|').slice(-2)[0].trim() : 'ROW-MISSING'
}
check(
  'S1 generate-summary: the scored A13-C4 cell is PASS (120 landings, control bites)',
  verdictOf('A13-C4', 'C4'),
  'PASS'
)
check('S1 generate-summary agrees with aggregateCell', verdictOf('A13-C4', 'C4'), r1.verdict)
check(
  'S2 generate-summary: the OOM cell is RECORD-ONLY',
  verdictOf('A13-C4-OOM', 'C4'),
  'RECORD-ONLY'
)
// the short version: 290 records
writeFileSync(
  path.join(sandbox, 'results', 'raw', 'x.jsonl'),
  [...scored220, ...oomOf(70), ...naiveRecs].map((r) => JSON.stringify(r)).join('\n') + '\n'
)
spawnSync('node', [path.join(sandbox, 'results', 'generate-summary.mjs')], { encoding: 'utf8' })
const summary2 = readFileSync(path.join(sandbox, 'results', 'SUMMARY.md'), 'utf8')
const row2 = summary2.split('\n').find((l) => l.startsWith('| A13-C4 |') && l.includes('| C4 |'))
check(
  'S3 generate-summary: 290/300 is INCOMPLETE too',
  row2.split('|').slice(-2)[0].trim(),
  r2.verdict
)
// two dirs scales of the same race are two cells in the summary, never merged
writeFileSync(
  path.join(sandbox, 'results', 'raw', 'x.jsonl'),
  [
    ...dScored,
    ...dOom,
    ...n(220, (i) => landed(cellOf('A13-C4', { dirs: 20 }), i)),
    ...n(80, (i) => landed(cellOf('A13-C4-OOM', { dirs: 20 }), 1000 + i)),
  ]
    .map((r) => JSON.stringify(r))
    .join('\n') + '\n'
)
spawnSync('node', [path.join(sandbox, 'results', 'generate-summary.mjs')], { encoding: 'utf8' })
const summary3 = readFileSync(path.join(sandbox, 'results', 'SUMMARY.md'), 'utf8')
check(
  'K1 dirs=10 and dirs=20 are separate A13-C4 rows in the cell table',
  summary3
    .split('\n')
    .filter((l) => /^\| A13-C4 \| race \[dirs=(10|20)\] \| C4 \| f \| 220 \|/.test(l)).length,
  2
)
check(
  'K1 the dirs value is shown',
  summary3.includes('[dirs=10]') && summary3.includes('[dirs=20]'),
  true
)
rmSync(sandbox, { recursive: true, force: true })
finish()
