// Owner decision (SMI-6715, governance finding 1): in tallyCell a C4 record with
// valid integer lost + changed > 0 is FAILED regardless of status or
// mutationApplied (failures beat everything), with exactly ONE exemption:
//   outcome.excludedReason === 'pre-caller-hash'
//   AND precondition.mutationApplied === false
//   AND outcome.callerIntentProof is a plain object whose callerHash and
//       movedTreeHash are both 64-char lowercase hex strings, equal to each
//       other (re-derived here, the `equal` flag is not trusted), with equal === true.
// An exempt record leaves the denominator as a non-landing and is counted in
// `callerIntentExcluded`. The cell is A13-C4 (probabilistic, R6): a non-landing only
// leaves the denominator there; a deterministic attack's non-landing blocks a PASS.
// Shared fixtures: c4-selftest-helpers.mjs.

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

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CELL = { attack: 'A13-C4', variant: 'v', candidate: 'C4', fs: 'f', runner: 't', target: 101 }
const H = 'a1'.repeat(32)
const H2 = 'b2'.repeat(32)
const proofOk = () => ({ callerHash: H, movedTreeHash: H, equal: true })
const cleanUf = { checked: 1, lost: 0, changed: 0, displaced: 0, deleted: 0 }
const n = (count, fn) => Array.from({ length: count }, (_, i) => fn(i))
const clean100 = n(100, (i) =>
  makeRecord({
    cell: CELL,
    run: i,
    precondition: goodPre(),
    outcome: { status: 'kept' },
    userFiles: { ...cleanUf },
  })
)
const lossRec = ({
  status = 'quarantined',
  mutationApplied = false,
  outcome = {},
  lost = 2,
  changed = 0,
  cell = CELL,
  pre = {},
} = {}) =>
  makeRecord({
    cell,
    run: 500,
    precondition: { ...goodPre(), mutationApplied, ...pre },
    outcome: { status, ...outcome },
    userFiles: { checked: 3, lost, changed, displaced: lost, deleted: 0 },
  })
const exemptOutcome = (proof = proofOk()) => ({
  excludedReason: 'pre-caller-hash',
  callerIntentProof: proof,
})
const verdict = (extra, over = {}) =>
  aggregateCell([...clean100, extra], () => false, {
    controlFailed: true,
    controlState: 'satisfied',
    ...over,
  })

// --- the one exemption -------------------------------------------------------------
const ok = verdict(lossRec({ outcome: exemptOutcome() }))
check(
  'P1 non-landing with lost 2 and a valid proof is excluded: the cell can PASS',
  ok.verdict,
  'PASS'
)
check('P1 and is counted in callerIntentExcluded', ok.callerIntentExcluded, 1)
check('P1 and is not a failure', ok.failed, 0)
check('P1 and is not counted in the vacuous excluded count', ok.excluded, 0)

