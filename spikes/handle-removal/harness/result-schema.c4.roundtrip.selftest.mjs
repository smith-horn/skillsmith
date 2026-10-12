// C4 round-trip self-test (SMI-6715, red-test round 2): the runner classifies the
// record in memory, the summary classifies what JSON.stringify persisted. For C4
// cells those must agree BY CONSTRUCTION. Also the '__proto__' key (R2-1b) and the
// lost/changed coercion (R2-1c). Shared fixtures: c4-selftest-helpers.mjs.

import { makeRecord, classifyRecord, appendJsonl } from './result-schema.mjs'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { check, finish, C4CELL, goodPre, goodUf, rec, legacyCell } from './c4-selftest-helpers.mjs'

const tmp = mkdtempSync(path.join(tmpdir(), 's6715-roundtrip-'))
const roundTrip = (r) => JSON.parse(JSON.stringify(r))
const throws = (fn) => {
  try {
    fn()
    return false
  } catch (e) {
    return e instanceof TypeError
  }
}
const mk = (over) =>
  makeRecord({
    cell: C4CELL,
    run: 0,
    precondition: goodPre(),
    outcome: { status: 'kept' },
    userFiles: goodUf(),
    ...over,
  })

// --- R2-1a: runner and summary agree by construction ---------------------------
// A record whose persisted form differs from its in-memory form (toJSON) can
// classify one way in the runner and another in the summary. For a C4 record the
// classifier refuses such a record AND the writer refuses to persist it.
const lyingPre = { ...goodPre(), extra: false, toJSON: () => goodPre() }
const lyingOutcome = { status: 'kept', toJSON: () => ({ status: 'removed' }) }
const lyingCell = { ...C4CELL, toJSON: () => ({ ...C4CELL, candidate: 'V2' }) }
const lyingUf = {
  ...goodUf(),
  toJSON: () => ({ checked: 3, lost: 1, changed: 0, displaced: 1, deleted: 0 }),
}
const lyingRecords = [
  ['precondition toJSON hides a false', rec({ precondition: lyingPre })],
  ['outcome toJSON changes the status', rec({ outcome: lyingOutcome })],
  ['cell toJSON changes the candidate', rec({ cell: lyingCell })],
  ['userFiles toJSON reports a loss', rec({ userFiles: lyingUf })],
]
for (const [label, r] of lyingRecords) {
  check('R2-1a ' + label + ': classified never-ran in memory', classifyRecord(r), 'never-ran')
  check(
    'R2-1a ' + label + ': appendJsonl refuses to persist it',
    throws(() => appendJsonl(path.join(tmp, 'x.jsonl'), r)),
    true
  )
}
check(
  'R2-1a makeRecord throws on a precondition with a toJSON',
  throws(() => mk({ precondition: lyingPre })),
  true
)
check(
  'R2-1a makeRecord throws on an outcome with a toJSON',
  throws(() => mk({ outcome: lyingOutcome })),
  true
)
check(
  'R2-1a makeRecord throws on a userFiles with a toJSON',
  throws(() => mk({ userFiles: lyingUf })),
  true
)
check(
  'R2-1a makeRecord throws on a cell with a toJSON',
  throws(() => mk({ cell: lyingCell })),
  true
)
for (const [label, v] of [
  ['object value', { a: 1 }],
  ['array value', [true]],
  ['function value', () => true],
  ['Date value', new Date(0)],
  ['bigint value', 1n],
  ['symbol value', Symbol('s')],
  ['boxed Boolean', new Boolean(true)],
]) {
  check(
    'R2-1a precondition ' + label + ' is refused by makeRecord',
    throws(() => mk({ precondition: { ...goodPre(), extra: v } })),
    true
  )
}
check(
  'R2-1a userFiles boxed Number is refused',
  throws(() => mk({ userFiles: { ...goodUf(), checked: new Number(3) } })),
  true
)
check(
  'R2-1a non-finite number is refused (JSON turns it into null)',
  throws(() => mk({ userFiles: { ...goodUf(), changed: NaN } })),
  true
)
// Positive control + the agreement property over records makeRecord can produce.
const sample = [
  mk({}),
  mk({
    outcome: { status: 'quarantined', reason: 'x', quarantineLeft: { dirs: 0, paths: ['a'] } },
  }),
  mk({ userFiles: { checked: 3, lost: 1, changed: 0, displaced: 1, deleted: 0 } }),
  mk({ precondition: { ...goodPre(), traceMatched: false } }),
  mk({ userFiles: { checked: 0, lost: 0, changed: 0, displaced: 0, deleted: 0 } }),
  mk({ outcome: { status: 'harness-error' } }),
  mk({ userFiles: { checked: 3, lost: 0, changed: 0, displaced: 0, deleted: 0, extraKey: 1 } }),
]
for (let i = 0; i < sample.length; i += 1) {
  check(
    'R2-1a sample ' + i + ': runner verdict === summary verdict',
    classifyRecord(sample[i]),
    classifyRecord(roundTrip(sample[i]))
  )
}
check(
  'R2-1a positive control: a plain record still persists',
  (() => {
    const f = path.join(tmp, 'ok.jsonl')
    appendJsonl(f, sample[0])
    return JSON.parse(readFileSync(f, 'utf8')).run
  })(),
  0
)
check(
  'R2-1a legacy records are not subject to the C4 persistence check',
  (() => {
    const f = path.join(tmp, 'legacy.jsonl')
    appendJsonl(f, { cell: legacyCell, precondition: {}, toJSON: () => ({ cell: legacyCell }) })
    return JSON.parse(readFileSync(f, 'utf8')).cell.attack
  })(),
  'A3'
)

