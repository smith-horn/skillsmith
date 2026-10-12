// Trace-artifact cases for harness/a13-c4.selftest.mjs (run through that file).
// Every run that has a trace stores it as a content-addressed Brotli side file
// (attacks/c4-trace-store.mjs) and records extra.traceArtifact {sha256, path}
// next to traceCompact; the compact's sha256 must name the artifact. A write
// or verify failure, or a missing traceDir, is a counted harness-error: a
// matched run's compact drops the full trace, so an unstored trace would be
// lost evidence. The caller-hash-race record has no trace: traceArtifact null.

import fs from 'node:fs'
import path from 'node:path'
import { traceArtifactFor, traceCompactOf, decideRecord } from './attacks/a13-c4.record.mjs'
import { readTraceArtifact } from './attacks/c4-trace-store.mjs'
import { runOnce } from './attacks/a13-c4.mjs'
import { CALLER_HASH_FAILED_PREFIX } from './attacks/a13-c4.classify.mjs'

const TRACE = [
  { fn: 'FIRE', path: '/fx/tree', window: 'pre-call', at: 1, endAt: 1.1, threw: null },
  { fn: 'lstatSync', path: '/fx/tree', scope: 'origin', at: 2, endAt: 2.1, threw: null },
]

/**
 * One real run where C4 executed. Caller-hash races (a 'not-run' record, or a
 * by-design rethrow) are retried, up to 5 attempts, and the not-run records
 * seen are returned so the caller checks them as their own branch; running
 * out of attempts returns rec null, which fails the main check.
 */
async function liveRun(args) {
  const notRuns = []
  for (let i = 0; i < 5; i += 1) {
    try {
      const rec = await runOnce(args)
      if (rec.outcome.status !== 'not-run') return { rec, notRuns }
      notRuns.push(rec)
    } catch (e) {
      if (!(e instanceof Error && e.message.startsWith(CALLER_HASH_FAILED_PREFIX))) throw e
    }
  }
  return { rec: null, notRuns }
}

export async function runArtifactCases(check, { traceDir }) {
  // --- pure: the helper ---------------------------------------------------------
  {
    const compact = traceCompactOf(TRACE, true)
    const ok = traceArtifactFor(TRACE, compact, traceDir)
    check(
      'artifact: helper writes the trace, sha256 equals the compact sha256, path relative',
      ok.error === null &&
        ok.traceArtifact?.sha256 === compact.sha256 &&
        typeof ok.traceArtifact?.path === 'string' &&
        !path.isAbsolute(ok.traceArtifact.path),
      ok
    )
    const boom = traceArtifactFor(TRACE, compact, traceDir, () => {
      throw new Error('disk full')
    })
    check(
      'artifact: a throwing writer -> no artifact, an error naming the cause',
      boom.traceArtifact === null &&
        typeof boom.error === 'string' &&
        boom.error.includes('disk full'),
      boom
    )
    const noDir = traceArtifactFor(TRACE, compact, undefined)
    check(
      'artifact: no traceDir -> error, never a silent skip',
      noDir.traceArtifact === null && typeof noDir.error === 'string',
      noDir
    )
    const wrong = traceArtifactFor(TRACE, { ...compact, sha256: 'f'.repeat(64) }, traceDir)
    check(
      'artifact: compact sha256 not naming the artifact -> error',
      wrong.traceArtifact === null && typeof wrong.error === 'string',
      wrong
    )
    const d = decideRecord({
      c4Status: 'quarantined',
      traceMatched: true,
      clockOrderOk: true,
      clockSkewCheckMs: 0.1,
      markerObservedAt: 1,
      callerHashStartAt: 2,
      unscorable: null,
      routed: { mutationApplied: false, label: 'A13-C4' },
      landings: [],
      scored: { lost: 0, changed: 0, vacuous: false },
      traceArtifactError: 'trace-artifact:disk full',
    })
    check(
      'artifact: decideRecord turns an artifact error into a COUNTED harness-error (mutationApplied true)',
      d.status === 'harness-error' &&
        d.mutationApplied === true &&
        d.harnessErrors.some((e) => e.startsWith('trace-artifact')),
      d
    )
  }

  // --- live: the emitted record -----------------------------------------------
  for (const candidate of ['C4', 'C4-naive']) {
    const { rec, notRuns } = await liveRun({ candidate, traceDir })
    check(
      `artifact live ${candidate}: every caller-hash-race record seen (${notRuns.length}) has traceArtifact null`,
      notRuns.every((n) => n.extra.traceArtifact === null),
      notRuns.map((n) => n.extra.traceArtifact)
    )
    const x = rec?.extra ?? {}
    let read = null
    let readErr = null
    try {
      read = readTraceArtifact(x.traceArtifact?.sha256, { dir: traceDir })
    } catch (e) {
      readErr = String(e.message)
    }
    check(
      `artifact live ${candidate}: traceArtifact.sha256 === traceCompact.sha256, and readTraceArtifact verifies it`,
      rec !== null &&
        rec.outcome.status !== 'harness-error' &&
        x.traceArtifact?.sha256 === x.traceCompact?.sha256 &&
        readErr === null &&
        Array.isArray(read?.trace) &&
        read.trace.length === x.traceCompact?.length,
      {
        status: rec?.outcome?.status,
        artifact: x.traceArtifact,
        compactSha: x.traceCompact?.sha256,
        readErr,
      }
    )
  }

  // --- live: a forced write failure ---------------------------------------------
  {
    // An absolute path that is a regular FILE, so the store cannot use it as a dir.
    const notADir = path.join(traceDir, 'not-a-dir')
    fs.writeFileSync(notADir, 'x')
    const { rec } = await liveRun({ candidate: 'C4', traceDir: notADir })
    check(
      'artifact live: a forced trace-write failure is a counted harness-error (mutationApplied not false)',
      rec?.outcome?.status === 'harness-error' &&
        rec.precondition.mutationApplied === true &&
        (rec.extra.harnessErrors ?? []).some((e) => e.startsWith('trace-artifact')) &&
        rec.extra.traceArtifact === null,
      rec && { status: rec.outcome.status, pre: rec.precondition, he: rec.extra.harnessErrors }
    )
  }
}
