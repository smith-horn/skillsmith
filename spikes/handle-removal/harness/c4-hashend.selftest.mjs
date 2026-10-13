// SMI-6715 Step 1b part 2, item 4: runC4Candidate's hash-end clock (onHashEnd,
// times.hashEndAt), the release point for A13-C4-POSTHASH's racer.
//
// The property that matters: onHashEnd runs AFTER C4's own pre-move hash and
// BEFORE the rename. HE2 proves "after" behaviourally, not by timestamp: a
// change made inside onHashEnd cannot be seen by C4's pre-move hash, so C4 must
// end `held` (caught after the move), never `kept/identity-changed` (caught by
// the pre-move hash).
//
// DECLARED FAILURE ON THE PRE-CHANGE c4-shared: onHashEnd is ignored -- never
// called (HE1/HE3 count 0), times.hashEndAt is undefined, HE2's change never
// happens so C4 quarantines, and HE5 does not throw.

import fs from 'node:fs'
import path from 'node:path'
import { makeFixtureRoot, resolveHarnessRoot } from './fixture-root.mjs'
import { buildSwapFixture } from './attacks/_shared.mjs'
import { runC4Candidate } from './attacks/c4-shared.mjs'

const TAG = '[c4-hashend self-test]'
let allOk = true
function check(label, actual, expected) {
  const ok = actual === expected
  allOk = allOk && ok
  console.log(
    `${TAG} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} -- ${ok ? 'PASS' : 'FAIL'}`
  )
}
const harnessRoot = resolveHarnessRoot()
function run(candidate, onHashEnd, extra = {}) {
  const fx = makeFixtureRoot({ harnessRoot })
  try {
    const f = buildSwapFixture(fx.root)
    const out = runC4Candidate({
      candidate,
      parentAbs: fx.root,
      name: 'tree',
      window: 'pre-call',
      onFire: () => {},
      ...(onHashEnd ? { onHashEnd: () => onHashEnd(f) } : {}),
      ...extra,
    })
    return out
  } finally {
    fx.cleanup()
  }
}

{
  let calls = 0
  const out = run('C4', () => {
    calls += 1
  })
  const t = out.times
  const descEnds = out.trace.filter((e) => e.scope === 'desc').map((e) => e.endAt)
  const lastDescEnd = Math.max(...descEnds)
  check('HE1 C4: onHashEnd called exactly once', calls, 1)
  check('HE1b hashEndAt is a number', typeof t.hashEndAt, 'number')
  check('HE1c after the last pre-move hash read', t.hashEndAt >= lastDescEnd, true)
  check('HE1d before the re-check lstat', t.hashEndAt <= t.recheckAt, true)
  check('HE1e before the rename', t.hashEndAt <= t.renameAt, true)
  check('HE1f the run still matched its trace', out.traceMatched, true)
  check('HE1g no hook error', out.hashEndError, null)
}
{
  const out = run('C4', (f) => fs.appendFileSync(path.join(f.targetAbs, 'orig-f1'), '-at-hash-end'))
  check(
    'HE2 a change at hash end is caught AFTER the move (held, not kept)',
    out.result.status,
    'held'
  )
  check('HE2b reason', out.result.reason, 'changed-during-move')
}
{
  let calls = 0
  const out = run('C4-naive', () => {
    calls += 1
  })
  check('HE3 C4-naive: onHashEnd called exactly once', calls, 1)
  check('HE3b before the rename', out.times.hashEndAt <= out.times.renameAt, true)
}
{
  const out = run('C4', null)
  check(
    'HE4 without onHashEnd the return shape is unchanged (no hashEndError key)',
    'hashEndError' in out,
    false
  )
  check('HE4b but hashEndAt is still measured', typeof out.times.hashEndAt, 'number')
}
check(
  'HE5 a non-function onHashEnd is refused',
  (() => {
    try {
      run('C4', null, { onHashEnd: 'soon' })
      return 'accepted'
    } catch (err) {
      return err instanceof TypeError ? 'TypeError' : String(err)
    }
  })(),
  'TypeError'
)

if (!allOk) {
  console.log(`${TAG} SOME CASES FAILED`)
  process.exit(1)
}
console.log(`${TAG} all cases passed`)
