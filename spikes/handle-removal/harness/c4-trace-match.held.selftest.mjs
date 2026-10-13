// SMI-6715 Step 1b (design §9): matchC4Trace and the `held` outcome.
//
// A held result is valid only with the FULL C4 root skeleton, a root rename that
// returned, `last.dest === result.path`, and no origin-side call after the
// rename (phase (c), the matcher's enforcement of "never move back").
//
// Every case starts from a REAL C4 trace (clean, unmutated run) and changes one
// thing. DECLARED FAILURE ON THE PRE-REPAIR MATCHER: H1 is false (status 'held'
// is not handled, so no held trace can ever match). H2-H5 are false either way;
// their check is the mutations recorded in the hand-back (drop phase (c); drop
// the threw / dest / length clauses from the held rule).

import { makeFixtureRoot, resolveHarnessRoot } from './fixture-root.mjs'
import { buildSwapFixture } from './attacks/_shared.mjs'
import { runC4Candidate, matchC4Trace } from './attacks/c4-shared.mjs'

const TAG = '[c4-trace-match held self-test]'
let allOk = true
function check(label, actual, expected) {
  const ok = actual === expected
  allOk = allOk && ok
  console.log(`${TAG} ${label}: expected ${expected}, got ${actual} -- ${ok ? 'PASS' : 'FAIL'}`)
}

const harnessRoot = resolveHarnessRoot()
const fx = makeFixtureRoot({ harnessRoot })
let out
try {
  buildSwapFixture(fx.root)
  out = runC4Candidate({
    candidate: 'C4',
    parentAbs: fx.root,
    name: 'tree',
    window: 'post-hash',
    opId: `tmh-${fx.runId}`,
    onFire: () => {},
  })
} finally {
  fx.cleanup()
}
const renameIdx = out.trace.findIndex(
  (e) => e.fn === 'renameSync' && e.scope === 'origin' && !e.nested
)
const asHeld = (res) => ({
  ...res,
  status: 'held',
  reason: 'changed-during-move',
  heldPath: res.path,
})
const args = (extra = {}) => ({
  candidate: 'C4',
  window: 'post-hash',
  trace: out.trace.map((e) => ({ ...e })),
  result: asHeld(out.result),
  callStartAt: out.times.callStartAt,
  interpositionIntact: true,
  ...extra,
})

check(
  'H0 control: the real clean trace matches as quarantined',
  matchC4Trace({ ...args(), result: { ...out.result } }),
  true
)
check('H0b and the real run had a root rename', renameIdx !== -1, true)
check(
  'H1 the same trace matches as held (full skeleton, rename returned, dest === path)',
  matchC4Trace(args()),
  true
)
{
  const a = args()
  a.trace = a.trace.slice(0, renameIdx + 1)
  a.trace[renameIdx].threw = 'EACCES'
  check('H2 held with a rename that threw -> false', matchC4Trace(a), false)
}
{
  const a = args()
  const at = a.trace[a.trace.length - 1].at
  a.trace.push({
    fn: 'mkdirSync',
    path: out.result.originPath ?? a.trace[renameIdx].path,
    scope: 'origin',
    scope2: null,
    nested: false,
    at,
    endAt: at,
    threw: null,
  })
  check('H3 held with an origin-side mkdir after the rename -> false', matchC4Trace(a), false)
}
{
  const a = args()
  const at = a.trace[a.trace.length - 1].at
  const r = a.trace[renameIdx]
  a.trace.push({
    fn: 'renameSync',
    path: r.dest,
    dest: r.path,
    scope: 'dest',
    scope2: 'origin',
    nested: false,
    at,
    endAt: at,
    threw: null,
  })
  check('H3b held with a move-back rename onto the origin -> false', matchC4Trace(a), false)
}
{
  const a = args()
  a.result.path = `${a.result.path}-elsewhere`
  check('H4 held whose path is not the rename destination -> false', matchC4Trace(a), false)
}
{
  const a = args()
  a.trace = a.trace.slice(0, renameIdx)
  check('H5 held with no rename in the trace -> false', matchC4Trace(a), false)
}

if (!allOk) {
  console.log(`${TAG} SOME CASES FAILED`)
  process.exit(1)
}
console.log(`${TAG} all cases passed`)
