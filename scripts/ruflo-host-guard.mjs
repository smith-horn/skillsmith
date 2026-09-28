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
 * copies) for tokenizing and wrapper-normalizing a Bash command. H1–H8 and
 * the brace-syntax check live in `scripts/lib/ruflo-host-guard-predicates.mjs`;
 * launcher/wrapper/shell-fed-text detection lives in
 * `scripts/lib/ruflo-host-guard-wrappers.mjs` (both split out purely to
 * stay under the 500-line file-length gate).
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
  detectEnvSplitString,
  findShellFedLiteralText,
  normalizeWrappersWithExec,
  tokensForArgv,
} from './lib/ruflo-host-guard-wrappers.mjs'
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

/**
 * Splits `tokens` into segments, each carrying the operator that PRECEDED
 * it (`null` for the first segment) — H-F fix (SMI-6744 Wave 4 governance
 * round) needs to know whether a segment was joined to its predecessor by
 * a pipe specifically (`echo '...' | bash`), not just that a split
 * happened, so `evaluateGuardCommand` can hand a bare-shell segment its
 * PRECEDING pipeline segment's tokens only when that relationship is a
 * real pipe.
 */
function splitSegments(tokens) {
  const segments = []
  let current = []
  let precedingOp = null
  for (const tok of tokens) {
    if (tok.type === 'op' && SPLIT_OPS.has(tok.value)) {
      if (current.length > 0) segments.push({ tokens: current, precedingOp })
      precedingOp = tok.value
      current = []
    } else {
      current.push(tok)
    }
  }
  if (current.length > 0) segments.push({ tokens: current, precedingOp })
  return segments
}

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
 * token expands (`$` in `.value` or non-empty `.subs`); otherwise join the
 * literal values and recursively evaluate the joined text through the
 * same pipeline (existing MAX_DEPTH cap — exceeding it DENIES, not
 * allows, matching this guard's fail-closed posture). A nested `-c` body
 * found while peeling is left for the main flow to handle (`undefined`,
 * "not an eval segment").
 * @param {Array<{value: string, subs?: string[]}>} wordTokens
 * @param {number} depth
 * @returns {object | undefined} undefined = "not an eval segment, keep going"
 */
function checkEvalPredicate(wordTokens, depth) {
  if (wordTokens.length === 0) return undefined
  const rawValues = wordTokens.map((t) => t.value)
  const { argv: normalizedArgv, nested } = normalizeWrappersWithExec(rawValues)
  if (nested !== null) return undefined
  if (normalizedArgv.length === 0) return undefined
  if (basenameOf(normalizedArgv[0]) !== 'eval') return undefined

  const alignedTokens = tokensForArgv(wordTokens, normalizedArgv)
  const rest = alignedTokens.slice(1)
  if (rest.length === 0) return null
  const hasExpansion = rest.some((t) => t.value.includes('$') || (t.subs && t.subs.length > 0))
  if (hasExpansion) {
    return denyWith('H9', alignedTokens[0].value + ' ' + rest.map((t) => t.value).join(' '))
  }
  const joined = rest.map((t) => t.value).join(' ')
  return evaluateGuardCommand(joined, depth + 1)
}

/**
 * Evaluate one segment (a raw, un-split-on-brace token list: word tokens
 * interleaved with any surviving `{`/`}` op tokens). Order matters — see
 * the plan's Stage 0/1/2 structure, reordered by the M-C governance-round
 * fix (SMI-6744 Wave 4):
 *   0. recurse into `.subs` (command substitutions) first
 *   1. Stage 1(a) — sanctioned `docker exec skillsmith-ruflo-1` (pre-strip)
 *      — moved ABOVE the brace/H9/H8(i) checks (M-C fix): a sanctioned
 *      wrapper's own INNER shape (e.g. `env V=ruflo`) must not be denied
 *      by a predicate scoped to the whole segment before Stage 1 gets a
 *      chance to recognize the wrapper.
 *   1b. brace-syntax fail-closed check (needs the RAW token list)
 *   2. H9 (eval) — before wrapper normalization
 *   3. H8(i) — pre-strip assignment-value check
 *   4. H-B — `env -S`/`--split-string` (before wrapper normalization
 *      mishandles it as an ordinary flag value)
 *   5. wrapper normalization (exec/launcher/docker-container-exec-aware) /
 *      recurse into a nested shell body
 *   6. Stage 1(b) — the three exact npm forms (post-normalize)
 *   7. H-F — literal text fed to a bare shell (pipe/here-string/process-sub)
 *   8. H1–H7
 *   9. H8(ii)
 * @param {Array<{type: string, value?: string, subs?: string[]}>} segmentTokens
 * @param {number} depth
 * @param {Array<{type: string, value?: string, subs?: string[]}> | null} precedingSegmentTokens
 */
function evaluateGuardSegment(segmentTokens, depth, precedingSegmentTokens) {
  for (const tok of segmentTokens) {
    if (tok.type !== 'word') continue
    for (const sub of tok.subs ?? []) {
      const nestedVerdict = evaluateGuardCommand(sub, depth + 1)
      if (nestedVerdict) return nestedVerdict
    }
  }

  const wordTokens = segmentTokens.filter((t) => t.type === 'word')
  if (wordTokens.length === 0) return null
  const rawValues = wordTokens.map((t) => t.value)

  if (isSanctionedDockerExec(rawValues)) return null

  const braceVerdict = checkBraceSegment(segmentTokens)
  if (braceVerdict) return braceVerdict

  const evalVerdict = checkEvalPredicate(wordTokens, depth)
  if (evalVerdict !== undefined) return evalVerdict

  const h8iVerdict = checkAssignmentValuePredicate(wordTokens)
  if (h8iVerdict) return h8iVerdict

  const envSplitNested = detectEnvSplitString(rawValues)
  if (envSplitNested !== null) return evaluateGuardCommand(envSplitNested, depth + 1)

  const { argv: normalizedArgv, nested } = normalizeWrappersWithExec(rawValues)
  if (nested !== null) return evaluateGuardCommand(nested, depth + 1)
  if (normalizedArgv.length === 0) return null

  const argvLower = normalizedArgv.map((s) => s.toLowerCase())
  if (isSanctionedNpmForm(argvLower)) return null

  const shellFedText = findShellFedLiteralText(argvLower, segmentTokens, precedingSegmentTokens)
  if (shellFedText !== null) return evaluateGuardCommand(shellFedText, depth + 1)

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
  for (let i = 0; i < segments.length; i++) {
    const { tokens: segmentTokens, precedingOp } = segments[i]
    const precedingSegmentTokens = precedingOp === '|' && i > 0 ? segments[i - 1].tokens : null
    const verdict = evaluateGuardSegment(segmentTokens, depth, precedingSegmentTokens)
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
