// SMI-6715: the runners' check of a module's trace-artifact claim (shared by
// run-c4-attacks.mjs and run-c4-mount-attacks.mjs).
//
// Two rules, both fail-closed and both about not destroying evidence:
//  1. A reported artifact must really exist, verify, and be the one the record's own
//     traceCompact names. 'x', or a valid-looking sha256 that was never written, is
//     not an artifact.
//  2. A problem with the TRACE evidence must never erase what the run MEASURED. The
//     record keeps its precondition and userFiles; only its status becomes
//     'harness-error' and the cause is appended to extra.harnessErrors (as A13's
//     decideRecord does). A tally counts a C4 harness-error that measured a loss as
//     failed, so a loss survives; a blank record would have turned a FAIL into
//     NEVER-RAN. harnessErrorRaw (a blank record) is for runs that produced no
//     record at all.

import { readTraceArtifact } from './attacks/c4-trace-store.mjs'

/**
 * @param {object} raw - a module's result ({precondition, outcome, userFiles, extra, ...})
 * @param {string[]} problems
 * @returns {object} the same result with status 'harness-error' and the causes recorded
 */
export function markHarnessError(raw, problems) {
  // `raw`, `raw.outcome` and `raw.extra` are plain object literals built by an attack
  // module, so these spreads copy every field.
  const extra = raw.extra ?? {}
  const harnessErrors = [
    ...(Array.isArray(extra.harnessErrors) ? extra.harnessErrors : []),
    ...problems,
  ]
  return {
    ...raw,
    outcome: {
      ...raw.outcome,
      status: 'harness-error',
      reason: `traceArtifact: ${harnessErrors.join('; ')}`,
    },
    extra: { ...extra, harnessErrors },
  }
}

/**
 * Verifies the trace artifact a module reported when it was given a `traceDir`.
 * The one exemption is a clean A13 caller-hash race (quarantineTree never ran, so
 * there is no trace): status 'not-run' AND traceCompact === null AND
 * traceArtifact === null, all three.
 *
 * @param {object} raw
 * @param {string|undefined} traceDir - absolute; undefined means none was requested
 * @returns {object} `raw` untouched, or the same result marked harness-error
 */
export function checkTraceArtifact(raw, traceDir) {
  if (traceDir === undefined) return raw
  const extra = raw.extra
  const notRunNoTrace =
    raw.outcome?.status === 'not-run' &&
    extra?.traceCompact === null &&
    extra?.traceArtifact === null
  if (notRunNoTrace) return raw

  const problems = []
  const sha = extra?.traceArtifact?.sha256
  if (typeof sha !== 'string' || sha === '') {
    problems.push('module did not report extra.traceArtifact for the requested traceDir')
  } else {
    try {
      const back = readTraceArtifact(sha, { dir: traceDir })
      if (extra?.traceCompact?.sha256 !== back.sha256) {
        problems.push(
          `extra.traceArtifact.sha256 ${sha} is not the extra.traceCompact.sha256 ${String(extra?.traceCompact?.sha256)}`
        )
      }
    } catch (err) {
      problems.push(`extra.traceArtifact ${sha} does not verify: ${err.message}`)
    }
  }
  if (problems.length === 0) return raw
  // markHarnessError keeps any cause the module already recorded (c4Extra reports a
  // failed artifact write there) and appends the runner's own findings.
  return markHarnessError(raw, problems)
}
