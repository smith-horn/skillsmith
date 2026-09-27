/**
 * Pure predicate logic for `scripts/ruflo-host-guard.mjs` (SMI-6744 Wave 4
 * A4.6). Split out of the guard's own orchestration file purely to stay
 * under the 500-line file-length gate (`scripts/check-file-length.mjs`) —
 * every export here is a pure function or constant, no I/O, no state.
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

/** Package runners H5/H8(ii)/the brace check treat as "a runner". */
export const RUNNER_BASENAMES = new Set([
  'npx',
  'npm',
  'pnpm',
  'yarn',
  'bunx',
  'bun',
  'corepack',
  'deno',
])

/** H3's basename set (post `.bin/` resolution). */
const H3_NAMES = new Set(['ruflo', 'claude-flow', 'claude-flow-mcp', 'cli'])

/** H4's exact-string set — argv[0] itself, NOT its basename (see H4 vs H3). */
const H4_NAMES = new Set(['ruflo', 'claude-flow', 'claude-flow-mcp'])

// H1/H2/H7's first clause deliberately has NO leading `(?:^|\/)` boundary
// requirement (round 1 smoke-test finding, not in the original design
// draft's literal regex): `git config alias.x '!node
// node_modules/ruflo/bin/ruflo.js memory store' && git x`, `rg --pre
// 'node node_modules/ruflo/bin/ruflo.js' .` and the `cat … | node` pipe
// form all embed the path INSIDE a larger single argv token (one shell
// word holding an alias body, a `--pre` command, etc.), preceded by a
// SPACE or `!`, never a `/` or the start of the whole token -- a leading
// anchor silently allowed exactly the laundering inputs the queen's own
// pre-review correction names as must-deny. The trailing boundary
// (`(?:\/|$)`) is kept: it is what makes the C9/`ruflo-eslint-plugin`
// negative case ("ruflo followed by `-`, not `/` or end, does not match")
// still correct — only the leading requirement was dropped.
const H1_RE1 = /node_modules\/ruflo(?:\/|$)/
const H1_RE2 = /(?:^|\/)bin\/ruflo\.js$/
const H2_RE1 = /node_modules\/@claude-flow\/cli\/bin\//
const H2_RE2 = /\/bin\/mcp-server\.js$/
/** H5's runner-token forms; also reused (bare form only) by H8(i). */
export const RUNNER_TOKEN_RE = /^(@claude-flow\/cli|ruflo|claude-flow)(@.*)?$/
const H5_NPM_COLON_RE = /^npm:(ruflo|@claude-flow\/cli)/
const H5_PACKAGE_FLAG_RE = /^--package=(ruflo|@claude-flow\/cli)$/
const H6_NPX_DIR_RE = /_npx\/[0-9a-f]{16}\//
const H7_RE1 = /lib\/node_modules\/ruflo(?:\/|$)/
const H7_RE2 = /(?:^|\/)versions\/node\/v[0-9.]+\/bin\/(ruflo|claude-flow|claude-flow-mcp|cli)$/

/** The exact npm inspection/remediation forms Stage 1 allows (design § 1(b) row 3). */
const NPM_ALLOW_FORMS = [
  ['ls', '-g', 'ruflo'],
  ['view', 'ruflo'],
  ['uninstall', '-g', 'ruflo'],
]

function stripDotSlash(s) {
  return s.startsWith('./') ? s.slice(2) : s
}

function dirnameOf(p) {
  const idx = p.lastIndexOf('/')
  return idx === -1 ? '' : p.slice(0, idx)
}

/** The literal alternative every denial reason names (design § 1(b)). */
export const SANCTIONED_ALTERNATIVE =
  'docker exec skillsmith-ruflo-1 node /opt/ruflo-seed/node_modules/@claude-flow/cli/bin/cli.js …'

/**
 * Build a deny verdict for a matched H-predicate (or the brace-syntax
 * check). Shape copied from `env-read-guard.mjs`'s `decide()` byte-for-byte
 * (plan § Predicate Specification "Denial shape").
 * @param {string} predicate e.g. 'H5', 'brace-syntax'
 * @param {string} token the offending argv element/token, named literally
 */
