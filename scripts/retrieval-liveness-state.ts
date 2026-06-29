#!/usr/bin/env tsx
/**
 * SMI-5432 W0.2 telemetry-liveness alert — thin tsx CLI over the shared state module.
 *
 * Called by `scripts/retrieval-liveness-check.sh` to read/write the liveness
 * state. Keeps the JSON shape, re-notify math, and banner text in ONE place
 * (`packages/doc-retrieval-mcp/src/retrieval-log/liveness-state.ts`), shared
 * with the priming hook — no bash↔TS re-implementation (SMI-5419 lesson).
 *
 * Subcommands (all accept `--cwd <dir>` and `--key <k>` to resolve the state key):
 *   decision      → prints `notify` | `dedupe`
 *   record        → `--verdict healthy|stale [--stale-since <iso>]`; writes state
 *   record-alert  → `[--issue <n>]`; writes lastAlertEpoch + openIssueNumber
 *   banner        → `--log <path> [--autoheal-failed]`; prints the banner line
 *
 * Always exits 0 and degrades safely on any error:
 *   - Unknown key on `decision` → 'dedupe' (fail-open; never page on unresolvable repo).
 *   - No key on `record` / `record-alert` → no-op.
 *   - Write failure → silently swallowed (never breaks the eval cron).
 *   - Unknown command → print nothing, exit 0.
 */

import { parseArgs } from 'node:util'
import {
  alertDecision,
  readEntry,
  recordAlert,
  recordCheck,
  renderLivenessBanner,
  resolveLivenessLogPath,
  resolveMainRepoKey,
  writeEntry,
} from '../packages/doc-retrieval-mcp/src/retrieval-log/liveness-state.js'

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000)
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2)
  let values: Record<string, string | boolean | undefined> = {}
  try {
    ;({ values } = parseArgs({
      args: rest,
      options: {
        cwd: { type: 'string' },
        key: { type: 'string' },
        verdict: { type: 'string' },
        'stale-since': { type: 'string' },
        issue: { type: 'string' },
        log: { type: 'string' },
        now: { type: 'string' },
        'autoheal-failed': { type: 'boolean' },
      },
      strict: false,
    }))
  } catch {
    // Fall through with empty values → safe defaults below.
  }

  const cwd = typeof values.cwd === 'string' ? values.cwd : process.cwd()
  // Prefer the explicit --key the bash orchestrator passes (its MAIN_REPO has a
  // robust fallback chain); fall back to git-derived resolution for direct callers.
  const key = typeof values.key === 'string' && values.key ? values.key : resolveMainRepoKey(cwd)

  if (command === 'decision') {
    // Fail-open to 'dedupe' when key is unknown — never false-alert on an
    // unresolvable repo; the bash side logs its own diagnostic.
    const entry = key ? readEntry(key) : null
    process.stdout.write(alertDecision(entry, nowEpoch()))
    return
  }

  if (command === 'record') {
    if (!key) return // cannot key the write — no-op
    const verdict = values.verdict === 'stale' ? 'stale' : 'healthy'
    const staleSince = typeof values['stale-since'] === 'string' ? values['stale-since'] : undefined
    const prior = readEntry(key)
    const entry = recordCheck(prior, verdict, nowEpoch(), { staleSinceTs: staleSince })
    try {
      writeEntry(key, entry)
    } catch {
      // best-effort; a failed state write must not break the eval cron
    }
    return
  }

  if (command === 'record-alert') {
    if (!key) return
    const prior = readEntry(key)
    if (!prior) return // no state to update
    const issueStr = typeof values.issue === 'string' ? values.issue : undefined
    const issueNum = issueStr != null ? parseInt(issueStr, 10) : undefined
    const entry = recordAlert(
      prior,
      nowEpoch(),
      issueNum != null && !isNaN(issueNum) ? issueNum : undefined
    )
    try {
      writeEntry(key, entry)
    } catch {
      // best-effort
    }
    return
  }

  if (command === 'banner') {
    const now = new Date()
    const logPath = typeof values.log === 'string' ? values.log : resolveLivenessLogPath(now)
    const autohealFailed = values['autoheal-failed'] === true
    const entry = key ? readEntry(key) : null
    process.stdout.write(renderLivenessBanner(entry, { now, logPath, autohealFailed }))
    return
  }

  // Unknown command — print nothing, exit 0.
}

main()
