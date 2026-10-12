// C4 record-shape self-test (SMI-6715): S1-S5 shape attacks and makeRecord.
// Shared fixtures: c4-selftest-helpers.mjs.

import { makeRecord, classifyRecord } from './result-schema.mjs'
import {
  check,
  finish,
  C4CELL,
  goodPre,
  goodUf,
  rec,
  legacyCell,
  UfInst,
} from './c4-selftest-helpers.mjs'

// SHAPE attacks. INHERITED PROPERTIES: the legacy filter (Object.entries) skips
// them, so an inherited false is silently ignored -- a measured fail-open on a
// non-C4 record, pinned here so the contrast stays visible. For C4 an inherited
// key is never trusted in either direction.
const inheritedFalse = Object.create({ hookFired: false })
check(
  'S1 legacy fail-open: inherited false is skipped (passed)',
  classifyRecord(rec({ cell: legacyCell, precondition: inheritedFalse })),
  'passed'
)
check(
  'S1 C4: inherited false is never-ran',
  classifyRecord(rec({ precondition: Object.create({ ...goodPre(), hookFired: false }) })),
  'never-ran'
)
check(
  'S1 C4: inherited TRUE does not count as held',
  classifyRecord(
    rec({
      precondition: Object.create({ hookFired: true, mutationApplied: true, traceMatched: true }),
    })
  ),
  'never-ran'
)
const mixed = Object.create({ traceMatched: true })
Object.assign(mixed, { hookFired: true, mutationApplied: true })
check(
  'S1 C4: one required key only inherited is never-ran',
  classifyRecord(rec({ precondition: mixed })),
  'never-ran'
)
// The case that makes the prototype check load-bearing: every REQUIRED key is
// an own true, but an EXTRA inherited key is false. Reflect.ownKeys cannot see
// it; only the plain-object check can.
const ownAllTrueInheritedFalse = Object.assign(Object.create({ reuseObserved: false }), goodPre())
check(
  'S1 legacy: own-true + inherited-extra-false passes (blind)',
  classifyRecord(rec({ cell: legacyCell, precondition: ownAllTrueInheritedFalse })),
  'passed'
)
check(
  'S1 C4: own-true + inherited-extra-false is never-ran',
  classifyRecord(rec({ precondition: ownAllTrueInheritedFalse })),
  'never-ran'
)
check(
  'S1 C4 positive control: same keys, plain object, passes',
  classifyRecord(rec({ precondition: { ...goodPre(), reuseObserved: true } })),
  'passed'
)
class PreInst {
  constructor() {
    this.hookFired = true
    this.mutationApplied = true
  }
  get traceMatched() {
    return true
  }
}
check(
  'S2 C4: class instance with a getter is never-ran',
  classifyRecord(rec({ precondition: new PreInst() })),
  'never-ran'
)
const acc = { hookFired: true, mutationApplied: true }
Object.defineProperty(acc, 'traceMatched', { enumerable: true, get: () => true })
check(
  'S2 C4: plain object with an accessor is never-ran',
  classifyRecord(rec({ precondition: acc })),
  'never-ran'
)
let reads = 0
const flip = { hookFired: true, mutationApplied: true }
Object.defineProperty(flip, 'traceMatched', { enumerable: true, get: () => reads++ === 0 })
check(
  'S2 C4: a getter that lies on later reads is never-ran',
  classifyRecord(rec({ precondition: flip })),
  'never-ran'
)
const hiddenFalse = goodPre()
Object.defineProperty(hiddenFalse, 'reuseObserved', { value: false, enumerable: false })
check(
  'S3 legacy: non-enumerable false is skipped (passed)',
  classifyRecord(rec({ cell: legacyCell, precondition: hiddenFalse })),
  'passed'
)
check(
  'S3 C4: non-enumerable false is never-ran',
  classifyRecord(rec({ precondition: hiddenFalse })),
  'never-ran'
)
const hiddenTrue = { hookFired: true, mutationApplied: true }
Object.defineProperty(hiddenTrue, 'traceMatched', { value: true, enumerable: false })
check(
  'S3 C4: required key only non-enumerable is never-ran',
  classifyRecord(rec({ precondition: hiddenTrue })),
  'never-ran'
)
const symKey = goodPre()
symKey[Symbol('x')] = false
check(
  'S3 C4: a symbol-keyed false is never-ran',
  classifyRecord(rec({ precondition: symKey })),
  'never-ran'
)
check(
  'S4 C4: null-prototype precondition is accepted',
  classifyRecord(rec({ precondition: Object.assign(Object.create(null), goodPre()) })),
  'passed'
)
check(
  'S4 C4: non-object precondition is never-ran',
  classifyRecord(rec({ precondition: 'true' })),
  'never-ran'
)
check(
  'S4 C4: missing precondition is never-ran',
  classifyRecord({ cell: C4CELL, outcome: { status: 'kept' }, userFiles: goodUf() }),
  'never-ran'
)
check(
  'S5 C4: userFiles via Object.create is never-ran',
  classifyRecord(rec({ userFiles: Object.create({ checked: 3, lost: 0, changed: 0 }) })),
  'never-ran'
)
check(
  'S5 C4: userFiles class instance with a getter is never-ran',
  classifyRecord(rec({ userFiles: new UfInst() })),
  'never-ran'
)
const ufHidden = { checked: 3, changed: 0 }
Object.defineProperty(ufHidden, 'lost', { value: 0, enumerable: false })
check(
  'S5 C4: non-enumerable lost is never-ran',
  classifyRecord(rec({ userFiles: ufHidden })),
  'never-ran'
)

// makeRecord, C4: no null defaults, displaced/deleted survive, legacy untouched.
const mk = makeRecord({
  cell: C4CELL,
  run: 0,
  precondition: goodPre(),
  outcome: { status: 'quarantined' },
  userFiles: { checked: 3, lost: 1, changed: 0, displaced: 1, deleted: 0 },
})
check('M1 C4 record has no reuseObserved default', 'reuseObserved' in mk.precondition, false)
check('M1 displaced carried', mk.userFiles.displaced, 1)
check('M1 deleted carried', mk.userFiles.deleted, 0)
check('M1 classifies failed (displacement)', classifyRecord(mk), 'failed')
const mkOk = makeRecord({
  cell: C4CELL,
  run: 0,
  precondition: goodPre(),
  outcome: { status: 'kept' },
  userFiles: { checked: 2 },
})
check('M2 C4 record built by makeRecord passes', classifyRecord(mkOk), 'passed')
check('M2 no displaced key invented', 'displaced' in mkOk.userFiles, false)
const mkBad = makeRecord({
  cell: C4CELL,
  run: 0,
  precondition: { hookFired: true, mutationApplied: true, traceMatched: null },
  outcome: { status: 'kept' },
  userFiles: { checked: 2 },
})
check('M3 null traceMatched through makeRecord is never-ran', classifyRecord(mkBad), 'never-ran')
const mkDisp = makeRecord({
  cell: C4CELL,
  run: 0,
  precondition: goodPre(),
  outcome: { status: 'kept' },
  userFiles: { checked: 2, lost: 1, displaced: '1', deleted: 0 },
})
check(
  'M4 uncoerced bad displaced reaches classify as never-ran',
  classifyRecord(mkDisp),
  'never-ran'
)
check(
  'M5 legacy record keeps reuseObserved null default',
  makeRecord({
    cell: legacyCell,
    run: 0,
    precondition: { hookFired: true },
    outcome: { status: 'kept' },
    userFiles: { checked: 1 },
  }).precondition.reuseObserved,
  null
)

finish()