// --- R2-1b: own __proto__ / constructor / prototype keys ---------------------------
// JSON.parse creates an OWN '__proto__' property; a plain `out[key] = v` would
// silently set the prototype instead of storing it.
const protoFalse = JSON.parse(
  '{"hookFired":true,"mutationApplied":true,"traceMatched":true,"controlExpected":true,"__proto__":false}'
)
check(
  'R2-1b control: JSON.parse really made an own __proto__ key',
  Object.hasOwn(protoFalse, '__proto__'),
  true
)
check(
  'R2-1b precondition with own __proto__:false is refused',
  throws(() => mk({ precondition: protoFalse })),
  true
)
const protoTrue = JSON.parse(
  '{"hookFired":true,"mutationApplied":true,"traceMatched":true,"controlExpected":true,"__proto__":true}'
)
check(
  'R2-1b precondition with own __proto__:true is refused too',
  throws(() => mk({ precondition: protoTrue })),
  true
)
const ufViaProto = JSON.parse(
  '{"__proto__":{"checked":3,"lost":0,"changed":0,"displaced":0,"deleted":0}}'
)
check(
  'R2-1b userFiles supplying counts via __proto__ is refused',
  throws(() => mk({ userFiles: ufViaProto })),
  true
)
check(
  'R2-1b classify: own __proto__ in a hand-built precondition is never-ran',
  classifyRecord(rec({ precondition: protoTrue })),
  'never-ran'
)
check(
  'R2-1b classify: own __proto__ in hand-built userFiles is never-ran',
  classifyRecord(
    rec({
      userFiles: JSON.parse(
        '{"checked":3,"lost":0,"changed":0,"displaced":0,"deleted":0,"__proto__":0}'
      ),
    })
  ),
  'never-ran'
)
for (const key of ['constructor', 'prototype']) {
  check(
    'R2-1b precondition key ' + key + ' is refused',
    throws(() => mk({ precondition: { ...goodPre(), [key]: true } })),
    true
  )
  check(
    'R2-1b outcome key ' + key + ' is refused',
    throws(() => mk({ outcome: { status: 'kept', [key]: 'x' } })),
    true
  )
}
check(
  'R2-1b positive control: an ordinary extra key is fine',
  classifyRecord(mk({ precondition: { ...goodPre(), protoX: true } })),
  'passed'
)

// --- R2-1c: lost/changed are not coerced for C4 cells ---------------------------
const noLost = mk({ userFiles: { checked: 2, changed: 0, displaced: 0, deleted: 0 } })
check('R2-1c absent lost is never-ran, not coerced to 0', classifyRecord(noLost), 'never-ran')
check(
  'R2-1c absent lost is not invented on the record',
  'lost' in noLost.userFiles && noLost.userFiles.lost !== undefined,
  false
)
check(
  'R2-1c lost null is never-ran',
  classifyRecord(mk({ userFiles: { ...goodUf(), lost: null } })),
  'never-ran'
)
check(
  'R2-1c changed null is never-ran',
  classifyRecord(mk({ userFiles: { ...goodUf(), changed: null } })),
  'never-ran'
)
check(
  'R2-1c lost undefined is never-ran',
  classifyRecord(mk({ userFiles: { ...goodUf(), lost: undefined } })),
  'never-ran'
)
check(
  'R2-1c absent changed is never-ran',
  classifyRecord(mk({ userFiles: { checked: 2, lost: 0, displaced: 0, deleted: 0 } })),
  'never-ran'
)
check(
  'R2-1c the same record persisted and re-read agrees',
  classifyRecord(roundTrip(noLost)),
  'never-ran'
)
check(
  'R2-1c positive control: explicit zeros pass',
  classifyRecord(mk({ userFiles: { checked: 2, lost: 0, changed: 0, displaced: 0, deleted: 0 } })),
  'passed'
)
check(
  'R2-1c legacy cells keep the ?? 0 default',
  makeRecord({
    cell: legacyCell,
    run: 0,
    precondition: { hookFired: true },
    outcome: { status: 'kept' },
    userFiles: { checked: 1 },
  }).userFiles.lost,
  0
)

rmSync(tmp, { recursive: true, force: true })
finish()
