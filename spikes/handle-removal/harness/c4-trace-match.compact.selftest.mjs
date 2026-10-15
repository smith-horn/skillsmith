// Unit self-test for compactTrace (attacks/c4-trace-match.mjs). Plain node
// script: PASS/FAIL lines, non-zero exit on any failure. Host node, darwin.
//
// (Named c4-trace-match.compact.selftest.mjs: harness/c4-trace-compact.selftest.mjs
// is a different worker's test of how records CARRY the compact form.)
//
// compactTrace decides what of a C4 trace is KEPT in a record, so a defect here
// silently drops evidence. Every call goes through `safe()`, which turns a throw
// into a FAIL line: "never throws on a well-formed trace" is itself asserted.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { makeFixtureRoot, resolveHarnessRoot } from './fixture-root.mjs'
import { buildSwapFixture } from './attacks/_shared.mjs'
import { runC4Candidate, FIRE } from './attacks/c4-shared.mjs'
import { compactTrace } from './attacks/c4-trace-match.mjs'

const DIRS = 1630
const MAX_BYTES = 8 * 1024
let allOk = true
function check(label, cond, detail = '') {
  if (!cond) allOk = false
  console.log(
    `[compactTrace self-test] ${label}: ${cond ? 'PASS' : 'FAIL'}${detail ? ` (${detail})` : ''}`
  )
}
function safe(trace, opts) {
  try {
    return { c: compactTrace(trace, opts), threw: null }
  } catch (err) {
    return { c: null, threw: `${err?.name}: ${String(err?.message).replace(/\s+/g, ' ')}` }
  }
}
const sha = (t) => crypto.createHash('sha256').update(JSON.stringify(t)).digest('hex')
const classOf = (e) => e.scope ?? e.scope2 ?? null
const sum = (o) => Object.values(o ?? {}).reduce((a, b) => a + b, 0)