export function denyWith(predicate, token) {
  return {
    action: 'deny',
    json: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `[ruflo-host-guard] ${predicate}: this command invokes ruflo/@claude-flow/cli outside ` +
          `the sanctioned container (matched on \`${token}\`). Host-side ruflo/claude-flow ` +
          `execution is not permitted here — use \`${SANCTIONED_ALTERNATIVE}\` instead.`,
      },
    },
    stderr: null,
  }
}

/**
 * Deny for a runtime/evaluator failure — this guard's failure posture is
 * fail-CLOSED (deliberately the opposite of env-read-guard.mjs's fail-open;
 * plan § "Failure posture — where this guard must differ from its
 * precedent, and why").
 * @param {string} message
 */
export function denyInternalError(message) {
  return {
    action: 'deny',
    json: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `[ruflo-host-guard] internal error: ${message}. Denying by design (fail-closed, no ` +
          `disable variable) — use \`${SANCTIONED_ALTERNATIVE}\` for ruflo access.`,
      },
    },
    stderr: null,
  }
}

/**
 * Deny for a malformed/unparseable PreToolUse payload (round 1 finding 4 —
 * this guard denies on input failure instead of copying the precedent's
 * fail-open wrapper).
 * @param {string} reason
 */
export function denyMalformedInput(reason) {
  return {
    action: 'deny',
    json: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `[ruflo-host-guard] malformed PreToolUse input: ${reason}. Denying by design ` +
          `(fail-closed on unparseable/malformed hook input, round 1 finding 4).`,
      },
    },
    stderr: null,
  }
}

/**
 * Deny for the `mcp__ruflo__hooks_session-start` `startDaemon` gate
 * (design § "SMI-6854").
 * @param {unknown} value the offending startDaemon value
 */
export function denyStartDaemon(value) {
  return {
    action: 'deny',
    json: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `[ruflo-host-guard] mcp__ruflo__hooks_session-start: startDaemon=${JSON.stringify(value)} ` +
          'is not permitted — only an absent field or startDaemon===false is allowed (SMI-6854).',
      },
    },
    stderr: null,
  }
}

export const ALLOW = { action: 'allow', json: null, stderr: null }

/**
 * Stage 1 row 1 — `docker exec skillsmith-ruflo-1 …` (design § 1(b), plan
 * § Predicate Specification Stage 1). Runs on the RAW pre-strip word
 * values, before the shared `normalizeWrappers` ever gets a chance to
 * unwrap `docker exec` unconditionally (it doesn't know about container
 * names). The container name is matched EXACTLY (case-sensitive) — the
 * one field in this whole predicate set that deliberately does not
 * lowercase, per the plan's explicit "equals `skillsmith-ruflo-1` exactly".
 * @param {string[]} rawValues
 */
export function isSanctionedDockerExec(rawValues) {
  if (rawValues.length < 2) return false
  if (basenameOf(rawValues[0]).toLowerCase() !== 'docker') return false
  if (rawValues[1].toLowerCase() !== 'exec') return false
  const rest = stripFlags(rawValues.slice(2))
  return rest[0] === 'skillsmith-ruflo-1'
}

/**
 * Stage 1 row 3 — the three exact npm inspection/remediation forms,
 * evaluated AFTER normal wrapper normalization (same stage as H1–H8).
 * @param {string[]} argvLower the post-normalize, lowercased argv
 */
export function isSanctionedNpmForm(argvLower) {
  if (argvLower.length === 0) return false
  if (basenameOf(argvLower[0]) !== 'npm') return false
  const rest = argvLower.slice(1)
  return NPM_ALLOW_FORMS.some(
    (form) => rest.length === form.length && form.every((tok, i) => rest[i] === tok)
  )
}

