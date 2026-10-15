#!/usr/bin/env node
// SMI-6715: runner selftest: argument handling for both runners, the record-only verdict line, the symlink guard and repeated flags.
// Plain node; PASS/FAIL per case; non-zero exit on failure. Every runner spawn is
// sandboxed (scratch --out, --target 1, relocated short-target corpus dir) and the
// real results/raw is snapshotted around the run (see c4-selftest-util.mjs).
//
//   node harness/c4-runner.selftest.mjs

import path from 'node:path'
import os from 'node:os'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { scoreCell } from './run-c4-attacks.mjs'
import { parseFlags } from './c4-target-guard.mjs'
import { oomRecord, makeSelftest } from './c4-selftest-util.mjs'

const { check, here, run, exits2With, finish } = makeSelftest(import.meta.url)

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

await finish()
