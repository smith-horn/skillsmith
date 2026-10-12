#!/usr/bin/env node
// SMI-6715: selftest for the C4 scoring helpers and the mutation post-conditions.
// Plain node; prints PASS/FAIL per case; exits non-zero on any FAIL.
//
//   node harness/c4-score.selftest.mjs
//
// Every "must read NEVER-RAN" case is END TO END: the attack module's runOnce is
// called with a seam (`_test`) that disables or sabotages the mutation, the raw
// result goes through makeRecord, and classifyRecord must say 'never-ran'. Each
// is paired with an unsabotaged run of the same module that must NOT be
// never-ran, so a classifier that says never-ran for everything cannot pass.

import path from 'node:path'
import os from 'node:os'
import { makeRunner, snapshotDir } from './c4-selftest-util.mjs'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { makeRecord, classifyRecord } from './result-schema.mjs'
import { resolveHarnessRoot } from './fixture-root.mjs'
import { shortTargetRefusal } from './c4-target-guard.mjs'
import { c4Precondition, padTree, trashHasSymlink } from './attacks/c4-score.mjs'
import * as a3 from './attacks/a3-c4.mjs'
import * as a4 from './attacks/a4-c4.mjs'
import * as a7 from './attacks/a7-c4.mjs'
import * as a8 from './attacks/a8-c4.mjs'
import * as a10 from './attacks/a10-c4.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const harnessRoot = resolveHarnessRoot()
let failures = 0
const check = (name, fn) => {
  try {
    const why = fn()
    if (why === true || why === undefined) console.log(`PASS  ${name}`)
    else {
      failures += 1
      console.log(`FAIL  ${name}: ${why}`)
    }
  } catch (err) {
    failures += 1
    console.log(`FAIL  ${name}: threw ${err?.message ?? err}`)
  }
}

const classify = (raw, attack, candidate) =>
  classifyRecord(
    makeRecord({
      cell: {
        attack,
        variant: 'selftest',
        candidate,
        fs: 'selftest',
        runner: 'c4-score.selftest.mjs',
      },
      run: 0,
      precondition: raw.precondition,
      outcome: raw.outcome,
      userFiles: raw.userFiles,
      durationMs: raw.durationMs,
    })
  )

// ---- F1: c4Precondition.mutationApplied -----------------------------------
const base = { hookFired: true, traceMatched: true, mutationError: null }
check('c4Precondition: completed + no error -> mutationApplied true', () =>
  c4Precondition(base, true).mutationApplied === true ? true : 'expected true'
)
check('c4Precondition: mutationError set -> mutationApplied false', () => {
  const p = c4Precondition(
    { ...base, mutationError: { name: 'Error', message: 'x', code: null } },
    true
  )
  return p.mutationApplied === false ? true : `got ${p.mutationApplied}`
})
check('c4Precondition: completed=false -> mutationApplied false', () => {
  const p = c4Precondition(base, false)
  return p.mutationApplied === false ? true : `got ${p.mutationApplied}`
})
check('c4Precondition: values are strict booleans', () =>
  Object.values(c4Precondition(base, true)).every((v) => typeof v === 'boolean')
    ? true
    : 'non-boolean value'
)

// ---- F1/F2: end to end ------------------------------------------------------
const noop = { mutate: () => {} }
const ARMS = ['C4', 'C4-naive']

for (const arm of ARMS) {
  check(`A10b ${arm}: unsabotaged fixture is NOT never-ran (positive control)`, () => {
    const raw = a10.runOnce({ harnessRoot, candidate: arm, subcase: 'b' })
    const cls = classify(raw, 'A10b-C4', arm)
    return cls === 'passed' && raw.precondition.mutationApplied === true ? true : `class=${cls}`
  })
  check(`A10b ${arm}: fixture with nlink < 2 -> mutationApplied false -> NEVER-RAN`, () => {
    const raw = a10.runOnce({
      harnessRoot,
      candidate: arm,
      subcase: 'b',
      _test: { afterFixture: (fx) => unlinkSync(fx.hardlinkAbs) },
    })
    const cls = classify(raw, 'A10b-C4', arm)
    return raw.precondition.mutationApplied === false && cls === 'never-ran' ? true : `class=${cls}`
  })
}