/**
 * H1–H7. Two argv views are needed, not one (queen correction found by the
 * D13 smoke input `NODE_OPTIONS="--require ./node_modules/ruflo/bin/ruflo.js"
 * node -e ''`): the shared `normalizeWrappers` strips ANY leading
 * `VAR=val`-shaped token as part of unwrapping, so a path hidden inside an
 * unrelated env-assignment's VALUE (not a recognized wrapper like `env`)
 * would vanish before an argv[0]-relative check ever ran. H1/H2/H3/H6/H7
 * are pure "does any element contain X" checks with no notion of
 * position, so they run over `scanArgvLower` — the PRE-strip, this-segment
 * lowercased word values, which is always a superset of the post-strip
 * result (wrapper-stripping only ever drops a prefix, never the middle or
 * end). H4/H5 are positional (argv[0]-relative after resolving the real
 * command past its wrappers) and run over `argvLower`, the POST-normalize
 * lowercased argv.
 *
 * H5 is additionally broadened beyond a literal "argv[0] only" reading
 * (design § 1(b)'s own census cites H5 as E4's sole closure —
 * `docker run --rm node:22-slim npx -y ruflo memory store …` — where the
 * runner `npx` sits at position 4, not 0, since `docker run` is not one of
 * `normalizeWrappers`' recognized unwrap shapes, unlike `docker exec`):
 * H5 scans every position for a runner basename, then scans FORWARD from
 * that position (order-preserving — the token must still follow the
 * runner) for a matching token.
 * @param {string[]} scanArgvLower pre-strip, lowercased word values for H1/H2/H3/H6/H7
 * @param {string[]} argvLower post-normalize, lowercased argv for H4/H5
 * @returns {{action:string, json:object|null, stderr:string|null} | null}
 */
export function checkH1toH7(scanArgvLower, argvLower) {
  for (const el of scanArgvLower) {
    const stripped = stripDotSlash(el)
    if (H1_RE1.test(stripped) || H1_RE2.test(stripped)) return denyWith('H1', el)
  }

  for (const el of scanArgvLower) {
    if (H2_RE1.test(el)) return denyWith('H2', el)
    if (H2_RE2.test(el) && scanArgvLower.some((a) => a.includes('@claude-flow'))) {
      return denyWith('H2', el)
    }
  }

  for (const el of scanArgvLower) {
    const base = basenameOf(el)
    const dir = dirnameOf(el)
    if (
      H3_NAMES.has(base) &&
      (dir.endsWith('node_modules/.bin') || dir.endsWith('lib/node_modules/ruflo/bin'))
    ) {
      return denyWith('H3', el)
    }
  }

  if (H4_NAMES.has(argvLower[0])) return denyWith('H4', argvLower[0])

  for (let i = 0; i < argvLower.length; i++) {
    if (!RUNNER_BASENAMES.has(basenameOf(argvLower[i]))) continue
    for (const el of argvLower.slice(i + 1)) {
      if (RUNNER_TOKEN_RE.test(el) || H5_NPM_COLON_RE.test(el) || H5_PACKAGE_FLAG_RE.test(el)) {
        return denyWith('H5', el)
      }
    }
  }

  for (const el of scanArgvLower) {
    if (
      H6_NPX_DIR_RE.test(el) &&
      scanArgvLower.some((a) => a.includes('ruflo') || a.includes('@claude-flow'))
    ) {
      return denyWith('H6', el)
    }
  }

  for (const el of scanArgvLower) {
    if (H7_RE1.test(el) || H7_RE2.test(el)) return denyWith('H7', el)
  }

  return null
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
 * H8(ii) — "deny the runner-with-a-variable-argument shape" (a44 § 5 D11
 * candidate closure (ii), the owner's chosen primary closure). Runs on the
 * POST-normalize argv/tokens: argv[0]'s basename must be a runner, and any
 * later token must have EITHER a `$` in its raw `.value` OR a non-empty
 * `.subs` (round 1 finding 2 correction — a backtick substitution drops
 * its backticks in `tokenize()`, so `.value` alone misses it).
 * @param {string[]} argvLower
 * @param {Array<{value: string, subs?: string[]}>} alignedTokens the
 *   ORIGINAL (non-lowercased) tokens aligned 1:1 with argvLower — see
 *   `tokensForArgv` in the guard's own orchestration file.
 */
export function checkRunnerVariableArgument(argvLower, alignedTokens) {
  if (argvLower.length === 0) return null
  if (!RUNNER_BASENAMES.has(basenameOf(argvLower[0]))) return null
  for (let i = 1; i < alignedTokens.length; i++) {
    const tok = alignedTokens[i]
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
  const hasBrace = segmentTokens.some(
    (t) => t.type === 'op' && (t.value === '{' || t.value === '}')
  )
  if (!hasBrace) return null

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
  return denyWith(
    'brace-syntax',
    'a `{`/`}` brace expression in a package-runner command — fails closed rather than ' +
      'implementing partial brace-expansion (round 1 finding 3)'
  )
}
