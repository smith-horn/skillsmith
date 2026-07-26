#!/usr/bin/env node
/**
 * Linear issue creation guard (SMI-5846).
 *
 * A `PreToolUse` hook, matched to `mcp__linear__save_issue` in
 * `.claude/settings.json`, that blocks (or, during shadow mode, warns on) a
 * non-compliant Linear issue **create** call before it reaches Linear.
 * `save_issue` does double duty (create when `id` is absent, update when
 * present) — this guard only ever gates the create path.
 *
 * Complements SMI-5841's `scripts/lint-linear-issues.mjs`, a scheduled CI
 * job that detects violations in already-created issues after the fact.
 * This hook is the client-side prevention layer, scoped to this repo's own
 * `.claude/settings.json` (and therefore this repo's own Claude Code
 * sessions only — it cannot reach the Linear web UI, other repos, or other
 * integrations).
 *
 * Validation contract lives in `scripts/lib/linear-issue-validation.mjs`
 * (shared with `scripts/lint-linear-issues.mjs` so both stay in sync by
 * construction).
 *
 * Env vars (both plain local environment variables — this hook runs
 * client-side in a developer's own Claude Code session, not in CI):
 *   SKILLSMITH_LINEAR_ISSUE_GUARD_DISABLE  - '1' to hard-disable; the hook
 *     does not even compute a decision. Always checked first — this
 *     precedence over SHADOW is an explicit invariant.
 *   SKILLSMITH_LINEAR_ISSUE_GUARD_SHADOW   - default on (unset); while on,
 *     a non-compliant description produces a `warn` (visible transcript
 *     notice, call still proceeds). Set to '0' to start actually denying.
 *
 * @see docs/internal/implementation/smi-5846-linear-issue-creation-guard.md
 */
import { validateIssueDescription } from './lib/linear-issue-validation.mjs'

/**
 * Dated follow-up review target for the shadow-first rollout (matches
 * Check 59/60's hardcoded-shadow-end-date convention, `scripts/audit-standards.mjs`).
 * A dated Linear issue filed at merge time references this date; when it
 * arrives, a session reviews the transcript-visible `warn` notices actually
 * seen over the burn-in window before deciding whether to set
 * SKILLSMITH_LINEAR_ISSUE_GUARD_SHADOW=0.
 */
export const LINEAR_ISSUE_GUARD_SHADOW_END_DATE = '2026-08-09'

/**
 * Pure decision function — no I/O. Given a raw PreToolUse `toolCall`
 * payload and `process.env` (or an equivalent plain object), decides
 * whether to allow, warn, or deny the call.
 *
 * @param {{ tool_name?: string, tool_input?: { id?: string, description?: string | null } } | null | undefined} toolCall
 * @param {Record<string, string | undefined>} env
 * @returns {{ action: 'allow' | 'warn' | 'deny', json: object | null, stderr: string | null }}
 */
export function decide(toolCall, env) {
  try {
    if (env?.SKILLSMITH_LINEAR_ISSUE_GUARD_DISABLE === '1') {
      return { action: 'allow', json: null, stderr: null }
    }

    if (toolCall?.tool_name !== 'mcp__linear__save_issue') {
      return { action: 'allow', json: null, stderr: null }
    }

    const id = toolCall?.tool_input?.id
    if (typeof id === 'string' && id.length > 0) {
      // An update, not a create — save_issue does double duty and updates
      // must never be gated on the create-time template contract.
      return { action: 'allow', json: null, stderr: null }
    }

    const errors = validateIssueDescription(toolCall?.tool_input?.description)

    if (errors.length === 0) {
      return { action: 'allow', json: null, stderr: null }
    }

    const reason =
      errors.join('; ') +
      ' — see .claude/templates/linear-issue-template.md for the required format.'

    if (env?.SKILLSMITH_LINEAR_ISSUE_GUARD_SHADOW !== '0') {
      // Shadow mode (default): warn, call still proceeds.
      return { action: 'warn', json: null, stderr: reason }
    }

    // Shadow lifted: deny outright.
    return {
      action: 'deny',
      json: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      },
      stderr: null,
    }
  } catch (err) {
    // Fail open — a bug in this hook's own code must never block Linear
    // issue creation in every session working in this repo.
    return {
      action: 'allow',
      json: null,
      stderr: `[linear-issue-creation-guard] internal error, failing open: ${err.message}`,
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
      // every field via optional chaining, so a null toolCall resolves to
      // undefined at every access rather than throwing, and falls through
      // to the tool_name mismatch branch (allow).
      toolCall = null
    }

    const result = decide(toolCall, process.env)

    if (result.action === 'deny') {
      process.stdout.write(JSON.stringify(result.json))
      process.exit(0)
    } else if (result.action === 'warn') {
      process.stderr.write(`${result.stderr}\n`)
      process.exit(1)
    } else {
      // allow — any diagnostic stderr from the fail-open path is still
      // written, but exit 0 keeps it out of the transcript (--debug-log
      // only), which is fine since it's a breadcrumb for the rare
      // internal-bug case, not the load-bearing shadow signal.
      if (result.stderr) {
        process.stderr.write(`${result.stderr}\n`)
      }
      process.exit(0)
    }
  })
}