const NOOP_CASES = [
  ['A3', 'A3-C4', (arm) => a3.runOnce({ harnessRoot, candidate: arm, _test: noop })],
  ['A4', 'A4-C4', (arm) => a4.runOnce({ harnessRoot, candidate: arm, _test: noop })],
  ...['between', 'late'].flatMap((subcase) =>
    ['file', 'symlink'].map((entryKind) => [
      `A7 ${subcase}-${entryKind}`,
      'A7-C4',
      (arm) => a7.runOnce({ harnessRoot, candidate: arm, subcase, entryKind, _test: noop }),
    ])
  ),
  [
    'A8a',
    'A8a-C4',
    (arm) => a8.runOnce({ harnessRoot, candidate: arm, subcase: 'a', _test: noop }),
  ],
  ['A8b', 'A8-C4', (arm) => a8.runOnce({ harnessRoot, candidate: arm, subcase: 'b', _test: noop })],
  [
    'A10a',
    'A10-C4',
    (arm) => a10.runOnce({ harnessRoot, candidate: arm, subcase: 'a', _test: noop }),
  ],
]
for (const [name, attack, run] of NOOP_CASES) {
  for (const arm of ARMS) {
    check(`${name} ${arm}: no-op mutation -> mutationApplied false -> NEVER-RAN`, () => {
      const raw = run(arm)
      const cls = classify(raw, attack, arm)
      return raw.precondition.mutationApplied === false && cls === 'never-ran'
        ? true
        : `mutationApplied=${raw.precondition.mutationApplied} class=${cls}`
    })
  }
}

// Positive controls for the same modules: a real mutation must NOT be never-ran.
for (const [name, attack, run] of [
  ['A3', 'A3-C4', (arm) => a3.runOnce({ harnessRoot, candidate: arm })],
  ['A8a', 'A8a-C4', (arm) => a8.runOnce({ harnessRoot, candidate: arm, subcase: 'a' })],
]) {
  for (const arm of ARMS) {
    check(`${name} ${arm}: real mutation is NOT never-ran (positive control)`, () => {
      const raw = run(arm)
      const cls = classify(raw, attack, arm)
      return raw.precondition.mutationApplied === true && cls !== 'never-ran'
        ? true
        : `class=${cls}`
    })
  }
}

check('A8a C4-naive: quarantined but link missing from trash -> run throws (harness-error)', () => {
  try {
    a8.runOnce({
      harnessRoot,
      candidate: 'C4-naive',
      subcase: 'a',
      _test: {
        beforeScore: ({ fxRoot }) =>
          rmSync(path.join(fxRoot, '.skillsmith-trash'), { recursive: true, force: true }),
      },
    })
  } catch (err) {
    return /trash/.test(err.message) ? true : `threw something else: ${err.message}`
  }
  return 'did not throw'
})

// ---- R2-2: A10b hard link moved out of the tree (nlink still 2) -----------------
for (const arm of ARMS) {
  check(`A10b ${arm}: hard link moved outside the tree (nlink still 2) -> NEVER-RAN`, () => {
    const raw = a10.runOnce({
      harnessRoot,
      candidate: arm,
      subcase: 'b',
      _test: {
        afterFixture: (fx) =>
          renameSync(fx.hardlinkAbs, path.join(path.dirname(fx.outsideFile), 'moved-link')),
      },
    })
    const cls = classify(raw, 'A10b-C4', arm)
    return raw.precondition.mutationApplied === false && cls === 'never-ran' ? true : `class=${cls}`
  })
}

for (const arm of ARMS) {
  check(
    `A10b ${arm}: tree entry is a symlink to the outside file, not a hard link -> NEVER-RAN`,
    () => {
      const raw = a10.runOnce({
        harnessRoot,
        candidate: arm,
        subcase: 'b',
        _test: {
          afterFixture: (fx) => {
            // keep nlink(outside) at 2 via a link elsewhere, so only the identity check can object
            linkSync(fx.outsideFile, path.join(path.dirname(fx.outsideFile), 'extra-link'))
            unlinkSync(fx.hardlinkAbs)
            symlinkSync(fx.outsideFile, fx.hardlinkAbs)
          },
        },
      })
      const cls = classify(raw, 'A10b-C4', arm)
      return raw.precondition.mutationApplied === false && cls === 'never-ran'
        ? true
        : `class=${cls}`
    }
  )
}