// 1. A real, unattacked, 1630-directory C4 run (the size measured for Step 1).
const fx = makeFixtureRoot({ harnessRoot: resolveHarnessRoot() })
let out
try {
  const f = buildSwapFixture(fx.root)
  for (let i = 0; i < DIRS; i++) {
    const d = path.join(f.treeRoot, `bulk-${String(i).padStart(4, '0')}`)
    fs.mkdirSync(d)
    fs.writeFileSync(path.join(d, 'f'), `bulk-${i}`)
  }
  out = runC4Candidate({
    candidate: 'C4',
    parentAbs: fx.root,
    name: 'tree',
    window: 'at-rename',
    onFire() {},
  })
} finally {
  fx.cleanup()
}
const t = out.trace
check(
  'precondition: real run matched and is large',
  out.traceMatched === true && t.length > 10000,
  `length=${t.length}`
)
const { c, threw } = safe(t, { traceMatched: out.traceMatched })
check('real: compactTrace did not throw', threw === null, threw ?? '')
const bytes = c ? Buffer.byteLength(JSON.stringify(c)) : Infinity
const fullBytes = Buffer.byteLength(JSON.stringify(t))
check(
  `real: compact record under ${MAX_BYTES} bytes`,
  bytes < MAX_BYTES,
  `compact=${bytes} full=${fullBytes}`
)
check(
  'real: schema tag and full dropped for a matched trace',
  c?.schema === 'c4-trace-compact/1' && c?.full === null
)
check('real: length equals the trace length', c?.length === t.length, `${c?.length} vs ${t.length}`)
{
  const fire = t.filter((e) => e.fn === FIRE).length
  const total =
    sum(c?.counts?.origin) + sum(c?.counts?.desc) + sum(c?.counts?.dest) + (c?.counts?.fire ?? NaN)
  check(
    'real: per-scope counts plus FIRE sum to length',
    total === t.length,
    `sum=${total} fire=${c?.counts?.fire}/${fire}`
  )
}
for (const s of ['origin', 'desc', 'dest']) {
  const want = t.filter((e) => e.fn !== FIRE && classOf(e) === s).length
  const perFn = {}
  for (const e of t) if (e.fn !== FIRE && classOf(e) === s) perFn[e.fn] = (perFn[e.fn] ?? 0) + 1
  const got = c?.counts?.[s] ?? {}
  const sameFns =
    JSON.stringify(Object.entries(perFn).sort()) === JSON.stringify(Object.entries(got).sort())
  check(
    `real: ${s} counts reproduce the trace's ${s} totals, per fn`,
    sum(got) === want && sameFns,
    `got=${sum(got)} want=${want}`
  )
}
check(
  'real: nested count equals nested entries',
  c?.counts?.nested === t.filter((e) => e.nested === true).length,
  `${c?.counts?.nested}`
)
check('real: sha256 is the hash of JSON.stringify(full trace)', c?.sha256 === sha(t))
{
  const want = t
    .filter((e) => e.fn === FIRE || (e.scope === 'origin' && e.nested !== true))
    .map((e) => e.fn)
  check(
    'real: rootSkeleton is the top-level origin calls with FIRE',
    JSON.stringify(c?.rootSkeleton) === JSON.stringify(want),
    (c?.rootSkeleton ?? []).join(',')
  )
}
check(
  'real: fireIndex is FIRE position in the FULL trace',
  c?.fireIndex === t.findIndex((e) => e.fn === FIRE) && t[c?.fireIndex]?.fn === FIRE,
  `${c?.fireIndex}`
)
{
  const p = c?.phases ?? {}
  check(
    'real: renameAt / renameEndAt equal the run times',
    p.renameAt === out.times.renameAt && p.renameEndAt === out.times.renameEndAt
  )
  // at-rename: the call right before FIRE is the re-check lstat.
  check(
    'real: recheckAt is the re-check lstat (the call before FIRE at-rename)',
    Number.isInteger(c?.fireIndex) &&
      c.fireIndex > 0 &&
      Number.isFinite(p.recheckAt) &&
      p.recheckAt === t[c.fireIndex - 1].at
  )
  const ordered = [
    p.firstDescAt,
    p.lastDescAt,
    p.recheckAt,
    p.renameAt,
    p.renameEndAt,
    p.firstDestAt,
    p.lastDestAt,
  ]
  check(
    'real: phases present and ordered (firstDesc<=lastDesc<recheck<=rename<=renameEnd<=firstDest<=lastDest)',
    ordered.every(Number.isFinite) &&
      ordered.every((v, i) => i === 0 || ordered[i - 1] <= v) &&
      p.lastDescAt < p.recheckAt,
    ordered.map((v) => (Number.isFinite(v) ? 'n' : String(v))).join(',')
  )
  const descs = t.filter((e) => e.fn !== FIRE && classOf(e) === 'desc')
  const dests = t.filter((e) => e.fn !== FIRE && classOf(e) === 'dest')
  check(
    'real: phase endpoints are the first/last desc and dest entries exactly',
    descs.length > 0 &&
      dests.length > 0 &&
      p.firstDescAt === descs[0].at &&
      p.lastDescAt === descs.at(-1).at &&
      p.firstDestAt === dests[0].at &&
      p.lastDestAt === dests.at(-1).at
  )
}
check(
  'real: threw is empty for a clean run',
  Array.isArray(c?.threw) && c.threw.length === 0 && c.threwTotal === 0
)
check(
  'real: result is JSON-safe',
  c !== null && JSON.stringify(JSON.parse(JSON.stringify(c))) === JSON.stringify(c)
)

// 2. traceMatched must be a strict boolean true to drop the full trace.
for (const [label, opts] of [
  ['false', { traceMatched: false }],
  ["'true' (string)", { traceMatched: 'true' }],
  ['1', { traceMatched: 1 }],
  ['missing option', {}],
  ['no options object', undefined],
]) {
  const r = safe(t, opts)
  check(
    `traceMatched ${label} -> full trace kept`,
    r.threw === null && r.c?.full === t && r.c?.sha256 === sha(t),
    r.threw ?? ''
  )
}

// 3. Malformed traces keep everything and say so.
const cyclic = [{ fn: 'lstatSync', scope: 'origin', at: 1, threw: null }]
cyclic[0].self = cyclic[0]
for (const [label, trace] of [
  ['not an array (null)', null],
  ['not an array (object)', { fn: 'x' }],
  [
    'an array-like object with its own map() method',
    {
      length: 1,
      map: () => [{ fn: 'lstatSync', scope: 'origin', scope2: null, at: 1, threw: null }],
    },
  ],
  ['entry is null', [null]],
  ['entry missing fn', [{ scope: 'origin', at: 1, threw: null }]],
  ['non-FIRE entry missing scope', [{ fn: 'lstatSync', at: 1, threw: null }]],
  [
    'scope key missing although scope2 is valid',
    [{ fn: 'lstatSync', scope2: 'dest', at: 1, threw: null }],
  ],
  [
    'entry with no valid scope at all',
    [{ fn: 'lstatSync', scope: 'elsewhere', scope2: null, at: 1, threw: null }],
  ],
  ['cyclic entry (not JSON-serialisable)', cyclic],
]) {
  const r = safe(trace, { traceMatched: true })
  check(
    `malformed: ${label} -> {schema, malformed:true, full}`,
    r.threw === null &&
      r.c?.schema === 'c4-trace-compact/1' &&
      r.c?.malformed === true &&
      r.c?.full === trace &&
      Object.keys(r.c).length === 3,
    r.threw ?? JSON.stringify(Object.keys(r.c ?? {}))
  )
}

