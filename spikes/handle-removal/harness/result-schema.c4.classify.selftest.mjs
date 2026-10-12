// C4 classifyRecord self-test (SMI-6715): clauses K1-K7.
// Shared fixtures: c4-selftest-helpers.mjs.

import { classifyRecord } from './result-schema.mjs'
import { check, finish, goodPre, rec, legacyCell } from './c4-selftest-helpers.mjs'

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
      rec({
        outcome: { status: st },
        userFiles: { checked: 3, lost: 1, changed: 0, displaced: 1, deleted: 0 },
      })
    ),
    'failed'
  )
}
check(
  'K2 changed bytes fail',
  classifyRecord(rec({ userFiles: { checked: 3, lost: 0, changed: 1, displaced: 0, deleted: 0 } })),
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
    'K4 controlExpected=' + String(ce) + ' is never-ran (SMI-6715 Sol F6b: strict true required)',
    classifyRecord(rec({ precondition: { ...goodPre(), controlExpected: ce } })),
    'never-ran'
  )
}
{
  const noCe = goodPre()
  delete noCe.controlExpected
  check(
    'K4 controlExpected absent is never-ran',
    classifyRecord(rec({ precondition: noCe })),
    'never-ran'
  )
  check('K4 controlExpected strictly true is the positive control', classifyRecord(rec()), 'passed')
  const ceInherited = Object.assign(Object.create({ controlExpected: true }), {
    hookFired: true,
    mutationApplied: true,
    traceMatched: true,
  })
  check(
    'K4 controlExpected only inherited is never-ran',
    classifyRecord(rec({ precondition: ceInherited })),
    'never-ran'
  )
  const ceHidden = { hookFired: true, mutationApplied: true, traceMatched: true }
  Object.defineProperty(ceHidden, 'controlExpected', { value: true, enumerable: false })
  check(
    'K4 controlExpected non-enumerable is never-ran',
    classifyRecord(rec({ precondition: ceHidden })),
    'never-ran'
  )
}
// Gating: the SAME malformed shapes on a non-C4 record keep legacy behaviour.
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
  [
    'checked 0 (a verifier that checked nothing)',
    { checked: 0, lost: 0, changed: 0, displaced: 0, deleted: 0 },
  ],
  ['checked string', { checked: '3', lost: 0, changed: 0, displaced: 0, deleted: 0 }],
  ['lost string "0"', { checked: 3, lost: '0', changed: 0, displaced: 0, deleted: 0 }],
  ['changed string "0"', { checked: 3, lost: 0, changed: '0', displaced: 0, deleted: 0 }],
  ['lost negative', { checked: 3, lost: -1, changed: 0, displaced: 0, deleted: 0 }],
  ['lost fractional', { checked: 3, lost: 0.5, changed: 0, displaced: 0, deleted: 0 }],
  ['lost NaN', { checked: 3, lost: NaN, changed: 0, displaced: 0, deleted: 0 }],
  ['changed Infinity', { checked: 3, lost: 0, changed: Infinity, displaced: 0, deleted: 0 }],
  ['lost missing', { checked: 3, changed: 0, displaced: 0, deleted: 0 }],
  ['lost null', { checked: 3, lost: null, changed: 0, displaced: 0, deleted: 0 }],
  ['lost boolean', { checked: 3, lost: false, changed: 0, displaced: 0, deleted: 0 }],
]) {
  check('K6 ' + label + ' is never-ran', classifyRecord(rec({ userFiles: uf })), 'never-ran')
}
check(
  'K6 positive control: checked 1 is enough',
  classifyRecord(rec({ userFiles: { checked: 1, lost: 0, changed: 0, displaced: 0, deleted: 0 } })),
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
  'K7 displaced/deleted both absent is never-ran (a loss with no split proves nothing)',
  classifyRecord(rec({ userFiles: { checked: 3, lost: 1, changed: 0 } })),
  'never-ran'
)
check(
  'K7 both absent with lost 0 is never-ran too (required, not optional)',
  classifyRecord(rec({ userFiles: { checked: 3, lost: 0, changed: 0 } })),
  'never-ran'
)
check(
  'K7 deleted absent alone is never-ran',
  classifyRecord(rec({ userFiles: { checked: 3, lost: 0, changed: 0, displaced: 0 } })),
  'never-ran'
)
check(
  'K7 deleted null is never-ran',
  classifyRecord(
    rec({ userFiles: { checked: 3, lost: 0, changed: 0, displaced: 0, deleted: null } })
  ),
  'never-ran'
)
// lost + changed <= checked (Sol F6c)
const bound = (checked, lost, changed, displaced = lost, deleted = 0) =>
  rec({ userFiles: { checked, lost, changed, displaced, deleted } })
check(
  'K8 lost+changed == checked is failed (positive control)',
  classifyRecord(bound(2, 1, 1)),
  'failed'
)
check('K8 lost+changed < checked is failed', classifyRecord(bound(3, 1, 1)), 'failed')
check('K8 lost+changed > checked is never-ran', classifyRecord(bound(1, 1, 1)), 'never-ran')
check('K8 lost alone > checked is never-ran', classifyRecord(bound(1, 2, 0)), 'never-ran')
check('K8 changed alone > checked is never-ran', classifyRecord(bound(1, 0, 5)), 'never-ran')
check('K8 clean record at the bound passes', classifyRecord(bound(1, 0, 0)), 'passed')
check(
  'K7 split present with a loss is failed',
  classifyRecord(rec({ userFiles: { checked: 3, lost: 1, changed: 0, displaced: 1, deleted: 0 } })),
  'failed'
)

finish()
