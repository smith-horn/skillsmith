#!/usr/bin/env node
/**
 * Ruflo host-invocation guard (SMI-6744 Wave 4, Layer H).
 *
 * A `PreToolUse` hook — matched to `Bash` and to
 * `^mcp__ruflo__hooks_session-start$` in `.claude/settings.json` — that
 * denies any host-side invocation of `ruflo`/`@claude-flow/cli` outside
 * the sanctioned `docker exec skillsmith-ruflo-1 …` path, and denies a
 * `hooks_session-start` call that would enable `startDaemon`.
 *
 * Design: docs/internal/implementation/smi-6744-ruflo-host-guard.md (this
 * is its Wave 1 implementation, extended by a governance round's H-A
 * through M-D fixes — see that doc's own "Governance round on the
 * implementation" section), built from
 * docs/internal/uat/smi-6744/a44-structural-design-2026-09-27.md § 1(b)
 * Layer H and its 62-row adversarial census (§ 5). Reuses
 * `scripts/lib/shell-command-normalize.mjs` (extracted from
 * `scripts/env-read-guard.mjs`, the precedent this guard's structure
 * copies) for tokenizing and wrapper-normalizing a Bash command. This
 * file's own logic is split across 17 sibling modules in `scripts/lib/`
 * (L2 correction — the list below used to name only 3; M3 follow-up added
 * `ruflo-host-guard-segments.mjs`/`ruflo-host-guard-eval.mjs`, split out of
 * THIS file, when its own docblock corrections pushed it over 500 lines).
 * Seven are imported directly: `ruflo-host-guard-wrappers.mjs`
 * (`envSplitCommandText`/`normalizeWrappersWithExec`/`tokensForArgv`),
 * `ruflo-host-guard-shell-fed.mjs` (`findShellFedLiteralText`/
 * `restoreXargsReplacementWordTokens`, plus `extractInlineScriptText`/
 * `INLINE_SCRIPT_BARE_NAME_RE` re-exported from ITS OWN sibling
 * `ruflo-host-guard-inline-script.mjs`), `ruflo-host-guard-predicates.mjs`
 * (`ALLOW`/`checkAssignmentValuePredicate`/`checkBareNameInversion`/
 * `checkBraceSegment`/`denyInternalError`/`denyMalformedInput`/`denyWith`/
 * `isSanctionedDockerExec`, plus `checkH1toH7`,
 * `isSanctionedNpmForm`/`isReadOnlyNpmForm`, and
 * `checkRunnerVariableArgument` re-exported from its own three siblings
 * `ruflo-host-guard-h1to7.mjs`, `ruflo-host-guard-npm.mjs`, and
 * `ruflo-host-guard-runner-arg.mjs` so this file's own import statement
 * needed no change across any of the three splits),
 * `ruflo-host-guard-verdicts.mjs` (`decideHooksSessionStart` — its other
 * verdict constructors reach this file via the `predicates.mjs` re-export
 * above, not a direct import), `ruflo-host-guard-unresolved.mjs`
 * (`checkUnresolvedCommand`), `ruflo-host-guard-consumers.mjs`
 * (`extractConsumerTexts`/`extractExecEnvVarTexts`, itself dispatching to
 * four further per-family sibling extractors — awk/sed, git config keys,
 * tmux, and sqlite3/psql/osascript — plus
 * `ruflo-host-guard-heredoc-consumers.mjs` for make/crontab/at/batch, none
 * of which this file imports directly), `ruflo-host-guard-segments.mjs`
 * (`splitSegments`), and `ruflo-host-guard-eval.mjs` (`parseEvalSegment` —
 * only the PARSING half of H9's eval predicate; the final recursive
 * `evaluateGuardCommand` call stays in THIS file's own `checkEvalPredicate`
 * wrapper, since `evaluateGuardCommand` is local/non-exported here). All
 * split out purely to stay under the 500-line-per-file convention this
 * repo keeps by hand for .mjs files under scripts/ (M3 correction: not
 * enforced by tooling here — `scripts/check-file-length.mjs` only runs via
 * `lint-staged` for `*.ts`/`*.sh`; SMI-5994).
 *
 * **Failure posture: fail CLOSED**, deliberately the opposite of
 * `env-read-guard.mjs`'s fail-open. A silent re-opening of this closure
 * would be worse than a false-positive denial, because no other layer in
 * this repo's design catches the gap this guard exists to close (design
 * § 1(b) "Failure posture"). One try/catch spans the WHOLE per-segment
 * pipeline (tokenize → normalize → Stage 1 → H1–H9), not narrowly around
 * the H-predicate calls — a tokenizer-level exception must deny too.
 *
 * **No disable variable, by design.** A leading shell assignment never
 * reaches this hook process (it is spawned fresh with the session's
 * environment), so the only real "escape hatch" would be a
 * `.claude/settings.json` `env` block entry — and Check 73 (SMI-6744
 * sibling brief) pins that block to an exact expected set, so a smuggled
 * disable variable there fails Check 73 by construction. The sanctioned
 * path — `docker exec skillsmith-ruflo-1 …` — always works; see
 * docs/internal/process/guards-and-opt-outs.md.
 */

