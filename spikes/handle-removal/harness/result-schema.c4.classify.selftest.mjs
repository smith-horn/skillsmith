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

finish()
