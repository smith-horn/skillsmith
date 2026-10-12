#!/usr/bin/env node
// SMI-6715: records carry extra.traceCompact, not the full extra.trace (a full trace is
// ~3.4 MB per record at 1630 directories). Plain node; PASS/FAIL per case; non-zero exit
// on failure.
//
//   node harness/c4-trace-compact.selftest.mjs

import { c4Extra, keepTrace } from './attacks/c4-score.mjs'
import { runMountCase } from './attacks/a1-c4.mjs'
import * as a3 from './attacks/a3-c4.mjs'
import * as a4 from './attacks/a4-c4.mjs'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { runCells } from './run-c4-attacks.mjs'
import { readTraceArtifact } from './attacks/c4-trace-store.mjs'
import { tallyCell } from './cell-tally.mjs'
import { classifyRecord } from './result-schema.mjs'
import { makeSelftest } from './c4-selftest-util.mjs'

const { check, harnessRoot, finish, R } = makeSelftest(import.meta.url)
// traces are written under the selftest's scratch dir, never results/raw
const traceDir = path.join(R.scratch, 'traces')

const ARMS = ['C4', 'C4-naive']

for (const arm of ARMS) {
  check(`A3 --dirs 50 ${arm}: extra has traceCompact and no full trace`, () => {
    const { extra } = a3.runOnce({ harnessRoot, candidate: arm, dirs: 50 })
    return typeof extra.traceCompact === 'object' &&
      extra.traceCompact !== null &&
      typeof extra.traceCompact.schema === 'string' &&
      !('trace' in extra)
      ? true
      : `keys=${Object.keys(extra).join()}`
  })
  check(`A3 --dirs 50 ${arm}: a matched trace drops the full copy (full === null)`, () => {
    const { extra, precondition } = a3.runOnce({ harnessRoot, candidate: arm, dirs: 50 })
    return precondition.traceMatched === true && extra.traceCompact.full === null
      ? true
      : `traceMatched=${precondition.traceMatched} full=${typeof extra.traceCompact.full}`
  })
  check(`A4 --dirs 50 ${arm}: record extra stays small (< 20 KB) despite the padded tree`, () => {
    const { extra } = a4.runOnce({ harnessRoot, candidate: arm, dirs: 50 })
    const bytes = JSON.stringify(extra).length
    return bytes < 20000 ? true : `${bytes} bytes`
  })
}

// A forced mismatch must keep the evidence. c4Extra is called with a stand-in run result
// (a real mismatch is hard to provoke), once per traceMatched value.
const fakeRun = (traceMatched, trace) => ({
  trace,
  traceMatched,
  firedAt: null,
  times: {},
  guardHash: 'h',
  opId: 'o',
  onFireInvoked: true,
  mutationError: null,
})
check('c4Extra: traceMatched false keeps the full trace inside traceCompact', () => {
  const t = [{ fn: 'FIRE', at: 1, endAt: 2, threw: null }]
  const e = c4Extra(fakeRun(false, t), 'X', 'pre-call', {})
  return 'trace' in e === false &&
    Array.isArray(e.traceCompact.full) &&
    e.traceCompact.full.length === 1
    ? true
    : JSON.stringify(e.traceCompact).slice(0, 160)
})
check('c4Extra: traceMatched true drops the full trace', () => {
  const t = [{ fn: 'FIRE', at: 1, endAt: 2, threw: null }]
  const e = c4Extra(fakeRun(true, t), 'X', 'pre-call', {})
  return e.traceCompact.full === null ? true : 'full kept'
})
check('c4Extra: a malformed trace is kept whole and flagged, never thrown away', () => {
  const e = c4Extra(fakeRun(true, 'not-an-array'), 'X', 'pre-call', {})
  return e.traceCompact.malformed === true && e.traceCompact.full === 'not-an-array'
    ? true
    : JSON.stringify(e.traceCompact)
})

// a1-c4 builds its own extra; mount, umount and /proc/mounts are replaced through its seam.
const withLinux = (fn) => {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', orig)
  }
}
check('a1 extra: traceCompact and no full trace', () => {
  const r = withLinux(() =>
    runMountCase({
      harnessRoot,
      candidate: 'C4',
      subcase: 'bind',
      window: 'pre-call',
      _test: {
        doMount: () => {},
        detachAll: () => ({ found: 0, umounted: 0, failed: [], lazyUsed: 0, remaining: 0 }),
        mountsUnder: () => [],
      },
    })
  )
  return typeof r.extra.traceCompact === 'object' && !('trace' in r.extra)
    ? true
    : `keys=${Object.keys(r.extra).join()}`
})

