/**
 * Pure predicate logic for `scripts/ruflo-host-guard.mjs` (SMI-6744 Wave 4
 * A4.6). Split out of the guard's own orchestration file purely to stay
 * under the 500-line file-length gate (`scripts/check-file-length.mjs`) —
 * every export here is a pure function or constant, no I/O, no state. H1–H7
 * and the verdict-shape constructors live in their own sibling files
 * (`ruflo-host-guard-h1to7.mjs`, `ruflo-host-guard-verdicts.mjs` —
 * governance-round split, same 500-line pressure) and are re-exported here
 * so `scripts/ruflo-host-guard.mjs`'s own import statement needed no
 * change across either split.
 *
 * Design: docs/internal/implementation/smi-6744-ruflo-host-guard.md
 * § Predicate Specification (Stage 1 allowlist, H1–H8), built from
 * docs/internal/uat/smi-6744/a44-structural-design-2026-09-27.md § 1(b)
 * Layer H and its 62-row adversarial census (§ 5).
 *
 * All H1–H8 matching is against LOWERCASED argv (`argvLower`) — a
 * deliberate, stated choice (plan § Predicate Specification): Bash rule
 * case-sensitivity is undocumented, so this guard covers both cases, and
 * every sanctioned/denied token in this domain is conventionally lowercase
 * in this repo. The one exception is the Stage 1 `docker exec
 * skillsmith-ruflo-1` container-name check, which the plan states must
 * match "exactly" — kept case-sensitive on that one field, deliberately.
 */

import { basenameOf, stripFlags } from './shell-command-normalize.mjs'
import { RUNNER_BASENAMES, RUNNER_TOKEN_RE, checkH1toH7 } from './ruflo-host-guard-h1to7.mjs'
import {
  ALLOW,
  SANCTIONED_ALTERNATIVE,
  denyInternalError,
  denyMalformedInput,
  denyStartDaemon,
  denyWith,
} from './ruflo-host-guard-verdicts.mjs'

export {
  RUNNER_BASENAMES,
  RUNNER_TOKEN_RE,
  checkH1toH7,
  ALLOW,
  SANCTIONED_ALTERNATIVE,
  denyInternalError,
  denyMalformedInput,
  denyStartDaemon,
  denyWith,
}

/** The exact npm inspection/remediation forms Stage 1 allows (design § 1(b) row 3). */
const NPM_ALLOW_FORMS = [
  ['ls', '-g', 'ruflo'],
  ['view', 'ruflo'],
  ['uninstall', '-g', 'ruflo'],
]

/**
 * Stage 1 row 1 — `docker exec skillsmith-ruflo-1 …` (design § 1(b), plan
 * § Predicate Specification Stage 1). Runs on the RAW pre-strip word
 * values, before the shared `normalizeWrappers` ever gets a chance to
 * unwrap `docker exec` unconditionally (it doesn't know about container
 * names). The container name is matched EXACTLY (case-sensitive) — the
 * one field in this whole predicate set that deliberately does not
 * lowercase, per the plan's explicit "equals `skillsmith-ruflo-1` exactly".
 *
 * Also accepts the `docker container exec …` long-form alias (L-A fix,
 * SMI-6744 Wave 4 governance round) — `docker container exec` is a real
 * Docker CLI alias for `docker exec`, and this guard's own goal (letting
 * the ONE sanctioned invocation shape through) is undermined by
 * recognizing only the short form.
 * @param {string[]} rawValues
 */
export function isSanctionedDockerExec(rawValues) {
  if (rawValues.length < 2) return false
  if (basenameOf(rawValues[0]).toLowerCase() !== 'docker') return false
  let rest
  if (rawValues[1].toLowerCase() === 'exec') {
    rest = rawValues.slice(2)
  } else if (rawValues[1].toLowerCase() === 'container' && rawValues[2]?.toLowerCase() === 'exec') {
    rest = rawValues.slice(3)
  } else {
    return false
  }
  rest = stripFlags(rest)
  return rest[0] === 'skillsmith-ruflo-1'
}

