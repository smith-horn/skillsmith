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
 * Named instances of the "reader not on READER_COMMANDS" clause, so they are not
 * rediscovered as findings (SMI-6903 L2): `read -r line < .env` and
 * `while IFS= read -r l; do echo "$l"; done < .env` are ALLOWED, and correctly so.
 * `read` is not a reader -- it prints nothing, it assigns a variable -- so the file's
 * contents never reach the transcript through it. The loop body's `echo "$l"` does
 * expose them, but that is the variable-indirection clause above, which this guard
 * does not claim to cover. Both shapes also allowed before the input-redirect fix
 * (SMI-6903 C1), so they are a stated limit of the contract rather than a regression
 * in it; `inputRedirectSources` deliberately does not special-case them.
 *
 * Env vars (plain local environment variables — this hook runs
 * client-side in a developer's own Claude Code session, not in CI):
 *   SKILLSMITH_ENV_READ_GUARD_DISABLE - '1' to hard-disable; the hook
 *     does not even compute a decision. Checked first, before anything
 *     else, as an explicit invariant.
 *
 * @see docs/internal/implementation/varlock-secret-exposure-defense-in-depth.md
 *
 * SMI-6744 A4.6: every tokenizer and wrapper-normalization primitive this
 * file used to own (`tokenize`, `stripFlags`, `stripEnvPrefix`,
 * `stripDockerExec`, `stripDockerCompose`, `stripVarlockRun`,
 * `extractShellDashC`, `normalizeWrappers`, `hasInlineScriptFlag`,
 * `scanPositionalScriptText`, `basenameOf`, `SHELL_COMMANDS`, `MAX_DEPTH`,
 * `INLINE_SCRIPT_LONG_FLAGS`) lives in
 * `scripts/lib/shell-command-normalize.mjs` so `scripts/ruflo-host-guard.mjs`
 * can reuse it; `WRAPPER_VALUE_FLAGS` and `POSITIONAL_SCRIPT_COMMANDS` moved
 * there too but stay private to it. The `.env`-specific argv rules
 * (`checkArgv`, the reader/metadata/grep tables, path classification,
 * `scanTextForProtected`, `INLINE_SCRIPT_SHORT_FLAG_CHARS`) live in
 * `scripts/lib/env-read-guard-argv.mjs` since SMI-6920, when this file
 * crossed the same 500-line convention; it keeps the command-line walk
 * (`evaluateCommand`) and `decide`.
 */

import { checkArgv, classifyPath } from './lib/env-read-guard-argv.mjs'
import { reasonFor } from './lib/env-read-guard-reasons.mjs'
import { shellTextOperand } from './lib/shell-command-shell-text.mjs'
import {
  checkUnresolvedHeadTail,
  flattenSubWords,
  inputRedirectSources,
  MAX_DEPTH,
  normalizeWrappers,
  splitCommandSegmentsWithSubRuns,
  tokenize,
} from './lib/shell-command-normalize.mjs'

const ALLOW = { action: 'allow', json: null, stderr: null }

/**
 * Evaluate a full command string: split on shell operators, recurse into command
 * substitutions and `bash -c` bodies, check each segment. Contract: a protected file
 * spelled LITERALLY anywhere, substitution bodies included, up to `MAX_DEPTH` nesting
 * levels, is a read target -- an unquoted `${...}` expansion is NOT an exception
 * (`SEGMENT_SEPARATOR_OPS` never tears a brace apart, and `groupingOpSubRuns` keeps the
 * command name a brace merge would otherwise hide). Past `MAX_DEPTH` a nested command
 * denies with kind `'depth-cap'` unread, never silently allowed. Limit: a name the shell
 * only ASSEMBLES at runtime (a variable, a non-literal emitter, a literal split across a
 * substitution boundary) is not spelled anywhere this guard can read (`f=.en; cat ${f}v`).
 * `inheritedSources` are the input-redirect sources of the wrapper or shell-text head
 * whose body this call reads (`bash -c '…' < .env`, `eval '…'`): stdin follows the body
 * inward, so they are every body segment's read targets too, through the same checks the
 * segment's own sources get (SMI-6908 F-1, SMI-6920 F-B).
 * @returns {{ kind: string, file?: string, format?: string } | null}
 */
function evaluateCommand(command, depth, inheritedSources = []) {
  // Fail CLOSED at the cap -- the posture `evaluateGuardCommand` takes at
  // the same `MAX_DEPTH`, and the one `flattenSubWords`' docblock claims
  // for this file. Folded into the checks below it returned null (ALLOW),
  // so a validity-checked 7-level `bash -c` chain hid its innermost `cat
  // .env`; the flatten's own cap covers only substitution bodies.
  if (depth > MAX_DEPTH) return { kind: 'depth-cap' }
  if (typeof command !== 'string' || command.trim() === '') return null

  const segments = splitCommandSegmentsWithSubRuns(tokenize(command), normalizeWrappers)

  for (const segment of segments) {
    for (const w of segment) {
      for (const sub of w.subs) {
        // The INHERITED sources, not this segment's own: `eval 'echo $(cat)'
        // < .env` feeds the body's stdin to the substitution's `cat` and
        // printed a decoy, while `echo $(cat) < .env` prints nothing because
        // expansion precedes redirection (measured, bash 3.2 and zsh 5.9; the
        // governance review of 243a96847, C-2).
        const nestedViolation = evaluateCommand(sub, depth + 1, inheritedSources)
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
    // An INPUT redirect's source is this segment's read target too (see
    // `inputRedirectSources`), fed through the SAME `checkArgv` as argv so
    // every existing exception still applies: `wc < .env` and
    // `grep -q KEY < .env` stay allowed, as `wc .env` already is.
    const redirectSources = inputRedirectSources(segment, flattenSubWords).concat(inheritedSources)
    const extraArgs = subWords.concat(redirectSources)
    const { argv, nested } = normalizeWrappers(argvWords.map((w) => w.value))
    // A wrapper's own redirect feeds the nested BODY's stdin, which has no
    // argv to append to, so the sources travel into the body's evaluation
    // as `inheritedSources` and meet every reading AND every check there
    // (round 21 appended them to the separator reading only; SMI-6908 F-1
    // gave the body every reading; SMI-6920 F-B gave it the computed-head
    // check too, by this one parameter instead of a second implementation).
    const violation =
      nested !== null
        ? evaluateCommand(nested, depth + 1, redirectSources)
        : checkArgv(extraArgs.length > 0 ? argv.concat(extraArgs) : argv)
    if (violation) return violation
    // An argv[0] that is itself a substitution (after wrapper peeling)
    // leaves the command name unresolved for this segment; see
    // `checkUnresolvedHeadTail`'s own doc for the two checks it runs.
    const headViolation = checkUnresolvedHeadTail(
      argvWords,
      argv,
      (a) => (classifyPath(a) === 'protected' ? { kind: 'read', file: a } : null),
      checkArgv,
      () => ({ kind: 'depth-cap' }),
      redirectSources
    )
    if (headViolation) return headViolation
    // SMI-6920 F-A: a head whose operand IS shell text (`eval "cat .env"`,
    // `env -S "cat .env"`, `trap "cat .env" EXIT`) hands one word to the
    // shell to be tokenized again; stripping the head as transparent never
    // read inside that word, so every quoted spelling allowed while the
    // separate-word spelling denied. Read the operand as a command line
    // under the same depth cap, stdin inherited.
    // A nested body already read above is not read twice (`env -S` reports
    // one through the normalizer).
    const operandText = nested === null ? shellTextOperand(argv) : null
    if (operandText !== null) {
      const operandViolation = evaluateCommand(operandText, depth + 1, redirectSources)
      if (operandViolation) return operandViolation
    }
  }
  return null
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
          permissionDecisionReason: reasonFor(violation, MAX_DEPTH),
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
