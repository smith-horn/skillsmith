#!/usr/bin/env node
// SMI-6715: selftest for the C4 runners' argument handling and for a1-c4's
// cleanup error handling. Plain node; PASS/FAIL per case; non-zero on failure.
//
//   node harness/c4-runner.selftest.mjs

import path from 'node:path'
import os from 'node:os'
import { makeRunner, snapshotDir } from './c4-selftest-util.mjs'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveHarnessRoot } from './fixture-root.mjs'
import { makeRecord } from './result-schema.mjs'
import { scoreCell, runCells } from './run-c4-attacks.mjs'
import { parseFlags } from './c4-target-guard.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const harnessRoot = resolveHarnessRoot()
let failures = 0
const report = (name, why) => {
  if (why === true || why === undefined) console.log(`PASS  ${name}`)
  else {
    failures += 1
    console.log(`FAIL  ${name}: ${why}`)
  }
}
// Sync cases run where they are registered. Async cases share module state
// (orderLog), so they are queued and run one at a time at the end.
const queued = []
const check = (name, fn) => {
  if (fn.constructor.name === 'AsyncFunction') {
    queued.push({ name, fn })
    return
  }
  try {
    report(name, fn())
  } catch (err) {
    report(name, `threw ${err?.message ?? err}`)
  }
}

// Every spawn goes through makeRunner: --out in a scratch dir, --target 1, and the
// short-target guard pointed at a scratch dir, so no command line (however
// mis-parsed) can reach results/raw. The real corpus is snapshotted around the whole
// run and any change FAILS the selftest.
const realRaw = path.join(here, '..', 'results', 'raw')
const rawBefore = snapshotDir(realRaw)
const R = makeRunner(here)
const run = R.run
const exits2With = (r, re) =>
  r.status === 2 && re.test(r.stderr) ? true : `status=${r.status} stderr=${r.stderr.slice(0, 240)}`

