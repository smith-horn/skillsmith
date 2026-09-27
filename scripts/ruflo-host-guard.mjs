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
 * is its Wave 1 implementation), built from
 * docs/internal/uat/smi-6744/a44-structural-design-2026-09-27.md § 1(b)
 * Layer H and its 62-row adversarial census (§ 5). Reuses
 * `scripts/lib/shell-command-normalize.mjs` (extracted from
 * `scripts/env-read-guard.mjs`, the precedent this guard's structure
 * copies) for tokenizing and wrapper-normalizing a Bash command; H1–H8 and
 * the brace-syntax check live in `scripts/lib/ruflo-host-guard-predicates.mjs`
 * (split out purely to stay under the 500-line file-length gate).
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

import {
  basenameOf,
  MAX_DEPTH,
  normalizeWrappers,
  stripFlags,
  tokenize,
} from './lib/shell-command-normalize.mjs'
import {
  ALLOW,
  checkAssignmentValuePredicate,
  checkBraceSegment,
  checkH1toH7,
  checkRunnerVariableArgument,
  denyInternalError,
  denyMalformedInput,
  denyStartDaemon,
  denyWith,
  isSanctionedDockerExec,
  isSanctionedNpmForm,
} from './lib/ruflo-host-guard-predicates.mjs'

/**
 * Real statement separators for THIS guard's own segmentation — unlike
 * `env-read-guard.mjs`'s `evaluateCommand`, which treats every op token
 * (including `{`/`}`) as a splitter, this guard deliberately does NOT
 * split on `{`/`}` so the brace-syntax check (below) can see them still
 * grouped with the command they belong to (round 1 finding 3).
 */
const SPLIT_OPS = new Set([';', '&&', '||', '|', '&', '\n', '(', ')'])

function splitSegments(tokens) {
  const segments = []
  let current = []
  for (const tok of tokens) {
    if (tok.type === 'op' && SPLIT_OPS.has(tok.value)) {
      if (current.length > 0) segments.push(current)
      current = []
    } else {
      current.push(tok)
    }
  }
  if (current.length > 0) segments.push(current)
  return segments
}

/**
 * Guard-local transparent wrappers the shared `normalizeWrappers` does not
 * know about: `exec` (round 1 finding 2 — `exec ruflo …` reached H4 with
 * `argv[0] === "exec"`), and `command`/`noglob` (docs fact 3 — Claude
 * Code's own deny-rule engine already strips these before prefix-matching;
 * D12's census closure names H5 too, which requires this guard to see
 * through them the same way for its own argv[0]-relative predicates).
 */
const TRANSPARENT_WRAPPERS = new Set(['exec', 'command', 'noglob'])

/**
 * `exec`/`command`/`noglob`-aware wrapper normalization (round 1 finding
 * 2; docs fact 3). The shared `normalizeWrappers` strips `sudo`/`env`/
 * `varlock run`/`docker exec`/`docker compose` but not these three — this
 * is guard-local (not added to the shared module) because it is specific
 * to this guard's own H4/H5/H8(ii) exposure, not a general normalization
 * every consumer needs. Alternates peeling a leading transparent wrapper
 * and calling the shared unwrap until neither changes anything or a
 * nested shell body is found.
 * @param {string[]} argvIn
 * @returns {{argv: string[], nested: string|null}}
 */
function normalizeWrappersWithExec(argvIn) {
  let current = argvIn
  for (let pass = 0; pass < 8; pass++) {
    let changed = false
    while (current.length > 0 && TRANSPARENT_WRAPPERS.has(basenameOf(current[0]))) {
      current = stripFlags(current.slice(1))
      changed = true
    }
    const { argv: after, nested } = normalizeWrappers(current)
    if (nested !== null) return { argv: after, nested }
    if (!changed && after.length === current.length) {
      return { argv: after, nested: null }
    }
    current = after
  }
  return { argv: current, nested: null }
}

/**
 * Recover the ORIGINAL token objects (with `.subs`) aligned to a
 * normalized argv string array. Every wrapper-stripping step in
 * `shell-command-normalize.mjs` (and this file's own exec-peel) only ever
 * drops elements from the FRONT of the array it is given — never reorders,
 * filters from the middle, or appends — so the final normalized argv is
 * always a contiguous SUFFIX of the segment's original word-token list.
 * That lets H8(ii) read `.subs` on the surviving tokens without the
 * shared/guard-local normalizers needing to carry token objects through
 * (which would change their string-array contract for every caller,
 * including env-read-guard.mjs).
 * @param {Array<{value: string}>} originalTokens
 * @param {string[]} normalizedArgv
 */
function tokensForArgv(originalTokens, normalizedArgv) {
  const start = Math.max(0, originalTokens.length - normalizedArgv.length)
  return originalTokens.slice(start)
}

/**
 * H9 — dynamic shell evaluators (round 1 finding 1). Runs BEFORE wrapper
 * normalization, on the segment's raw pre-strip word tokens. If the
 * segment's command basename is `eval`: deny when any later token expands
 * (`$` in `.value` or non-empty `.subs`); otherwise join the literal
 * values and recursively evaluate the joined text through the same
 * pipeline (existing MAX_DEPTH cap — but see the depth-cap note in
 * `evaluateGuardCommand`: unlike the precedent, exceeding it here DENIES,
 * not allows, matching this guard's fail-closed posture).
 * @param {Array<{value: string, subs?: string[]}>} wordTokens
 * @param {number} depth
 * @returns {object | undefined} undefined = "not an eval segment, keep going"
 */
