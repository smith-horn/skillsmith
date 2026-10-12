#!/usr/bin/env node
// SMI-6715: runner selftest: --dirs padding.
// Plain node; PASS/FAIL per case; non-zero exit on failure. Every runner spawn is
// sandboxed (scratch --out, --target 1, relocated short-target corpus dir) and the
// real results/raw is snapshotted around the run (see c4-selftest-util.mjs).
//
//   node harness/c4-runner-dirs.selftest.mjs

import path from 'node:path'
import { readFileSync } from 'node:fs'
import { runCells } from './run-c4-attacks.mjs'
import { makeSelftest } from './c4-selftest-util.mjs'

const { check, harnessRoot, R, run, exits2With, finish } = makeSelftest(import.meta.url)

// ---- STEP-1: --dirs ------------------------------------------------------------------------
check(
  '--dirs 50 end to end: cell.dirs, variant tag and extra.actualDirs are recorded; verdicts hold',
  () => {
    const o = path.join(R.scratch, 'dirs-check.jsonl')
    const r = R.run('run-c4-attacks.mjs', ['--only', 'a3', '--dirs', '50', '--out', o])
    if (r.status !== 0) return `status=${r.status} stderr=${r.stderr.slice(0, 200)}`
    const recs = readFileSync(o, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    const ok =
      recs.length === 2 &&
      recs.every(
        (x) =>
          x.cell.dirs === 50 && x.cell.variant.endsWith('/dirs=50') && x.extra.actualDirs === 50
      )
    const naiveFails = recs.find((x) => x.cell.candidate === 'C4-naive').userFiles.lost === 1
    const c4Passes = recs.find((x) => x.cell.candidate === 'C4').userFiles.lost === 0
    return ok && naiveFails && c4Passes
      ? true
      : `ok=${ok} naiveFails=${naiveFails} c4Passes=${c4Passes}`
  }
)
check('without --dirs: cell.dirs is null and the variant tag has no dirs suffix', () => {
  const o = path.join(R.scratch, 'nodirs-check.jsonl')
  const r = R.run('run-c4-attacks.mjs', ['--only', 'a3', '--out', o])
  if (r.status !== 0) return `status=${r.status}`
  const recs = readFileSync(o, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  return recs.every((x) => x.cell.dirs === null && !/dirs=/.test(x.cell.variant))
    ? true
    : JSON.stringify(recs[0].cell)
})
check(
  'a module that does not pad when --dirs is requested becomes harness-error, not a fake dirs cell',
  async () => {
    const lazy = { target: 30, runOnce: () => ({ extra: { label: 'X-C4' } }) }
    const cells = await runCells({
      mod: lazy,
      args: {},
      labels: ['X-C4'],
      tag: 't',
      target: 1,
      harnessRoot,
      fsLabel: 'selftest',
      out: null,
      interleave: false,
      dirs: 50,
    })
    const rec = cells.C4.records[0]
    return rec.outcome.status === 'harness-error' && /actualDirs/.test(rec.outcome.reason)
      ? true
      : JSON.stringify(rec.outcome)
  }
)
check('--dirs abc / --dirs 0 are usage errors (both runners, before any platform check)', () => {
  const a = exits2With(
    run('run-c4-attacks.mjs', ['--only', 'a3', '--dirs', 'abc']),
    /positive integer/
  )
  const m = exits2With(run('run-c4-mount-attacks.mjs', ['--dirs', '0']), /positive integer/)
  return a === true && m === true ? true : `${a} | ${m}`
})
check('--dirs below the fixture minimum is reported, not silently under-padded', () => {
  const o = path.join(R.scratch, 'dirs-min.jsonl')
  const r = R.run('run-c4-attacks.mjs', ['--only', 'a3', '--dirs', '2', '--out', o])
  const recs = readFileSync(o, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  return r.status === 0 &&
    recs.every(
      (x) =>
        x.outcome.status === 'harness-error' && /below the fixture minimum/.test(x.outcome.reason)
    )
    ? true
    : `status=${r.status} ${JSON.stringify(recs[0]?.outcome)}`
})

await finish()