// --- everything else is FAILED ---------------------------------------------------------
const failedCase = (label, rec) => {
  const r = verdict(rec)
  check('P2 ' + label + ': FAIL', r.verdict, 'FAIL')
  check('P2 ' + label + ': counted failed', r.failed, 1)
  check('P2 ' + label + ': not excluded', r.callerIntentExcluded, 0)
}
failedCase(
  'mismatched hashes (both valid hex, equal true)',
  lossRec({ outcome: exemptOutcome({ callerHash: H, movedTreeHash: H2, equal: true }) })
)
failedCase(
  'equal false with identical hashes',
  lossRec({ outcome: exemptOutcome({ callerHash: H, movedTreeHash: H, equal: false }) })
)
failedCase(
  'equal missing',
  lossRec({ outcome: exemptOutcome({ callerHash: H, movedTreeHash: H }) })
)
failedCase(
  'equal the string "true"',
  lossRec({ outcome: exemptOutcome({ callerHash: H, movedTreeHash: H, equal: 'true' }) })
)
failedCase('missing proof', lossRec({ outcome: { excludedReason: 'pre-caller-hash' } }))
failedCase('null proof', lossRec({ outcome: exemptOutcome(null) }))
failedCase('array proof', lossRec({ outcome: exemptOutcome([H, H]) }))
failedCase('string proof', lossRec({ outcome: exemptOutcome(H) }))
failedCase(
  'proof missing movedTreeHash',
  lossRec({ outcome: exemptOutcome({ callerHash: H, equal: true }) })
)
failedCase(
  'uppercase hex',
  lossRec({
    outcome: exemptOutcome({
      callerHash: H.toUpperCase(),
      movedTreeHash: H.toUpperCase(),
      equal: true,
    }),
  })
)
failedCase(
  '63 hex chars',
  lossRec({
    outcome: exemptOutcome({ callerHash: H.slice(1), movedTreeHash: H.slice(1), equal: true }),
  })
)
failedCase(
  '65 hex chars',
  lossRec({ outcome: exemptOutcome({ callerHash: H + 'a', movedTreeHash: H + 'a', equal: true }) })
)
failedCase(
  'non-hex characters',
  lossRec({
    outcome: exemptOutcome({
      callerHash: 'g'.repeat(64),
      movedTreeHash: 'g'.repeat(64),
      equal: true,
    }),
  })
)
failedCase(
  'non-string hashes',
  lossRec({ outcome: exemptOutcome({ callerHash: 1, movedTreeHash: 1, equal: true }) })
)
failedCase(
  'valid proof but mutationApplied true',
  lossRec({ mutationApplied: true, outcome: exemptOutcome() })
)
failedCase(
  'valid proof but no excludedReason',
  lossRec({ outcome: { callerIntentProof: proofOk() } })
)
failedCase(
  'valid proof but a different excludedReason',
  lossRec({ outcome: { excludedReason: 'vacuous-check', callerIntentProof: proofOk() } })
)
failedCase(
  'valid proof but an unrecognised excludedReason',
  lossRec({ outcome: { excludedReason: 'whatever', callerIntentProof: proofOk() } })
)
failedCase('not-run with lost 3 and no proof', lossRec({ status: 'not-run', lost: 3 }))
failedCase(
  'kept non-landing with changed 1 and no proof',
  lossRec({ status: 'kept', lost: 0, changed: 1 })
)
failedCase('stopped non-landing with lost 1 and no proof', lossRec({ status: 'stopped', lost: 1 }))
failedCase('an unknown status with lost 1', lossRec({ status: 'quarantine', lost: 1 }))
failedCase('harness-error with lost 1 and no proof', lossRec({ status: 'harness-error', lost: 1 }))
// positive controls on the exemption's inputs
check(
  'P3 control: changed alone with a valid proof is also excluded',
  verdict(lossRec({ lost: 0, changed: 1, outcome: exemptOutcome() })).callerIntentExcluded,
  1
)
// A harness error always counts against the cell, whatever proof it carries: the
// tally does not trust the producer, and a harness-error is never a non-landing.
failedCase(
  'harness-error with an otherwise fully valid proof',
  lossRec({ status: 'harness-error', outcome: exemptOutcome() })
)
check(
  'P3 a harness-error with a valid proof adds nothing to controlFailures',
  verdict(lossRec({ status: 'harness-error', outcome: exemptOutcome() })).controlFailures,
  0
)
// F4: the only producer emits this proof for A13 + quarantined, so that is all the
// tally accepts.
check(
  'P3 control: quarantined on A13-C4 with a valid proof is exempt',
  verdict(lossRec({ outcome: exemptOutcome() })).callerIntentExcluded,
  1
)
check(
  'P3 control: and on A13-C4-OOM',
  (() => {
    const r = aggregateCell(
      [lossRec({ outcome: exemptOutcome(), cell: { ...CELL, attack: 'A13-C4-OOM' } })],
      () => false,
      { controlFailed: true, controlState: 'none' }
    )
    return r.callerIntentExcluded
  })(),
  1
)
for (const st of ['kept', 'stopped', 'not-run']) {
  failedCase(
    'status ' + st + ' with an otherwise valid proof',
    lossRec({ status: st, outcome: exemptOutcome() })
  )
}
for (const attack of ['A3-C4', 'A4-C4', 'A8-C4', 'A10-C4', 'A13', 'X13-C4']) {
  const r = aggregateCell(
    [
      ...clean100.map((x) => ({ ...x, cell: { ...x.cell, attack } })),
      lossRec({ outcome: exemptOutcome(), cell: { ...CELL, attack } }),
    ],
    () => false,
    { controlFailed: true, controlState: 'satisfied' }
  )
  check('P7 attack ' + attack + ' with a valid proof is never exempt', r.callerIntentExcluded, 0)
}
check(
  'P7 an A3-C4 record with a valid proof is FAILED',
  aggregateCell(
    [lossRec({ outcome: exemptOutcome(), cell: { ...CELL, attack: 'A3-C4' } })],
    () => false,
    { controlFailed: true, controlState: 'satisfied' }
  ).failed,
  1
)
for (const [key, v] of [
  ['hookFired', 1],
  ['hookFired', 'true'],
  ['traceMatched', 1],
  ['traceMatched', 'true'],
]) {
  failedCase(
    key + ' = ' + JSON.stringify(v) + ' (truthy, not strictly true)',
    lossRec({ outcome: exemptOutcome(), pre: { [key]: v } })
  )
}
for (const key of ['hookFired', 'traceMatched']) {
  failedCase(
    key + ' false with an otherwise valid proof',
    lossRec({ outcome: exemptOutcome(), pre: { [key]: false } })
  )
  failedCase(key + ' missing', lossRec({ outcome: exemptOutcome(), pre: { [key]: undefined } }))
}
// the exemption is about a MEASURED loss only: no loss, the reason is informational
const noLoss = verdict(lossRec({ lost: 0, outcome: exemptOutcome() }))
check(
  'P4 pre-caller-hash with no loss is an ordinary non-landing, not a caller-intent exclusion',
  noLoss.callerIntentExcluded,
  0
)
check('P4 and it still leaves the denominator (mutationApplied false)', noLoss.verdict, 'PASS')
// invalid counts do not trigger the rule
const badCounts = aggregateCell(
  [
    ...clean100,
    makeRecord({
      cell: CELL,
      run: 500,
      precondition: { ...goodPre(), mutationApplied: false },
      outcome: { status: 'quarantined' },
      userFiles: { checked: 3, lost: '2', changed: 0, displaced: 2, deleted: 0 },
    }),
  ],
  () => false,
  { controlFailed: true, controlState: 'satisfied' }
)
check(
  'P5 string lost is not a valid integer count: not scored failed by this rule',
  badCounts.failed,
  0
)
// a loss that cannot be proven intended counts as control evidence unless it is an error
check(
  'P6 an unexempted loss on a genuine record (quarantined, preconditions true) is control evidence',
  verdict(lossRec({ mutationApplied: true })).controlFailures,
  1
)
check(
  'P6 an unexempted loss on a not-run record is not (F3: only genuine scored failures count)',
  verdict(lossRec({ status: 'not-run' })).controlFailures,
  0
)
check(
  'P6 a harness-error loss is not',
  verdict(lossRec({ status: 'harness-error' })).controlFailures,
  0
)

