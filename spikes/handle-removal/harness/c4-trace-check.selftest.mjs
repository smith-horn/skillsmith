#!/usr/bin/env node
// SMI-6715 governance F1/F2/F5: a trace-artifact problem must never erase a measured
// loss, a reported artifact must really exist and match, and exempted losses must be
// visible on the runner's A13 verdict line. Plain node; PASS/FAIL per case.
//
//   node harness/c4-trace-check.selftest.mjs

import path from 'node:path'
import { runCells, scoreCell } from './run-c4-attacks.mjs'
import { tallyCell } from './cell-tally.mjs'
import { classifyRecord } from './result-schema.mjs'
import { writeTraceArtifact } from './attacks/c4-trace-store.mjs'
import * as a3 from './attacks/a3-c4.mjs'
import { oomRecordFor, makeSelftest } from './c4-selftest-util.mjs'

const { check, harnessRoot, finish, R } = makeSelftest(import.meta.url)
const traceDir = path.join(R.scratch, 'traces')

const runA3 = (traceDirArg, target = 1) =>
  runCells({
    mod: a3,
    args: { window: 'after-bind' },
    labels: ['A3-C4'],
    tag: 't',
    target,
    harnessRoot,
    fsLabel: 'selftest',
    out: null,
    interleave: false,
    traceDir: traceDirArg,
  })
const tally = (records) => tallyCell(records, (r) => classifyRecord(r))

// ---- F1: a measured loss survives an artifact failure ------------------------------------
check('F1 baseline: A3 naive with a good traceDir measures a loss (failed 1)', async () => {
  const cells = await runA3(traceDir)
  const rec = cells['C4-naive'].records[0]
  return rec.userFiles.lost === 1 && tally([rec]).failed === 1
    ? true
    : JSON.stringify(rec.userFiles)
})
check(
  'F1: A3 naive with a forced artifact failure keeps its loss: harness-error, FAIL not NEVER-RAN',
  async () => {
    const cells = await runA3('relative/traces')
    const rec = cells['C4-naive'].records[0]
    const t = tally([rec])
    const kept = rec.userFiles.lost === 1 && rec.userFiles.displaced === 1
    const harness =
      rec.outcome.status === 'harness-error' && /traceArtifact/.test(rec.outcome.reason)
    return kept && harness && t.failed === 1
      ? true
      : `lost=${rec.userFiles.lost} status=${rec.outcome.status} failed=${t.failed}`
  }
)
check('F1: the artifact failure is recorded in extra.harnessErrors', async () => {
  const cells = await runA3('relative/traces')
  const e = cells['C4-naive'].extras[0]
  return Array.isArray(e?.harnessErrors) && e.harnessErrors.some((m) => /absolute/.test(m))
    ? true
    : JSON.stringify(e?.harnessErrors)
})
check(
  'F1: the C4 arm (no loss) with the same failure is a harness-error with lost 0, never a pass',
  async () => {
    const cells = await runA3('relative/traces')
    const rec = cells.C4.records[0]
    return rec.outcome.status === 'harness-error' &&
      rec.userFiles.lost === 0 &&
      tally([rec]).failed === 0
      ? true
      : JSON.stringify([rec.outcome.status, rec.userFiles])
  }
)

const fakeRaw = (over = {}) => ({
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
  ...over,
})
const runFake = async (raw, labels = ['X-C4']) => {
  const mod = { target: 30, runOnce: () => raw }
  const cells = await runCells({
    mod,
    args: {},
    labels,
    tag: 't',
    target: 1,
    harnessRoot,
    fsLabel: 'selftest',
    out: null,
    interleave: false,
    traceDir,
  })
  return cells.C4.records[0]
}
check(
  'F1: an A13-style unexplained-loss harness-error record keeps its loss under traceDir',
  async () => {
    const raw = fakeRaw({
      outcome: { status: 'harness-error', reason: 'a13-c4-harness-error:unexplained-loss' },
      userFiles: { checked: 1, lost: 1, changed: 0, displaced: 1, deleted: 0 },
      extra: {
        label: 'A13-C4',
        traceCompact: null,
        traceArtifact: null,
        harnessErrors: ['unexplained-loss'],
      },
    })
    const rec = await runFake(raw, ['A13-C4', 'A13-C4-OOM'])
    return rec.userFiles.lost === 1 && tally([rec]).failed === 1
      ? true
      : JSON.stringify(rec.userFiles)
  }
)

