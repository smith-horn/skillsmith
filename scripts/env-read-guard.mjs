#!/usr/bin/env node
/**
 * Env-file read guard (SMI-6361, Wave 1 / Tier 1).
 *
 * A `PreToolUse` hook, matched to `Bash` in `.claude/settings.json`, that
 * denies any Bash command which references a secret-bearing env file as a
 * read target — before the command runs and before its output can reach
 * the session transcript.
 *
 * Why a hook and not more `permissions.deny` entries: Claude Code
 * `Bash(...)` permission patterns are **prefix** matches, so
 * `Bash(cat .env:*)` cannot express "block any command that names this
 * file". It structurally cannot block `grep PAT .env` (the pattern comes
 * before the filename) nor `docker exec skillsmith-dev-1 cat /app/.env`
 * (the repo root is bind-mounted at `/app`, and `Bash(docker exec:*)` is
 * blanket-allowed). This hook receives the FULL command string via
 * `.tool_input.command` — the same payload the sibling pre-command
 * wrapper already reads — so it matches a filename anywhere in the
 * command, after normalizing wrapper shells away.
 *
 * This is the primary control; the `permissions.deny` list is retained
 * as redundant-but-harmless backup for the literal shapes it covers.
 *
 * **No shadow mode.** Per Owner Decision A this guard denies from day
 * one: it is a security control with a bounded, well-understood
 * false-positive cost (one command denied, with the escape hatch named
 * in the denial message), not a detection heuristic of unknown
 * precision.
 *
 * **Known-uncovered bypasses (Tier 1 raises the cost, it does not close
 * these — Tier 2 plaintext removal is what makes them harmless):** shell
 * variable indirection (`V=.env; cat "$V"`), copy-then-read
 * (`cp .env /tmp/x && cat /tmp/x`), archive/encode round-trips, and any
 * reader not on READER_COMMANDS. Also out of scope entirely: NEEDLE /
 * Codex dispatch, the MCP servers' own processes, GitHub Actions
 * runners, and any non-Claude-Code process on the machine.
 *
 * Env vars (plain local environment variables — this hook runs
 * client-side in a developer's own Claude Code session, not in CI):
 *   SKILLSMITH_ENV_READ_GUARD_DISABLE - '1' to hard-disable; the hook
 *     does not even compute a decision. Checked first, before anything
 *     else, as an explicit invariant.
 *
 * @see docs/internal/implementation/varlock-secret-exposure-defense-in-depth.md
 */

/** Env files that are always safe to read — placeholders / schema only. */
const SAFE_ENV_BASENAMES = new Set(['.env.example', '.env.schema'])

/**
 * Commands that emit file contents. Illustrative, not exhaustive — a
 * reader outside this set is a named residual gap, not an oversight.
 */
const READER_COMMANDS = new Set([
  'cat',
  'tac',
  'bat',
  'zcat',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'head',
  'tail',
  'sed',
  'awk',
  'gawk',
  'mawk',
  'less',
  'more',
  'strings',
  'od',
  'xxd',
  'hexdump',
  'nl',
  'cut',
  'sort',
  'uniq',
  'base64',
  'base32',
  'source',
  '.',
])

/**
 * Long flags that introduce inline script text on an interpreter. Checked
 * against every interpreter uniformly (never per-interpreter) — unlike the
 * short-flag map below, over-recognizing a long flag no interpreter
 * actually has is safe (it just triggers one extra, harmless text scan).
 * Includes php's four long-form process-hook aliases (--run/--process-begin/
 * --process-code/--process-end), confirmed against php.net's CLI options
 * page — SMI-6361 adversarial confirmation-pass finding F3.
 */
