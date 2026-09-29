/**
 * Shared shell-command normalization primitives (SMI-6744 A4.6 extraction).
 *
 * Moved out of `scripts/env-read-guard.mjs` verbatim (a pure move, no
 * behavior edit) so a second `PreToolUse` Bash hook —
 * `scripts/ruflo-host-guard.mjs` — can reuse the same tokenizer and
 * wrapper-normalization machinery instead of re-implementing it. Before
 * this move, every one of these was a private top-level declaration with
 * no `export` keyword (confirmed: `grep -n '^export' scripts/env-read-guard.mjs`
 * returned only its `decide` export), so a second guard could not import
 * them as written.
 *
 * Two functions changed SIGNATURE, not behavior, in the move:
 * `hasInlineScriptFlag` and `scanPositionalScriptText` used to close over
 * env-read-guard.mjs's own module-level `INLINE_SCRIPT_SHORT_FLAG_CHARS`
 * and `scanTextForProtected` — env-specific pieces tied to hunting `.env`
 * references. They now take the equivalent piece as a parameter instead,
 * so a domain-specific consumer supplies its own without this module
 * knowing anything about either domain. `env-read-guard.mjs` passes its
 * own `INLINE_SCRIPT_SHORT_FLAG_CHARS` / `scanTextForProtected` at each
 * call site — its own verdicts are unchanged by this move. **The second
 * consumer this parameterisation was provisioned for now exists (H-8 fix,
 * SMI-6744 Wave 4 governance round, superseding the L-5 finding's "not an
 * existing one" note)**: `scripts/lib/ruflo-host-guard-wrappers.mjs`'s
 * `extractInlineScriptText` calls `hasInlineScriptFlag` (with its OWN
 * per-interpreter short-flag map) as a first-pass "does this argv even
 * carry an inline-script flag" check before extracting the script-text
 * argument's value and scanning it for a bare `ruflo`/`claude-flow`/
 * `claude-flow-mcp` reference — `node -e 'require("child_process").
 * execSync("ruflo")'` is exactly the shape this closes.
 *
 * Parity claim: "behaviourally equivalent for the characterised input
 * matrix" pinned by `scripts/tests/shell-command-normalize.test.ts` (run
 * green against the pre-extraction in-file implementations before this
 * file existed, then re-run green against these exports after the move),
 * not "byte-for-byte" — see that test file's header and
 * docs/internal/implementation/smi-6744-ruflo-host-guard.md's "Parity
 * harness for the shared normalizer" section.
 *
 * `env-read-guard.mjs`'s own `checkArgv`, `evaluateCommand`, `decide`,
 * `scanTextForProtected`, `INLINE_SCRIPT_SHORT_FLAG_CHARS` and
 * `INLINE_INTERPRETERS` stay in that file — they are `.env`-specific, not
 * reusable normalization primitives. `scripts/ruflo-host-guard.mjs`'s own
 * `exec`-wrapper handling, brace-syntax fail-closed check, and H9 (`eval`)
 * predicate are guard-local for the same reason and are NOT in this file.
 *
 * `tokenize`/`basenameOf` moved to the sibling `shell-command-tokenize.mjs`
 * (SMI-6744 Wave 4 delta governance round, same hand-kept 500-line-per-file
 * convention this repo keeps for .mjs files under scripts/ — M3
 * correction: not enforced by tooling here, `scripts/check-file-length.mjs`
 * only runs via `lint-staged` for `*.ts`/`*.sh`; SMI-5994) and are
 * re-exported below, so every existing import of THIS file keeps working
 * unchanged.
 */

import { basenameOf, tokenize } from './shell-command-tokenize.mjs'

export { basenameOf, tokenize }

/** Recognized shell wrappers whose `-c '<body>'` form carries a nested command. */
export const SHELL_COMMANDS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])