// ---- G3: run-c4-attacks.mjs argument validation ---------------------------
const tmp = mkdtempSync(path.join(os.tmpdir(), 'c4-runner-'))
const out = path.join(tmp, 'o.jsonl')
const A = 'run-c4-attacks.mjs'
check('attacks: --only a99 -> exit 2 naming a99', () =>
  exits2With(run(A, ['--only', 'a99', '--out', out]), /a99/)
)
check('attacks: --only a3,a99 -> exit 2 (one bad entry rejects all)', () =>
  exits2With(run(A, ['--only', 'a3,a99', '--out', out]), /a99/)
)
check('attacks: --only a3, (empty entry) -> exit 2', () =>
  exits2With(run(A, ['--only', 'a3,', '--out', out]), /unknown --only/)
)
check('attacks: unknown flag -> exit 2', () =>
  exits2With(run(A, ['--bogus', '1', '--out', out]), /unknown argument/)
)
check('attacks: positional argument -> exit 2', () =>
  exits2With(run(A, ['a3', '--out', out]), /unknown argument/)
)
check('attacks: --target with no value -> exit 2', () =>
  exits2With(run(A, ['--only', 'a3', '--target']), /requires a value/)
)
check('attacks: --only followed by another flag -> exit 2', () =>
  exits2With(run(A, ['--only', '--target', '1']), /requires a value/)
)
check('attacks: --target abc -> exit 2', () =>
  exits2With(run(A, ['--only', 'a3', '--target', 'abc', '--out', out]), /positive integer/)
)
check('attacks: --target 0 -> exit 2', () =>
  exits2With(run(A, ['--only', 'a3', '--target', '0', '--out', out]), /positive integer/)
)
check('attacks: every known key (a3,a4,a7,a8,a10,a13) passes validation; only a99 is named', () =>
  exits2With(run(A, ['--only', 'a99,a3,a4,a7,a8,a10,a13', '--out', out]), /entry: a99 \(known/)
)
check('attacks: valid arguments still run and exit 0 (positive control)', () => {
  const r = run(A, ['--only', 'a3', '--target', '1', '--fs-label', 'selftest', '--out', out])
  return r.status === 0 && /A3-C4/.test(r.stdout)
    ? true
    : `status=${r.status} stderr=${r.stderr.slice(0, 240)}`
})

// ---- G3: run-c4-mount-attacks.mjs validates BEFORE its platform check ------
const M = 'run-c4-mount-attacks.mjs'
check('mount: unknown flag -> usage error, not the Linux-only message', () => {
  const r = run(M, ['--bogus', '1'])
  return r.status === 2 && /unknown argument/.test(r.stderr) && !/Linux only/.test(r.stderr)
    ? true
    : `status=${r.status} stderr=${r.stderr.slice(0, 240)}`
})
check('mount: --target with no value -> usage error', () =>
  exits2With(run(M, ['--target']), /requires a value/)
)
check('mount: --target abc -> usage error', () =>
  exits2With(run(M, ['--target', 'abc']), /positive integer/)
)
if (process.platform !== 'linux') {
  check(
    'mount: valid arguments off Linux still hit the Linux-only refusal (positive control)',
    () => exits2With(run(M, ['--target', '1', '--out', out]), /Linux only/)
  )
}
rmSync(tmp, { recursive: true, force: true })

// ---- G1: record-only cells show what verdictFor returns ---------------------
const oomRecord = (lost, target = 1) => oomRecordFor('A13-C4-OOM', lost, target)
// cell.target is what the summary compares `ran` with, so the records carry one
const oomRecordFor = (attack, lost = 0, target = 1) => {
  const rec = makeRecord({
    cell: {
      attack,
      variant: 'racer/by-timestamp',
      candidate: 'C4',
      fs: 'selftest',
      runner: 'c4-runner.selftest.mjs',
    },
    run: 0,
    precondition: {
      hookFired: true,
      mutationApplied: true,
      traceMatched: true,
      controlExpected: true,
    },
    outcome: { status: 'quarantined' },
    userFiles: { checked: 1, lost, changed: 0, displaced: lost, deleted: 0 },
    durationMs: 1,
  })
  rec.cell.target = target
  return rec
}
const oomLine = (lost) =>
  scoreCell({
    label: 'A13-C4-OOM',
    variant: 'racer/by-timestamp',
    candidate: 'C4',
    records: [oomRecord(lost)],
    target: 1,
    rows: [
      {
        attack: 'A13-C4-OOM',
        variant: 'racer/by-timestamp',
        candidate: 'C4',
        fs: 'selftest',
        failed: lost,
      },
    ],
  })
check('record-only: a lost file shows as RECORD-ONLY (1 lost), not a bare RECORD-ONLY', () => {
  const line = oomLine(1)
  return /^RECORD-ONLY \(1 lost\)\t/.test(line) ? true : `got ${JSON.stringify(line)}`
})
check('record-only: no loss shows a bare RECORD-ONLY (positive control)', () => {
  const line = oomLine(0)
  return /^RECORD-ONLY\t/.test(line) ? true : `got ${JSON.stringify(line)}`
})

// ---- G2-1: script guard works through a symlinked path --------------------------
check('attacks: runs (not a silent no-op) when invoked through a symlink', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'c4-link-'))
  try {
    const link = path.join(dir, 'run-c4-attacks.mjs')
    symlinkSync(path.join(here, 'run-c4-attacks.mjs'), link)
    const r = run(link, [
      '--only',
      'a3',
      '--fs-label',
      'selftest',
      '--out',
      path.join(dir, 'o.jsonl'),
    ])
    return r.status === 0 && /A3-C4/.test(r.stdout)
      ? true
      : `status=${r.status} stdout=${JSON.stringify(r.stdout.slice(0, 120))} stderr=${r.stderr.slice(0, 160)}`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- G2-4: a repeated flag is an error --------------------------------------------
check('parseFlags: a repeated flag is an error naming the flag', () => {
  const r = parseFlags(['--only', 'a3', '--only', 'a4'], {
    '--only': { key: 'only', kind: 'list' },
  })
  return /--only given more than once/.test(r.error ?? '') ? true : `got ${JSON.stringify(r)}`
})
check('attacks: missing --out -> exit 2 (no default into results/raw)', () =>
  exits2With(run(A, ['--only', 'a3'], { noOut: true }), /--out .* is required/)
)
check('mount: missing --out -> usage error before the Linux-only check', () => {
  const r = run(M, [], { noOut: true })
  return r.status === 2 && /--out .* is required/.test(r.stderr) && !/Linux only/.test(r.stderr)
    ? true
    : `status=${r.status} stderr=${r.stderr.slice(0, 240)}`
})
check('attacks: --only a3 --only a4 -> exit 2', () =>
  exits2With(run(A, ['--only', 'a3', '--only', 'a4']), /more than once/)
)

// ---- F4: A13 arms are interleaved per run, in random order -------------------------
const orderLog = []
const fakeMod = {
  runOnce: ({ candidate }) => {
    orderLog.push(candidate)
    throw new Error('fake: order test only')
  },
}
const cellsFor = (interleave, rng) => {
  orderLog.length = 0
  return runCells({
    mod: fakeMod,
    args: {},
    labels: ['A13-C4', 'A13-C4-OOM'],
    tag: 't',
    target: 4,
    harnessRoot,
    fsLabel: 'selftest',
    out: null,
    interleave,
    rng,
  })
}
const scripted = (vals) => {
  let i = 0
  return () => vals[i++ % vals.length]
}
check(
  'interleave: scripted rng gives exactly alternating-pair order, C4 or naive first',
  async () => {
    await cellsFor(true, scripted([0.1, 0.9, 0.1, 0.9]))
    const want = ['C4', 'C4-naive', 'C4-naive', 'C4', 'C4', 'C4-naive', 'C4-naive', 'C4']
    return JSON.stringify(orderLog) === JSON.stringify(want)
      ? true
      : `got ${JSON.stringify(orderLog)}`
  }
)
check(
  'non-interleaved (deterministic rows): all C4 runs then all C4-naive runs, unchanged',
  async () => {
    await cellsFor(false)
    const want = ['C4', 'C4', 'C4', 'C4', 'C4-naive', 'C4-naive', 'C4-naive', 'C4-naive']
    return JSON.stringify(orderLog) === JSON.stringify(want)
      ? true
      : `got ${JSON.stringify(orderLog)}`
  }
)
check(
  'interleave: real rng produces both orders; every pair has both arms; run indexes 0..n-1 per arm',
  async () => {
    orderLog.length = 0
    const cells = await runCells({
      mod: fakeMod,
      args: {},
      labels: ['A13-C4', 'A13-C4-OOM'],
      tag: 't',
      target: 40,
      harnessRoot,
      fsLabel: 'selftest',
      out: null,
      interleave: true,
    })
    const pairs = []
    for (let i = 0; i < orderLog.length; i += 2) pairs.push(`${orderLog[i]}>${orderLog[i + 1]}`)
    const okPairs = pairs.every((p) => p === 'C4>C4-naive' || p === 'C4-naive>C4')
    const both = new Set(pairs).size === 2
    const idx = cells.C4.records.map((r) => r.run).join() === [...Array(40).keys()].join()
    const stamped = cells.C4.extras.every(
      (e) => e?.armOrder === 'C4-first' || e?.armOrder === 'naive-first'
    )
    return okPairs && both && idx && stamped
      ? true
      : `okPairs=${okPairs} both=${both} idx=${idx} stamped=${stamped}`
  }
)

// ---- F4: straddle count beside the A13 verdict -------------------------------------
const straddleLine = (extras) =>
  scoreCell({
    label: 'A13-C4-OOM',
    variant: 'racer/by-timestamp',
    candidate: 'C4',
    records: [oomRecord(0, 2), oomRecord(0, 2)],
    target: 2,
    extras,
    rows: [
      {
        attack: 'A13-C4-OOM',
        variant: 'racer/by-timestamp',
        candidate: 'C4',
        fs: 'selftest',
        failed: 0,
      },
    ],
  })
check('straddles: summed from extra.straddleCount when supplied', () =>
  /straddles=3(\t|$)/.test(straddleLine([{ straddleCount: 1 }, { straddleCount: 2 }]))
    ? true
    : straddleLine([{ straddleCount: 1 }, { straddleCount: 2 }])
)
check('straddles: n/a when the module supplies none', () =>
  /straddles=n\/a(\t|$)/.test(straddleLine([null, {}])) ? true : straddleLine([null, {}])
)

// ---- R2-3: every record carries the module's target for its cell -------------------
check('records carry cell.target = the module target, not the requested --target', () => {
  const o = path.join(R.scratch, 'target-check.jsonl')
  const r = R.run('run-c4-attacks.mjs', ['--only', 'a3', '--out', o])
  if (r.status !== 0) return `status=${r.status} stderr=${r.stderr.slice(0, 160)}`
  const recs = readFileSync(o, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  return recs.length === 2 && recs.every((x) => x.cell.target === 30)
    ? true
    : `targets=${JSON.stringify(recs.map((x) => x.cell.target))}`
})

// ---- R2-4: A13 harness errors are filed under the scored label whatever the order --
check('A13 harness errors file under A13-C4 even when the label order is swapped', async () => {
  const throwing = {
    target: 300,
    runOnce: () => {
      throw new Error('fake: module crashed')
    },
  }
  const cells = await runCells({
    mod: throwing,
    args: {},
    labels: ['A13-C4-OOM', 'A13-C4'],
    tag: 't',
    target: 3,
    harnessRoot,
    fsLabel: 'selftest',
    out: null,
    interleave: true,
  })
  const all = [...cells.C4.records, ...cells['C4-naive'].records]
  const labelsOk = [...cells.C4.runLabels, ...cells['C4-naive'].runLabels].every(
    (l) => l === 'A13-C4'
  )
  const attacksOk = all.every(
    (x) => x.cell.attack === 'A13-C4' && x.outcome.status === 'harness-error'
  )
  return labelsOk && attacksOk && all.length === 6
    ? true
    : `labelsOk=${labelsOk} attacksOk=${attacksOk}`
})

// ---- R2: vacuous-check exclusions are counted beside the A13 verdict -----------------
const vacuousLine = (extras) =>
  scoreCell({
    label: 'A13-C4',
    variant: 'racer/by-timestamp',
    candidate: 'C4',
    records: [oomRecordFor('A13-C4', 0, 2), oomRecordFor('A13-C4', 0, 2)],
    target: 2,
    extras,
    rows: [
      {
        attack: 'A13-C4',
        variant: 'racer/by-timestamp',
        candidate: 'C4',
        fs: 'selftest',
        failed: 0,
      },
    ],
  })
check('vacuous: counted from extra.excludedReason === vacuous-check', () => {
  const line = vacuousLine([{ excludedReason: 'vacuous-check' }, { excludedReason: 'other' }])
  return /vacuousExcluded=1(\t|$)/.test(line) ? true : line
})
check('vacuous: n/a when the module never supplies excludedReason', () => {
  const line = vacuousLine([{}, null])
  return /vacuousExcluded=n\/a(\t|$)/.test(line) ? true : line
})

// Async cases run last, one at a time (they share module state), before the corpus check.
for (const { name, fn } of queued) {
  try {
    report(name, await fn())
  } catch (err) {
    report(name, `threw ${err?.message ?? err}`)
  }
}

check('results/raw is byte-for-byte unchanged by this selftest (names + sizes)', () => {
  const after = snapshotDir(realRaw)
  return after === rawBefore ? true : `changed:\n before=${rawBefore}\n after=${after}`
})
R.cleanup()

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
