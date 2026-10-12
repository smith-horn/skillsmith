// Self-test for matchC4Trace (attacks/c4-trace-match.mjs, re-exported from
// attacks/c4-shared.mjs). Plain node script: PASS/FAIL lines, non-zero exit on
// any failure. Host node, darwin.
//
// Every red case starts from a REAL trace whose unmodified copy matches, then
// changes ONE thing, so a false below is caused by that one change.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { makeFixtureRoot, resolveHarnessRoot } from './fixture-root.mjs'
import { buildSwapFixture } from './attacks/_shared.mjs'
import { runC4Candidate, matchC4Trace, FIRE } from './attacks/c4-shared.mjs'
import { makeScoper } from './attacks/c4-trace-match.mjs'
import { pathToFileURL } from 'node:url'

const harnessRoot = resolveHarnessRoot()
let allOk = true
function check(label, cond, detail = '') {
  if (!cond) allOk = false
  console.log(
    `[c4-trace-match self-test] ${label}: ${cond ? 'PASS' : 'FAIL'}${detail ? ` (${detail})` : ''}`
  )
}
const isRoot = (e, fn) => e.fn === fn && e.scope === 'origin' && !e.nested
const rootNames = (t) =>
  t
    .filter((e) => e.fn === FIRE || (e.scope === 'origin' && !e.nested))
    .map((e) => e.fn)
    .join(',')

/** One run on a fresh swap fixture; cleans up on throw, caller cleans up otherwise. */
function runOn(candidate, window, makeOnFire = () => () => {}) {
  const fx = makeFixtureRoot({ harnessRoot })
  try {
    const f = buildSwapFixture(fx.root)
    const opId = `tm-${fx.runId}`
    const out = runC4Candidate({
      candidate,
      parentAbs: fx.root,
      name: 'tree',
      window,
      opId,
      onFire: makeOnFire(f, fx, opId),
    })
    return { out, fx, f, opId }
  } catch (err) {
    fx.cleanup()
    throw err
  }
}
function real(candidate, window) {
  const { out, fx } = runOn(candidate, window)
  fx.cleanup()
  return out
}
const args = (out, candidate, window, extra = {}) => ({
  candidate,
  window,
  trace: out.trace.map((e) => ({ ...e })),
  result: { ...out.result },
  callStartAt: out.times.callStartAt,
  interpositionIntact: true,
  ...extra,
})
/** Inserts `entry` before index i, timestamped at trace[i] so order stays non-decreasing. */
function insertBefore(a, i, entry) {
  a.trace.splice(i, 0, {
    scope2: null,
    nested: false,
    threw: null,
    endAt: null,
    ...entry,
    at: a.trace[i].at,
  })
  return a
}

