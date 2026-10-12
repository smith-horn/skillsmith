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

export async function runTraceCases(check) {
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
  for (const candidate of ['C4', 'C4-naive']) {
    let rec = null
    let thrown = null
    try {
      rec = await runOnce({ candidate })
    } catch (e) {
      thrown = e
    }
    const x = rec?.extra ?? {}
    check(
      `trace live ${candidate}: record carries extra.traceCompact and NO extra.trace`,
      thrown === null &&
        !Object.prototype.hasOwnProperty.call(x, 'trace') &&
        x.traceCompact !== null &&
        typeof x.traceCompact === 'object' &&
        typeof x.traceCompact.schema === 'string',
      thrown
        ? String(thrown.message)
        : { keys: Object.keys(x), traceCompactType: typeof x.traceCompact }
    )
    const tm = rec?.precondition?.traceMatched
    check(
      `trace live ${candidate}: traceCompact.full is null exactly when the trace matched`,
      tm === true ? x.traceCompact?.full === null : Array.isArray(x.traceCompact?.full),
      { traceMatched: tm, full: x.traceCompact?.full === null ? null : typeof x.traceCompact?.full }
    )
  }
}
