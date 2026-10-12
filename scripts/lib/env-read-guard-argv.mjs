/**
 * The `.env`-specific argv rules of `scripts/env-read-guard.mjs`: which
 * commands read, which only inspect metadata, which grep forms print, how a
 * path classifies, and `checkArgv`, the rule applied to one normalized argv.
 * Moved here verbatim in SMI-6920, when the guard crossed the 500-line
 * convention `scripts/check-file-length.mjs` enforces for `*.ts`/`*.sh` and
 * this repo keeps by hand for `.mjs` (SMI-5994); the guard keeps the
 * command-line walk (`evaluateCommand`) and `decide`. Every table and
 * docblock below carries its original measurements unchanged.
 */

import {
  basenameOf,
  hasInlineScriptFlag,
  scanPositionalScriptText,
} from './shell-command-normalize.mjs'
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
export function classifyPath(raw) {
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
export function checkArgv(argv) {
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