// 4. Synthetic well-formed shapes: scope2-only entry, nested origin, bounded threw.
// A function declaration, not `const e = (...) => ({...})`: that arrow form,
// followed directly by the `{` block below, is misparsed by the TypeScript
// parser ESLint uses -- it reads `({...}) {` as an arrow function missing its
// `=>` and treats the object literal as a destructuring pattern, so
// `scope2: null` becomes an invalid binding target. Node parses it correctly
// (ASI before the block); the declaration sidesteps the ambiguity entirely.
function e(fn, scope, extra = {}) {
  return { fn, scope, scope2: null, nested: false, at: 1, endAt: 2, threw: null, ...extra }
}
{
  const trace = [
    e('lstatSync', 'origin'),
    e('lstatSync', 'origin', { nested: true }),
    { fn: FIRE, at: 1, endAt: 1, threw: null },
    e('renameSync', null, { scope2: 'dest' }),
    ...Array.from({ length: 25 }, (_, i) => e('readFileSync', 'desc', { threw: `E${i}` })),
  ]
  const r = safe(trace, { traceMatched: true })
  check(
    'synthetic: a scope2-only entry is counted under its scope2',
    r.c?.counts?.dest?.renameSync === 1 && !r.c?.counts?.origin?.renameSync
  )
  check(
    'synthetic: a nested origin call is not in rootSkeleton',
    JSON.stringify(r.c?.rootSkeleton) === JSON.stringify(['lstatSync', FIRE])
  )
  check(
    'synthetic: threw bounded to 20, with the true total and per-entry fn/scope/code',
    r.c?.threw?.length === 20 &&
      r.c?.threwTotal === 25 &&
      r.c.threw[0].fn === 'readFileSync' &&
      r.c.threw[0].scope === 'desc' &&
      r.c.threw[0].code === 'E0'
  )
  const empty = safe([], { traceMatched: true })
  check(
    'empty trace: well-formed, compacts without throwing',
    empty.threw === null &&
      empty.c?.length === 0 &&
      empty.c?.fireIndex === null &&
      empty.c?.malformed === undefined
  )
}

// 5. Governance F4: hostile-but-plausible entry shapes.
{
  const throwing = e('x', 'desc')
  Object.defineProperty(throwing, 'fn', {
    get() {
      throw new Error('getter boom')
    },
    enumerable: true,
  })
  let reads = 0
  const changing = e('x', 'desc')
  Object.defineProperty(changing, 'fn', {
    get() {
      reads += 1
      return reads === 1 ? 'lstatSync' : 42
    },
    enumerable: true,
  })
  const boom = () => {
    throw new Error('trap boom')
  }
  const proxy = new Proxy(e('lstatSync', 'desc'), {
    getOwnPropertyDescriptor: boom,
    get: boom,
    has: boom,
  })
  for (const [label, entry] of [
    ['fn is a throwing getter', throwing],
    ['fn is a getter whose value changes between reads', changing],
    ['entry is a Proxy whose traps throw', proxy],
  ]) {
    const trace = [e('lstatSync', 'origin'), entry]
    const r = safe(trace, { traceMatched: true })
    check(
      `F4: ${label} -> malformed with full kept, no throw`,
      r.threw === null && r.c?.malformed === true && r.c?.full === trace,
      r.threw ?? JSON.stringify(Object.keys(r.c ?? {}))
    )
  }
  const r = safe([e('__proto__', 'desc'), e('__proto__', 'desc'), e('lstatSync', 'desc')], {
    traceMatched: true,
  })
  const round = r.c ? JSON.parse(JSON.stringify(r.c)) : null
  check(
    "F4: fn '__proto__' is counted, and survives a JSON round trip",
    r.threw === null &&
      r.c?.counts?.desc?.['__proto__'] === 2 &&
      Object.prototype.hasOwnProperty.call(round?.counts?.desc ?? {}, '__proto__') &&
      round.counts.desc['__proto__'] === 2 &&
      sum(r.c.counts.desc) === 3,
    r.threw ?? JSON.stringify(round?.counts?.desc)
  )
}

if (!allOk) {
  console.error('[compactTrace self-test] FAIL')
  process.exit(1)
}
console.log('[compactTrace self-test] all cases passed')
process.exit(0)