/**
 * Wrapper options that consume a following value, so flag-skipping does
 * not mistake that value for the wrapped command. One shared set across
 * `sudo`, `docker exec`, `docker compose`, and `varlock run` — these four
 * wrappers' own flag vocabularies don't collide with each other, so a flag
 * belonging to one being recognized by another among THESE FOUR is
 * harmless.
 *
 * **That claim does not generalize to every wrapper (H-2 correction,
 * SMI-6744 Wave 4 governance round).** `scripts/ruflo-host-guard.mjs`
 * originally routed `exec`/`command`/`noglob`/`builtin` through this same
 * shared set via the generic `stripFlags`, and it was NOT harmless there:
 * this set's `-p`/`--prompt` (sudo's password-prompt flag) collided with
 * `command -p`'s own POSIX "use the default PATH" flag, which takes NO
 * value — `command -p ruflo memory store` was wrongly parsed as `-p`
 * consuming `ruflo` as ITS value, leaving a residual (`memory store`) with
 * no recognizable ruflo signal left in it. That guard now gives
 * `exec`/`command`/`noglob`/`builtin` their OWN per-wrapper value-flag
 * sets instead of reusing this one — see `ruflo-host-guard-wrappers.mjs`'s
 * `LAUNCHER_TABLE`.
 */
const WRAPPER_VALUE_FLAGS = new Set(
  (
    '-u --user -g --group -p --prompt -h --host -e --env -w --workdir --env-file --detach-keys ' +
    '--index -f --file --project-name --project-directory --profile --progress --ansi ' +
    '--parallel --context'
  ).split(' ')
)

/** Recursion cap for nested `bash -c` / `$(...)` unwrapping. */
export const MAX_DEPTH = 6

/**
 * Long flags that introduce inline script text on an interpreter. Checked
 * against every interpreter uniformly (never per-interpreter) — unlike a
 * per-interpreter short-flag map, over-recognizing a long flag no
 * interpreter actually has is safe (it just triggers one extra, harmless
 * text scan). Includes php's four long-form process-hook aliases
 * (--run/--process-begin/--process-code/--process-end), confirmed against
 * php.net's CLI options page — SMI-6361 adversarial confirmation-pass
 * finding F3.
 */
export const INLINE_SCRIPT_LONG_FLAGS = new Set([
  '--eval',
  '--print',
  '--execute',
  '--command',
  '--run',
  '--process-begin',
  '--process-code',
  '--process-end',
])

/**
 * Commands whose FIRST positional (non-flag) argument is inline script
 * text BY DEFAULT, unlike an interpreter whose inline-code argument is
 * always introduced by an explicit flag (-e/-c/-p/-r/...): awk puts
 * script text in bare position, `awk '<program>' [file...]`. Unless a
 * `-f <file>` flag names an external script file instead, in which case
 * there is no inline text to scan. See `scanPositionalScriptText` below
 * for the scanning rationale (moved verbatim from env-read-guard.mjs,
 * SMI-6361 finding F6).
 */
const POSITIONAL_SCRIPT_COMMANDS = new Set(['awk', 'gawk', 'mawk', 'sed'])

// --- Wrapper normalization ---

/**
 * Drop leading option tokens, consuming a value for known value-taking
 * flags. Stops at `--`, at the first non-flag, or at end.
 */
export function stripFlags(argv) {
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--') {
      i++
      break
    }
    if (!a.startsWith('-') || a === '-') break
    if (a.includes('=')) {
      i++
      continue
    }
    i += WRAPPER_VALUE_FLAGS.has(a) ? 2 : 1
  }
  return argv.slice(i)
}

/** Strip `env`'s own flags and `VAR=val` assignments. */
export function stripEnvPrefix(argv) {
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
      i++
      continue
    }
    if (a === '-u' || a === '--unset' || a === '-C' || a === '--chdir') {
      i += 2
      continue
    }
    if (a.startsWith('-')) {
      i++
      continue
    }
    break
  }
  return argv.slice(i)
}

/** `docker exec [flags] <container> <inner...>` → `<inner...>`. */
export function stripDockerExec(rest) {
  return stripFlags(rest).slice(1)
}

