// SMI-6715 Step 1b part 2, item 3 (coordinator decision): matchC4Trace accepts a
// THROWN read on a path strictly inside destPath, before the sidecar write, only
// for a `held` result whose reason is `changed-during-move`. That is the trace a
// post-move re-hash leaves when a file in the moved tree cannot be read (R5).
// Every other thrown call stays a mismatch.
//
// Every case starts from a REAL clean guarded C4 trace (S9 reads, then the
// sidecar write) and changes one thing.
//
// DECLARED FAILURE ON THE PRE-CHANGE MATCHER: T1 is false (only the last
// top-level call may throw). T2-T7 are false either way; each is pinned by a
// named mutation in the hand-back (drop the status, reason, scope/inside,
// read-only, before-sidecar or rename-returned clause).

import path from 'node:path'
import { makeFixtureRoot, resolveHarnessRoot } from './fixture-root.mjs'
import { buildSwapFixture } from './attacks/_shared.mjs'
import { runC4Candidate, matchC4Trace } from './attacks/c4-shared.mjs'

const TAG = '[c4-trace-match threw self-test]'
let allOk = true
function check(label, actual, expected) {
  const ok = actual === expected
  allOk = allOk && ok
  console.log(`${TAG} ${label}: expected ${expected}, got ${actual} -- ${ok ? 'PASS' : 'FAIL'}`)
}

const fx = makeFixtureRoot({ harnessRoot: resolveHarnessRoot() })
let out
try {
  buildSwapFixture(fx.root)
  out = runC4Candidate({
    candidate: 'C4',
    parentAbs: fx.root,
    name: 'tree',
    window: 'post-hash',
    opId: `tmt-${fx.runId}`,
    onFire: () => {},
  })
} finally {
  fx.cleanup()
}
const dest = out.result.path
const sidecar = `${dest}.json`
const renameIdx = out.trace.findIndex(
  (e) => e.fn === 'renameSync' && e.scope === 'origin' && !e.nested
)
const sidecarIdx = out.trace.findIndex((e) => e.path === sidecar)
// The first destination read after the rename that lies strictly INSIDE dest.
const firstInsideIdx = out.trace.findIndex(
  (e, i) => i > renameIdx && e.scope === 'dest' && e.path.startsWith(dest + path.sep) && !e.nested
)

check('P0 real run quarantined', out.result.status, 'quarantined')
check(
  'P1 the trace has a rename, an inside-dest read, then the sidecar write',
  renameIdx !== -1 && firstInsideIdx > renameIdx && sidecarIdx > firstInsideIdx,
  true
)

const held = (reason = 'changed-during-move') => ({
  ...out.result,
  status: 'held',
  reason,
  heldPath: dest,
})
/** A copy of the trace with a thrown call inserted before index `at`. */
function withThrown(at, entry, result) {
  const trace = out.trace.map((e) => ({ ...e }))
  const t = trace[at].at
  trace.splice(at, 0, {
    scope2: null,
    nested: false,
    endAt: t,
    threw: 'EACCES',
    ...entry,
    at: t,
  })
  return {
    candidate: 'C4',
    window: 'post-hash',
    trace,
    result,
    callStartAt: out.times.callStartAt,
    interpositionIntact: true,
  }
}
const insideFile = path.join(dest, 'target', 'orig-f1')
const insideRead = { fn: 'readFileSync', path: insideFile, scope: 'dest' }

check(
  'T1 held/changed-during-move with a thrown read inside dest before the sidecar -> true',
  matchC4Trace(withThrown(firstInsideIdx + 1, insideRead, held())),
  true
)
check(
  'T2 the same thrown read on a QUARANTINED result -> false',
  matchC4Trace(withThrown(firstInsideIdx + 1, insideRead, { ...out.result })),
  false
)
check(
  'T3 the same thrown read on held/mount-appeared-during-move -> false',
  matchC4Trace(withThrown(firstInsideIdx + 1, insideRead, held('mount-appeared-during-move'))),
  false
)
{
  // An origin-side (descendant) read that threw, in the hash phase.
  const descIdx = out.trace.findIndex((e) => e.scope === 'desc' && !e.nested)
  check(
    'T4 a thrown ORIGIN-SIDE read on a held result -> false',
    matchC4Trace(
      withThrown(
        descIdx + 1,
        { fn: 'readFileSync', path: out.trace[descIdx].path, scope: 'desc' },
        held()
      )
    ),
    false
  )
}
{
  // After the sidecar call, and NOT the last top-level call (the matcher already
  // lets the last call throw, so a trailing clean read is appended after it).
  const a = withThrown(sidecarIdx + 1, insideRead, held())
  const last = a.trace[a.trace.length - 1]
  a.trace.push({ ...out.trace[firstInsideIdx], at: last.at, endAt: last.at, threw: null })
  check('T5 a thrown read AFTER the sidecar write -> false', matchC4Trace(a), false)
}
check(
  'T6 a thrown WRITE inside dest -> false',
  matchC4Trace(
    withThrown(firstInsideIdx + 1, { fn: 'writeFileSync', path: insideFile, scope: 'dest' }, held())
  ),
  false
)
check(
  'T7 a thrown read on the destination ROOT itself (not inside it) -> false',
  matchC4Trace(
    withThrown(firstInsideIdx + 1, { fn: 'lstatSync', path: dest, scope: 'dest' }, held())
  ),
  false
)

if (!allOk) {
  console.log(`${TAG} SOME CASES FAILED`)
  process.exit(1)
}
console.log(`${TAG} all cases passed`)