import { MAX_DEPTH, basenameOf, tokenize } from './lib/shell-command-normalize.mjs'
import {
  envSplitCommandText,
  normalizeWrappersWithExec,
  tokensForArgv,
} from './lib/ruflo-host-guard-wrappers.mjs'
import {
  extractInlineScriptText,
  findShellFedLiteralText,
  INLINE_SCRIPT_BARE_NAME_RE,
  restoreXargsReplacementWordTokens,
} from './lib/ruflo-host-guard-shell-fed.mjs'
import {
  ALLOW,
  checkAssignmentValuePredicate,
  checkBareNameInversion,
  checkBraceSegment,
  checkH1toH7,
  checkRunnerVariableArgument,
  denyInternalError,
  denyMalformedInput,
  denyWith,
  isReadOnlyNpmForm,
  isSanctionedDockerExec,
  isSanctionedNpmForm,
} from './lib/ruflo-host-guard-predicates.mjs'
import { decideHooksSessionStart } from './lib/ruflo-host-guard-verdicts.mjs'
import { checkUnresolvedCommand } from './lib/ruflo-host-guard-unresolved.mjs'
import { extractConsumerTexts, extractExecEnvVarTexts } from './lib/ruflo-host-guard-consumers.mjs'
import { evaluateGlobGroupReadings, splitSegments } from './lib/ruflo-host-guard-segments.mjs'
import { parseEvalSegment, resolveTrapVerdict } from './lib/ruflo-host-guard-eval.mjs'

// M3 follow-up: `splitSegments` moved to `ruflo-host-guard-segments.mjs`
// (pure, no dependency on anything else in this file, so it moves
// cleanly) — see that file's own docblock.

/**
 * H9 — dynamic shell evaluators (round 1 finding 1). The PARSING lives in
 * `ruflo-host-guard-eval.mjs`'s `parseEvalSegment`; only the recursion into
 * this file's own `evaluateGuardCommand` stays here. A `trap` whose action
 * is clean FALLS THROUGH (undefined): its segment still carries real argv
 * for every later predicate (SMI-6920 round 2, M-1).
 * @param {Array<{value: string, subs?: string[]}>} wordTokens
 * @param {number} depth
 * @returns {object | undefined} undefined = "not an eval segment, keep going"
 */
function checkEvalPredicate(wordTokens, depth) {
  const parsed = parseEvalSegment(wordTokens)
  if (parsed === undefined || parsed === null) return parsed
  if (typeof parsed.joined !== 'string') return parsed // H9 itself fired
  const verdict = evaluateGuardCommand(parsed.joined, depth + 1)
  return resolveTrapVerdict(parsed, verdict, (t) => evaluateGuardCommand(t, depth + 1))
}

