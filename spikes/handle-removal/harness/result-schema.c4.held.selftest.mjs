// SMI-6715 Step 1b (design §8 R-b, §9 held predicate; coordinator part 2 item 1).
//
// A C4 record whose outcome is `held` classifies `held` ONLY when every item of
// the strict predicate holds; anything else is `failed`:
//   1. outcome.status 'held' (and c4Validate passed: every precondition strictly
//      true, so the trace matched);
//   2. userFiles.checked >= 1;
//   3. lost === 0 AND changed === 0, scored against the held copy;
//   4. heldEvidence.location === 'held-copy' (the bytes were checked in the held
//      copy, byte-exact, not at the empty origin);
//   5. heldEvidence.originRecreated is a boolean, and when true originIntact is
//      strictly true (when false, originIntact is null);
//   6. heldEvidence.sidecarVerified === true (parses, hold:true, heldPath and
//      originPath match the result).
// A cell renders `PASS (<n> held)` only if every record is passed or held, the
// run is complete and the control failed; one failed record still FAILs it.
//
// DECLARED FAILURE ON THE PRE-PREDICATE SCHEMA: there is no 'held' class, so
// HP1/HP2 classify 'passed' (byte rule), every HN case with zero loss also reads
// 'passed' instead of 'failed', and the verdict cases read 'PASS' with no held
// count. makeRecord drops outcome.heldEvidence (HM1 reads undefined).

import { classifyRecord, aggregateCell, makeRecord } from './result-schema.mjs'
import { C4_KNOWN_STATUSES } from './result-schema.c4.mjs'
import { tallyCell } from './cell-tally.mjs'
import { check, finish, goodPre, goodUf, C4CELL } from './c4-selftest-helpers.mjs'

const CELL = { ...C4CELL, attack: 'A4-C4', variant: 'target-swap/post-hash', target: 30 }
const goodEv = () => ({
  location: 'held-copy',
  sidecarVerified: true,
  originRecreated: false,
  originIntact: null,
})
const held = (o = {}) => ({
  cell: o.cell ?? CELL,
  precondition: o.precondition ?? goodPre(),
  outcome: {
    status: 'held',
    reason: 'changed-during-move',
    ...(o.noEvidence ? {} : { heldEvidence: { ...goodEv(), ...(o.ev ?? {}) } }),
  },
  userFiles: o.userFiles ?? goodUf(),
})
const passedRec = () => ({
  cell: CELL,
  precondition: goodPre(),
  outcome: { status: 'kept' },
  userFiles: goodUf(),
})

// --- the predicate, positive ---------------------------------------------------
check('HP1 a held record meeting every item classifies held', classifyRecord(held()), 'held')
check(
  'HP2 a re-created origin left intact is still held',
  classifyRecord(held({ ev: { originRecreated: true, originIntact: true } })),
  'held'
)

