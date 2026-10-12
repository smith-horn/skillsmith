// C4 gate self-test (SMI-6715): control-spec rows, F3 gate, F4 makeRecord, F5 scoring.
// Shared fixtures: c4-selftest-helpers.mjs.

import { makeRecord, classifyRecord, aggregateCell } from './result-schema.mjs'
import { resolveControl, isProbabilistic, CONTROL_SPEC } from './control-spec.mjs'
import { isC4Cell } from './result-schema.c4.mjs'
import { check, finish, C4CELL, goodPre, rec, legacyCell, UfInst } from './c4-selftest-helpers.mjs'

// control-spec rows for C4.
const row = (attack, candidate, failed, variant = 'v') => ({
  attack,
  candidate,
  variant,
  fs: 'f',
  failed,
})
for (const a of ['A3-C4', 'A4-C4', 'A7-C4', 'A8-C4', 'A10-C4', 'A1-C4', 'A2-C4', 'A13-C4']) {
  check(
    a + ' control cell is is-control',
    resolveControl(row(a, 'C4-naive', 5), []).state,
    'is-control'
  )
  check(
    a + ' C4 cell satisfied by failing C4-naive',
    resolveControl(row(a, 'C4', 0), [row(a, 'C4-naive', 5)]).state,
    'satisfied'
  )
  check(
    a + ' C4 cell: control that never failed',
    resolveControl(row(a, 'C4', 0), [row(a, 'C4-naive', 0)]).state,
    'did-not-fail'
  )
  check(a + ' C4 cell: control absent', resolveControl(row(a, 'C4', 0), []).state, 'absent')
  check(
    a + ' control must match the variant exactly',
    resolveControl(row(a, 'C4', 0, 'v1'), [row(a, 'C4-naive', 5, 'v2')]).state,
    'absent'
  )
}
for (const a of ['A8a-C4', 'A10b-C4', 'A13-C4-OOM']) {
  check(a + ' has kind none (not unspecified)', resolveControl(row(a, 'C4', 0), []).state, 'none')
}
check('A13-C4 is probabilistic (R6)', isProbabilistic('A13-C4'), true)
check('A13-C4-OOM is deliberately not probabilistic', isProbabilistic('A13-C4-OOM'), false)
const aggC4 = aggregateCell(
  [rec({ outcome: { status: 'kept' } }), rec({ outcome: { status: 'kept' } })],
  () => false,
  { target: 2, controlFailed: true }
)
check('aggregateCell derives C4 classification: clean C4 cell', aggC4.verdict, 'PASS')

// --- F3: the C4 gate must not widen onto legacy attacks or candidates -------
const LEGACY_CANDIDATES = [
  'V0',
  'V1',
  'V2',
  'C0',
  'c0',
  'v0',
  'v1',
  'v2',
  'baseline',
  'ud24Only',
  'ud25WalkStart',
  'control-continues-past-errors',
]
const specKeys = Object.keys(CONTROL_SPEC)
const legacyKeys = specKeys.filter((k) => !k.endsWith('-C4') && !k.endsWith('-C4-OOM'))
const c4Keys = specKeys.filter((k) => k.endsWith('-C4') || k.endsWith('-C4-OOM'))
check(
  'F3 precondition: enumerated legacy attack keys (denominator > 15)',
  legacyKeys.length > 15,
  true
)
check('F3 precondition: enumerated C4 attack keys (denominator >= 11)', c4Keys.length >= 11, true)
let f3Wrong = []
for (const k of legacyKeys)
  for (const c of LEGACY_CANDIDATES)
    if (isC4Cell({ attack: k, candidate: c })) f3Wrong.push(k + '/' + c)
check(
  'F3 no legacy attack x legacy candidate is C4 (' +
    legacyKeys.length * LEGACY_CANDIDATES.length +
    ' pairs; wrongly matched: ' +
    f3Wrong.slice(0, 5).join(',') +
    ')',
  f3Wrong.length,
  0
)
let f3Missed = []
for (const k of c4Keys)
  for (const c of LEGACY_CANDIDATES)
    if (!isC4Cell({ attack: k, candidate: c })) f3Missed.push(k + '/' + c)
check(
  'F3 positive control: every -C4 / -C4-OOM attack is C4 whatever the candidate',
  f3Missed.length,
  0
)
check('F3 candidate C4 gates alone', isC4Cell({ attack: 'A3', candidate: 'C4' }), true)
check('F3 no cell is not C4', isC4Cell(undefined), false)