/**
 * Evaluate one segment (a raw, un-split-on-brace token list: word tokens
 * interleaved with any surviving `{`/`}` op tokens). Order matters — see
 * the plan's Stage 0/1/2 structure, reordered by the M-C governance-round
 * fix (SMI-6744 Wave 4) and extended by the delta round's own fixes:
 *   0. recurse into `.subs` (command substitutions) first
 *   0b. (H-1) restore a xargs `-I`/`-i` replacement token this guard's own
 *      tokenizer loses to brace op-tokens, before word-token extraction
 *   1. Stage 1(a) — sanctioned `docker exec skillsmith-ruflo-1` (pre-strip)
 *      — moved ABOVE the brace/H9/H8(i) checks (M-C fix): a sanctioned
 *      wrapper's own INNER shape (e.g. `env V=ruflo`) must not be denied
 *      by a predicate scoped to the whole segment before Stage 1 gets a
 *      chance to recognize the wrapper.
 *   1b. brace-syntax fail-closed check (needs the RAW token list)
 *   2. H9 (eval) — before wrapper normalization
 *   3. H8(i) — pre-strip assignment-value check
 *   3b. (SMI-6869) `extractExecEnvVarTexts` — an `EXEC_ENV_VARS` assignment's
 *      VALUE recursed as real shell text; H8(i) above is a verdict-redundant
 *      cheap early deny for the same shapes (see its own docblock)
 *   4. H-B/H-3 — `env -S`/`--split-string` (before wrapper normalization
 *      mishandles it as an ordinary flag value)
 *   5. wrapper normalization (exec/launcher/docker-container-exec-aware/
 *      script-su-dtrace `-c`-aware) / recurse into a nested shell body
 *   6. Stage 1(b) `isSanctionedNpmForm` — the three exact npm forms
 *      (post-normalize) — followed by Fix D's `isReadOnlyNpmForm` (L4
 *      correction: this step runs BOTH checks, not just the first; the
 *      second closes npm's own read-only subcommands — ls/view/explain/… —
 *      before H5's blunt runner-token scan ever reaches them)
 *   7. (A) fail-closed fall-through — argv[0] must resolve to a real name
 *   8. H-F/H-4/M-1/M-2 — literal text fed to a bare shell
 *      (pipe/here-string/process-sub), or an unreadable pipeline producer
 *   9. H1–H7
 *   10. H8(ii)/H-5
 *   11. (H-8) inline interpreter script text (node -e / python -c / …) —
 *      deliberately AFTER H1–H7/H8(ii): those already close an inline
 *      `-e`/`-c` argument that spells a path-shaped substring, so this
 *      only needs to catch what they don't (a bare quoted name, no path)
 *   11a. (SMI-6869) `extractConsumerTexts` — awk/sed/ssh/git/vim/tmux/
 *      screen/expect/sqlite3/psql/osascript, whose OWN arguments (or a
 *      config value they write) embed a string that PROGRAM will itself
 *      hand to a shell or spawn as a new process. Checked AFTER H-8, same
 *      rationale: a narrower predicate above may already have closed the
 *      same argv. See `scripts/lib/ruflo-host-guard-consumers.mjs`'s own
 *      docblock.
 *   12. (M-6) bare-name inversion — LAST, the most general fallback,
 *      closing a bare `ruflo` past argv[0] in front of an unmodelled
 *      launcher (`ssh`/`watch`/`flock`/`strace`/…) that nothing above
 *      already denies
 *
 * SMI-6869 Fix A/B/C additions: a redirect-marked word token (`2>&1`,
 * `>/dev/null`) is excluded from `wordTokens`/argv wherever this file
 * builds it — it is never real command argv (Fix A). A `heredoc`-type
 * token's own `.subs` are recursed into unconditionally alongside `.word`
 * subs (step 0) — an UNQUOTED heredoc's `$(...)`/backtick spans are
 * expanded by the CURRENT shell regardless of which command consumes the
 * heredoc body, so they execute even when that body is otherwise inert
 * data (Fix B). `embedded` (default false, Fix C) gates three groups of
 * this function's own arms — `checkUnresolvedCommand`'s empty-residual,
 * all-digit, `/dev/` path and `$`-in-head arms, the `unreadable-shell-input`
 * shell-fed-deny arm, and the bare-name-inversion check — off when
 * evaluating INTERPRETER PROGRAM SOURCE, since those arms presume the
 * text is a real shell command line. It is set true at exactly THREE sites
 * (round-4 correction — an earlier version of this doc said "two"), all
 * program-source entrances: the interpreter-stdin branch of the shell-fed
 * step (an interpreter's own heredoc, or a pipe into one), the H-8
 * inline-flag recursion below, and the consumer-string step's own
 * `kind === 'source'` recursion further below. Every route that extracts
 * genuine shell text (`$()`, backticks, `eval`, `env -S`, a shell's `-c`,
 * text fed to a shell) recurses non-embedded.
 * @param {Array<{type: string, value?: string, subs?: string[]}>} segmentTokens
 * @param {number} depth
 * @param {Array<{tokens: Array<object>, precedingOp: string|null}>} segments
 *   every segment of the FULL command, in order
 * @param {number} segmentIndex this segment's own index into `segments`
 * @param {boolean} [embedded]
 */