/** `docker compose [flags] exec [flags] <service> <inner...>` → `<inner...>`. */
export function stripDockerCompose(argv, head) {
  const rest = stripFlags(head === 'docker-compose' ? argv.slice(1) : argv.slice(2))
  if (rest[0] !== 'exec') return null
  return stripDockerExec(rest.slice(1))
}

/**
 * True when every token in `argv[start, end)` is either a flag or the
 * consumed value of a preceding value-taking flag — i.e. the span cannot
 * hide the start of a wrapped command's own argv. Used by `stripVarlockRun`
 * (H-E fix, SMI-6744 Wave 4 governance round) to confirm a `--` really is
 * `varlock run`'s own separator before trusting `indexOf('--', 2)` to find
 * it, rather than a `--` belonging to the WRAPPED command's own argv (e.g.
 * `varlock run npx ruflo … -- x`, where `--` is npx/npm's own separator,
 * not varlock's).
 */
function isFlagOnlySpan(argv, start, end) {
  let i = start
  while (i < end) {
    const a = argv[i]
    if (!a.startsWith('-') || a === '-') return false
    i += WRAPPER_VALUE_FLAGS.has(a) ? 2 : 1
  }
  return i === end
}

/**
 * `varlock run [flags] -- <inner...>` → `<inner...>`. The naive
 * `indexOf('--', 2)` used to accept the FIRST `--` anywhere in argv as the
 * separator, even when everything between `run` and it was already the
 * wrapped command's own argv (H-E fix, SMI-6744 Wave 4 governance round:
 * `varlock run npx ruflo memory store --key k -- x` silently exposed
 * `['npx','ruflo',…]` unstripped as the "flags" span, but `isFlagOnlySpan`
 * correctly rejects it since `npx` is not a flag, so this falls back to
 * `stripFlags` instead of trusting that `--` as varlock's own boundary).
 * This also closes the identical hole in `env-read-guard.mjs`'s own
 * varlock-unwrap, which shares this function via `normalizeWrappers`.
 */
export function stripVarlockRun(argv) {
  const sep = argv.indexOf('--', 2)
  if (sep !== -1 && isFlagOnlySpan(argv, 2, sep)) return argv.slice(sep + 1)
  return stripFlags(argv.slice(2))
}

/** `bash -c '<inner>'` → the inner string, or null if not that shape. */
export function extractShellDashC(argv) {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('-')) return null
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) return i + 1 < argv.length ? argv[i + 1] : null
  }
  return null
}

/**
 * Peel wrapper shells off argv until a real command is exposed. A
 * command can be wrapped more than once, so this iterates.
 * @returns {{ argv: string[], nested: string | null }}
 */
export function normalizeWrappers(argvIn) {
  let argv = argvIn.slice()
  for (let pass = 0; pass < 8; pass++) {
    if (argv.length === 0) break
    let lead = 0
    while (lead < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[lead])) lead++
    if (lead > 0) {
      argv = argv.slice(lead)
      continue
    }
    const head = basenameOf(argv[0])
    if (head === 'sudo') {
      argv = stripFlags(argv.slice(1))
      continue
    }
    if (head === 'env') {
      argv = stripEnvPrefix(argv.slice(1))
      continue
    }
    if (head === 'varlock' && argv[1] === 'run') {
      argv = stripVarlockRun(argv)
      continue
    }
    if (head === 'docker' && argv[1] === 'exec') {
      argv = stripDockerExec(argv.slice(2))
      continue
    }
    if ((head === 'docker' && argv[1] === 'compose') || head === 'docker-compose') {
      const inner = stripDockerCompose(argv, head)
      if (inner) {
        argv = inner
        continue
      }
    }
    if (SHELL_COMMANDS.has(head)) {
      const nested = extractShellDashC(argv)
      if (nested !== null) return { argv, nested }
    }
    break
  }
  return { argv, nested: null }
}

