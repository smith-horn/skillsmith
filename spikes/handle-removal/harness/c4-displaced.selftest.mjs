// Self-test for locateDisplaced (attacks/c4-displaced.mjs, re-exported from
// attacks/c4-shared.mjs). Plain node script: PASS/FAIL lines, non-zero exit on
// any failure. Host node, darwin.
//
// R1-F5: displacement must be proven against THIS run's destination, by
// relative path, type and content -- never by content anywhere under the trash.

import fs from 'node:fs'
import path from 'node:path'
import { makeFixtureRoot, resolveHarnessRoot } from './fixture-root.mjs'
import { buildSwapFixture, renameAsideAndReplace } from './attacks/_shared.mjs'
import { runC4Candidate, locateDisplaced } from './attacks/c4-shared.mjs'

const harnessRoot = resolveHarnessRoot()
let allOk = true
function check(label, cond, detail = '') {
  if (!cond) allOk = false
  console.log(
    `[c4-displaced self-test] ${label}: ${cond ? 'PASS' : 'FAIL'}${detail ? ` (${detail})` : ''}`
  )
}
function withFx(fn) {
  const fx = makeFixtureRoot({ harnessRoot })
  try {
    return fn(fx)
  } finally {
    fx.cleanup()
  }
}
const write = (abs, content) => {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

// Hand-built trash layout: this run's destination and a stale other op.
//   <root>/.skillsmith-trash/op-this/tree-bbbb   <- destination (moved <root>/tree)
//   <root>/.skillsmith-trash/op-stale/tree-aaaa  <- another, older operation
function layout(fx) {
  const trash = path.join(fx.root, '.skillsmith-trash')
  const destination = path.join(trash, 'op-this', 'tree-bbbb')
  fs.mkdirSync(destination, { recursive: true })
  const originRoot = path.join(fx.root, 'tree')
  return { trash, destination, originRoot, baseDir: path.join(originRoot, 'target') }
}
const U = 'user-bytes-unique'

// 1. Real run: post-hash swap moves the replacement into this run's destination.
withFx((fx) => {
  const f = buildSwapFixture(fx.root)
  const content = `displaced-${fx.runId}`
  const out = runC4Candidate({
    candidate: 'C4',
    parentAbs: fx.root,
    name: 'tree',
    window: 'post-hash',
    opId: `dt-${fx.runId}`,
    onFire: () => renameAsideAndReplace(f.targetAbs, { 'orig-f1': content }),
  })
  const loc = locateDisplaced(
    fx.root,
    { 'orig-f1': content },
    // The caller contract: destination is result.path ONLY for a quarantined run.
    {
      destination: out.result.status === 'quarantined' ? out.result.path : null,
      originRoot: f.treeRoot,
      baseDir: f.targetAbs,
    }
  )
  check(
    'real run: replacement moved into this destination counts displaced',
    out.result.status === 'quarantined' && loc.displaced === 1 && loc.deleted === 0,
    JSON.stringify(loc)
  )
})

// 2. Hand-built positive: right path, regular file, right content.
withFx((fx) => {
  const L = layout(fx)
  write(path.join(L.destination, 'target', 'orig-f1'), U)
  const loc = locateDisplaced(fx.root, { 'orig-f1': U }, L)
  check(
    'positive: same rel path + regular file + same content -> displaced',
    loc.displaced === 1 && loc.deleted === 0,
    JSON.stringify(loc)
  )
})

// 3. R1-F5 decoy: identical file at the identical relative path, but in ANOTHER op.
withFx((fx) => {
  const L = layout(fx)
  write(path.join(L.trash, 'op-stale', 'tree-aaaa', 'target', 'orig-f1'), U)
  const loc = locateDisplaced(fx.root, { 'orig-f1': U }, L)
  check(
    'decoy in a different op does NOT count displaced',
    loc.displaced === 0 && loc.deleted === 1,
    JSON.stringify(loc)
  )
})

// 4. Same op, same content, WRONG relative path.
withFx((fx) => {
  const L = layout(fx)
  write(path.join(L.destination, 'zzz-sibling', 'orig-f1'), U)
  const loc = locateDisplaced(fx.root, { 'orig-f1': U }, L)
  check(
    'same content at a different relative path does NOT count displaced',
    loc.displaced === 0 && loc.deleted === 1,
    JSON.stringify(loc)
  )
})

// 5. Right path, right bytes reachable, wrong TYPE (a symlink to a file with them).
withFx((fx) => {
  const L = layout(fx)
  const elsewhere = path.join(fx.root, 'elsewhere.txt')
  write(elsewhere, U)
  fs.mkdirSync(path.join(L.destination, 'target'), { recursive: true })
  fs.symlinkSync(elsewhere, path.join(L.destination, 'target', 'orig-f1'))
  const loc = locateDisplaced(fx.root, { 'orig-f1': U }, L)
  check(
    'symlink at the expected path does NOT count displaced',
    loc.displaced === 0 && loc.deleted === 1,
    JSON.stringify(loc)
  )
})

// 6. A symlinked INTERMEDIATE directory (A8a shape: target -> outside dir).
withFx((fx) => {
  const L = layout(fx)
  const outside = path.join(fx.root, 'outside')
  write(path.join(outside, 'orig-f1'), U)
  fs.symlinkSync(outside, path.join(L.destination, 'target'))
  const loc = locateDisplaced(fx.root, { 'orig-f1': U }, L)
  check(
    'file reached through a symlinked directory does NOT count displaced',
    loc.displaced === 0 && loc.deleted === 1,
    JSON.stringify(loc)
  )
})

// 7. destination null: this run quarantined nothing, so nothing can be displaced by it.
withFx((fx) => {
  const L = layout(fx)
  write(path.join(L.destination, 'target', 'orig-f1'), U)
  const loc = locateDisplaced(fx.root, { 'orig-f1': U }, { ...L, destination: null })
  check(
    'destination null -> every entry deleted',
    loc.displaced === 0 && loc.deleted === 1,
    JSON.stringify(loc)
  )
})

// 8. A file that was never inside the moved tree cannot have been displaced by it.
withFx((fx) => {
  const L = layout(fx)
  // Plant the bytes exactly where an UNGUARDED lookup would land: rel from
  // originRoot is ../outside/orig-f1, so destination/../outside/orig-f1. Without
  // the outside-originRoot guard this would read as displaced.
  write(path.join(L.destination, '..', 'outside', 'orig-f1'), U)
  const loc = locateDisplaced(
    fx.root,
    { 'orig-f1': U },
    { ...L, baseDir: path.join(fx.root, 'outside') }
  )
  check(
    'entry outside originRoot -> deleted, never looked up',
    loc.displaced === 0 && loc.deleted === 1,
    JSON.stringify(loc)
  )
})

// 9. Shape: the destination argument is REQUIRED and must be inside this fixture's trash.
withFx((fx) => {
  const L = layout(fx)
  for (const [label, where] of [
    ['no third argument', undefined],
    ['destination omitted', { originRoot: L.originRoot }],
    ['destination outside the trash', { ...L, destination: path.join(fx.root, 'tree') }],
    ['destination relative', { ...L, destination: 'op-this/tree-bbbb' }],
    ['originRoot relative', { ...L, originRoot: 'tree' }],
  ]) {
    let thrown = null
    try {
      locateDisplaced(fx.root, { 'orig-f1': U }, where)
    } catch (err) {
      thrown = err
    }
    check(
      `shape: ${label} -> TypeError`,
      thrown instanceof TypeError,
      thrown ? thrown.message.slice(0, 70) : 'no throw'
    )
  }
})

if (!allOk) {
  console.error('[c4-displaced self-test] FAIL')
  process.exit(1)
}
console.log('[c4-displaced self-test] all cases passed')
process.exit(0)
