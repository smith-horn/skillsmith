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
 * The `unresolved-command` label `denyWith` writes into its reason. The
 * predicate is not a structured field on the verdict, and adding one would
 * change an object shape the suites compare whole, so the label is matched in
 * the text it is interpolated into. The suite pins both directions of this
 * match, since a silent miss would make the retry below never happen and a
 * silent over-match would suppress every denial instead of one class.
 */
const UNRESOLVED_LABEL = 'unresolved-command: '

/**
 * A plain, resolvable word to stand in for a `trap` action's head when the
 * shell assembles that head at runtime. It must not look unresolvable to
 * `checkUnresolvedHeadTail` (so: not `--`, not all digits, not under
 * `/dev/`, no `$`) and must name nothing this guard matches on.
 */
const NEUTRAL_HEAD = 'skillsmithTrapHead'

/** Does this verdict deny because the guard could not resolve a command name? */
function isUnresolvedHeadDenial(verdict) {
  const reason = verdict?.json?.hookSpecificOutput?.permissionDecisionReason ?? ''
  return reason.includes(UNRESOLVED_LABEL)
}

/**
 * The literal spine of a `trap` action: the action text re-tokenized, every
 * WORD that expands dropped, the operators kept, and the survivors re-joined.
 *
 * This is a LOSSY reading and is only ever one of two. Round 4 measured four
 * loss classes in the token-to-text round trip -- operator-to-target binding,
 * adjacency glue, quoting boundaries, and a substitution body that the
 * single-quote branch records in `.value` rather than `.subs` -- so six
 * spellings read nothing here. They are read by the other reading, the action
 * exactly as written. What this one adds is the case that reading cannot see:
 * an action whose HEAD the shell assembles, where the fail-closed
 * `unresolved-command` denial masks every ruflo predicate behind it
 * (`$(echo npx) ruflo`, `\${X} npx ruflo`, `$X; ruflo`).
 * @param {string} actionText
 * @returns {string}
 */
function literalSpineOf(actionText) {
  const parts = []
  let prev = null
  for (const tok of tokenize(actionText)) {
    const expands = tok.value.includes('$') || (tok.subs && tok.subs.length > 0)
    if (tok.type === 'word' && expands) continue
    // No blank where the tokenizer recorded the two tokens as welded, or a
    // glued glob group -- ONE zsh word -- comes back as several and the glob
    // reading no longer sees a path. Every defeat left in round 4's 2,450-row
    // fuzz was that one shape.
    const glued = tok.gluedLeft === true || prev?.gluedRight === true
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
 * `verdict` is the first reading: the action exactly as written, every
 * substitution body, redirect binding, glue flag and quoting boundary intact.
 * {@link literalSpineOf} is the second. A fail-closed `unresolved-command`
 * from either is suppressed, because an action whose head the shell assembles
 * at runtime is the variable-indirection limit this guard declares and 3 of the
 * 45 real `trap` lines in this repository are exactly that. Every other denial
 * from either reading stands, and a reading can only ADD one.
 * @param {{head: string, joined: string}} parsed
 * @param {object | null | undefined} verdict the action as written
 * @param {(text: string) => object | null | undefined} recurse same evaluator, next depth
 * @returns {object | null | undefined}
 */
export function resolveTrapVerdict(parsed, verdict, recurse) {
  if (parsed.head !== 'trap') return verdict ?? null
  if (verdict && !isUnresolvedHeadDenial(verdict)) return verdict
  const spine = literalSpineOf(parsed.joined)
  if (spine === '' || spine === parsed.joined) return undefined
  const second = recurse(spine)
  return second && !isUnresolvedHeadDenial(second) ? second : undefined
}