/**
 * True when an interpreter invocation carries inline script text. Short
 * flags are checked per-interpreter via the caller-supplied `shortFlagChars`
 * map (e.g. env-read-guard.mjs's own `INLINE_SCRIPT_SHORT_FLAG_CHARS`);
 * long flags (--eval/--print/--execute/--command/...) are checked against
 * every interpreter uniformly — over-recognizing a long flag no
 * interpreter actually has is safe (it just triggers an extra, harmless
 * text scan), unlike under-recognizing a real short flag.
 * @param {string} cmd
 * @param {string[]} args
 * @param {Record<string, string>} shortFlagChars per-interpreter short-flag
 *   characters (moved out of this module so a consumer's own env-specific
 *   map doesn't have to live here)
 */
export function hasInlineScriptFlag(cmd, args, shortFlagChars) {
  const shortChars = shortFlagChars?.[cmd] ?? ''
  for (const a of args) {
    if (a === '--') break
    if (INLINE_SCRIPT_LONG_FLAGS.has(a.split('=')[0])) return true
    if (a.startsWith('--') || a === '-' || !a.startsWith('-')) continue
    for (const ch of a.slice(1)) {
      if (shortChars.includes(ch)) return true
    }
  }
  return false
}

/**
 * awk/sed/gawk/mawk mix flags and inline SCRIPT TEXT unpredictably, across
 * both separated (`-v n=1`) and attached (`-vn=1`, `-e'r .env'`) short-
 * option forms, plus gawk's long forms (`--source=`, `--assign=`) and
 * platform-specific arity quirks. This scans EVERY argument uniformly
 * instead of trying to identify which one is "the script" — see
 * env-read-guard.mjs's own SMI-6361 history for why (three live bypasses
 * found against an arity-modeling attempt in one adversarial round).
 *
 * Deliberately no `if (a === '--') break` here, unlike the flag-scanning
 * loops in `hasInlineScriptFlag`/callers' own option scans. Those loops
 * scan OPTIONS, where `--` correctly means "stop, everything after this is
 * not a flag." Here we scan SCRIPT TEXT, where `--` means the opposite:
 * "everything after this IS the script, even though it might start with a
 * dash" — `awk -- 'BEGIN{...}'` puts the real program immediately after
 * `--`. `scanFn('--')` returning null/falsy harmlessly is relied on
 * instead of a special case. **This is not a stylistic choice — a fourth
 * adversarial round (SMI-6361) found this exact `break` was a regression
 * an earlier uniform-scan rewrite introduced**: the two functions it
 * replaced both deliberately looked PAST `--`, so `awk -- '<code touching
 * the protected reference>'` denied on the parent commit and silently
 * started ALLOWING on the regression — a real bypass, not this design's
 * accepted over-scanning tradeoff (L-F fix, SMI-6744 Wave 4 governance
 * round — this clause was dropped when the function moved out of
 * `env-read-guard.mjs` into this shared module).
 * @param {string} cmd
 * @param {string[]} args
 * @param {(text: string) => string | null} scanFn scans one argument's text
 *   for a protected reference, returning the match or null (moved out of
 *   this module so a consumer's own scan target — e.g. `.env`, or a
 *   `node_modules/ruflo` path segment — doesn't have to live here)
 * @returns {string | null} the first match scanFn finds in positional/
 *   flag-attached script text, or null.
 */
export function scanPositionalScriptText(cmd, args, scanFn) {
  if (!POSITIONAL_SCRIPT_COMMANDS.has(cmd)) return null
  for (const a of args) {
    const embedded = scanFn(a)
    if (embedded) return embedded
  }
  return null
}

