// C4 self-test for result-schema.mjs / result-schema.c4.mjs (SMI-6715).
// Split from result-schema.selftest.mjs; same check() convention.

import {
  makeRecord,
  classifyRecord,
  aggregateCell,
  scanQuarantineLeftovers,
} from './result-schema.mjs'
import fs from 'node:fs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { quarantineTree, computePathTreeHash } from '../quarantine.mjs'
import { resolveControl, isProbabilistic, CONTROL_SPEC } from './control-spec.mjs'
import { isC4Cell } from './result-schema.c4.mjs'

let allOk = true
function check(label, actual, expected) {
  const ok = actual === expected
  allOk = allOk && ok
  console.log(
    `[result-schema c4 self-test] ${label}: expected ${expected}, got ${actual} -- ${ok ? 'PASS' : 'FAIL'}`
  )
}

// The V2 no-leak check needs a V2-shaped parent; build a tiny one here.
const qReal = mkdtempSync(path.join(tmpdir(), 's6715-selftest-v2-'))
mkdirSync(path.join(qReal, '.skillsmith-rm-beef', 'leftover'), { recursive: true })

// ---------------------------------------------------------------------------
// C4 (SMI-6715). Scan cases are built by EXECUTING quarantineTree on scratch
// fixtures; classify cases attack the record SHAPE. Every negative has a
// positive control beside it.
// ---------------------------------------------------------------------------
const cTmp = mkdtempSync(path.join(tmpdir(), 's6715-selftest-c4-'))
function c4Fixture() {
  const root = mkdtempSync(path.join(cTmp, 'fx-'))
  mkdirSync(path.join(root, 'tree', 'sub'), { recursive: true })
  writeFileSync(path.join(root, 'tree', 'sub', 'f.txt'), 'x')
  return root
}
// kept AFTER the op dir exists: swap the tree at the 3rd lstat of the origin
// (bind, hash-root-visit, re-check), so the identity re-check refuses.
function keptAfterMkdir(root, opId) {
  const origin = path.join(root, 'tree')
  const guardHash = computePathTreeHash(origin).treeHash
  const real = fs.lstatSync
  let n = 0
  fs.lstatSync = function (p, ...a) {
    if (p === origin && ++n === 3) {
      real.call(fs, p)
      fs.renameSync(origin, origin + '.aside')
      fs.mkdirSync(origin)
    }
    return real.call(fs, p, ...a)
  }
  try {
    return quarantineTree(root, 'tree', { guardHash, opId })
  } finally {
    fs.lstatSync = real
  }
}

// C1 quarantined: the op dir's contents are EXPECTED, not leftovers.
const c1root = c4Fixture()
const c1res = quarantineTree(c1root, 'tree', {
  guardHash: computePathTreeHash(path.join(c1root, 'tree')).treeHash,
  opId: 'opq',
})
check('C1 precondition: really quarantined', c1res.status, 'quarantined')
const c1 = scanQuarantineLeftovers(c1root, 'C4', { status: 'quarantined', opId: 'opq' })
check('C1 expected present', c1.expected.present, true)
check('C1 expected = tree entry + sidecar', c1.expected.entries, 2)
check('C1 expected path', c1.expected.path, '.skillsmith-trash/opq')
check('C1 expected excluded from dirs', c1.dirs, 0)
check('C1 expected excluded from entries', c1.entries, 0)
check('C1 no litter', c1.litter, 0)
check('C1 no scan error', c1.scanError, null)
// C1b negative: the SAME disk read as a kept outcome is NOT expected -> counted.
const c1b = scanQuarantineLeftovers(c1root, 'C4-naive', { status: 'kept', opId: 'opq' })
check('C1b same dir under status kept is counted (dirs)', c1b.dirs, 1)
check('C1b same dir under status kept is counted (entries)', c1b.entries, 2)
check('C1b expected not claimed under kept', c1b.expected.present, false)
// C1c: an unexpected sibling op dir next to the expected one still counts.
mkdirSync(path.join(c1root, '.skillsmith-trash', 'other-op', 'stranded'), { recursive: true })
const c1c = scanQuarantineLeftovers(c1root, 'C4', { status: 'quarantined', opId: 'opq' })
check('C1c sibling op dir counted', c1c.dirs, 1)
check('C1c sibling entry counted', c1c.entries, 1)
check('C1c expected still reported', c1c.expected.entries, 2)
check('C1c sibling path named', c1c.paths[0], '.skillsmith-trash/other-op/stranded')
// C1d: a V2-style leftover beside a C4 trash root counts too.
mkdirSync(path.join(c1root, '.skillsmith-rm-zz', 'left'), { recursive: true })
const c1d = scanQuarantineLeftovers(c1root, 'C4', { status: 'quarantined', opId: 'opq' })
check('C1d .skillsmith-rm-* beside trash counted', c1d.dirs, 2)
// C1e: a stray FILE directly in the trash root counts.
writeFileSync(path.join(c1root, '.skillsmith-trash', 'stray.txt'), 'x')
const c1e = scanQuarantineLeftovers(c1root, 'C4', { status: 'quarantined', opId: 'opq' })
check('C1e stray trash-root file counted', c1e.entries, c1d.entries + 1)