function evaluateGuardSegment(segmentTokens, depth, segments, segmentIndex, embedded = false) {
  for (const tok of segmentTokens) {
    if (tok.type !== 'word' && tok.type !== 'heredoc') continue
    for (const sub of tok.subs ?? []) {
      const nestedVerdict = evaluateGuardCommand(sub, depth + 1)
      if (nestedVerdict) return nestedVerdict
    }
  }

  const firstWord = segmentTokens.find((t) => t.type === 'word' && !t.redirect)
  const wordTokens =
    firstWord && basenameOf(firstWord.value) === 'xargs'
      ? restoreXargsReplacementWordTokens(segmentTokens)
      : segmentTokens.filter((t) => t.type === 'word' && !t.redirect)
  if (wordTokens.length === 0) return null
  const rawValues = wordTokens.map((t) => t.value)

  if (isSanctionedDockerExec(rawValues)) return null

  const braceVerdict = checkBraceSegment(segmentTokens)
  if (braceVerdict) return braceVerdict

  const evalVerdict = checkEvalPredicate(wordTokens, depth)
  if (evalVerdict !== undefined) return evalVerdict

  const h8iVerdict = checkAssignmentValuePredicate(wordTokens)
  if (h8iVerdict) return h8iVerdict

  // SMI-6869 round 2: an EXEC_ENV_VARS assignment's VALUE is real shell
  // text a downstream program execs — recurse it non-embedded, same as an
  // `env -S` body. Runs on the SAME pre-strip wordTokens as H8(i) above.
  const execEnvTexts = extractExecEnvVarTexts(wordTokens)
  if (execEnvTexts) {
    for (const { text } of execEnvTexts) {
      const nestedEnvVerdict = evaluateGuardCommand(text, depth + 1)
      if (nestedEnvVerdict) return nestedEnvVerdict
    }
  }

  const envSplitNested = envSplitCommandText(rawValues)
  if (envSplitNested !== null) return evaluateGuardCommand(envSplitNested, depth + 1)

  const { argv: normalizedArgv, nested } = normalizeWrappersWithExec(rawValues)
  if (nested !== null) return evaluateGuardCommand(nested, depth + 1)

  const argvLower = normalizedArgv.map((s) => s.toLowerCase())
  if (isSanctionedNpmForm(argvLower)) return null
  // SMI-6869 Fix D: read-only npm subcommands (ls/view/explain/…), checked
  // here (before H1–H7) so H5's blunt runner-token scan never reaches
  // them; npm's own executing forms (exec/x/run) are untouched by this.
  if (isReadOnlyNpmForm(argvLower)) return null

  const alignedTokens = tokensForArgv(wordTokens, normalizedArgv)

  const unresolvedVerdict = checkUnresolvedCommand(
    rawValues,
    normalizedArgv,
    alignedTokens,
    embedded
  )
  if (unresolvedVerdict) return unresolvedVerdict

  const shellFedResult = findShellFedLiteralText(argvLower, segmentTokens, segments, segmentIndex)
  if (shellFedResult) {
    if (shellFedResult.deny) {
      if (!embedded) return denyWith('unreadable-shell-input', shellFedResult.token)
      // embedded: an "unreadable pipeline producer" heuristic doesn't
      // mean anything against inline script text — skip this arm only,
      // fall through to the remaining checks below.
    } else if (shellFedResult.embedded) {
      // an interpreter's stdin is PROGRAM SOURCE, not a shell command line
      if (INLINE_SCRIPT_BARE_NAME_RE.test(shellFedResult.text)) {
        return denyWith('H8-script', shellFedResult.text)
      }
      const nested = evaluateGuardCommand(shellFedResult.text, depth + 1, true)
      if (nested) return nested
    } else {
      // Governance-round Minor 3 fix (confirmed by mutation: deleting the
      // sibling `continueOnAllow` arm this replaced changed 0 of 1,263
      // verdicts while its own motivating cases still reached it, since a
      // heredoc CONSUMER's body and a BARE shell's fed text — heredoc,
      // here-string, process substitution, or pipe into
      // `bash`/`sh`/`zsh`/`dash`/`ksh`/`make`/`crontab`/`at`/`batch` — are
      // both an EXTRA place to look, not a REPLACEMENT for this segment's
      // own argv checks (governance-round C1 fix, post-PR-#2959 retro,
      // regression: an unconditional `return evaluateGuardCommand(...)`
      // here used to return `null` whenever the fed body was itself
      // benign, short-circuiting every check below — including the ones
      // that already deny `bash ruflo <<'EOF'` (H4b) and `bash
      // node_modules/.bin/ruflo <<'EOF'` (H3) with NO fed text at all).
      // Only a POSITIVE verdict from the fed body returns early; a clean
      // body falls through to every remaining check.
      const nestedFed = evaluateGuardCommand(shellFedResult.text, depth + 1)
      if (nestedFed) return nestedFed
    }
  }

  const scanArgvLower = rawValues.map((s) => s.toLowerCase())
  const h1to7Verdict = checkH1toH7(scanArgvLower, argvLower)
  if (h1to7Verdict) return h1to7Verdict

  const h8iiVerdict = checkRunnerVariableArgument(argvLower, alignedTokens)
  if (h8iiVerdict) return h8iiVerdict

  // (H-8) inline interpreter script text — checked AFTER H1–H7/H8(ii),
  // not before: H1's own raw-text substring scan already catches an
  // inline `-e`/`-c` argument that spells a `node_modules/ruflo`- or
  // `bin/ruflo.js`-shaped PATH (its whole `-e` argument is one of the raw
  // elements `scanArgvLower` scans), so running this check first would
  // steal H1/H2's own predicate label from cases they already close
  // (measured: the existing B8/L-D census rows regressed to `H8-script`
  // when this ran earlier). This check exists for the shapes H1–H7 do
  // NOT already catch — a bare quoted name with no path text at all
  // (`execSync("ruflo")`).
  const inlineScriptText = extractInlineScriptText(normalizedArgv, alignedTokens)
  if (inlineScriptText !== null) {
    if (INLINE_SCRIPT_BARE_NAME_RE.test(inlineScriptText)) {
      return denyWith('H8-script', inlineScriptText)
    }
    // SMI-6869 Fix C: this text is program source (JS/Python/…), not a
    // shell command line — evaluate it in embedded mode. This is one of
    // THREE program-source entrances that set embedded true (round-4
    // correction — an earlier version of this comment said "two", but the
    // consumer-string step's OWN `kind === 'source'` recursion below has
    // been a third since that family's awk/vim/expect source-kind entries
    // were introduced): the interpreter-stdin branch of the shell-fed step
    // above (round 1), this H-8 inline-script recursion, and the
    // consumer-string `kind === 'source'` recursion a few lines down; every
    // other recursive call in this file evaluates real shell text and
    // stays non-embedded.
    const nestedScriptVerdict = evaluateGuardCommand(inlineScriptText, depth + 1, true)
    if (nestedScriptVerdict) return nestedScriptVerdict
  }

  // SMI-6869 consumer-string family — awk/sed/ssh/git/vim/tmux/screen/
  // expect (see ruflo-host-guard-consumers.mjs). Each extracted text is
  // either 'shell' (recursed non-embedded, the same treatment a nested
  // `-c` body gets) or 'source' (tested against INLINE_SCRIPT_BARE_NAME_RE,
  // then recursed embedded — exactly the H-8 pattern immediately above).
  const consumerTexts = extractConsumerTexts(
    normalizedArgv,
    alignedTokens,
    segmentTokens,
    segments,
    segmentIndex
  )
  if (consumerTexts) {
    for (const { text, kind } of consumerTexts) {
      if (kind === 'source') {
        if (INLINE_SCRIPT_BARE_NAME_RE.test(text)) {
          return denyWith('H8-script', text)
        }
        const nestedSourceVerdict = evaluateGuardCommand(text, depth + 1, true)
        if (nestedSourceVerdict) return nestedSourceVerdict
      } else {
        const nestedShellVerdict = evaluateGuardCommand(text, depth + 1)
        if (nestedShellVerdict) return nestedShellVerdict
      }
    }
  }

  // (M-6) bare-name inversion — checked LAST, as the most general
  // fallback: every EXISTING H-predicate above (H1–H7, H8(ii), the H-8
  // inline-script check) is more specific than "any bare name past
  // argv[0]", so anything they already deny must keep their OWN
  // predicate label (measured: several A-row/H-5/L-D census rows
  // regressed to `H4b` when this ran earlier). This closes what NONE of
  // them do: a bare `ruflo` in front of an unmodelled launcher
  // (`ssh`/`watch`/`flock`/`strace`/…). Skipped when embedded (SMI-6869
  // Fix C) — program source text is not shaped like "a launcher followed
  // by a bare command name".
  if (!embedded) {
    const bareNameVerdict = checkBareNameInversion(argvLower)
    if (bareNameVerdict) return bareNameVerdict
  }

  return null
}