// --- the predicate, each item negated (R-b is HN1) -----------------------------
const uf = (lost, changed, displaced = 0) => ({
  checked: 3,
  lost,
  changed,
  displaced,
  deleted: lost - displaced,
})
check(
  'HN1 (R-b) one changed file -> failed',
  classifyRecord(held({ userFiles: uf(0, 1) })),
  'failed'
)
check('HN2 one lost file -> failed', classifyRecord(held({ userFiles: uf(1, 0, 1) })), 'failed')
check('HN3 no heldEvidence -> failed', classifyRecord(held({ noEvidence: true })), 'failed')
check(
  'HN4 scored at the origin, not the held copy -> failed',
  classifyRecord(held({ ev: { location: 'origin' } })),
  'failed'
)
check(
  'HN5 sidecar did not verify -> failed',
  classifyRecord(held({ ev: { sidecarVerified: false } })),
  'failed'
)
check(
  'HN6 a re-created origin NOT intact -> failed',
  classifyRecord(held({ ev: { originRecreated: true, originIntact: false } })),
  'failed'
)
check(
  'HN7 originRecreated not a boolean -> failed',
  classifyRecord(held({ ev: { originRecreated: 'yes' } })),
  'failed'
)
check(
  'HN8 truthy-but-not-true sidecarVerified -> failed',
  classifyRecord(held({ ev: { sidecarVerified: 1 } })),
  'failed'
)
{
  // Inherited evidence never reaches the predicate: a non-plain object is not
  // JSON-safe, so the whole record is never-ran (fail-closed), never held.
  const proto = Object.create(goodEv())
  check(
    'HN9 inherited evidence is never held (never-ran, not JSON-safe)',
    classifyRecord({ ...held(), outcome: { status: 'held', heldEvidence: proto } }),
    'never-ran'
  )
}
check(
  'HN10 a false precondition is still never-ran, not held',
  classifyRecord(held({ precondition: { ...goodPre(), traceMatched: false } })),
  'never-ran'
)
check('HN11 held is a known C4 status (not a tally fault)', C4_KNOWN_STATUSES.has('held'), true)
check(
  'HN12 an unknown status is still never-ran (control)',
  classifyRecord({ ...passedRec(), outcome: { status: 'helds' } }),
  'never-ran'
)

// --- makeRecord carries the evidence ---------------------------------------------
{
  const r = makeRecord({ ...held(), run: 0 })
  check(
    'HM1 makeRecord keeps outcome.heldEvidence',
    JSON.stringify(r.outcome.heldEvidence),
    JSON.stringify(goodEv())
  )
  check('HM2 and the persisted record still classifies held', classifyRecord(r), 'held')
}

// --- cell verdicts --------------------------------------------------------------
const verdict = (records) =>
  aggregateCell(records, () => false, {
    target: 30,
    controlFailed: true,
    controlState: 'satisfied',
  }).verdict
check(
  'HV1 30 held -> PASS (30 held)',
  verdict(Array.from({ length: 30 }, () => held())),
  'PASS (30 held)'
)
check(
  'HV2 20 passed + 10 held -> PASS (10 held)',
  verdict([...Array.from({ length: 20 }, passedRec), ...Array.from({ length: 10 }, () => held())]),
  'PASS (10 held)'
)
check(
  'HV3 29 held + 1 held with a changed file -> FAIL',
  verdict([...Array.from({ length: 29 }, () => held()), held({ userFiles: uf(0, 1) })]),
  'FAIL'
)
check(
  'HV4 30 passed, no held -> plain PASS (control)',
  verdict(Array.from({ length: 30 }, passedRec)),
  'PASS'
)
{
  const agg = aggregateCell(
    Array.from({ length: 30 }, () => held()),
    () => false,
    {
      target: 30,
      controlFailed: true,
      controlState: 'satisfied',
    }
  )
  check('HV5 aggregateCell reports held=30', agg.held, 30)
  check('HV6 and passed=0 (held is not passed)', agg.passed, 0)
}
// --- a vacuous held run leaves the floor like a vacuous passed one --------------
// Found by the A13-C4-POSTHASH smoke (darwin, 1,630 dirs): 5 of 10 held runs
// carried excludedReason 'vacuous-check' and were tallied as otherNeverRan, which
// blocks the cell, where a vacuous PASSED run is merely excluded.
{
  const vac = { ...held(), outcome: { ...held().outcome, excludedReason: 'vacuous-check' } }
  const t = tallyCell([vac], (r) => classifyRecord(r))
  check('HT1 a vacuous held run is excluded', t.excluded, 1)
  check('HT2 and is not a harness-class never-ran', t.otherNeverRan, 0)
  const lossy = {
    ...held({ userFiles: uf(0, 1) }),
    outcome: { ...held().outcome, excludedReason: 'vacuous-check' },
  }
  check(
    'HT3 a vacuous held run that changed a file still fails',
    tallyCell([lossy], (r) => classifyRecord(r)).failed,
    1
  )
}
finish()