// C2 kept after mkdir: the empty op dir is LITTER, not entries.
const c2root = c4Fixture()
const c2res = keptAfterMkdir(c2root, 'opk')
check('C2 precondition: really kept after mkdir', c2res.status, 'kept')
check(
  'C2 precondition: op dir exists and is empty',
  fs.readdirSync(path.join(c2root, '.skillsmith-trash', 'opk')).length,
  0
)
const c2 = scanQuarantineLeftovers(c2root, 'C4', { status: 'kept', opId: 'opk' })
check('C2 litter counted', c2.litter, 1)
check('C2 litter not in dirs', c2.dirs, 0)
check('C2 litter not in entries', c2.entries, 0)
check('C2 nothing expected', c2.expected.present, false)
// C2b negative: litter must NOT be hidden when the opId is a different one.
const c2b = scanQuarantineLeftovers(c2root, 'C4', { status: 'kept', opId: 'not-it' })
check('C2b empty op dir under another opId is counted as a dir', c2b.dirs, 1)
check('C2b no litter claimed for another opId', c2b.litter, 0)

// C3 kept before mkdir: nothing on disk -> a real zero, with expected absent.
const c3root = c4Fixture()
const c3res = quarantineTree(c3root, 'tree', { guardHash: 'bad', opId: 'opw' })
check('C3 precondition: kept', c3res.status, 'kept')
const c3 = scanQuarantineLeftovers(c3root, 'C4', { status: 'kept', opId: 'opw' })
check('C3 real zero dirs', c3.dirs, 0)
check('C3 real zero litter', c3.litter, 0)
check('C3 expected absent', c3.expected.present, false)
// C3b: quarantined outcome but nothing on disk -> expected.present false (the
// scan does not invent the move).
const c3b = scanQuarantineLeftovers(c3root, 'C4', { status: 'quarantined', opId: 'opw' })
check('C3b quarantined claimed but nothing on disk', c3b.expected.present, false)

// C4 cannot-run cases report nulls, never 0.
for (const [label, opts] of [
  ['no options', undefined],
  ['no status', { opId: 'x' }],
  ['bad status', { status: 'removed', opId: 'x' }],
  ['no opId', { status: 'kept' }],
  ['opId with slash', { status: 'kept', opId: 'a/b' }],
  ['opId ..', { status: 'kept', opId: '..' }],
]) {
  const r = scanQuarantineLeftovers(c3root, 'C4', opts)
  check('C4 ' + label + ': dirs null', r.dirs, null)
  check('C4 ' + label + ': entries null', r.entries, null)
  check('C4 ' + label + ': litter null', r.litter, null)
  check('C4 ' + label + ': scanError set', typeof r.scanError, 'string')
}
const cMissing = scanQuarantineLeftovers(path.join(cTmp, 'nope'), 'C4', {
  status: 'kept',
  opId: 'x',
})
check('C4 missing parent: null not 0', cMissing.dirs, null)
check('C4 missing parent: ENOENT', cMissing.scanError, 'ENOENT')
// V2 / V0 behaviour unchanged: no C4 fields leak into them.
check('V2 result has no expected field', 'expected' in scanQuarantineLeftovers(qReal, 'V2'), false)
check('V0 stays n/a', scanQuarantineLeftovers(c1root, 'V0').scanError, 'n/a:no-quarantine-in-V0')