/**
 * Evaluate a full command string: tokenize, split into segments (NOT
 * splitting on `{`/`}`, per `SPLIT_OPS`), evaluate each in order, return
 * the first denial. Fail-closed depth boundary — this guard DENIES once
 * `depth > MAX_DEPTH`, matching its overall fail-closed posture (plan §
 * "Choices Made" / § Predicate Specification "Failure posture").
 * `env-read-guard.mjs`'s own `evaluateCommand` used to return `null`
 * (allow) at the same boundary instead; since SMI-6892 it denies with kind
 * `'depth-cap'` at the same shared `MAX_DEPTH`, so both guards now share
 * one fail-closed posture at this cap, not two different ones.
 * @param {string} commandText
 * @param {number} depth
 * @param {boolean} [embedded] SMI-6869 Fix C — true only when `commandText`
 *   is inline interpreter/consumer-string program source, not a real shell
 *   command line; see `evaluateGuardSegment`'s own doc. Applies uniformly to
 *   every segment of `commandText` (all of it is the same embedded program
 *   source), but is NOT inherited by any recursive `evaluateGuardCommand`
 *   call this function's segments make for genuinely nested shell text
 *   (subs, heredoc subs, eval, `env -S`, a nested shell body, shell-fed
 *   text) — embedded mode is entered only from THREE recursion sites
 *   (round-4 correction — an earlier version of this doc said "the one H-8
 *   recursion site"): the shell-fed step's interpreter-stdin branch, the
 *   H-8 inline-script recursion, and the consumer-string step's own
 *   `kind === 'source'` recursion; a fourth gate is this function's own, the glob reading below, skipped when embedded (SMI-6908 F-14).
 */
