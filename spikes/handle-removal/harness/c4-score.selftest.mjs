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
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, unlinkSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { makeRecord, classifyRecord } from './result-schema.mjs'
import { resolveHarnessRoot } from './fixture-root.mjs'
import { shortTargetRefusal } from './c4-target-guard.mjs'
import { c4Precondition } from './attacks/c4-score.mjs'
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
check('guard: run-c4-attacks.mjs exits 2 and writes nothing for a short default --out', () => {
  const r = spawnSync(
    process.execPath,
    [
      path.join(here, 'run-c4-attacks.mjs'),
      '--target',
      '1',
      '--only',
      'a3',
      '--fs-label',
      'selftest-guard',
    ],
    { encoding: 'utf8' }
  )
  const wrote = existsSync(path.join(rawDir, 'c4-attacks-selftest-guard.jsonl'))
  if (wrote) rmSync(path.join(rawDir, 'c4-attacks-selftest-guard.jsonl'), { force: true })
  return r.status === 2 && /refusing --target 1/.test(r.stderr) && !wrote
    ? true
    : `status=${r.status} wrote=${wrote} stderr=${r.stderr.slice(0, 200)}`
})
check(
  'guard: run-c4-attacks.mjs accepts the same short target with --out outside results/raw',
  () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'c4-guard-'))
    const r = spawnSync(
      process.execPath,
      [
        path.join(here, 'run-c4-attacks.mjs'),
        '--target',
        '1',
        '--only',
        'a3',
        '--fs-label',
        'selftest-guard',
        '--out',
        path.join(dir, 'o.jsonl'),
      ],
      { encoding: 'utf8' }
    )
    rmSync(dir, { recursive: true, force: true })
    return r.status === 0 ? true : `status=${r.status} stderr=${r.stderr.slice(0, 200)}`
  }
)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
