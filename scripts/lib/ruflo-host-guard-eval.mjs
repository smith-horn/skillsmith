/**
 * H9 eval-predicate PARSING for `scripts/ruflo-host-guard.mjs`. Split out
 * (governance-round M3 file-length follow-up) purely to stay under the
 * 500-line-per-file convention this repo keeps by hand for .mjs files
 * under scripts/ (not enforced by tooling here —
 * `scripts/check-file-length.mjs` only runs via `lint-staged` for
 * `*.ts`/`*.sh`; SMI-5994) once that file's own M3/L2/L4 governance-round
 * docblock corrections moved it out to stay under the convention.
 *
 * Only the PARSING half moves here — the final recursive
 * `evaluateGuardCommand(joined, depth + 1)` call stays in the orchestration
 * file itself, which the caller (`checkEvalPredicate`, still in
 * `scripts/ruflo-host-guard.mjs`) makes using this function's `{ joined }`
 * result. `evaluateGuardCommand` is a local, non-exported function there —
 * importing it back here would recreate the exact same file-length
 * pressure this split exists to relieve, and this function has no other
 * reason to depend on it.
 */

import { basenameOf } from './shell-command-normalize.mjs'
import { normalizeWrappersWithExec, tokensForArgv } from './ruflo-host-guard-wrappers.mjs'
import { denyWith } from './ruflo-host-guard-verdicts.mjs'

/**
 * H9 — dynamic shell evaluators (round 1 finding 1). Runs BEFORE the main
 * flow's own wrapper normalization, on the segment's raw pre-strip word
 * tokens, peeling wrappers via the SAME `normalizeWrappersWithExec` the
 * main flow uses (H-C fix, SMI-6744 Wave 4 governance round: `command
 * eval '...'`/`builtin eval '...'`/`noglob eval '...'` all evaded H9
 * before this, because the original check only ever looked at
 * `wordTokens[0]` — reusing one normalizer instead of a bespoke second
 * peel keeps this in sync with H-A/H-B/L-A's own wrapper coverage for
 * free). If the peeled argv[0]'s basename is `eval`: deny when any later
 * token expands (`$` in `.value` or non-empty `.subs`); otherwise return
 * the joined literal eval-body text for the CALLER to recursively
 * evaluate through the same pipeline. A nested `-c` body found while
 * peeling is left for the main flow to handle (`undefined`, "not an eval
 * segment").
 * @param {Array<{value: string, subs?: string[]}>} wordTokens
 * @returns {object | null | { joined: string } | undefined} `undefined` =
 *   "not an eval segment, keep going"; `null` = an eval segment with no
 *   arguments; a deny-verdict object = H9 itself fired; `{ joined }` = the
 *   eval body's literal text, for the caller to recurse into.
 */
export function parseEvalSegment(wordTokens) {
  if (wordTokens.length === 0) return undefined
  const rawValues = wordTokens.map((t) => t.value)
  const { argv: normalizedArgv, nested } = normalizeWrappersWithExec(rawValues)
  if (nested !== null) return undefined
  if (normalizedArgv.length === 0) return undefined
  if (basenameOf(normalizedArgv[0]) !== 'eval') return undefined

  const alignedTokens = tokensForArgv(wordTokens, normalizedArgv)
  const rest = alignedTokens.slice(1)
  if (rest.length === 0) return null
  const hasExpansion = rest.some((t) => t.value.includes('$') || (t.subs && t.subs.length > 0))
  if (hasExpansion) {
    return denyWith('H9', alignedTokens[0].value + ' ' + rest.map((t) => t.value).join(' '))
  }
  return { joined: rest.map((t) => t.value).join(' ') }
}
