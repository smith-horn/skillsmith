/**
 * Segment-splitting for `scripts/ruflo-host-guard.mjs`. Split out
 * (governance-round M3 file-length follow-up) purely to stay under the
 * 500-line-per-file convention this repo keeps by hand for .mjs files
 * under scripts/ (not enforced by tooling here —
 * `scripts/check-file-length.mjs` only runs via `lint-staged` for
 * `*.ts`/`*.sh`; SMI-5994) once that file's own M3/L2/L4 governance-round
 * docblock corrections moved it out to stay under the convention — this is
 * a pure function with no dependency on anything else in the orchestration
 * file, so it moves cleanly.
 */

import {
  globGroupAlternativeReadings,
  SEGMENT_SEPARATOR_OPS as SPLIT_OPS,
} from './shell-command-segments.mjs'

/**
 * Real statement separators for THIS guard's own segmentation -- this
 * guard deliberately does NOT split on `{`/`}` so the brace-syntax check
 * (`checkBraceSegment` in `ruflo-host-guard-predicates.mjs`) can see them
 * still grouped with the command they belong to (round 1 finding 3).
 * `env-read-guard.mjs`'s own `evaluateCommand` used to treat every op
 * token, `{`/`}` included, as a splitter; since SMI-6892 it splits on this
 * SAME shared `SEGMENT_SEPARATOR_OPS` set (imported here under the local
 * name `SPLIT_OPS` this file already used, M-4 governance round -- the two
 * sets had drifted into a byte-identical independent copy, now one source)
 * plus `groupingOpSubRuns`'s own separate sub-run check for the words a
 * dropped `{`/`}` merges, so a violation in either denies.
 */

/**
 * Splits `tokens` into segments, each carrying the operator that PRECEDED
 * it (`null` for the first segment) — H-F fix (SMI-6744 Wave 4 governance
 * round) needs to know whether a segment was joined to its predecessor by
 * a pipe specifically (`echo '...' | bash`), not just that a split
 * happened, so `evaluateGuardCommand` can hand a bare-shell segment its
 * PRECEDING pipeline segment's tokens only when that relationship is a
 * real pipe.
 */
export function splitSegments(tokens) {
  const segments = []
  let current = []
  let precedingOp = null
  for (const tok of tokens) {
    if (tok.type === 'op' && SPLIT_OPS.has(tok.value)) {
      if (current.length > 0) segments.push({ tokens: current, precedingOp })
      precedingOp = tok.value
      current = []
    } else {
      current.push(tok)
    }
  }
  if (current.length > 0) segments.push({ tokens: current, precedingOp })
  return segments
}

/**
 * The SECOND reading, beside `splitSegments` and never replacing it (SMI-6903
 * H1). A word-position paren group is a zsh glob alternation welded into one
 * word, so `./(node_modules|x)/.bin/ruflo memory store` really invokes
 * `./node_modules/.bin/ruflo` (measured in zsh 5.9) — but splitting on `(`,
 * `|` and `)` left `x` as `argv[0]`, hiding the path from the `argv[0]`-keyed
 * H3/H5 checks. `globGroupAlternativeReadings` rebuilds each word the shell
 * would form; this runs the caller's OWN per-segment evaluator over each
 * rebuilt token list and returns the first denial.
 *
 * Additive by construction: it only ever ADDS a denial, because the caller
 * has already run its primary reading and this returns `null` when nothing
 * denies. Teaching `splitSegments` itself about word-position parens was
 * tried first and rejected on measurement — it moved 21 real repository
 * command lines from `deny/unresolved-command` to `allow`, a fail-open change
 * to a guard whose whole posture is fail-closed, and it did not even fix the
 * target shape.
 * @param {Array<object>} tokens the full token stream for this command text
 * @param {(segments: Array<{tokens: Array<object>, precedingOp: string|null}>, index: number) => object|null} evalSegment
 * @returns {object|null}
 */
export function evaluateGlobGroupReadings(tokens, evalSegment) {
  for (const reading of globGroupAlternativeReadings(tokens)) {
    const segments = splitSegments(reading)
    for (let i = 0; i < segments.length; i++) {
      const verdict = evalSegment(segments, i)
      if (verdict) return verdict
    }
  }
  return null
}