/** The uninstall form, named separately so the L-B `--dry-run` allowance below can reference it. */
const NPM_UNINSTALL_FORM = ['uninstall', '-g', 'ruflo']

/**
 * Stage 1 row 3 — the three exact npm inspection/remediation forms,
 * evaluated AFTER normal wrapper normalization (same stage as H1–H8).
 *
 * `npm uninstall -g ruflo --dry-run` is also sanctioned (L-B fix, SMI-6744
 * Wave 4 governance round) — named as its own exact suffix, not a generic
 * "any extra flag is fine" widening: `--dry-run` makes this form STRICTLY
 * SAFER than the already-sanctioned bare uninstall (no actual removal
 * happens), so accepting it narrows nothing this Stage 1 allowlist
 * otherwise protects.
 * @param {string[]} argvLower the post-normalize, lowercased argv
 */
export function isSanctionedNpmForm(argvLower) {
  if (argvLower.length === 0) return false
  if (basenameOf(argvLower[0]) !== 'npm') return false
  const rest = argvLower.slice(1)
  if (
    NPM_ALLOW_FORMS.some(
      (form) => rest.length === form.length && form.every((tok, i) => rest[i] === tok)
    )
  ) {
    return true
  }
  return (
    rest.length === NPM_UNINSTALL_FORM.length + 1 &&
    NPM_UNINSTALL_FORM.every((tok, i) => rest[i] === tok) &&
    rest[NPM_UNINSTALL_FORM.length] === '--dry-run'
  )
}

/**
 * H8(i) — "deny the assignment-plus-runner shape" (a44 § 5 D11 candidate
 * closure (i), kept as an additional narrow arm alongside (ii) per the
 * owner's round-1 decision). Reads the PRE-strip word tokens for one
 * segment — this must run before wrapper normalization discards a bare
 * leading assignment, which is exactly what the shared `normalizeWrappers`
 * does. Scans EVERY token in the segment (not just position 0), so it also
 * catches a bare-assignment-only segment (`V=ruflo` on its own, ahead of a
 * later `;`-joined use) as well as an assignment prefixing more argv in
 * the same segment.
 * @param {Array<{value: string}>} wordTokens pre-strip word tokens (this segment)
 */
export function checkAssignmentValuePredicate(wordTokens) {
  for (const tok of wordTokens) {
    const m = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(tok.value)
    if (!m) continue
    if (RUNNER_TOKEN_RE.test(m[1].toLowerCase())) {
      return denyWith('H8', tok.value)
    }
  }
  return null
}

/**
 * Value-taking flags shared across npx/npm/pnpm/yarn/bun/corepack/deno's
 * own top-level options (H-5 fix, SMI-6744 Wave 4 governance round): each
 * consumes the FOLLOWING token as ITS OWN value, so the generic
 * "unrecognized flag, skip just it" fallback below must not treat that
 * value as the runner's package-name slot. Before this fix, `npx --cache
 * /tmp "$V"` wrongly identified `/tmp` (the flag's own value) as the
 * package-name slot and never examined `$V` at all — a live bypass, not a
 * cosmetic mis-scan.
 */
const RUNNER_VALUE_FLAGS = new Set([
  '--cache',
  '--userconfig',
  '--prefix',
  '--registry',
  '--workspace',
  '-w',
  '--node-options',
  '--shell',
  '-c',
])

/**
 * Runner subcommands that themselves precede the real package-name
 * argument, keyed by the runner's own basename (H-5 fix): `pnpm dlx`/
 * `yarn dlx`, `bun x`, `deno run`/`deno install`. `npm`'s own `exec`/`x`
 * subcommand is handled separately below (pre-existing) since it also
 * needs its own `--` handling; `corepack`'s nested-runner-name token
 * (`corepack npx …`, `corepack pnpm …`) is handled separately too — it
 * substitutes for a runner rather than being one of a FIXED runner's own
 * subcommands.
 */
const RUNNER_SUBCOMMANDS = new Map([
  ['pnpm', new Set(['dlx'])],
  ['yarn', new Set(['dlx'])],
  ['bun', new Set(['x'])],
  ['deno', new Set(['run', 'install'])],
])

