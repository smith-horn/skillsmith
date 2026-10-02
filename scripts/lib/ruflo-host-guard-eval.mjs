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

import { basenameOf, tokenize } from './shell-command-normalize.mjs'
import { shellTextOperandSpan } from './shell-command-shell-text.mjs'
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
 *
 * SMI-6920 (the post-merge retro of PR #2978): `trap ACTION SIG…` hands its
 * ACTION to the shell as text exactly as `eval` hands its arguments, and
 * `trap "npx ruflo memory store" EXIT` allowed on every tree while the eval
 * twin denied. The action joins this reading with eval's posture: literal
 * text is recursed, an expanding action is left alone as the variable-
 * indirection limit (round 2, H-2), and the forms that run nothing
 * (`trap -l`, `trap -p`, `trap - SIG`) are not eval segments.
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
  const head = basenameOf(normalizedArgv[0])
  if (head !== 'eval' && head !== 'trap') return undefined

  const alignedTokens = tokensForArgv(wordTokens, normalizedArgv)
  // Which words are shell text is ONE rule, shared with the env guard
  // (`shellTextOperandSpan`: eval joins everything past a separate `--`,
  // trap hands over its one action past an optional `--`; SMI-6920 round 2,
  // M-5), mapped here onto the `.subs`-bearing tokens the expansion check
  // needs. A `trap` that runs nothing is not an eval segment; an `eval`
  // with no argument is one with nothing to read.
  const span = shellTextOperandSpan(normalizedArgv)
  if (span === null) return head === 'eval' ? null : undefined
  const rest = alignedTokens.slice(span.start, span.end)
  if (rest.length === 0) return null
  const hasExpansion = rest.some((t) => t.value.includes('$') || (t.subs && t.subs.length > 0))
  if (hasExpansion) {
    // An expanding `trap` action is the variable-indirection limit this
    // guard already accepts, not H9: most `trap` lines in this repository
    // expand (`trap 'rm -rf "$TMPROOT"' EXIT`) and every one denied with a
    // false reason on a guard with no opt-out (the review of 243a96847,
    // H-2). `eval "$X"` stays H9, as it has been since round 1.
    //
    // Round 3 of SMI-6920: suppressing the WHOLE reading on one expansion
    // anywhere in the action made the literal denial worth nothing, because
    // appending a variable bought an allow — `trap "npx ruflo $X" EXIT`
    // allowed while `trap "npx ruflo" EXIT` denied, and the `eval` twin
    // denied either way. So read the action's literal spine instead: the
    // limit is the words that expand, not the action that contains one.
    if (head === 'trap') {
      const spine = literalSpineOf(rest.map((t) => t.value).join(' '))
      return spine === '' ? undefined : { joined: spine, head }
    }
    return denyWith('H9', alignedTokens[0].value + ' ' + rest.map((t) => t.value).join(' '))
  }
  return { joined: rest.map((t) => t.value).join(' '), head }
}

/**
 * The literal spine of a `trap` action: re-tokenize the action text with the
 * shared tokenizer and drop every WORD that expands, keeping operators so the
 * recursion still sees the action's own segment structure. An action that is
 * nothing but expansions (`trap "$exit_body" EXIT`) yields the empty string,
 * which the caller reads as "no reading to add" — the same fall-through round
 * 2 gave every expanding action.
 *
 * Dropping words can only ADD a denial (ADR-172 § 1: a reading never moves a
 * verdict toward allow), because the alternative for this branch is no reading
 * at all. It cannot resurrect a name the action never wrote literally: a head
 * that arrives only by expansion is dropped with its word, which is the
 * variable-indirection limit this guard still declares.
 * @param {string} actionText
 * @returns {string}
 */
function literalSpineOf(actionText) {
  const kept = []
  for (const t of tokenize(actionText)) {
    const expands = t.value.includes('$') || (t.subs && t.subs.length > 0)
    if (t.type === 'word' && expands) continue
    kept.push(t.value)
  }
  return kept.join(' ').trim()
}
