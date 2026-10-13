// SMI-6715 Step 1b (design §8 R-b, §9 status plumbing): a C4 record whose
// outcome is `held` is a known, scorable status -- and a held run with one
// changed file scores FAILED, never passed and never never-ran.
//
// DECLARED FAILURE ON THE PRE-REPAIR SCHEMA: 'held' is not in C4_STATUSES, so
// c4Validate returns null and both R-b1 and R-b2 classify 'never-ran'; R-b3
// reports C4_KNOWN_STATUSES without 'held'.
//
// R-b's design mutation (drop `changed === 0` from the held predicate) needs
// the held predicate, which is part 2 of Step 1b; see the hand-back.

import { classifyRecord } from './result-schema.mjs'
import { C4_KNOWN_STATUSES } from './result-schema.c4.mjs'
import { check, finish, rec } from './c4-selftest-helpers.mjs'

check(
  'R-b1 a held record with one changed file fails',
  classifyRecord(
    rec({
      outcome: { status: 'held' },
      userFiles: { checked: 3, lost: 0, changed: 1, displaced: 0, deleted: 0 },
    })
  ),
  'failed'
)
check(
  'R-b2 a held record with a lost file fails',
  classifyRecord(
    rec({
      outcome: { status: 'held' },
      userFiles: { checked: 3, lost: 1, changed: 0, displaced: 1, deleted: 0 },
    })
  ),
  'failed'
)
check('R-b3 held is a known C4 status (not a tally fault)', C4_KNOWN_STATUSES.has('held'), true)
check(
  'R-b4 an unknown status is still never-ran (control)',
  classifyRecord(rec({ outcome: { status: 'helds' } })),
  'never-ran'
)
finish()