function checkEvalPredicate(wordTokens, depth) {
  const first = wordTokens[0]
  if (!first || basenameOf(first.value) !== 'eval') return undefined
  const rest = wordTokens.slice(1)
  if (rest.length === 0) return null
  const hasExpansion = rest.some((t) => t.value.includes('$') || (t.subs && t.subs.length > 0))
  if (hasExpansion) return denyWith('H9', first.value + ' ' + rest.map((t) => t.value).join(' '))
  const joined = rest.map((t) => t.value).join(' ')
  return evaluateGuardCommand(joined, depth + 1)
}

/**
 * Evaluate one segment (a raw, un-split-on-brace token list: word tokens
 * interleaved with any surviving `{`/`}` op tokens). Order matters —
 * see the plan's Stage 0/1/2 structure:
 *   0. recurse into `.subs` (command substitutions) first
 *   0b. brace-syntax fail-closed check (needs the RAW token list)
 *   1. H9 (eval) — before wrapper normalization
 *   2. H8(i) — pre-strip assignment-value check
 *   3. Stage 1(a) — sanctioned `docker exec skillsmith-ruflo-1` (pre-strip)
 *   4. wrapper normalization (exec-aware) / recurse into a nested shell body
 *   5. Stage 1(b) — the three exact npm forms (post-normalize)
 *   6. H1–H7
 *   7. H8(ii)
 * @param {Array<{type: string, value?: string, subs?: string[]}>} segmentTokens
 * @param {number} depth
 */
function evaluateGuardSegment(segmentTokens, depth) {
  for (const tok of segmentTokens) {
    if (tok.type !== 'word') continue
    for (const sub of tok.subs ?? []) {
      const nestedVerdict = evaluateGuardCommand(sub, depth + 1)
      if (nestedVerdict) return nestedVerdict
    }
  }

  const braceVerdict = checkBraceSegment(segmentTokens)
  if (braceVerdict) return braceVerdict

  const wordTokens = segmentTokens.filter((t) => t.type === 'word')
  if (wordTokens.length === 0) return null

  const evalVerdict = checkEvalPredicate(wordTokens, depth)
  if (evalVerdict !== undefined) return evalVerdict

  const h8iVerdict = checkAssignmentValuePredicate(wordTokens)
  if (h8iVerdict) return h8iVerdict

  const rawValues = wordTokens.map((t) => t.value)
  if (isSanctionedDockerExec(rawValues)) return null

  const { argv: normalizedArgv, nested } = normalizeWrappersWithExec(rawValues)
  if (nested !== null) return evaluateGuardCommand(nested, depth + 1)
  if (normalizedArgv.length === 0) return null

  const argvLower = normalizedArgv.map((s) => s.toLowerCase())
  if (isSanctionedNpmForm(argvLower)) return null

  const scanArgvLower = rawValues.map((s) => s.toLowerCase())
  const h1to7Verdict = checkH1toH7(scanArgvLower, argvLower)
  if (h1to7Verdict) return h1to7Verdict

  const alignedTokens = tokensForArgv(wordTokens, normalizedArgv)
  const h8iiVerdict = checkRunnerVariableArgument(argvLower, alignedTokens)
  if (h8iiVerdict) return h8iiVerdict

  return null
}

/**
 * Evaluate a full command string: tokenize, split into segments (NOT
 * splitting on `{`/`}`, per `SPLIT_OPS`), evaluate each in order, return
 * the first denial. Fail-closed depth boundary — unlike
 * `env-read-guard.mjs`'s `evaluateCommand`, which returns `null` (allow)
 * once `depth > MAX_DEPTH`, this guard DENIES at that boundary, matching
 * its overall fail-closed posture (plan § "Choices Made" / § Predicate
 * Specification "Failure posture").
 * @param {string} commandText
 * @param {number} depth
 */
function evaluateGuardCommand(commandText, depth) {
  if (depth > MAX_DEPTH) {
    return denyInternalError('recursion depth cap exceeded while unwrapping nested shell text')
  }
  if (typeof commandText !== 'string' || commandText.trim() === '') return null
  const tokens = tokenize(commandText)
  const segments = splitSegments(tokens)
  for (const segment of segments) {
    const verdict = evaluateGuardSegment(segment, depth)
    if (verdict) return verdict
  }
  return null
}

/**
 * `mcp__ruflo__hooks_session-start`'s `startDaemon` gate (SMI-6854, design
 * § "SMI-6854"). Allow only when `tool_input` is a plain object and
 * `startDaemon` is absent or strictly `false`; deny every other present
 * value. A missing/malformed `tool_input` follows the runtime fail-closed
 * rule (round 1 finding 5).
 * @param {unknown} toolInput
 */
function decideHooksSessionStart(toolInput) {
  if (toolInput === null || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return denyMalformedInput('mcp__ruflo__hooks_session-start requires an object tool_input')
  }
  if (!('startDaemon' in toolInput) || toolInput.startDaemon === false) return ALLOW
  return denyStartDaemon(toolInput.startDaemon)
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