// ---- Root skeleton (rules 1-7) ----
const q = real('C4', 'at-rename')
const base = args(q, 'C4', 'at-rename')
check('baseline: real C4/at-rename trace matches', matchC4Trace(base) === true, rootNames(q.trace))
{
  const a = args(q, 'C4', 'at-rename')
  a.trace = a.trace.filter((e) => e.fn !== FIRE)
  check('red: FIRE marker dropped -> false', matchC4Trace(a) === false, rootNames(a.trace))
}
{
  const a = args(q, 'C4', 'at-rename')
  a.trace.splice(1, 0, { ...a.trace[0] })
  check('red: extra root lstat inserted -> false', matchC4Trace(a) === false, rootNames(a.trace))
}
{
  const a = args(q, 'C4', 'at-rename')
  ;[a.trace[1], a.trace[2]] = [a.trace[2], a.trace[1]]
  for (let i = 0; i < a.trace.length; i++) a.trace[i].at = q.trace[i].at
  check('red: root readdir/lstat reordered -> false', matchC4Trace(a) === false, rootNames(a.trace))
}
{
  const a = args(q, 'C4', 'at-rename')
  a.trace[0].threw = 'ENOENT'
  check(
    'red: non-final top-level call threw -> false',
    matchC4Trace(a) === false,
    'trace[0].threw=ENOENT'
  )
}
{
  const r = (fn, at, threw = null) => ({
    fn,
    scope: 'origin',
    scope2: null,
    nested: false,
    at,
    endAt: at + 1,
    threw,
  })
  const s = {
    candidate: 'C4',
    window: 'after-bind',
    result: { status: 'stopped' },
    callStartAt: 1,
    interpositionIntact: true,
  }
  const withFire = [
    r('lstatSync', 10),
    { fn: FIRE, at: 12, endAt: 13, threw: null },
    r('lstatSync', 14, 'ENOENT'),
  ]
  check(
    'control: stopped prefix WITH FIRE matches',
    matchC4Trace({ ...s, trace: withFire }) === true
  )
  check(
    'red: stopped prefix with no FIRE -> false',
    matchC4Trace({ ...s, trace: [r('lstatSync', 10, 'ENOENT')] }) === false
  )
}
check(
  'red Ciii: quarantined but result.path != rename dest -> false',
  matchC4Trace(
    args(q, 'C4', 'at-rename', { result: { ...q.result, path: `${q.result.path}-elsewhere` } })
  ) === false
)
check(
  'red Civ: full clean trace with status kept -> false',
  matchC4Trace(args(q, 'C4', 'at-rename', { result: { ...q.result, status: 'kept' } })) === false
)
check(
  'red Civ: full clean trace with status stopped -> false',
  matchC4Trace(args(q, 'C4', 'at-rename', { result: { ...q.result, status: 'stopped' } })) === false
)
check(
  'red Cv: interpositionIntact false -> false',
  matchC4Trace(args(q, 'C4', 'at-rename', { interpositionIntact: false })) === false
)
{
  const p = real('C4', 'pre-call')
  check(
    'baseline: real C4/pre-call trace matches',
    matchC4Trace(args(p, 'C4', 'pre-call')) === true
  )
  const a = args(p, 'C4', 'pre-call')
  a.trace[0].at = a.callStartAt // FIRE at the call start, still <= the first lstat's time
  check(
    'red Cvi: pre-call FIRE not before callStartAt -> false',
    a.trace[1].at >= a.trace[0].at && matchC4Trace(a) === false
  )
}
{
  const ab = real('C4', 'after-bind')
  check(
    'red Ci-b: after-bind-shaped trace claimed as post-hash -> false',
    matchC4Trace(args(ab, 'C4', 'post-hash')) === false,
    rootNames(ab.trace)
  )
}

// ---- Scoped tracing: presence first, so the absence checks below mean something ----
const count = (t, pred) => t.filter(pred).length
check(
  'presence: real C4 trace records descendant reads, nested opens and destination calls',
  count(q.trace, (e) => e.scope === 'desc') > 0 &&
    count(q.trace, (e) => e.fn === 'openSync' && e.nested === true) > 0 &&
    count(q.trace, (e) => e.scope === 'dest') > 0,
  `desc=${count(q.trace, (e) => e.scope === 'desc')} nestedOpen=${count(q.trace, (e) => e.fn === 'openSync' && e.nested)} dest=${count(q.trace, (e) => e.scope === 'dest')}`
)
const nv = real('C4-naive', 'at-rename')
check(
  'presence: real C4-naive trace has destination calls and no descendant calls, and matches',
  count(nv.trace, (e) => e.scope === 'dest') > 0 &&
    count(nv.trace, (e) => e.scope === 'desc') === 0 &&
    matchC4Trace(args(nv, 'C4-naive', 'at-rename')) === true
)

