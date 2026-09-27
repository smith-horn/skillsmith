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
 * references. They now take the equivalent piece as a parameter, so a
 * consumer scanning for something else (e.g. a `ruflo`/`node_modules`
 * path segment) can supply its own without this module knowing anything
 * about either domain. `env-read-guard.mjs` passes its own
 * `INLINE_SCRIPT_SHORT_FLAG_CHARS` / `scanTextForProtected` at each call
 * site — its own verdicts are unchanged by this move.
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
 */

/** Recognized shell wrappers whose `-c '<body>'` form carries a nested command. */
export const SHELL_COMMANDS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])

/**
 * Wrapper options that consume a following value, so flag-skipping does
 * not mistake that value for the wrapped command. One shared set across
 * `sudo`, `docker exec`, `docker compose`, and `varlock run` — these
 * only ever appear in wrapper-flag position, so a flag belonging to one
 * wrapper being recognized by another is harmless.
 */
export const WRAPPER_VALUE_FLAGS = new Set(
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
export const POSITIONAL_SCRIPT_COMMANDS = new Set(['awk', 'gawk', 'mawk', 'sed'])

/** @param {string} p */
export function basenameOf(p) {
  return p.split('/').pop()
}

// --- Tokenizer (quote-aware, records command substitutions) ---

/** Index just past the closing `"` starting at s[i] === '"'. */
function skipDouble(s, i) {
  let j = i + 1
  while (j < s.length) {
    if (s[j] === '\\') {
      j += 2
      continue
    }
    if (s[j] === '"') return j + 1
    j++
  }
  return s.length
}

/** Balanced-paren read; s[start] === '('. */
function readParen(s, start) {
  let depth = 0
  let i = start
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === "'") {
      const e = s.indexOf("'", i + 1)
      i = e === -1 ? s.length : e + 1
      continue
    }
    if (c === '"') {
      i = skipDouble(s, i)
      continue
    }
    if (c === '(') {
      depth++
      i++
      continue
    }
    if (c === ')') {
      depth--
      i++
      if (depth === 0) return { inner: s.slice(start + 1, i - 1), next: i }
      continue
    }
    i++
  }
  return { inner: s.slice(start + 1), next: s.length }
}

/**
 * Split a command string into word/operator tokens. Word tokens carry
 * their unquoted `value` plus any `$(...)` / backtick bodies in `subs`.
 * @param {string} command
 */
export function tokenize(command) {
  const tokens = []
  let cur = null
  const flush = () => {
    if (cur !== null) tokens.push(cur)
    cur = null
  }
  const word = () => {
    if (cur === null) cur = { type: 'word', value: '', subs: [] }
    return cur
  }
  const pushOp = (value, width, i) => {
    flush()
    tokens.push({ type: 'op', value })
    return i + width
  }

  let i = 0
  while (i < command.length) {
    const c = command[i]
    if (c === '\\') {
      if (i + 1 < command.length) word().value += command[i + 1]
      i += 2
      continue
    }
    if (c === "'") {
      const e = command.indexOf("'", i + 1)
      word().value += e === -1 ? command.slice(i + 1) : command.slice(i + 1, e)
      i = e === -1 ? command.length : e + 1
      continue
    }
    if (c === '"') {
      const w = word()
      let j = i + 1
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\') {
          if (j + 1 < command.length) w.value += command[j + 1]
          j += 2
        } else if (command[j] === '$' && command[j + 1] === '(') {
          const r = readParen(command, j + 1)
          w.subs.push(r.inner)
          w.value += command.slice(j, r.next)
          j = r.next
        } else if (command[j] === '`') {
          const e = command.indexOf('`', j + 1)
          const inner = e === -1 ? command.slice(j + 1) : command.slice(j + 1, e)
          w.subs.push(inner)
          w.value += inner
          j = e === -1 ? command.length : e + 1
        } else {
          w.value += command[j]
          j++
        }
      }
      i = j < command.length ? j + 1 : command.length
      continue
    }
    if (c === '`') {
      const w = word()
      const e = command.indexOf('`', i + 1)
      const inner = e === -1 ? command.slice(i + 1) : command.slice(i + 1, e)
      w.subs.push(inner)
      w.value += inner
      i = e === -1 ? command.length : e + 1
      continue
    }
    if ((c === '$' || c === '<' || c === '>') && command[i + 1] === '(') {
      const w = word()
      const r = readParen(command, i + 1)
      w.subs.push(r.inner)
      w.value += command.slice(i, r.next)
      i = r.next
      continue
    }
    if (c === '\n') {
      i = pushOp('\n', 1, i)
      continue
    }
    if (/\s/.test(c)) {
      flush()
      i++
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      i = pushOp(two, 2, i)
      continue
    }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '{' || c === '}') {
      i = pushOp(c, 1, i)
      continue
    }
    word().value += c
    i++
  }
  flush()
  return tokens
}

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

/** `varlock run [flags] -- <inner...>` → `<inner...>`. */
export function stripVarlockRun(argv) {
  const sep = argv.indexOf('--', 2)
  if (sep !== -1) return argv.slice(sep + 1)
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
 * instead of a special case.
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