/**
 * H8(ii) — "deny the runner-with-a-variable-argument shape" (a44 § 5 D11
 * candidate closure (ii), the owner's chosen primary closure). Runs on the
 * POST-normalize argv/tokens: argv[0]'s basename must be a runner, and the
 * runner's own PACKAGE-NAME SLOT must have EITHER a `$` in its raw
 * `.value` OR a non-empty `.subs` (round 1 finding 2 correction — a
 * backtick substitution drops its backticks in `tokenize()`, so `.value`
 * alone misses it).
 *
 * Narrowed from "any later token" to "the package-name slot only" (M-A
 * fix, SMI-6744 Wave 4 governance round): the original scanned every
 * position after the runner, denying ordinary repo commands whose TARGET
 * argument (not the package name) carries a shell variable — `npx vitest
 * run "$F"`, `npx prettier --write "$f"`, `npm run build --workspace=$W`.
 * The slot is: the first non-flag argument after the runner (skipping the
 * runner's own leading flags — now RUNNER_VALUE_FLAGS-aware, H-5 fix —
 * and, for `npm`, an `exec`/`x` subcommand and its own `--`, or for
 * `pnpm`/`yarn`/`bun`/`deno`, their own RUNNER_SUBCOMMANDS entry, or for
 * `corepack`, its nested runner-name token), plus the value of
 * `-p`/`--package`/`--package=`/`-p=` (L-3 fix: `-p=` was missing beside
 * the already-recognized `--package=`).
 *
 * H-5 fail-closed fallback: when this scan never identifies ANY slot at
 * all (every remaining token looked like a flag, including one of
 * RUNNER_VALUE_FLAGS whose OWN value ran off the end of argv, e.g. `npx
 * --cache "$V"` with nothing after `$V`), deny if any later token still
 * carries an unresolved `$`/`.subs` — a runner invocation whose shape this
 * scan cannot parse must not silently let a variable argument through
 * completely unexamined just because it happened to sit in a flag's own
 * value position.
 * @param {string[]} argvLower
 * @param {Array<{value: string, subs?: string[]}>} alignedTokens the
 *   ORIGINAL (non-lowercased) tokens aligned 1:1 with argvLower — see
 *   `tokensForArgv` in the guard's own orchestration file.
 */
export function checkRunnerVariableArgument(argvLower, alignedTokens) {
  if (argvLower.length === 0) return null
  const runnerBase = basenameOf(argvLower[0])
  if (!RUNNER_BASENAMES.has(runnerBase)) return null

  const slots = new Set()
  let i = 1

  if (runnerBase === 'corepack') {
    if (i < argvLower.length) i++ // the nested package-manager name
  } else if (runnerBase === 'npm' && (argvLower[i] === 'exec' || argvLower[i] === 'x')) {
    i++
    if (argvLower[i] === '--') i++
  } else {
    const subcommands = RUNNER_SUBCOMMANDS.get(runnerBase)
    if (subcommands && subcommands.has(argvLower[i])) i++
  }

  while (i < argvLower.length) {
    const tok = argvLower[i]
    if (tok === '-p' || tok === '--package') {
      if (i + 1 < argvLower.length) slots.add(i + 1)
      i += 2
      continue
    }
    if (tok.startsWith('--package=') || tok.startsWith('-p=')) {
      slots.add(i)
      i += 1
      continue
    }
    if (RUNNER_VALUE_FLAGS.has(tok)) {
      i += 2
      continue
    }
    if (tok.startsWith('-') && tok !== '-') {
      i += 1
      continue
    }
    slots.add(i)
    break
  }

  if (slots.size === 0) {
    // No slot could be identified at all -- every remaining token looked
    // like a flag (possibly one of RUNNER_VALUE_FLAGS whose own value ran
    // off the end of argv, e.g. `npx --cache "$V"`). Re-scan every token
    // after the runner name, since nothing was actually examined above.
    for (let idx = 1; idx < alignedTokens.length; idx++) {
      const tok = alignedTokens[idx]
      if (tok && (tok.value.includes('$') || (tok.subs && tok.subs.length > 0))) {
        return denyWith('H8', tok.value)
      }
    }
  }

  for (const idx of slots) {
    const tok = alignedTokens[idx]
    if (!tok) continue
    if (tok.value.includes('$') || (tok.subs && tok.subs.length > 0)) {
      return denyWith('H8', tok.value)
    }
  }
  return null
}