// --- F4: makeRecord must not launder non-plain shapes (C4 cells) ------------
const mkThrows = (pre, uf) => {
  try {
    makeRecord({
      cell: C4CELL,
      run: 0,
      precondition: pre,
      outcome: { status: 'kept' },
      userFiles: uf ?? { checked: 2 },
    })
    return false
  } catch (e) {
    return e instanceof TypeError
  }
}
const nonEnum = goodPre()
Object.defineProperty(nonEnum, 'extra', { value: false, enumerable: false })
const inh = Object.assign(Object.create({ extra: false }), goodPre())
class ProtoGetter {
  get extra() {
    return false
  }
}
const protoGetter = Object.assign(new ProtoGetter(), goodPre())
const proxyAcc = new Proxy(goodPre(), {
  ownKeys: (t) => [...Reflect.ownKeys(t), 'extra'],
  getOwnPropertyDescriptor: (t, k) =>
    k === 'extra'
      ? { get: () => false, enumerable: true, configurable: true }
      : Reflect.getOwnPropertyDescriptor(t, k),
})
const proxyHidden = new Proxy(goodPre(), {
  ownKeys: (t) => [...Reflect.ownKeys(t), 'extra'],
  getOwnPropertyDescriptor: (t, k) =>
    k === 'extra'
      ? { value: false, enumerable: false, configurable: true }
      : Reflect.getOwnPropertyDescriptor(t, k),
})
const symPre = goodPre()
symPre[Symbol('s')] = false
const ufGetter = { checked: 3, changed: 0 }
Object.defineProperty(ufGetter, 'lost', { get: () => 0, enumerable: true })
for (const [label, v] of [
  ['non-enumerable false extra', nonEnum],
  ['inherited false extra', inh],
  ['prototype-getter false extra', protoGetter],
  ['Proxy accessor descriptor', proxyAcc],
  ['Proxy non-enumerable descriptor', proxyHidden],
  ['symbol-keyed false extra', symPre],
]) {
  check('F4 makeRecord throws on precondition: ' + label, mkThrows(v), true)
}
check('F4 makeRecord throws on userFiles own getter on lost', mkThrows(goodPre(), ufGetter), true)
check('F4 makeRecord throws on userFiles class instance', mkThrows(goodPre(), new UfInst()), true)
check(
  'F4 makeRecord throws on a non-object-prototype userFiles',
  mkThrows(goodPre(), Object.create({ checked: 3 })),
  true
)
check(
  'F4 positive control: plain shapes do not throw',
  mkThrows(goodPre(), { checked: 3, lost: 0, changed: 0 }),
  false
)
check(
  'F4 positive control: null-prototype precondition does not throw',
  mkThrows(Object.assign(Object.create(null), goodPre())),
  false
)
const proxyFalseData = new Proxy(goodPre(), {
  ownKeys: (t) => [...Reflect.ownKeys(t), 'extra'],
  getOwnPropertyDescriptor: (t, k) =>
    k === 'extra'
      ? { value: false, enumerable: true, configurable: true }
      : Reflect.getOwnPropertyDescriptor(t, k),
  get: (t, k) => (k === 'extra' ? undefined : t[k]),
})
const viaProxy = makeRecord({
  cell: C4CELL,
  run: 0,
  precondition: proxyFalseData,
  outcome: { status: 'kept' },
  userFiles: { checked: 2 },
})
check(
  'F4 Proxy hiding a false behind [[Get]] is still never-ran via makeRecord',
  classifyRecord(viaProxy),
  'never-ran'
)
// legacy cells keep their old makeRecord behaviour (no throw).
check(
  'F4 legacy cell with a non-plain precondition still does not throw',
  (() => {
    try {
      makeRecord({
        cell: legacyCell,
        run: 0,
        precondition: nonEnum,
        outcome: { status: 'kept' },
        userFiles: { checked: 1 },
      })
      return false
    } catch {
      return true
    }
  })(),
  false
)

// --- F5: score from the values that were validated (one read) ---------------
const ufProxy = (descLost, getLost) =>
  new Proxy(
    { checked: 3, lost: descLost, changed: 0 },
    { get: (t, k) => (k === 'lost' ? getLost : t[k]) }
  )
check(
  'F5 descriptor says 0, [[Get]] says 1: scored from the validated 0',
  classifyRecord(rec({ userFiles: ufProxy(0, 1) })),
  'passed'
)
check(
  'F5 descriptor says 1, [[Get]] says 0: scored from the validated 1',
  classifyRecord(rec({ userFiles: ufProxy(1, 0) })),
  'failed'
)
check('F5 control: the Proxy really lies through [[Get]]', ufProxy(0, 1).lost, 1)
check('F5 control: the Proxy really lies through [[Get]] (other way)', ufProxy(1, 0).lost, 0)

finish()