// ---- R2-6: A8a mutation pointing the symlink at the WRONG dir -------------------
for (const arm of ARMS) {
  check(`A8a ${arm}: symlink to the wrong directory -> mutationApplied false -> NEVER-RAN`, () => {
    const raw = a8.runOnce({
      harnessRoot,
      candidate: arm,
      subcase: 'a',
      _test: {
        mutate: (sf) => {
          rmSync(sf.targetAbs, { recursive: true, force: true })
          symlinkSync(path.dirname(sf.outsideDir), sf.targetAbs)
        },
      },
    })
    const cls = classify(raw, 'A8a-C4', arm)
    return raw.precondition.mutationApplied === false && cls === 'never-ran' ? true : `class=${cls}`
  })
}

// ---- S2-Low: displaced symlinks are located against THIS run's destination -------------
{
  const root = mkdtempSync(path.join(os.tmpdir(), 'c4-sym-'))
  const tree = path.join(root, 'tree')
  const trash = path.join(root, '.skillsmith-trash')
  const thisOp = path.join(trash, 'op-this', 'tree-aaa')
  const staleOp = path.join(trash, 'op-stale', 'tree-bbb')
  for (const d of [thisOp, staleOp]) mkdirSync(d, { recursive: true })
  const original = path.join(tree, 'link')
  const decoy = path.join(staleOp, 'link') // a stale link left by another operation
  symlinkSync('/wanted-target', decoy)
  const where = (destination) => ({ destination, originRoot: tree })
  check('trashHasSymlink: a decoy link in ANOTHER op is not counted (destination null)', () =>
    trashHasSymlink(root, original, '/wanted-target', where(null)) === false ? true : 'counted'
  )
  check(
    'trashHasSymlink: a decoy link in ANOTHER op is not counted when this run moved elsewhere',
    () =>
      trashHasSymlink(root, original, '/wanted-target', where(thisOp)) === false ? true : 'counted'
  )
  symlinkSync('/wanted-target', path.join(thisOp, 'link'))
  check(
    "trashHasSymlink: the link inside THIS run's destination is counted (positive control)",
    () =>
      trashHasSymlink(root, original, '/wanted-target', where(thisOp)) === true ? true : 'not found'
  )
  check('trashHasSymlink: the wrong link text inside this destination is not counted', () =>
    trashHasSymlink(root, original, '/other-target', where(thisOp)) === false ? true : 'counted'
  )
  check('trashHasSymlink: a destination outside the trash root is rejected', () => {
    try {
      trashHasSymlink(root, original, '/wanted-target', where(path.join(root, 'elsewhere')))
    } catch (err) {
      return /not inside/.test(err.message) ? true : err.message
    }
    return 'did not throw'
  })
  rmSync(root, { recursive: true, force: true })
}

// ---- STEP-1: --dirs pads the fixture tree without touching attacked paths -----------------
const countDirs = (d) =>
  1 +
  readdirSync(d, { withFileTypes: true }).reduce(
    (n, e) => n + (e.isDirectory() ? countDirs(path.join(d, e.name)) : 0),
    0
  )