/**
 * Brace-syntax fail-closed check (round 1 finding 3). The tokenizer does
 * not model Bash brace expansion — it treats `{`/`}` as command operators
 * — so `npx ru{f,}lo …` never reaches any H-predicate as a contiguous
 * `ruflo` substring. Rather than implement partial brace expansion, this
 * fails CLOSED whenever a `{`/`}` op-token appears in a segment whose
 * effective first command word (after skipping a leading VAR=val
 * assignment, then optionally one `env`/`sudo`/`exec` wrapper and ITS OWN
 * leading VAR=val arguments) is a package runner.
 * @param {Array<{type: string, value?: string}>} segmentTokens the RAW
 *   segment (word + op tokens interleaved) — must be called before the
 *   caller strips down to word-only tokens.
 */
export function checkBraceSegment(segmentTokens) {
  const braceIdx = segmentTokens.findIndex(
    (t) => t.type === 'op' && (t.value === '{' || t.value === '}')
  )
  if (braceIdx === -1) return null

  const words = segmentTokens.filter((t) => t.type === 'word')
  let i = 0
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].value)) i++
  if (i >= words.length) return null

  let base = basenameOf(words[i].value).toLowerCase()
  if (base === 'env' || base === 'sudo' || base === 'exec') {
    let j = i + 1
    while (j < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[j].value)) j++
    if (j < words.length) {
      i = j
      base = basenameOf(words[i].value).toLowerCase()
    }
  }

  if (!RUNNER_BASENAMES.has(base)) return null

  // M-B fix (SMI-6744 Wave 4 governance round): a `{`/`}` that appears AT
  // OR BEFORE the effective first command word is shell GROUPING syntax
  // (`{ npm run lint; }`), not a brace expression inside the runner's own
  // arguments -- only deny when the brace strictly FOLLOWS that word.
  // `words[i]` is the same object reference filtered out of
  // `segmentTokens`, so `indexOf` finds its true position by identity.
  const effectiveWordIdx = segmentTokens.indexOf(words[i])
  if (braceIdx <= effectiveWordIdx) return null

  return denyWith(
    'brace-syntax',
    'a `{`/`}` brace expression in a package-runner command — fails closed rather than ' +
      'implementing partial brace-expansion (round 1 finding 3)'
  )
}

