// Trace-size cases for harness/a13-c4.selftest.mjs (run through that file).
// A13 records at --dirs 1630 were ~2 MB, almost all of it the full fs trace;
// a13-c4 now emits extra.traceCompact (c4-trace-match.mjs compactTrace) and no
// extra.trace. Nothing that classifies or scores reads the trace: decideRecord
// takes runC4Candidate's strict traceMatched boolean, never the trace itself.
//
// Two kinds of case: synthetic (traceCompactOf keeps the full trace exactly
// when the trace did NOT match, so a mismatch stays diagnosable), and LIVE
// (one real runOnce per arm at fixture scale, so the emitted record itself is
// checked, not a description of it).

import { traceCompactOf } from './attacks/a13-c4.record.mjs'
import { runOnce } from './attacks/a13-c4.mjs'
import { CALLER_HASH_FAILED_PREFIX } from './attacks/a13-c4.classify.mjs'

/** A small well-formed trace in the shape runC4Candidate records. */
const TRACE = [
  { fn: 'FIRE', path: '/fx/tree', window: 'pre-call', at: 1, endAt: 1.1, threw: null },
  { fn: 'lstatSync', path: '/fx/tree', scope: 'origin', at: 2, endAt: 2.1, threw: null },
  {
    fn: 'renameSync',
    path: '/fx/tree',
    scope: 'origin',
    dest: '/fx/.skillsmith-trash/op/tree-1',
    at: 3,
    endAt: 3.2,
    threw: null,
  },
]

export async function runTraceCases(check, { traceDir } = {}) {
  // --- synthetic: full trace kept exactly on a mismatch ------------------------
  {
    const matched = traceCompactOf(TRACE, true)
    check(
      'trace: matched run -> compact summary, full trace dropped (full null)',
      matched !== null &&
        typeof matched === 'object' &&
        !Array.isArray(matched) &&
        matched.full === null &&
        matched.length === 3,
      Array.isArray(matched) ? 'got the raw trace array' : matched
    )
    const mismatch = traceCompactOf(TRACE, false)
    check(
      'trace: forced mismatch (traceMatched false) keeps the full trace',
      mismatch !== null &&
        typeof mismatch === 'object' &&
        !Array.isArray(mismatch) &&
        mismatch.full === TRACE,
      Array.isArray(mismatch) ? 'got the raw trace array' : mismatch
    )
    const loose = traceCompactOf(TRACE, 'true')
    check(
      "trace: a non-boolean traceMatched ('true') is not a match -> full trace kept",
      loose !== null && typeof loose === 'object' && !Array.isArray(loose) && loose.full === TRACE,
      Array.isArray(loose) ? 'got the raw trace array' : loose
    )
  }

  // --- live: the emitted record itself ----------------------------------------
  // A real race can legitimately hit the caller's own hash and yield a clean
  // caller-hash-race record (status 'not-run', traceCompact null): roughly 1
  // run in 10 at fixture scale, which made this check flaky. Such a record is
  // checked as its OWN branch, and the run is repeated (up to MAX_ATTEMPTS)
  // until C4 actually ran, so the main assertion is always exercised rather
  // than skipped. Running out of attempts is a FAIL, not a pass. A caller-hash
  // failure that runOnce RETHROWS by design (unrelated per R2-7, or racer
  // clock out of tolerance; the runner counts those against the cell) is also
  // a real-race outcome with no record to inspect, so it is retried too, and
  // counted; any OTHER throw fails the check.
  const MAX_ATTEMPTS = 5
  for (const candidate of ['C4', 'C4-naive']) {
    let rec = null
    let thrown = null
    let notRunSeen = 0
    let notRunBad = null
    let rethrownRaces = 0
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      rec = null
      thrown = null
      try {
        rec = await runOnce({ candidate, traceDir })
      } catch (e) {
        thrown = e
      }
      if (thrown instanceof Error && thrown.message.startsWith(CALLER_HASH_FAILED_PREFIX)) {
        rethrownRaces += 1
        continue
      }
      if (thrown !== null || rec?.outcome?.status !== 'not-run') break
      notRunSeen += 1
      const xn = rec.extra ?? {}
      const ok =
        rec.outcome.status === 'not-run' &&
        xn.traceCompact === null &&
        xn.traceArtifact === null &&
        !Object.prototype.hasOwnProperty.call(xn, 'trace')
      if (!ok && notRunBad === null)
        notRunBad = { status: rec.outcome.status, keys: Object.keys(xn) }
    }
    check(
      `trace live ${candidate}: every caller-hash-race record seen (${notRunSeen}) has status not-run, traceCompact null, no extra.trace`,
      notRunBad === null,
      notRunBad
    )
    const ran = thrown === null && rec !== null && rec.outcome?.status !== 'not-run'
    const x = rec?.extra ?? {}
    check(
      `trace live ${candidate}: record carries extra.traceCompact and NO extra.trace`,
      ran &&
        !Object.prototype.hasOwnProperty.call(x, 'trace') &&
        x.traceCompact !== null &&
        typeof x.traceCompact === 'object' &&
        typeof x.traceCompact.schema === 'string',
      thrown
        ? String(thrown.message)
        : ran
          ? { keys: Object.keys(x), traceCompactType: typeof x.traceCompact }
          : `no run where C4 executed in ${MAX_ATTEMPTS} attempts (not-run ${notRunSeen}, rethrown races ${rethrownRaces})`
    )
    const tm = rec?.precondition?.traceMatched
    check(
      `trace live ${candidate}: traceCompact.full is null exactly when the trace matched`,
      ran && (tm === true ? x.traceCompact?.full === null : Array.isArray(x.traceCompact?.full)),
      { traceMatched: tm, full: x.traceCompact?.full === null ? null : typeof x.traceCompact?.full }
    )
  }
}