// ---- Phase invariants (a)-(d), synthetic ----
const idx = (t, pred) => t.findIndex(pred)
const bindI = idx(q.trace, (e) => isRoot(e, 'lstatSync'))
const readdirI = idx(q.trace, (e) => isRoot(e, 'readdirSync'))
const rootLstatIs = q.trace.map((e, i) => (isRoot(e, 'lstatSync') ? i : -1)).filter((i) => i >= 0)
const recheckI = rootLstatIs[2]
const renameI = idx(q.trace, (e) => isRoot(e, 'renameSync'))
const descFile = path.join(q.trace[0].path, 'target', 'orig-f1')
const destFile = path.join(q.result.path, 'stray')
const descRead = { fn: 'lstatSync', path: descFile, scope: 'desc' }
check(
  'red (a): descendant read before the bind lstat -> false',
  matchC4Trace(insertBefore(args(q, 'C4', 'at-rename'), bindI, descRead)) === false
)
check(
  'red (b): descendant read before the root readdir -> false',
  matchC4Trace(insertBefore(args(q, 'C4', 'at-rename'), readdirI, descRead)) === false
)
check(
  'red (b): descendant WRITE during the hash phase -> false',
  matchC4Trace(
    insertBefore(args(q, 'C4', 'at-rename'), readdirI + 2, {
      fn: 'writeFileSync',
      path: descFile,
      scope: 'desc',
    })
  ) === false
)
check(
  'red (b): descendant open for writing during the hash phase -> false',
  matchC4Trace(
    insertBefore(args(q, 'C4', 'at-rename'), readdirI + 2, {
      fn: 'openSync',
      path: descFile,
      scope: 'desc',
      flags: 'w',
    })
  ) === false
)
check(
  'red (c): descendant read after the re-check lstat -> false',
  matchC4Trace(insertBefore(args(q, 'C4', 'at-rename'), recheckI + 1, descRead)) === false
)
check(
  'red (d): destination write before the rename -> false',
  matchC4Trace(
    insertBefore(args(q, 'C4', 'at-rename'), renameI, {
      fn: 'writeFileSync',
      path: destFile,
      scope: 'dest',
    })
  ) === false
)
{
  const a = args(q, 'C4', 'at-rename', { result: { ...q.result, status: 'stopped' } })
  const ri = idx(a.trace, (e) => isRoot(e, 'renameSync'))
  a.trace[ri].threw = 'EXDEV'
  a.trace = a.trace.slice(0, ri + 1)
  check('control: stopped at a rename that threw, nothing after, matches', matchC4Trace(a) === true)
  a.trace.push({
    fn: 'lstatSync',
    path: destFile,
    scope: 'dest',
    scope2: null,
    // NESTED inside the failed rename: a top-level call here would already be
    // rejected by the only-the-last-top-level-call-may-throw rule, so only a
    // nested call exercises (d)'s 'rename that returned' clause on its own.
    nested: true,
    threw: null,
    at: a.trace[ri].at,
    endAt: null,
  })
  check(
    'red (d): destination call nested inside a rename that THREW -> false',
    matchC4Trace(a) === false
  )
}
{
  const ni = idx(nv.trace, (e) => isRoot(e, 'renameSync'))
  check(
    'red C4-naive: any descendant call before the rename -> false',
    matchC4Trace(insertBefore(args(nv, 'C4-naive', 'at-rename'), ni, descRead)) === false
  )
}