// --- classifyRecord, C4 --------------------------------------------------
const C4CELL = { attack: 'A3-C4', variant: 'x/after-bind', candidate: 'C4', fs: 'f', runner: 't' }
const goodPre = () => ({
  hookFired: true,
  mutationApplied: true,
  traceMatched: true,
  controlExpected: true,
})
const goodUf = () => ({ checked: 3, lost: 0, changed: 0 })
const rec = (o = {}) => ({
  cell: o.cell ?? C4CELL,
  precondition: o.precondition ?? goodPre(),
  outcome: o.outcome ?? { status: 'quarantined' },
  userFiles: o.userFiles ?? goodUf(),
})
check('K1 baseline C4 record passes', classifyRecord(rec()), 'passed')
for (const st of ['quarantined', 'kept', 'stopped']) {
  check(
    'K2 status ' + st + ' with bytes intact passes',
    classifyRecord(rec({ outcome: { status: st } })),
    'passed'
  )
  check(
    'K2 status ' + st + ' with a lost byte fails',
    classifyRecord(
      rec({ outcome: { status: st }, userFiles: { checked: 3, lost: 1, changed: 0 } })
    ),
    'failed'
  )
}
check(
  'K2 changed bytes fail',
  classifyRecord(rec({ userFiles: { checked: 3, lost: 0, changed: 1 } })),
  'failed'
)
check(
  'K2 harness-error is never-ran',
  classifyRecord(rec({ outcome: { status: 'harness-error' } })),
  'never-ran'
)
for (const st of ['removed', 'ok', '', undefined, null, 'Quarantined']) {
  check(
    'K3 status ' + JSON.stringify(st) + ' is never-ran, no crash',
    classifyRecord(rec({ outcome: { status: st } })),
    'never-ran'
  )
}
for (const key of ['hookFired', 'mutationApplied', 'traceMatched']) {
  for (const bad of [false, null, undefined, 'true', 1, 0, {}]) {
    const pre = goodPre()
    pre[key] = bad
    check(
      'K4 ' + key + '=' + String(bad) + ' is never-ran',
      classifyRecord(rec({ precondition: pre })),
      'never-ran'
    )
  }
  const missing = goodPre()
  delete missing[key]
  check(
    'K4 ' + key + ' absent is never-ran',
    classifyRecord(rec({ precondition: missing })),
    'never-ran'
  )
}
check(
  'K4 an extra non-true key is never-ran',
  classifyRecord(rec({ precondition: { ...goodPre(), extra: null } })),
  'never-ran'
)
check(
  'K4 an extra true key is fine',
  classifyRecord(rec({ precondition: { ...goodPre(), extra: true } })),
  'passed'
)
for (const ce of [false, null, undefined, 'x']) {
  check(
    'K4 controlExpected=' + String(ce) + ' is exempt',
    classifyRecord(rec({ precondition: { ...goodPre(), controlExpected: ce } })),
    'passed'
  )
}
// Gating: the SAME malformed shapes on a non-C4 record keep legacy behaviour.
const legacyCell = { attack: 'A3', candidate: 'baseline', fs: 'f', runner: 't' }
check(
  'K5 legacy: null precondition value is not a never-ran',
  classifyRecord(rec({ cell: legacyCell, precondition: { hookFired: null } })),
  'passed'
)
check(
  'K5 legacy: unknown status is not a never-ran',
  classifyRecord(rec({ cell: legacyCell, outcome: { status: 'removed' } })),
  'passed'
)
check(
  'K5 legacy: checked 0 is not a never-ran',
  classifyRecord(rec({ cell: legacyCell, userFiles: { checked: 0, lost: 0, changed: 0 } })),
  'passed'
)
// Gate by attack label alone, and by candidate alone.
check(
  'K5 attack-label gate (-C4)',
  classifyRecord(
    rec({
      cell: { attack: 'A9-C4', candidate: 'x' },
      precondition: { hookFired: null, traceMatched: true, mutationApplied: true },
    })
  ),
  'never-ran'
)
check(
  'K5 attack-label gate (-C4-OOM)',
  classifyRecord(
    rec({
      cell: { attack: 'A13-C4-OOM', candidate: 'x' },
      precondition: { hookFired: null, traceMatched: true, mutationApplied: true },
    })
  ),
  'never-ran'
)
check(
  'K5 candidate gate (C4-naive)',
  classifyRecord(
    rec({
      cell: { attack: 'A3', candidate: 'C4-naive' },
      precondition: { hookFired: null, traceMatched: true, mutationApplied: true },
    })
  ),
  'never-ran'
)