// ---- F2: a reported artifact must exist and match the compact summary --------------------
const HEX64 = 'a'.repeat(64)
check("F2: a fake module reporting traceArtifact.sha256 'x' is a harness-error", async () => {
  const rec = await runFake(
    fakeRaw({
      extra: {
        label: 'X-C4',
        traceCompact: { sha256: 'x' },
        traceArtifact: { sha256: 'x', path: 'traces/x' },
      },
    })
  )
  return rec.outcome.status === 'harness-error' ? true : rec.outcome.status
})
check('F2: a valid-shaped sha256 with no file on disk is a harness-error', async () => {
  const rec = await runFake(
    fakeRaw({
      extra: {
        label: 'X-C4',
        traceCompact: { sha256: HEX64 },
        traceArtifact: { sha256: HEX64, path: `traces/${HEX64}.json.br` },
      },
    })
  )
  return rec.outcome.status === 'harness-error' ? true : rec.outcome.status
})
check(
  'F2: a real artifact whose sha differs from traceCompact.sha256 is a harness-error',
  async () => {
    const ref = writeTraceArtifact([{ fn: 'FIRE' }], { dir: traceDir })
    const rec = await runFake(
      fakeRaw({
        extra: {
          label: 'X-C4',
          traceCompact: { sha256: HEX64 },
          traceArtifact: { sha256: ref.sha256, path: ref.path },
        },
      })
    )
    return rec.outcome.status === 'harness-error' && /traceCompact/.test(rec.outcome.reason)
      ? true
      : rec.outcome.status
  }
)
check(
  'F2 positive control: a real artifact matching traceCompact.sha256 passes through',
  async () => {
    const ref = writeTraceArtifact([{ fn: 'FIRE', n: 7 }], { dir: traceDir })
    const rec = await runFake(
      fakeRaw({
        extra: {
          label: 'X-C4',
          traceCompact: { sha256: ref.sha256 },
          traceArtifact: { sha256: ref.sha256, path: ref.path },
        },
      })
    )
    return rec.outcome.status === 'quarantined'
      ? true
      : `${rec.outcome.status} ${rec.outcome.reason}`
  }
)
check('F2: a measured loss survives a bad artifact (kept fields, harness-error)', async () => {
  const rec = await runFake(
    fakeRaw({
      userFiles: { checked: 1, lost: 1, changed: 0, displaced: 1, deleted: 0 },
      extra: {
        label: 'X-C4',
        traceCompact: { sha256: 'x' },
        traceArtifact: { sha256: 'x', path: 'p' },
      },
    })
  )
  return rec.outcome.status === 'harness-error' &&
    rec.userFiles.lost === 1 &&
    tally([rec]).failed === 1
    ? true
    : JSON.stringify([rec.outcome.status, rec.userFiles])
})

// ---- F5: callerIntentExcluded printed beside the A13 verdict --------------------------------
const lineFor = (aggregate) => {
  const rec = oomRecordFor('A13-C4', 0, 1)
  return scoreCell({
    label: 'A13-C4',
    variant: 'racer/by-timestamp',
    candidate: 'C4',
    records: [rec],
    target: 1,
    aggregate,
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
}
check('F5: the A13 verdict line shows callerIntentExcluded=N from the aggregate', () => {
  const line = lineFor(() => ({
    ran: 1,
    passed: 0,
    failed: 0,
    neverRan: 1,
    callerIntentExcluded: 2,
    verdict: 'X',
  }))
  return /callerIntentExcluded=2(\t|$)/.test(line) ? true : line
})
check('F5: callerIntentExcluded is 0 when the aggregate has none', () => {
  const line = lineFor(() => ({ ran: 1, passed: 1, failed: 0, neverRan: 0, verdict: 'X' }))
  return /callerIntentExcluded=0(\t|$)/.test(line) ? true : line
})

await finish()