function evaluateGuardCommand(commandText, depth, embedded = false) {
  if (depth > MAX_DEPTH) {
    return denyInternalError('recursion depth cap exceeded while unwrapping nested shell text')
  }
  if (typeof commandText !== 'string' || commandText.trim() === '') return null
  const tokens = tokenize(commandText)
  const segments = splitSegments(tokens)
  for (let i = 0; i < segments.length; i++) {
    const verdict = evaluateGuardSegment(segments[i].tokens, depth, segments, i, embedded)
    if (verdict) return verdict
  }
  // SMI-6903 H1: additive second reading over zsh glob-group alternatives.
  // Not in embedded mode: inline program text is not shell words, so its
  // `(a || b)` groups are not zsh alternations, and their cross product
  // reached the `glob-cap` refusal on a real `node -e` (SMI-6908 F-14).
  if (embedded) return null
  return evaluateGlobGroupReadings(tokens, (segs, i) =>
    evaluateGuardSegment(segs[i].tokens, depth, segs, i, embedded)
  )
}

/**
 * Pure decision function — no I/O. Given a raw PreToolUse `toolCall`
 * payload and `process.env` (unused — this guard has no disable variable
 * by design; the parameter exists only to keep the same shape as
 * `env-read-guard.mjs`'s `decide(toolCall, env)`), decides allow/deny.
 *
 * Runtime input failures are DENIALS here (round 1 finding 4), unlike the
 * precedent: a non-object payload, a missing/non-string `tool_name`, or a
 * matched tool (`Bash` or `mcp__ruflo__hooks_session-start`) lacking its
 * required `tool_input` shape all deny. Only a well-formed payload for an
 * UNRELATED tool_name returns allow.
 *
 * @param {unknown} toolCall
 * @param {Record<string, string | undefined>} _env unused, see above
 */