// ---- every full trace is kept as a Brotli side file; the record points at it ------------
for (const arm of ARMS) {
  check(
    `A3 --dirs 50 ${arm}: traceArtifact.sha256 equals traceCompact.sha256 and the file verifies`,
    () => {
      const { extra } = a3.runOnce({ harnessRoot, candidate: arm, dirs: 50, traceDir })
      const a = extra.traceArtifact
      if (!a || a.sha256 !== extra.traceCompact.sha256) return `artifact=${JSON.stringify(a)}`
      if (a.path !== `traces/${a.sha256}.json.br`) return `path=${a.path}`
      if (!existsSync(path.join(R.scratch, a.path))) return 'file missing'
      const back = readTraceArtifact(a.sha256, { dir: traceDir })
      return Array.isArray(back.trace) && back.trace.length > 0 ? true : 'read back empty'
    }
  )
}
check(
  'A3: a non-absolute traceDir is recorded as a harness error, with no artifact claimed',
  () => {
    const { extra } = a3.runOnce({ harnessRoot, candidate: 'C4', traceDir: 'relative/traces' })
    return !('traceArtifact' in extra) && extra.harnessErrors?.some((m) => /absolute/.test(m))
      ? true
      : JSON.stringify(extra.harnessErrors)
  }
)
check('without a traceDir (module called directly) no artifact is written or claimed', () => {
  const { extra } = a3.runOnce({ harnessRoot, candidate: 'C4' })
  return !('traceArtifact' in extra) ? true : 'artifact claimed'
})
check('runner: a forced write failure yields harness-error records, counted', async () => {
  const cells = await runCells({
    mod: a3,
    args: { window: 'after-bind' },
    labels: ['A3-C4'],
    tag: 't',
    target: 2,
    harnessRoot,
    fsLabel: 'selftest',
    out: null,
    interleave: false,
    traceDir: 'relative/traces',
  })
  const all = [...cells.C4.records, ...cells['C4-naive'].records]
  return all.length === 4 &&
    all.every((x) => x.outcome.status === 'harness-error' && /absolute/.test(x.outcome.reason))
    ? true
    : JSON.stringify(all[0]?.outcome)
})
check(
  'runner: a module that does not report traceArtifact when asked becomes harness-error',
  async () => {
    const lazy = {
      target: 30,
      runOnce: () => ({
        precondition: {
          hookFired: true,
          mutationApplied: true,
          traceMatched: true,
          controlExpected: true,
        },
        outcome: { status: 'quarantined' },
        userFiles: { checked: 1, lost: 0, changed: 0, displaced: 0, deleted: 0 },
        durationMs: 1,
        extra: { label: 'X-C4' },
      }),
    }
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
      traceDir,
    })
    const rec = cells.C4.records[0]
    return rec.outcome.status === 'harness-error' && /traceArtifact/.test(rec.outcome.reason)
      ? true
      : JSON.stringify(rec.outcome)
  }
)
check('runner end to end: traces/ beside --out holds one verified artifact per record', () => {
  const o = path.join(R.scratch, 'e2e', 'o.jsonl')
  const r = R.run('run-c4-attacks.mjs', ['--only', 'a3', '--dirs', '50', '--out', o])
  if (r.status !== 0) return `status=${r.status} ${r.stderr.slice(0, 200)}`
  const recs = readFileSync(o, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  const dir = path.join(path.dirname(o), 'traces')
  const ok =
    recs.length === 2 &&
    recs.every((x) => {
      const a = x.extra.traceArtifact
      return (
        a &&
        a.sha256 === x.extra.traceCompact.sha256 &&
        readTraceArtifact(a.sha256, { dir }).trace.length > 0
      )
    })
  return ok ? true : JSON.stringify(recs.map((x) => x.extra.traceArtifact))
})

check(
  'keepTrace: a compact summary that disagrees with the written artifact is reported, not thrown',
  () => {
    // an entry whose JSON form changes between the two serialisations (compactTrace, then the store)
    let n = 0
    const entry = { fn: 'FIRE', toJSON: () => ({ fn: 'FIRE', n: (n += 1) }) }
    const k = keepTrace({ trace: [entry], traceMatched: false }, traceDir)
    return !('traceArtifact' in k) && k.harnessErrors?.some((m) => /does not match/.test(m))
      ? true
      : JSON.stringify(k.harnessErrors)
  }
)

// ---- a clean A13 caller-hash race has no trace: exempt ONLY under all three conditions ----
const rawWith = (status, extraBits) => ({
  precondition: {
    hookFired: false,
    mutationApplied: false,
    traceMatched: false,
    controlExpected: true,
  },
  outcome: { status },
  userFiles: { checked: 0, lost: 0, changed: 0 },
  durationMs: 1,
  extra: { label: 'A13-C4', variant: 'racer/by-timestamp', ...extraBits },
})
const runWith = async (raw) => {
  const mod = { target: 300, runOnce: () => raw }
  const cells = await runCells({
    mod,
    args: {},
    labels: ['A13-C4', 'A13-C4-OOM'],
    tag: 'racer/by-timestamp',
    target: 1,
    harnessRoot,
    fsLabel: 'selftest',
    out: null,
    interleave: true,
    traceDir,
  })
  return cells.C4.records[0]
}
const COMPACT = { schema: 'c4-trace-compact/1', sha256: 'x' }
check(
  'not-run with traceCompact null and traceArtifact null passes through unchanged (a non-landing)',
  async () => {
    const rec = await runWith(rawWith('not-run', { traceCompact: null, traceArtifact: null }))
    const t = tallyCell([rec], (r) => classifyRecord(r))
    return rec.outcome.status === 'not-run' && t.otherNeverRan === 0 && t.neverRan === 1
      ? true
      : `status=${rec.outcome.status} otherNeverRan=${t.otherNeverRan} neverRan=${t.neverRan}`
  }
)
check('not-run that carries a traceCompact but no artifact is a harness-error', async () => {
  const rec = await runWith(rawWith('not-run', { traceCompact: COMPACT, traceArtifact: null }))
  return rec.outcome.status === 'harness-error' && /traceArtifact/.test(rec.outcome.reason)
    ? true
    : rec.outcome.status
})
check(
  'a quarantined record without an artifact is a harness-error, even with both fields null',
  async () => {
    const rec = await runWith(rawWith('quarantined', { traceCompact: null, traceArtifact: null }))
    return rec.outcome.status === 'harness-error' && /traceArtifact/.test(rec.outcome.reason)
      ? true
      : rec.outcome.status
  }
)
check(
  'not-run with traceCompact null but traceArtifact absent (not null) is a harness-error',
  async () => {
    const rec = await runWith(rawWith('not-run', { traceCompact: null }))
    return rec.outcome.status === 'harness-error' && /traceArtifact/.test(rec.outcome.reason)
      ? true
      : rec.outcome.status
  }
)

await finish()