/**
 * Every word of every substitution BODY under `words`, at any nesting
 * depth: a body is tokenized, its words collected, and each of those
 * words' own `.subs` opened in turn, so `$(echo $(echo .env))` reads like
 * one flat argument list (a single pass leaves the nested `$(...)` as one
 * unopened word).
 *
 * Fails closed at `MAX_DEPTH`: this function feeds a read check its
 * argument list, so stopping early would understate what that argv
 * receives; a truncated result is reported as such and the caller treats
 * it as unresolvable (the posture `ruflo-host-guard.mjs`'s
 * `evaluateGuardCommand` takes at its own cap).
 * @param {Array<{value: string, subs?: string[]}>} words
 * @param {number} [depth]
 * @returns {{ words: string[], truncated: boolean }}
 */
export function flattenSubWords(words, depth = 0) {
  if (depth > MAX_DEPTH) return { words: [], truncated: true }
  const out = []
  for (const w of words) {
    for (const sub of w.subs ?? []) {
      const subTokens = tokenize(sub).filter((t) => t.type === 'word' && !t.redirect)
      out.push(...subTokens.map((t) => t.value))
      const nested = flattenSubWords(subTokens, depth + 1)
      if (nested.truncated) return { words: out, truncated: true }
      out.push(...nested.words)
    }
  }
  return { words: out, truncated: false }
}

/**
 * When a segment's own argv[0] IS a substitution, the command that will
 * run is unresolved for this segment -- `` `cat` .env `` runs whatever its
 * body prints, with `.env` as ITS OWN argument, so no reader check can
 * fire against a named command at all. Two independent checks the caller
 * cannot make on its own:
 *
 * 1. Whatever the body prints, a value in a REMAINING argument the
 *    caller's own `checkFlaggedArg` flags is still that unnamed command's
 *    argument -- checked first, regardless of what the body resolves to
 *    (`$(echo cat) .env`: the body's head is `echo`, not `cat`, so a
 *    head-only re-check misses this entirely).
 * 2. The shape this guard has always caught: the body prints its OWN
 *    name, found by re-running the caller's own `checkArgv` with the
 *    body's HEAD word swapped in for the unresolved argv[0].
 * @param {Array<{value: string, subs?: string[]}>} argvWords the segment's
 *   words BEFORE wrapper peeling (the peeled argv is aligned to them here)
 * @param {string[]} normalizedArgv the caller's wrapper-peeled argv values
 * @param {(arg: string) => T | null} checkFlaggedArg returns the caller's
 *   own violation shape for a flagged tail argument, or null
 * @param {(argv: string[]) => T | null} checkArgv the caller's own per-argv check
 * @param {() => T} onTruncated the caller's fail-closed violation when the
 *   tail's substitutions nest past `MAX_DEPTH`
 * @returns {T | null}
 */
export function checkUnresolvedHeadTail(
  argvWords,
  normalizedArgv,
  checkFlaggedArg,
  checkArgv,
  onTruncated
) {
  // Wrapper peeling (`normalizeWrappers`) only ever strips a PREFIX, so the
  // normalized argv is a suffix of the words: align to it, so that
  // `sudo $(echo cat) .env` is judged by its real head and not by `sudo`.
  const offset = argvWords.length - normalizedArgv.length
  const aligned =
    offset > 0 && normalizedArgv.every((v, i) => argvWords[offset + i]?.value === v)
      ? argvWords.slice(offset)
      : argvWords
  if (aligned.length === 0 || (aligned[0].subs?.length ?? 0) === 0) return null
  // A tail argument that is itself a substitution supplies its OUTPUT, so
  // its body's words (at any depth) are this unnamed command's arguments
  // too: `$(echo cat) $(echo .env)`.
  const tailWords = aligned.slice(1)
  const tailFlat = flattenSubWords(tailWords)
  if (tailFlat.truncated) return onTruncated()
  const tailArgs = [...tailWords.map((w) => w.value), ...tailFlat.words]
  for (const a of tailArgs) {
    const flagged = checkFlaggedArg(a)
    if (flagged) return flagged
  }
  for (const s of aligned[0].subs) {
    const head = tokenize(s).find((t) => t.type === 'word' && !t.redirect)
    if (!head) continue
    const violation = checkArgv([head.value, ...tailArgs])
    if (violation) return violation
  }
  return null
}
