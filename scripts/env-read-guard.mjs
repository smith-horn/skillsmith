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
 * **Known-uncovered bypasses (Tier 1 raises the cost, it does not close these — Tier 2
 * plaintext removal is what makes them harmless):** shell variable indirection
 * (`V=.env; cat "$V"`), copy-then-read (`cp .env /tmp/x && cat /tmp/x`), archive/encode
 * round-trips, any reader not on READER_COMMANDS, and a reader fed the filename from
 * another command's OUTPUT, not its own argv (`echo .env | xargs cat`, `find . -name
 * .env -exec cat {} \;`). Also out of scope: NEEDLE / Codex dispatch, the MCP servers'
 * own processes, GitHub Actions runners, and any non-Claude-Code process on the machine.
 *
 * Env vars (plain local environment variables — this hook runs
 * client-side in a developer's own Claude Code session, not in CI):
 *   SKILLSMITH_ENV_READ_GUARD_DISABLE - '1' to hard-disable; the hook
 *     does not even compute a decision. Checked first, before anything
 *     else, as an explicit invariant.
 *
 * @see docs/internal/implementation/varlock-secret-exposure-defense-in-depth.md
 *
 * SMI-6744 A4.6: the tokenizer and wrapper-normalization primitives below
 * (`tokenize`, `stripFlags`, `stripEnvPrefix`, `stripDockerExec`,
 * `stripDockerCompose`, `stripVarlockRun`, `extractShellDashC`,
 * `normalizeWrappers`, `hasInlineScriptFlag`, `scanPositionalScriptText`,
 * `basenameOf`, plus `SHELL_COMMANDS`/`MAX_DEPTH`/`INLINE_SCRIPT_LONG_FLAGS`)
 * moved to `scripts/lib/shell-command-normalize.mjs` so
 * `scripts/ruflo-host-guard.mjs` can reuse them instead of re-implementing its
 * own copy. `WRAPPER_VALUE_FLAGS` and `POSITIONAL_SCRIPT_COMMANDS` moved there
 * too, but live private to that module -- used only by the moved functions'
 * own bodies, not re-exported for another file to import. This file's own
 * `INLINE_SCRIPT_SHORT_FLAG_CHARS` and `scanTextForProtected` stay here —
 * they are `.env`-specific — and are passed into the two moved functions
 * whose env-specific piece became a parameter in the move.
 */

import {
  basenameOf,
  checkUnresolvedHeadTail,
  flattenSubWords,
  hasInlineScriptFlag,
  MAX_DEPTH,
  normalizeWrappers,
  scanPositionalScriptText,
  splitCommandSegments,
  tokenize,
} from './lib/shell-command-normalize.mjs'

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

const ALLOW = { action: 'allow', json: null, stderr: null }

// --- File classification ---

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

  const positionalEmbedded = scanPositionalScriptText(cmd, args, scanTextForProtected)
  if (positionalEmbedded) return { kind: 'read', file: positionalEmbedded }

  if (isInterpreter && hasInlineScriptFlag(cmd, args, INLINE_SCRIPT_SHORT_FLAG_CHARS)) {
    for (const a of args) {
      const embedded = scanTextForProtected(a)
      if (embedded) return { kind: 'read', file: embedded }
    }
  }

  return null
}

/**
 * Evaluate a full command string: split on shell operators, recurse into command
 * substitutions and `bash -c` bodies, check each segment. Contract: a protected file
 * spelled LITERALLY anywhere, substitution bodies included, up to `MAX_DEPTH` nesting
 * levels, is a read target -- an unquoted `${...}` expansion is NOT an exception
 * (`SEGMENT_SEPARATOR_OPS` never tears a brace apart). Past `MAX_DEPTH` a nested command
 * denies with kind `'depth-cap'` unread, never silently allowed. Limit: a name the shell
 * only ASSEMBLES at runtime (a variable, a non-literal emitter, a literal split across a
 * substitution boundary) is not spelled anywhere this guard can read (`f=.en; cat ${f}v`).
 * @returns {{ kind: string, file?: string, format?: string } | null}
 */
function evaluateCommand(command, depth) {
  // Fail CLOSED at the cap -- the posture `evaluateGuardCommand` takes at
  // the same `MAX_DEPTH`, and the one `flattenSubWords`' docblock claims
  // for this file. Folded into the checks below it returned null (ALLOW),
  // so a validity-checked 7-level `bash -c` chain hid its innermost `cat
  // .env`; the flatten's own cap covers only substitution bodies.
  if (depth > MAX_DEPTH) return { kind: 'depth-cap' }
  if (typeof command !== 'string' || command.trim() === '') return null

  const segments = splitCommandSegments(tokenize(command))

  for (const segment of segments) {
    for (const w of segment) {
      for (const sub of w.subs) {
        const nestedViolation = evaluateCommand(sub, depth + 1)
        if (nestedViolation) return nestedViolation
      }
    }
    // A heredoc BODY is text the consuming command receives on stdin; when
    // that consumer is a shell (`bash <<EOF`) or a shell reached through a
    // pipe (`cat <<EOF | sh`) it is executed verbatim. Before heredocs were
    // tokenized at all, those body lines were tokenized inline and reached
    // the checks below by accident; recursing here restores that reach
    // without depending on the accident.
    for (const t of segment) {
      if (t.type !== 'heredoc') continue
      const nestedViolation = evaluateCommand(t.value ?? '', depth + 1)
      if (nestedViolation) return nestedViolation
    }
    // SMI-6869 Fix A/B: a redirect-marked word token (`2>&1`,
    // `>/dev/null`) and a heredoc token are never real command argv — a
    // trailing `2>&1` must not perturb this guard's verdict, and a
    // heredoc's own body text is not a shell word (its `.subs`, scanned
    // just above via the same loop, is the only part of it that ever
    // executes).
    const argvWords = segment.filter((w) => w.type === 'word' && !w.redirect)
    // A command substitution in an ARGUMENT slot supplies its own OUTPUT as
    // that argument, so a protected path inside the body is a read target
    // of the ENCLOSING command: `cat $(echo /app/.env)` reads the file even
    // though `echo /app/.env` does not. The `.subs` recursion above
    // evaluates the body as a COMMAND and never sees this. Flatten every
    // word from every substitution BODY, at any nesting depth (round 12;
    // one non-recursive pass left a nested `$(...)` unopened), into extra
    // argv entries the enclosing command's own read check covers.
    const flattenedSubs = flattenSubWords(argvWords)
    if (flattenedSubs.truncated) return { kind: 'depth-cap' }
    const subWords = flattenedSubs.words
    const { argv, nested } = normalizeWrappers(argvWords.map((w) => w.value))
    const violation =
      nested !== null
        ? evaluateCommand(nested, depth + 1)
        : checkArgv(subWords.length > 0 ? argv.concat(subWords) : argv)
    if (violation) return violation
    // An argv[0] that is itself a substitution (after wrapper peeling)
    // leaves the command name unresolved for this segment; see
    // `checkUnresolvedHeadTail`'s own doc for the two checks it runs.
    const headViolation = checkUnresolvedHeadTail(
      argvWords,
      argv,
      (a) => (classifyPath(a) === 'protected' ? { kind: 'read', file: a } : null),
      checkArgv,
      () => ({ kind: 'depth-cap' })
    )
    if (headViolation) return headViolation
  }
  return null
}

const ALTERNATIVE =
  'Use `varlock load` (default pretty format, masked) or `varlock load --quiet` for validation only; ' +
  'for a genuine false positive, re-run with SKILLSMITH_ENV_READ_GUARD_DISABLE=1.'

/** `varlock load` fixes nothing about nesting -- depth-cap gets its own tail. */
const DEPTH_CAP_ALTERNATIVE =
  'Simplify the nesting, or for a genuine false positive re-run with SKILLSMITH_ENV_READ_GUARD_DISABLE=1.'

/** @param {{ kind: string, file?: string, format?: string }} violation */
function reasonFor(violation) {
  if (violation.kind === 'varlock-format') {
    return (
      `[env-read-guard] \`varlock load --format ${violation.format}\` emits UNMASKED secret ` +
      `values and is prohibited. ${ALTERNATIVE}`
    )
  }
  if (violation.kind === 'depth-cap') {
    return (
      `[env-read-guard] This command nests substitutions past depth ${MAX_DEPTH}, which ` +
      `cannot be confirmed safe -- denied by default rather than allowed. ${DEPTH_CAP_ALTERNATIVE}`
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
