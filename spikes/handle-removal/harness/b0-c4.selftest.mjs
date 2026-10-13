// SMI-6715 Step 1b part 2, item 5: B0-C4, the no-attack baseline.
//
// Guarded C4 on an UNTOUCHED tree must end `quarantined` every time. Any other
// outcome is a false positive of the repair (a false `held` from the post-move
// identity or re-hash check, a false `kept/mount-inside-tree` from the st_dev or
// mountinfo check) and FAILS the cell, whatever the user-file bytes say: a held
// tree is safe, but a removal that holds every clean tree is useless.
//
// DECLARED FAILURE ON THE PRE-CHANGE HARNESS: classifyRecord has no baseline
// rule, so B1-B3 (held / kept / stopped with intact bytes) read 'held' or
// 'passed' instead of 'failed', and B5's 29 quarantined + 1 held cell reads a
// PASS instead of FAIL. The module (B6-) does not exist: its import is caught
// and reported as a FAIL line, so the classify cases still report.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyRecord, aggregateCell } from './result-schema.mjs'
import { resolveHarnessRoot } from './fixture-root.mjs'

const TAG = '[b0-c4 self-test]'
let allOk = true
function check(label, actual, expected) {
  const ok = actual === expected
  allOk = allOk && ok
  console.log(
    `${TAG} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} -- ${ok ? 'PASS' : 'FAIL'}`
  )
}

const CELL = {
  attack: 'B0-C4',
  variant: 'untouched',
  candidate: 'C4',
  fs: 'f',
  runner: 't',
  target: 30,
}
const pre = { hookFired: true, mutationApplied: true, traceMatched: true, controlExpected: true }
const uf = { checked: 2, lost: 0, changed: 0, displaced: 0, deleted: 0 }
const ev = {
  location: 'held-copy',
  sidecarVerified: true,
  originRecreated: false,
  originIntact: null,
}
const rec = (status, extra = {}) => ({
  cell: CELL,
  precondition: pre,
  outcome: { status, ...extra },
  userFiles: uf,
})

check('B0 a clean quarantined baseline run passes', classifyRecord(rec('quarantined')), 'passed')
check(
  'B1 a held baseline run fails (false held), even meeting the held predicate',
  classifyRecord(rec('held', { reason: 'changed-during-move', heldEvidence: ev })),
  'failed'
)
check(
  'B2 a kept baseline run fails (false refusal)',
  classifyRecord(rec('kept', { reason: 'mount-inside-tree' })),
  'failed'
)
check(
  'B3 a stopped baseline run fails',
  classifyRecord(rec('stopped', { reason: 'quarantine-failed' })),
  'failed'
)
check(
  'B4 the rule is B0-only: the same held record on A4-C4 is held (control)',
  classifyRecord({
    ...rec('held', { reason: 'changed-during-move', heldEvidence: ev }),
    cell: { ...CELL, attack: 'A4-C4' },
  }),
  'held'
)
{
  const v = (records) =>
    aggregateCell(records, () => false, { target: 30, controlState: 'none' }).verdict
  check(
    'B5a 30 quarantined -> PASS',
    v(Array.from({ length: 30 }, () => rec('quarantined'))),
    'PASS'
  )
  check(
    'B5b 29 quarantined + 1 held -> FAIL',
    v([
      ...Array.from({ length: 29 }, () => rec('quarantined')),
      rec('held', { reason: 'changed-during-move', heldEvidence: ev }),
    ]),
    'FAIL'
  )
}

// --- the module: one real run per arm on a padded tree ---------------------------
let b0 = null
try {
  b0 = await import('./attacks/b0-c4.mjs')
} catch (err) {
  check('B6 the B0 module loads', err.code ?? err.message, 'loaded')
}
if (b0) {
  check('B6 id', b0.id, 'B0-C4')
  check('B6b target is 30', b0.target, 30)
  const harnessRoot = resolveHarnessRoot()
  for (const candidate of ['C4', 'C4-naive']) {
    const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 's6715-b0tr-'))
    let raw
    try {
      raw = b0.runOnce({ harnessRoot, candidate, dirs: 200, traceDir })
    } finally {
      fs.rmSync(traceDir, { recursive: true, force: true })
    }
    const L = `B7 ${candidate}`
    check(`${L} quarantined`, raw.outcome.status, 'quarantined')
    check(`${L} padded to the requested size`, raw.extra.actualDirs, 200)
    check(
      `${L} user files checked in the quarantined copy, intact`,
      `${raw.userFiles.checked}/${raw.userFiles.lost}/${raw.userFiles.changed}`,
      '2/0/0'
    )
    check(
      `${L} untouched condition verified (pristine hash == caller hash)`,
      raw.precondition.mutationApplied,
      true
    )
    check(`${L} trace matched`, raw.precondition.traceMatched, true)
    check(
      `${L} classifies passed`,
      classifyRecord({ cell: { ...CELL, candidate }, ...raw }),
      'passed'
    )
  }
}

if (!allOk) {
  console.log(`${TAG} SOME CASES FAILED`)
  process.exit(1)
}
console.log(`${TAG} all cases passed`)