check('padTree: pads to exactly n directories under zz-pad, leaving other paths alone', () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'c4-pad-'))
  try {
    mkdirSync(path.join(d, 'tree', 'target'), { recursive: true })
    const actual = padTree(path.join(d, 'tree'), 50)
    const dirs = countDirs(path.join(d, 'tree'))
    const top = readdirSync(path.join(d, 'tree')).sort().join()
    return actual === 50 && dirs === 50 && top === 'target,zz-pad'
      ? true
      : `actual=${actual} dirs=${dirs} top=${top}`
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})
check('padTree: asking for fewer directories than the fixture already has throws', () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'c4-pad-'))
  try {
    mkdirSync(path.join(d, 'tree', 'a', 'b'), { recursive: true })
    padTree(path.join(d, 'tree'), 2)
  } catch (err) {
    return /below the fixture minimum/.test(err.message) ? true : err.message
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
  return 'did not throw'
})
for (const [mod, name, attack, args, c4Class = 'passed'] of [
  [a3, 'A3', 'A3-C4', {}],
  [a4, 'A4', 'A4-C4', {}, 'failed'], // the root-only re-check cannot see a post-hash swap
  [a8, 'A8b', 'A8-C4', { subcase: 'b' }],
  [a10, 'A10a', 'A10-C4', { subcase: 'a' }],
]) {
  check(
    `${name} --dirs 50: actualDirs is 50 on both arms; C4 ${c4Class}, naive failed (as unpadded)`,
    () => {
      const c4 = mod.runOnce({ harnessRoot, candidate: 'C4', dirs: 50, ...args })
      const nv = mod.runOnce({ harnessRoot, candidate: 'C4-naive', dirs: 50, ...args })
      const ok =
        c4.extra.actualDirs === 50 &&
        nv.extra.actualDirs === 50 &&
        classify(c4, attack, 'C4') === c4Class &&
        classify(nv, attack, 'C4-naive') === 'failed'
      return ok
        ? true
        : `actual=${c4.extra.actualDirs}/${nv.extra.actualDirs} c4=${classify(c4, attack, 'C4')} naive=${classify(nv, attack, 'C4-naive')}`
    }
  )
}
check('A7 late-append --dirs 50: padded fixture, naive still displaces', () => {
  const nv = a7.runOnce({ harnessRoot, candidate: 'C4-naive', subcase: 'late-append', dirs: 50 })
  return nv.extra.actualDirs === 50 && classify(nv, 'A7-C4', 'C4-naive') === 'failed'
    ? true
    : JSON.stringify(nv.extra.actualDirs)
})

// ---- R2-3: the short-target guard compares file IDENTITY, not spellings ---------
{
  const base = mkdtempSync(path.join(os.tmpdir(), 'c4-ident-'))
  const rawReal = path.join(realpathSync(base), 'raw')
  mkdirSync(rawReal)
  mkdirSync(path.join(base, 'raw-x'))
  symlinkSync(rawReal, path.join(base, 'lnk'))
  const g = (out) =>
    shortTargetRefusal({
      out,
      requested: 3,
      modules: [{ name: 'a3', target: 30 }],
      rawDir: rawReal,
    })
  check('guard: --out equal to the corpus dir itself is refused', () =>
    g(rawReal) ? true : 'allowed'
  )
  check('guard: --out in a not-yet-existing subdir of the corpus is refused', () =>
    g(path.join(rawReal, 'a', 'b', 'x.jsonl')) ? true : 'allowed'
  )
  check('guard: --out through a symlink that points at the corpus is refused', () =>
    g(path.join(base, 'lnk', 'x.jsonl')) ? true : 'allowed'
  )
  check(
    'guard: --out spelled via the non-canonical temp path (e.g. /var vs /private/var) is refused',
    () => (g(path.join(base, 'raw', 'x.jsonl')) ? true : 'allowed')
  )
  if (existsSync(path.join(base, 'RAW'))) {
    check(
      'guard: a case-variant spelling of the corpus dir is refused (case-insensitive fs)',
      () => (g(path.join(base, 'RAW', 'x.jsonl')) ? true : 'allowed')
    )
  } else {
    console.log('SKIP  guard: case-variant spelling (this filesystem is case-sensitive)')
  }
  check('guard: a sibling dir and an unrelated dir are still allowed (negative controls)', () =>
    g(path.join(base, 'raw-x', 'y.jsonl')) === null && g(path.join(base, 'other.jsonl')) === null
      ? true
      : 'refused'
  )
  rmSync(base, { recursive: true, force: true })
}