// ---- Phase invariants, real runs ----
// (d) for real: C4 itself writes into the destination before the rename, injected
// through crypto.randomBytes (randSuffix), which quarantine.mjs calls after the
// op-dir checks and before the re-check, while recording is on.
{
  const origRandom = crypto.randomBytes
  let injected = false
  let r
  try {
    r = runOn('C4', 'at-rename', (f, fx, opId) => {
      crypto.randomBytes = (...a) => {
        if (!injected) {
          injected = true
          fs.writeFileSync(path.join(fx.root, '.skillsmith-trash', opId, 'early-write'), 'x')
        }
        return origRandom.apply(crypto, a)
      }
      return () => {}
    })
  } finally {
    crypto.randomBytes = origRandom
  }
  const t = r.out.trace
  const wi = idx(t, (e) => e.fn === 'writeFileSync' && e.scope === 'dest')
  check(
    'real (d): destination write before the rename -> traceMatched false, hookFired false',
    injected &&
      wi !== -1 &&
      wi < idx(t, (e) => isRoot(e, 'renameSync')) &&
      r.out.traceMatched === false &&
      r.out.hookFired === false,
    `writeAt=${wi}`
  )
  r.fx.cleanup()
}
// Nested-throw control: an unreadable descendant makes readFileSync AND its nested
// openSync throw; that legitimate `stopped` must still match.
{
  const { out, fx } = runOn(
    'C4',
    'after-bind',
    (f) => () => fs.chmodSync(path.join(f.targetAbs, 'orig-f1'), 0)
  )
  const threw = out.trace.filter((e) => e.threw !== null)
  check(
    'real: unreadable descendant -> stopped/guard-unreadable, nested throw tolerated, matches',
    out.result.status === 'stopped' &&
      out.result.reason === 'guard-unreadable' &&
      threw.length === 2 &&
      threw[1].nested === true &&
      out.traceMatched === true,
    `${out.result.status}/${out.result.reason} threw=${threw.map((e) => `${e.fn}${e.nested ? '(nested)' : ''}:${e.threw}`).join(',')}`
  )
  fx.cleanup()
}

// ---- G3-9: non-string path arguments ----
// Decision: a Buffer or file: URL path is normalised and traced like a string;
// an fd is not a path and is not traced (pinned below, so the gap is visible).
{
  const root = '/srv/fixture/tree'
  const scopesOf = makeScoper(root, '/srv/fixture/.skillsmith-trash/op')
  const sc = (arg) => scopesOf('statSync', [arg]).scope
  check('scoper: Buffer path at the root -> origin', sc(Buffer.from(root)) === 'origin')
  check(
    'scoper: Buffer path inside the root -> desc',
    sc(Buffer.from(`${root}/target/f`)) === 'desc'
  )
  check(
    'scoper: file: URL inside the root -> desc',
    sc(pathToFileURL(`${root}/target/f`)) === 'desc'
  )
  check('scoper: non-file URL -> not traced', sc(new URL('http://x/srv/fixture/tree')) === null)
  check('scoper (pinned limitation): an fd -> not traced', sc(3) === null)
  check(
    'scoper: Buffer outside root and destination -> not traced',
    sc(Buffer.from('/elsewhere')) === null
  )
}
// Real runs: C4 itself touching the root through a Buffer or URL path must be
// traced and break the match (injected through crypto.randomBytes, as above).
for (const [label, toArg] of [
  ['Buffer', (p) => Buffer.from(p)],
  ['file: URL', (p) => pathToFileURL(p)],
]) {
  const origRandom = crypto.randomBytes
  let injected = false
  let r
  try {
    r = runOn('C4', 'at-rename', (f, fx) => {
      crypto.randomBytes = (...a) => {
        if (!injected) {
          injected = true
          fs.statSync(toArg(path.join(fx.root, 'tree')))
        }
        return origRandom.apply(crypto, a)
      }
      return () => {}
    })
  } finally {
    crypto.randomBytes = origRandom
  }
  const stray = r.out.trace.find((e) => e.fn === 'statSync')
  check(
    `real: C4 touching the root via a ${label} path is traced -> traceMatched false`,
    injected &&
      stray?.scope === 'origin' &&
      stray.path === path.resolve(r.fx.root, 'tree') &&
      r.out.traceMatched === false,
    stray ? `scope=${stray.scope} path=${stray.path}` : 'not traced'
  )
  r.fx.cleanup()
}

if (!allOk) {
  console.error('[c4-trace-match self-test] FAIL')
  process.exit(1)
}
console.log('[c4-trace-match self-test] all cases passed')
process.exit(0)