// userFiles counts.
for (const [label, uf] of [
  ['checked 0 (a verifier that checked nothing)', { checked: 0, lost: 0, changed: 0 }],
  ['checked string', { checked: '3', lost: 0, changed: 0 }],
  ['lost string "0"', { checked: 3, lost: '0', changed: 0 }],
  ['changed string "0"', { checked: 3, lost: 0, changed: '0' }],
  ['lost negative', { checked: 3, lost: -1, changed: 0 }],
  ['lost fractional', { checked: 3, lost: 0.5, changed: 0 }],
  ['lost NaN', { checked: 3, lost: NaN, changed: 0 }],
  ['changed Infinity', { checked: 3, lost: 0, changed: Infinity }],
  ['lost missing', { checked: 3, changed: 0 }],
  ['lost null', { checked: 3, lost: null, changed: 0 }],
  ['lost boolean', { checked: 3, lost: false, changed: 0 }],
]) {
  check('K6 ' + label + ' is never-ran', classifyRecord(rec({ userFiles: uf })), 'never-ran')
}
check(
  'K6 positive control: checked 1 is enough',
  classifyRecord(rec({ userFiles: { checked: 1, lost: 0, changed: 0 } })),
  'passed'
)
// displaced / deleted.
const dd = (d, x, lost) =>
  rec({ userFiles: { checked: 3, lost, changed: 0, displaced: d, deleted: x } })
check(
  'K7 displaced+deleted === lost, failed (displacement is failure)',
  classifyRecord(dd(1, 0, 1)),
  'failed'
)
check('K7 split across displaced/deleted still failed', classifyRecord(dd(1, 1, 2)), 'failed')
check('K7 zero/zero with lost 0 passes', classifyRecord(dd(0, 0, 0)), 'passed')
check('K7 sum below lost is never-ran', classifyRecord(dd(1, 0, 2)), 'never-ran')
check('K7 sum above lost is never-ran', classifyRecord(dd(2, 1, 1)), 'never-ran')
check(
  'K7 displaced alone is never-ran',
  classifyRecord(rec({ userFiles: { checked: 3, lost: 1, changed: 0, displaced: 1 } })),
  'never-ran'
)
check('K7 displaced string is never-ran', classifyRecord(dd('1', 0, 1)), 'never-ran')
check('K7 deleted negative is never-ran', classifyRecord(dd(2, -1, 1)), 'never-ran')
check(
  'K7 absent displaced/deleted is allowed',
  classifyRecord(rec({ userFiles: { checked: 3, lost: 1, changed: 0 } })),
  'failed'
)

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
class UfInst {
  constructor() {
    this.checked = 3
    this.changed = 0
  }
  get lost() {
    return 0
  }
}
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

// (cTmp removed at the end)
rmSync(cTmp, { recursive: true, force: true })

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

rmSync(qReal, { recursive: true, force: true })
if (!allOk) {
  console.error('[result-schema c4 self-test] FAIL')
  process.exit(1)
}
console.log('[result-schema c4 self-test] all cases passed')
process.exit(0)