// ---- F8b: short-target guard -------------------------------------------------
const rawDir = path.join(here, '..', 'results', 'raw')
const mods = [{ name: 'a3', target: 30 }]
check('guard: short target under results/raw is refused', () =>
  shortTargetRefusal({ out: path.join(rawDir, 'x.jsonl'), requested: 3, modules: mods, rawDir })
    ? true
    : 'allowed'
)
check('guard: full target under results/raw is allowed', () =>
  shortTargetRefusal({
    out: path.join(rawDir, 'x.jsonl'),
    requested: 30,
    modules: mods,
    rawDir,
  }) === null
    ? true
    : 'refused'
)
check('guard: short target outside results/raw is allowed', () =>
  shortTargetRefusal({
    out: path.join(os.tmpdir(), 'x.jsonl'),
    requested: 3,
    modules: mods,
    rawDir,
  }) === null
    ? true
    : 'refused'
)
check('guard: a sibling dir named results/raw-x is not under results/raw', () =>
  shortTargetRefusal({ out: `${rawDir}-x/y.jsonl`, requested: 3, modules: mods, rawDir }) === null
    ? true
    : 'refused'
)
// End to end through the real runner, with the guard's "corpus" relocated to a
// scratch dir (C4_RESULTS_RAW_DIR) so a broken guard writes there, not to results/raw.
const R = makeRunner(here)
const rawBefore = snapshotDir(rawDir)
check(
  'guard: run-c4-attacks.mjs exits 2 and writes nothing for a short --out under the corpus dir',
  () => {
    const target = path.join(R.simRaw, 'x.jsonl')
    const r = R.run('run-c4-attacks.mjs', [
      '--only',
      'a3',
      '--fs-label',
      'selftest-guard',
      '--out',
      target,
    ])
    const wrote = existsSync(target)
    return r.status === 2 && /refusing --target 1/.test(r.stderr) && !wrote
      ? true
      : `status=${r.status} wrote=${wrote} stderr=${r.stderr.slice(0, 200)}`
  }
)
check(
  'guard: run-c4-attacks.mjs accepts the same short target with --out outside the corpus dir',
  () => {
    const r = R.run('run-c4-attacks.mjs', ['--only', 'a3', '--fs-label', 'selftest-guard'])
    return r.status === 0 ? true : `status=${r.status} stderr=${r.stderr.slice(0, 200)}`
  }
)
check('results/raw is byte-for-byte unchanged by this selftest (names + sizes)', () => {
  const after = snapshotDir(rawDir)
  return after === rawBefore ? true : `changed:\n before=${rawBefore}\n after=${after}`
})
R.cleanup()

// ---- locateDisplaced wiring: a moved user file is DISPLACED, a missing one DELETED ---
check('A3 C4-naive: the moved replacement is counted displaced (destination wired through)', () => {
  const raw = a3.runOnce({ harnessRoot, candidate: 'C4-naive' })
  const u = raw.userFiles
  return u.lost === 1 && u.displaced === 1 && u.deleted === 0 ? true : JSON.stringify(u)
})
check('A8a C4-naive: outside bytes (lookup through a symlink) are never counted displaced', () => {
  const raw = a8.runOnce({ harnessRoot, candidate: 'C4-naive', subcase: 'a' })
  const u = raw.userFiles
  return u.lost === 0 && u.displaced === 0 && u.deleted === 0 ? true : JSON.stringify(u)
})

// ---- A7 edit subcases (late-renameover / late-append / late-chmod / late-create) -----
for (const subcase of a7.EDIT_SUBCASES) {
  for (const arm of ARMS) {
    check(`A7 ${subcase} ${arm}: no-op mutation -> mutationApplied false -> NEVER-RAN`, () => {
      const raw = a7.runOnce({ harnessRoot, candidate: arm, subcase, _test: noop })
      const cls = classify(raw, 'A7-C4', arm)
      return raw.precondition.mutationApplied === false && cls === 'never-ran'
        ? true
        : `mutationApplied=${raw.precondition.mutationApplied} class=${cls}`
    })
    check(
      `A7 ${subcase} ${arm}: real mutation lands and is NOT never-ran (positive control)`,
      () => {
        const raw = a7.runOnce({ harnessRoot, candidate: arm, subcase })
        const cls = classify(raw, 'A7-C4', arm)
        return raw.precondition.mutationApplied === true && cls !== 'never-ran'
          ? true
          : `class=${cls}`
      }
    )
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
