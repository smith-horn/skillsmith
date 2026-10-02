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
    // guard already accepts, not H9: 22 of the 45 `trap` lines in this
    // repository
    // expand (`trap 'rm -rf "$TMPROOT"' EXIT`) and every one denied with a
    // false reason on a guard with no opt-out (the review of 243a96847,
    // H-2). `eval "$X"` stays H9, as it has been since round 1.
    //
    // Round 3 of SMI-6920: suppressing the WHOLE reading on one expansion
    // anywhere in the action made the literal denial worth nothing, because
    // appending a variable bought an allow — `trap "npx ruflo $X" EXIT`
    // allowed while `trap "npx ruflo" EXIT` denied, and the `eval` twin
    // denied either way.
    //
    // Round 4: that round's own fix read the action's literal SPINE, dropping
    // the words that expand and re-joining the survivors as text. Six further
    // spellings still bought an allow, each measured against its literal twin,
    // because rebuilding a command line from surviving tokens loses operator
    // binding, adjacency glue, quoting boundaries and substitution bodies. The
    // text round-trip was the defect, so there is none: the action is recursed
    // EXACTLY as written, every reading intact, and the caller suppresses the
    // one denial class that strip existed to avoid (see
    // {@link resolveTrapVerdict}).
    if (head === 'trap') return { joined: rest.map((t) => t.value).join(' '), head }
    return denyWith('H9', alignedTokens[0].value + ' ' + rest.map((t) => t.value).join(' '))
  }
  return { joined: rest.map((t) => t.value).join(' '), head }
}

/**
 * The predicate `checkUnresolvedCommand` emits when it cannot resolve a
 * command name. Read from the verdict's structured `predicate` field, never
 * from its reason text: the reason interpolates the matched token, and an
 * inline script padded with this label impersonated the predicate before
 * round 5 (C2). The suite pins BOTH directions -- a padded script still
 * denies, and a genuinely unresolved head still falls through.
 */
const UNRESOLVED_PREDICATE = 'unresolved-command'

/** Did the guard refuse because it could not resolve a command name? */
function isUnresolvedHeadDenial(verdict) {
  return verdict?.predicate === UNRESOLVED_PREDICATE
}

/**
 * The literal spine of a `trap` action: the action re-tokenized, every WORD
 * that expands dropped, the operators kept, the survivors re-joined.
 *
 * This is a LOSSY reading and is only ever one of two. A token-to-text round
 * trip loses an operator's binding to its target, quoting boundaries, and a
 * substitution body that the single-quote branch records in `.value` rather
 * than `.subs`; six spellings read nothing here (round 4, F-A). They are read
 * by the other reading, the action exactly as written. What this one adds is
 * the case that reading cannot see: an action whose HEAD the shell assembles,
 * where the fail-closed unresolved-head refusal masks every ruflo predicate
 * behind it.
 *
 * The re-join emits no blank where the tokenizer welded two tokens. That does
 * not make a glued glob group come back as ONE word -- interior blanks are
 * still introduced, so `./(a|x)/.bin/ruflo` becomes `./( a | x )/.bin/ruflo`
 * -- it restores the two OUTER welds, and re-tokenizing that text re-derives
 * the paren flags, which is what the glob reading needs (round 4 L2 corrected
 * an overstatement here). `prev` is reset when a word is dropped, so a
 * dropped word cannot weld two tokens the source kept apart (round 5, M1).
 * @param {string} actionText
 * @returns {string}
 */
function literalSpineOf(actionText) {
  const parts = []
  let prev = null
  for (const tok of tokenize(actionText)) {
    const expands = tok.value.includes('$') || (tok.subs && tok.subs.length > 0)
    if (tok.type === 'word' && expands) {
      prev = null
      continue
    }
    const glued = prev !== null && (tok.gluedLeft === true || prev.gluedRight === true)
    if (parts.length > 0 && !glued) parts.push(' ')
    parts.push(tok.value)
    prev = tok
  }
  return parts.join('').trim()
}

/**
 * What a `trap` segment's two readings mean for the segment.
 *
 * `eval` hands the shell its whole argument list, so its recursion's verdict
 * IS the segment's. A `trap` segment still carries real argv after the action
 * (the signal names, and under a launcher the launcher's own words), so a clean
 * action falls THROUGH to the later predicates instead of ending the segment --
 * round 2's M-1.
 *
 * Only ONE refusal is excused, and the test for it is behavioural rather than
 * by label, because `checkUnresolvedCommand` emits the same predicate from
 * five arms and only the last is the variable-indirection limit: an empty
 * residual after peeling, a `--` head, an all-digit head and a `/dev/` head
 * are fail-closed arity arms that fire AFTER the head is read and BEFORE the
 * ruflo predicates, so excusing them masks a reader written out literally.
 * Round 5 (C1) measured seven such rows denying on `84aece0bf` and allowing
 * here, two of them carrying no expansion at all.
 *
 * So: if the spine equals the action, nothing expanded, there is no indirection
 * to excuse, and the refusal stands. If the spine is empty, every word
 * expanded, and that IS the limit -- `trap "$exit_body" EXIT`, 3 of the real
 * `trap` lines in this repository. Otherwise the spine is read, and whatever
 * it refuses stands, including its own fail-closed refusal.
 * @param {{head: string, joined: string}} parsed
 * @param {object | null | undefined} verdict the action as written
 * @param {(text: string) => object | null | undefined} recurse same evaluator, next depth
 * @returns {object | null | undefined}
 */
export function resolveTrapVerdict(parsed, verdict, recurse) {
  if (parsed.head !== 'trap') return verdict ?? null
  if (verdict && !isUnresolvedHeadDenial(verdict)) return verdict
  const spine = literalSpineOf(parsed.joined)
  if (spine === parsed.joined) return verdict ?? undefined
  if (spine === '') return undefined
  return recurse(spine) ?? undefined
}