/**
 * M-6 fix (SMI-6744 Wave 4 governance round) — bare-name inversion. Every
 * H-predicate before this one is either positional-at-argv[0] (H4),
 * scoped to a KNOWN runner's own forward-scan (H5/H8(ii)), or a
 * path-shaped substring check (H1/H2/H3/H6/H7) that a bare, unqualified
 * name never matches — so a bare `ruflo`/`claude-flow`/`claude-flow-mcp`
 * token sitting anywhere PAST argv[0], in front of a launcher this
 * guard's own table doesn't model, was never examined by anything:
 * `ssh localhost ruflo memory store`, `watch ruflo …`,
 * `flock /tmp/l ruflo …`, `strace -f ruflo …` all reached ALLOW.
 *
 * The inversion: deny whenever ANY token at index >= 1 EXACTLY equals one
 * of the three names (lowercased), UNLESS argv[0]'s own basename is on
 * `NON_EXECUTING_VERBS` — a command whose own semantics never treat a
 * bare positional word as something to RUN as a process (a search, a VCS
 * operation, a filesystem operation, a printer, a shell builtin/test).
 *
 * `npm` is DELIBERATELY NOT on that allowlist, even though it appears in
 * the design's own illustrative command list, because by the time a
 * segment reaches this check Stage 1 (`isSanctionedNpmForm`, checked
 * earlier in the pipeline) has ALREADY allowed npm's own legitimate
 * inspection/remediation forms and returned — so an `npm` segment
 * reaching here is one Stage 1 did NOT recognize, and `npm` must stay a
 * RUNNER for it (`npm frobnicate ruflo` must still deny). The
 * launchers/interpreters/shells that DO execute their own arguments
 * (`find`, `xargs`, `env`, `sudo`, `ssh`, `su`, `watch`, `flock`,
 * `strace`/`ltrace`/`dtrace`, `perl`/a `python*` build, `ruby`, `node`,
 * `deno`, `bun`, `time`, `timeout`, `nice`, `nohup`, `setsid`, `script`,
 * `stdbuf`, `chrt`, `ionice`, `caffeinate`, `exec`, `command`, `builtin`,
 * `eval`, `sh`/`bash`/`zsh`) are likewise never on the allowlist — most of
 * them are already peeled/recursed by an earlier H1–H9/H-1/H-2/H-8
 * mechanism before a bare-name segment would even reach this check with
 * `ruflo` still sitting past position 0.
 *
 * Two accepted false positives, MEASURED against the allowlist rather
 * than assumed: `find . -name ruflo` (a real, harmless search — only
 * `find`'s own literal `ruflo` search argument costs anything; `find`
 * itself is correctly NOT on the allowlist, since `find … -exec ruflo …`
 * really does execute it) and any `rm`/`mv`-class command naming a
 * literal path/argument component `ruflo` (`rm -rf ruflo`, `mv x ruflo`)
 * — these ARE on the allowlist, since neither ever executes its own
 * arguments as a process.
 * @param {string[]} argvLower post-normalize, lowercased argv
 */
const H4B_NAMES = new Set(['ruflo', 'claude-flow', 'claude-flow-mcp'])

/**
 * Per-launcher "this flag's value is a LABEL, not a command name" flags
 * (M-6 fix) — deliberately modeled PER-LAUNCHER-BASENAME rather than as
 * one shared/generic value-flags set: the SAME flag spelling means
 * different things across different programs (`-f` is docker-compose's
 * own `--file`, but strace's OWN `-f` is a boolean "follow forks" flag
 * with no value at all) — a generic shared set would have to pick ONE
 * meaning and get the other wrong. `docker compose --profile ruflo up -d`
 * (a real, legitimate compose profile NAME, not a command) is this fix's
 * own motivating case; `docker run --rm image ruflo memory store` (a bare
 * `ruflo` as the CONTAINER's overridden entrypoint command, with no such
 * label flag anywhere in front of it) must still deny, which is exactly
 * why this is keyed by flag, not by blanket-exempting `docker` itself.
 */
const H4B_LABEL_VALUE_FLAGS = new Map(
  [['docker', ['--profile', '--project-name', '--project-directory', '-p', '-f', '--file']]].map(
    ([name, flags]) => [name, new Set(flags)]
  )
)
H4B_LABEL_VALUE_FLAGS.set('docker-compose', H4B_LABEL_VALUE_FLAGS.get('docker'))

const NON_EXECUTING_VERBS = new Set([
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'git',
  'gh',
  'echo',
  'printf',
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'file',
  'du',
  'diff',
  'cmp',
  'tree',
  'sed',
  'awk',
  'jq',
  'cut',
  'sort',
  'uniq',
  'tr',
  'mkdir',
  'rmdir',
  'touch',
  'rm',
  'mv',
  'cp',
  'ln',
  'chmod',
  'chown',
  'cd',
  'pushd',
  'popd',
  'test',
  '[',
  'true',
  'false',
  'export',
  'unset',
  'read',
  'type',
  'which',
  'whereis',
])

export function checkBareNameInversion(argvLower) {
  if (argvLower.length < 2) return null
  const base = basenameOf(argvLower[0])
  if (NON_EXECUTING_VERBS.has(base)) return null
  const labelFlags = H4B_LABEL_VALUE_FLAGS.get(base)
  for (let i = 1; i < argvLower.length; i++) {
    if (labelFlags && labelFlags.has(argvLower[i - 1])) continue
    if (H4B_NAMES.has(argvLower[i])) {
      return denyWith('H4b', argvLower[i])
    }
  }
  return null
}
