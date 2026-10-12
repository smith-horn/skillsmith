#!/usr/bin/env node
// SMI-6715: selftest for the C4 runners' argument handling and for a1-c4's
// cleanup error handling. Plain node; PASS/FAIL per case; non-zero on failure.
//
//   node harness/c4-runner.selftest.mjs

import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveHarnessRoot } from './fixture-root.mjs'
import { runMountCase } from './attacks/a1-c4.mjs'
import { makeRecord } from './result-schema.mjs'
import { scoreCell } from './run-c4-attacks.mjs'

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

const run = (script, args) =>
  spawnSync(process.execPath, [path.join(here, script), ...args], { encoding: 'utf8' })
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

// ---- G4: a1-c4 cleanup error handling --------------------------------------
// runMountCase refuses off Linux, and the real mount/umount is out of reach
// here, so the platform is spoofed for the call and the mount, umount and
// cleanup steps are replaced through the `_test` seam. Only the control flow
// around `finally` is under test.
const withLinux = (fn) => {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', orig)
  }
}
const noDetach = () => ({ found: 0, umounted: 0, failed: [], lazyUsed: 0, remaining: 0 })
const callCase = (seam) =>
  withLinux(() =>
    runMountCase({
      harnessRoot,
      candidate: 'C4',
      subcase: 'bind',
      window: 'pre-call',
      _test: { detachAll: noDetach, ...seam },
    })
  )
const cleanupThenThrow = (fx) => {
  fx.cleanup()
  throw new Error('CLEANUP-BOOM')
}
const capture = (fn) => {
  try {
    return { value: fn() }
  } catch (err) {
    return { err }
  }
}

check('a1 cleanup: positive control, no failures -> returns a record', () => {
  const r = capture(() => callCase({ doMount: () => {} }))
  return r.value?.precondition?.mutationApplied === false
    ? true
    : `got ${r.err?.message ?? JSON.stringify(r.value)}`
})
check(
  'a1 cleanup: body fails + cleanup throws -> body error is the cause, cleanup message kept',
  () => {
    const body = new Error('BODY-BOOM')
    const r = capture(() =>
      callCase({
        doMount: () => {
          throw body
        },
        cleanup: cleanupThenThrow,
      })
    )
    if (!r.err) return 'did not throw'
    if (r.err.cause !== body)
      return `cause=${r.err.cause?.message ?? r.err.cause} message=${r.err.message}`
    return /CLEANUP-BOOM/.test(r.err.message)
      ? true
      : `message lost the cleanup error: ${r.err.message}`
  }
)
check('a1 cleanup: body ok + cleanup throws -> run fails loudly with the cleanup error', () => {
  const r = capture(() => callCase({ doMount: () => {}, cleanup: cleanupThenThrow }))
  return r.err && /CLEANUP-BOOM/.test(r.err.message) ? true : `got ${r.err?.message ?? 'no throw'}`
})
check('a1 cleanup: body fails, cleanup fine -> the body error itself is thrown', () => {
  const body = new Error('BODY-BOOM')
  const r = capture(() =>
    callCase({
      doMount: () => {
        throw body
      },
    })
  )
  return r.err === body ? true : `got ${r.err?.message ?? 'no throw'}`
})

// ---- G1: record-only cells show what verdictFor returns ---------------------
const oomRecord = (lost) =>
  makeRecord({
    cell: {
      attack: 'A13-C4-OOM',
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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