export function decide(toolCall, _env) {
  try {
    if (toolCall === null || typeof toolCall !== 'object' || Array.isArray(toolCall)) {
      return denyMalformedInput('empty, unparseable, or non-object PreToolUse payload')
    }
    if (typeof toolCall.tool_name !== 'string') {
      return denyMalformedInput('missing or non-string tool_name')
    }

    if (toolCall.tool_name === 'mcp__ruflo__hooks_session-start') {
      return decideHooksSessionStart(toolCall.tool_input)
    }

    if (toolCall.tool_name !== 'Bash') return ALLOW

    const toolInput = toolCall.tool_input
    const command =
      toolInput !== null && typeof toolInput === 'object' && !Array.isArray(toolInput)
        ? toolInput.command
        : undefined
    if (typeof command !== 'string') {
      return denyMalformedInput('Bash tool_input is missing a string command')
    }
    if (command.trim() === '') return ALLOW

    return evaluateGuardCommand(command, 0) ?? ALLOW
  } catch (err) {
    return denyInternalError(`evaluator threw: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// --- Runtime wrapper (thin shell around the pure decide() core) ---

if (import.meta.url === `file://${process.argv[1]}`) {
  const chunks = []
  process.stdin.on('data', (chunk) => chunks.push(chunk))
  process.stdin.on('end', () => {
    let toolCall = null
    try {
      const raw = Buffer.concat(chunks).toString('utf8')
      toolCall = raw.trim().length > 0 ? JSON.parse(raw) : null
    } catch {
      toolCall = null
    }

    const result = decide(toolCall, process.env)

    if (result.action === 'deny') {
      process.stdout.write(JSON.stringify(result.json))
      process.exit(0)
    }

    if (result.stderr) process.stderr.write(`${result.stderr}\n`)
    process.exit(0)
  })
}