// --- legacy unchanged ---------------------------------------------------------------------
const LEG = { attack: 'A3', variant: 'v', candidate: 'baseline', fs: 'f', runner: 't' }
const legacyAgg = aggregateCell(
  [
    ...n(100, (i) =>
      makeRecord({
        cell: LEG,
        run: i,
        precondition: { hookFired: true, mutationApplied: true },
        outcome: { status: 'kept' },
        userFiles: { checked: 1 },
      })
    ),
    makeRecord({
      cell: LEG,
      run: 100,
      precondition: { hookFired: true, mutationApplied: false },
      outcome: {
        status: 'not-run',
        excludedReason: 'pre-caller-hash',
        callerIntentProof: proofOk(),
      },
      userFiles: { checked: 1, lost: 2 },
    }),
  ],
  () => false,
  { controlFailed: true, controlState: 'satisfied' }
)
check('L1 legacy cell: lost on a non-landing is NOT rescored (unchanged)', legacyAgg.failed, 0)
check(
  'L1 legacy cell: nothing is counted as caller-intent excluded',
  legacyAgg.callerIntentExcluded,
  0
)

// --- generate-summary goes through the same function ----------------------------------------
const sandbox = mkdtempSync(path.join(tmpdir(), 's6715-intent-'))
mkdirSync(path.join(sandbox, 'results', 'raw'), { recursive: true })
copyFileSync(
  path.join(HERE, '..', 'results', 'generate-summary.mjs'),
  path.join(sandbox, 'results', 'generate-summary.mjs')
)
symlinkSync(HERE, path.join(sandbox, 'harness'))
const naive = n(101, (i) =>
  makeRecord({
    cell: { ...CELL, candidate: 'C4-naive' },
    run: i,
    precondition: goodPre(),
    outcome: { status: 'kept' },
    userFiles: { checked: 1, lost: 1, changed: 0, displaced: 1, deleted: 0 },
  })
)
const gen = (records) => {
  writeFileSync(
    path.join(sandbox, 'results', 'raw', 'x.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  )
  const r = spawnSync('node', [path.join(sandbox, 'results', 'generate-summary.mjs')], {
    encoding: 'utf8',
  })
  const text = readFileSync(path.join(sandbox, 'results', 'SUMMARY.md'), 'utf8')
  const row = text.split('\n').find((l) => l.startsWith('| A13-C4 |') && l.includes('| C4 |'))
  return {
    status: r.status,
    text,
    verdict: row ? row.split('|').slice(-2)[0].trim() : 'ROW-MISSING',
  }
}
const s1 = gen([...clean100, lossRec({ outcome: exemptOutcome() }), ...naive])
check('S1 the generator ran', s1.status, 0)
check(
  'S1 summary: the exempt record lets the cell PASS, same as aggregateCell',
  s1.verdict,
  ok.verdict
)
check('S1 summary shows the caller-intent exclusion', s1.text.includes('caller-intent'), true)
const s2 = gen([
  ...clean100,
  lossRec({ outcome: exemptOutcome({ callerHash: H, movedTreeHash: H2, equal: true }) }),
  ...naive,
])
check('S2 summary: mismatched hashes FAIL, same as aggregateCell', s2.verdict, 'FAIL')
rmSync(sandbox, { recursive: true, force: true })
finish()