const INLINE_SCRIPT_LONG_FLAGS = new Set([
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
 * Short-flag characters that introduce inline script text, PER INTERPRETER —
 * not a single shared set. A generic "-[ce]" regex misses real bypasses
 * (`node -p '<code>'` prints an expression's value exactly like `-e`; `php
 * -r '<code>'` runs code) because those interpreters' inline-code short
 * flags don't happen to be the letters `c`/`e`. Getting this wrong is not a
 * cosmetic gap here — `node -p "require('fs').readFileSync('.env','utf8')"`
 * and `php -r "readfile('.env');"` both print the complete secret file and
 * were confirmed to return `allow` before this fix (SMI-6361 pre-merge
 * review). Deliberately per-interpreter rather than a single pooled set:
 * ruby's `-r` means "require a library" (not inline code), so pooling
 * python/node/perl/ruby/php's short flags together would make `ruby -r`
 * false-positive as inline-script, or worse, tempt a future edit to drop a
 * real flag while "simplifying" a shared set.
 *
 * `perl: 'eE'` and `php: 'rBRE'` were added by a second-round adversarial
 * confirmation pass on the fix above (same session, same SMI-6361): `perl
 * -E` is documented as "like -e, but enables all optional features" (`perl
 * -h`, confirmed live) — the exact -e-equivalent shape the first round
 * fixed for node's -p, missed here on the first pass. `php`'s `-B`/`-R`/`-E`
 * (process-begin/process-code/process-end hooks, confirmed against
 * php.net's CLI options page) carry inline PHP code exactly like `-r`.
 * `php: 'F'` is deliberately excluded — `-F` names an external FILE to run
 * per input line, not inline text; that shape is already covered by the
 * plain reader/argv-path rule, not this inline-script path.
 *
 * Interpreters here MUST stay in sync with `INLINE_INTERPRETERS` below — a
 * name added to one without the other either skips inline-script scanning
 * entirely (added here but not there) or silently no-ops via the `?? ''`
 * fallback in `hasInlineScriptFlag` (added there but not here). Derived
 * relationship, not independently maintained: see `INLINE_INTERPRETERS`.
 */
const INLINE_SCRIPT_SHORT_FLAG_CHARS = {
  python: 'c',
  python3: 'c',
  node: 'ep',
  nodejs: 'ep',
  perl: 'eE',
  ruby: 'e',
  php: 'rBRE',
}

/**
 * Interpreters whose inline script text must be scanned, not just argv.
 * Derived from INLINE_SCRIPT_SHORT_FLAG_CHARS's keys (not a separately
 * maintained list) so the two structurally cannot drift apart — a gap an
 * adversarial review flagged as a latent fail-open risk (SMI-6361).
 */
const INLINE_INTERPRETERS = new Set(Object.keys(INLINE_SCRIPT_SHORT_FLAG_CHARS))

/**
 * Sanctioned exception: metadata-only / exit-code-only commands. These
 * never emit file contents, which preserves the already-approved
 * `[ -f .env ] && grep -q "KEY" .env` idiom.
 */
const METADATA_COMMANDS = new Set(['ls', 'stat', 'test', '[', 'wc'])

const GREP_COMMANDS = new Set(['grep', 'egrep', 'fgrep', 'rg'])
const GREP_QUIET_LONG = new Set(['--quiet', '--silent'])
const GREP_OUTPUT_LONG = new Set([
  '--only-matching',
  '--count',
  '--count-matches',
  '--after-context',
  '--before-context',
  '--context',
])

const SHELL_COMMANDS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])

/**
 * Wrapper options that consume a following value, so flag-skipping does
 * not mistake that value for the wrapped command. One shared set across
 * `sudo`, `docker exec`, `docker compose`, and `varlock run` — these
 * only ever appear in wrapper-flag position, so a flag belonging to one
 * wrapper being recognized by another is harmless.
 */
const WRAPPER_VALUE_FLAGS = new Set(
  (
    '-u --user -g --group -p --prompt -h --host -e --env -w --workdir --env-file --detach-keys ' +
    '--index -f --file --project-name --project-directory --profile --progress --ansi ' +
    '--parallel --context'
  ).split(' ')
)

/** Recursion cap for nested `bash -c` / `$(...)` unwrapping. */
const MAX_DEPTH = 6

const ALLOW = { action: 'allow', json: null, stderr: null }

// --- File classification ---

/** @param {string} p */
function basenameOf(p) {
  return p.split('/').pop()
}

/**
 * Classify a bare basename. Any `.env.<anything>` is protected except
 * the two safe files; `.envrc` and friends are not env files at all.
 * @param {string} base
 * @returns {'protected' | 'safe' | null}
 */
function classifyBasename(base) {
  if (base === '.env') return 'protected'
  if (SAFE_ENV_BASENAMES.has(base)) return 'safe'
  if (/^\.env\.[^/]+$/.test(base)) return 'protected'
  return null
}

/**
 * Classify a whole argv token as a path. Matching on the BASENAME makes
 * every enumerated form (bare, `./.env`, absolute, `.worktrees/**\/.env`,
 * container-side `/app/.env`) fall out of one rule; it is deliberately a
 * superset of that enumeration, since reading any other tree's `.env` is
 * the same class of exposure.
 * @param {string} raw
 * @returns {'protected' | 'safe' | null}
 */
function classifyPath(raw) {
  if (typeof raw !== 'string' || raw === '') return null
  return classifyBasename(basenameOf(raw.replace(/^[<>]+/, '')))
}

/**
 * Embedded reference inside script text, e.g. `open('.env')`. Anchored on
 * BOTH sides (leading boundary via the first alternation, trailing via the
 * negative lookahead) — a fifth adversarial confirmation round (SMI-6361)
 * found the original leading-only anchor let `.envrc`/`.environment`/
 * `.env-backup` false-positive as an embedded `.env` match (e.g.
 * `awk '{print}' .envrc` denied), contradicting this file's own stated
 * classification of `.envrc` as "not an env file at all" — `classifyPath`
 * already got this right for whole-token matches; this regex now agrees.
 * A false positive (over-blocking), not a bypass — same direction as
 * every other tradeoff in this file, just closing an inconsistency.
 */
const EMBEDDED_ENV_RE = /(?:^|[^A-Za-z0-9_.\-])(\.env(?:\.[A-Za-z0-9_-]+)*)(?![A-Za-z0-9_-])/g

/**
 * Scan free text (an inline interpreter's script) for a protected-file
 * reference. Returns the first protected match, or null.
 * @param {string} text
 * @returns {string | null}
 */
function scanTextForProtected(text) {
  if (typeof text !== 'string') return null
  EMBEDDED_ENV_RE.lastIndex = 0
  let m
  while ((m = EMBEDDED_ENV_RE.exec(text)) !== null) {
    if (classifyBasename(m[1]) === 'protected') return m[1]
  }
  return null
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
function tokenize(command) {
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
function stripFlags(argv) {
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
function stripEnvPrefix(argv) {
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
function stripDockerExec(rest) {
  return stripFlags(rest).slice(1)
}

/** `docker compose [flags] exec [flags] <service> <inner...>` → `<inner...>`. */
function stripDockerCompose(argv, head) {
  const rest = stripFlags(head === 'docker-compose' ? argv.slice(1) : argv.slice(2))
  if (rest[0] !== 'exec') return null
  return stripDockerExec(rest.slice(1))
}

/** `varlock run [flags] -- <inner...>` → `<inner...>`. */
function stripVarlockRun(argv) {
  const sep = argv.indexOf('--', 2)
  if (sep !== -1) return argv.slice(sep + 1)
  return stripFlags(argv.slice(2))
}

/** `bash -c '<inner>'` → the inner string, or null if not that shape. */
function extractShellDashC(argv) {
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
function normalizeWrappers(argvIn) {
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

// --- Rules ---

/**
 * The one sanctioned exception: a quiet grep with no output-producing
 * flag. A count (`-c`) is treated as output — it leaks structure.
 */
function isOutputFreeGrep(args) {
  let quiet = false
  let output = false
  for (const a of args) {
    if (a === '--') break
    if (!a.startsWith('-') || a === '-') continue
    if (a.startsWith('--')) {
      const name = a.split('=')[0]
      if (GREP_QUIET_LONG.has(name)) quiet = true
      if (GREP_OUTPUT_LONG.has(name)) output = true
      continue
    }
    for (const ch of a.slice(1)) {
      if (ch === 'q') quiet = true
      if (ch === 'o' || ch === 'c' || ch === 'A' || ch === 'B' || ch === 'C') output = true
    }
  }
  return quiet && !output
}

/**
 * True when an interpreter invocation carries inline script text. Short
 * flags are checked per-interpreter (see INLINE_SCRIPT_SHORT_FLAG_CHARS);
 * long flags (--eval/--print/--execute/--command) are checked against every
 * interpreter uniformly — over-recognizing a long flag no interpreter
 * actually has is safe (it just triggers an extra, harmless text scan),
 * unlike under-recognizing a real short flag.
 * @param {string} cmd
 * @param {string[]} args
 */
function hasInlineScriptFlag(cmd, args) {
  const shortChars = INLINE_SCRIPT_SHORT_FLAG_CHARS[cmd] ?? ''
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
 * Commands whose FIRST positional (non-flag) argument is inline script
 * text BY DEFAULT — unlike INLINE_INTERPRETERS, whose inline-code argument
 * is always introduced by an explicit flag (-e/-c/-p/-r/...), awk puts
 * script text in bare position: `awk '<program>' [file...]`. Unless a
 * `-f <file>` flag names an external script file instead, in which case
 * there is no inline text to scan. Found by a second-round adversarial
 * confirmation pass (SMI-6361, finding F6): awk/gawk/mawk are already on
 * READER_COMMANDS (the guard's own declared surface), but before this fix
 * only their bare argv tokens were checked for a literal protected-file
 * match — never their embedded program text — so
 * `awk 'BEGIN{while((getline l < ".env")>0) print l}'` returned `allow`.
 */
const POSITIONAL_SCRIPT_COMMANDS = new Set(['awk', 'gawk', 'mawk', 'sed'])

/**
 * awk/sed/gawk/mawk mix flags and inline SCRIPT TEXT unpredictably, across
 * both separated (`-v n=1`) and attached (`-vn=1`, `-e'r .env'`) short-
 * option forms, plus gawk's long forms (`--source=`, `--assign=`) and
 * platform-specific arity quirks (GNU sed's `-i` takes an attached-only
 * optional suffix; BSD/macOS sed's `-i` requires one, as a SEPARATE
 * argument). A first attempt at this modeled each flag's arity explicitly
 * (skip `-f`'s value, treat `-e`'s value as script text, etc.) and a
 * follow-up adversarial review round found THREE live, reproduced bypasses
 * against it in one pass — `awk -v n=1 'BEGIN{...".env"...}'`,
 * `sed -l 70 'r .env' file`, and the attached form `sed -e'r .env' file`
 * all returned `allow`, because the model didn't (and structurally could
 * not, without also modeling every other value-taking flag) know those
 * value tokens weren't the script (SMI-6361, third adversarial round).
 *
 * This scans EVERY argument uniformly instead of trying to identify which
 * one is "the script" — closing all three at once and removing an entire
 * class of arity-modeling bugs, at the cost of also scanning a flag's
 * non-script value (a field separator, a `-v` assignment). That's the same
 * over-inclusive-is-safe tradeoff already accepted for inline-interpreter
 * script text (`node -e "console.log('.env')"` already denies on the
 * mention alone, not just a real read) and for a bare `.env` grep pattern
 * (`grep '.env' .gitignore` already denies via the plain reader-path
 * check) — `scanTextForProtected`'s boundary-anchored regex only matches a
 * genuine standalone `.env`-shaped substring, so this doesn't invent a new
 * false-positive class, only extends an already-accepted one.
 * @param {string} cmd
 * @param {string[]} args
 * @returns {string | null} the first protected-file reference found in
 *   positional/flag-attached script text, or null.
 */
function scanPositionalScriptText(cmd, args) {
  if (!POSITIONAL_SCRIPT_COMMANDS.has(cmd)) return null
  // Deliberately no `if (a === '--') break` here, unlike the flag-scanning
  // loops elsewhere in this file (isOutputFreeGrep, hasInlineScriptFlag).
  // Those loops scan OPTIONS, where `--` correctly means "stop, everything
  // after this is not a flag." Here we scan SCRIPT TEXT, where `--` means
  // the opposite: "everything after this IS the script, even though it
  // might start with a dash" -- `awk -- 'BEGIN{...}'` and
  // `sed -- 'r .env' file` both put the real program immediately after
  // `--`. A fourth adversarial round (SMI-6361) found this exact `break`
  // was a regression this uniform-scan rewrite introduced: the two
  // functions it replaced both deliberately looked PAST `--` (one via an
  // explicit `a !== '--'` predicate, the other because its `find()` ran
  // outside any loop with a `break` in it), so `awk -- '<code touching
  // .env>'` denied on the parent commit and silently started allowing on
  // this one -- a real secret-file read, not the redesign's accepted
  // over-scanning tradeoff. `scanTextForProtected('--')` itself returns
  // null harmlessly, so no special-casing is needed at all.
  for (const a of args) {
    const embedded = scanTextForProtected(a)
    if (embedded) return embedded
  }
  return null
}

/** `varlock load --format <value>` → value, or null when absent. */
function extractFormatFlag(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--format') return i + 1 < args.length ? args[i + 1] : ''
    if (args[i].startsWith('--format=')) return args[i].slice('--format='.length)
  }
  return null
}

/**
 * Apply the rules to one normalized argv.
 * @returns {{ kind: string, file?: string, format?: string } | null}
 */
function checkArgv(argv) {
  if (argv.length === 0) return null
  const cmd = basenameOf(argv[0])
  const args = argv.slice(1)

  // Flag-level rule, no file argument involved: only the default pretty
  // format redacts. json / json-full / json-full-compact / env are all
  // unmasked plaintext.
  if (cmd === 'varlock' && args[0] === 'load') {
    const format = extractFormatFlag(args.slice(1))
    if (format !== null && format !== 'pretty') return { kind: 'varlock-format', format }
    return null
  }

  if (METADATA_COMMANDS.has(cmd)) return null

  const isInterpreter = INLINE_INTERPRETERS.has(cmd)
  const isReader = READER_COMMANDS.has(cmd) || isInterpreter

  if (isReader) {
    for (const a of args) {
      if (classifyPath(a) !== 'protected') continue
      if (GREP_COMMANDS.has(cmd) && isOutputFreeGrep(args)) return null
      return { kind: 'read', file: a }
    }
  }

  const positionalEmbedded = scanPositionalScriptText(cmd, args)
  if (positionalEmbedded) return { kind: 'read', file: positionalEmbedded }

  if (isInterpreter && hasInlineScriptFlag(cmd, args)) {
    for (const a of args) {
      const embedded = scanTextForProtected(a)
      if (embedded) return { kind: 'read', file: embedded }
    }
  }

  return null
}

/**
 * Evaluate a full command string: split on shell operators, recurse into
 * command substitutions and `bash -c` bodies, check each segment.
 * @returns {{ kind: string, file?: string, format?: string } | null}
 */
function evaluateCommand(command, depth) {
  if (depth > MAX_DEPTH || typeof command !== 'string' || command.trim() === '') return null

  const segments = []
  let current = []
  for (const token of tokenize(command)) {
    if (token.type === 'op') {
      if (current.length > 0) segments.push(current)
      current = []
    } else {
      current.push(token)
    }
  }
  if (current.length > 0) segments.push(current)

  for (const segment of segments) {
    for (const w of segment) {
      for (const sub of w.subs) {
        const nestedViolation = evaluateCommand(sub, depth + 1)
        if (nestedViolation) return nestedViolation
      }
    }
    const { argv, nested } = normalizeWrappers(segment.map((w) => w.value))
    const violation = nested !== null ? evaluateCommand(nested, depth + 1) : checkArgv(argv)
    if (violation) return violation
  }
  return null
}

const ALTERNATIVE =
  'Use `varlock load` (default pretty format, masked) or `varlock load --quiet` for validation only; ' +
  'for a genuine false positive, re-run with SKILLSMITH_ENV_READ_GUARD_DISABLE=1.'

/** @param {{ kind: string, file?: string, format?: string }} violation */
function reasonFor(violation) {
  if (violation.kind === 'varlock-format') {
    return (
      `[env-read-guard] \`varlock load --format ${violation.format}\` emits UNMASKED secret ` +
      `values and is prohibited. ${ALTERNATIVE}`
    )
  }
  return (
    `[env-read-guard] This command reads \`${violation.file}\`, a secret-bearing env file — ` +
    `reading its contents is prohibited because they would land in the session transcript. ${ALTERNATIVE}`
  )
}

/**
 * Pure decision function — no I/O. Given a raw PreToolUse `toolCall`
 * payload and `process.env` (or an equivalent plain object), decides
 * whether to allow or deny the call. There is no warn/shadow action.
 *
 * @param {{ tool_name?: string, tool_input?: { command?: string } } | null | undefined} toolCall
 * @param {Record<string, string | undefined>} env
 * @returns {{ action: 'allow' | 'deny', json: object | null, stderr: string | null }}
 */
export function decide(toolCall, env) {
  try {
    if (env?.SKILLSMITH_ENV_READ_GUARD_DISABLE === '1') return ALLOW
    if (toolCall?.tool_name !== 'Bash') return ALLOW

    const command = toolCall?.tool_input?.command
    if (typeof command !== 'string' || command.trim() === '') return ALLOW

    const violation = evaluateCommand(command, 0)
    if (!violation) return ALLOW

    return {
      action: 'deny',
      json: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reasonFor(violation),
        },
      },
      stderr: null,
    }
  } catch (err) {
    // Fail open — a bug in this hook's own code must never become a
    // repo-wide Bash outage in every session working in this repo.
    return {
      action: 'allow',
      json: null,
      stderr: `[env-read-guard] internal error, failing open: ${err.message}`,
    }
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
      // Malformed/unparseable stdin — treat as absent; decide() reads
      // every field via optional chaining, so a null toolCall resolves
      // to undefined at every access rather than throwing, and falls
      // through to the tool_name mismatch branch (allow).
      toolCall = null
    }

    const result = decide(toolCall, process.env)

    if (result.action === 'deny') {
      process.stdout.write(JSON.stringify(result.json))
      process.exit(0)
    }

    // allow — any diagnostic stderr from the fail-open path is still
    // written, but exit 0 keeps the Bash call unblocked.
    if (result.stderr) process.stderr.write(`${result.stderr}\n`)
    process.exit(0)
  })
}
