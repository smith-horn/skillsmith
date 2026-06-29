#!/usr/bin/env tsx
/**
 * SMI-5426 W0.1 host auto-heal — thin tsx CLI over the shared state module.
 *
 * Called by `scripts/retrieval-autoheal.sh` ONLY on the unhealthy path (the
 * bash cheap-probe + disable/Docker exits run first, so a healthy host never
 * pays the tsx startup). Keeps the JSON shape, cooldown/backoff math, and banner
 * text in ONE place (`packages/doc-retrieval-mcp/src/retrieval-log/autoheal-state.ts`),
 * shared with the priming hook — no bash↔TS re-implementation (SMI-5419 lesson).
 *
 * Subcommands (all take `--cwd <dir>` to resolve the main-repo state key):
 *   decision  → prints `run` | `cooldown <untilEpoch>` | `capped`
 *   record    → `--result ok|fail [--reason R] [--module M] [--abi A]`; writes state
 *   banner    → `--log <path>`; prints the D5 banner line (caller guarantees broken)
 *
 * Always exits 0 and degrades to `run` / no-op / a generic banner on any error,
 * so it can never break the post-merge hook.
 */

import { parseArgs } from 'node:util'
import {
  cooldownDecision,
  readEntry,
  recordResult,
  renderAutohealBanner,
  resolveAutohealLogPath,
  resolveMainRepoKey,
  writeEntry,
} from '../packages/doc-retrieval-mcp/src/retrieval-log/autoheal-state.js'

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
        result: { type: 'string' },
        reason: { type: 'string' },
        module: { type: 'string' },
        abi: { type: 'string' },
        log: { type: 'string' },
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
    // Fail-open to `run` when the key is unknown — the heal itself re-probes and
    // locks, so an extra attempt is safe; a false `cooldown` would suppress a heal.
    const entry = key ? readEntry(key) : null
    const decision = cooldownDecision(entry, nowEpoch())
    if (decision.action === 'cooldown') process.stdout.write(`cooldown ${decision.untilEpoch}`)
    else process.stdout.write(decision.action) // 'run' | 'capped'
    return
  }

  if (command === 'record') {
    if (!key) return // cannot key the write — no-op (bash logs its own verdict)
    const result = values.result === 'fail' ? 'fail' : 'ok'
    const prior = readEntry(key)
    const entry = recordResult(prior, result, nowEpoch(), {
      reason: typeof values.reason === 'string' ? values.reason : undefined,
      module: typeof values.module === 'string' ? values.module : undefined,
      abi: typeof values.abi === 'string' ? values.abi : undefined,
    })
    try {
      writeEntry(key, entry)
    } catch {
      // best-effort; a failed state write must not break the (already detached) heal
    }
    return
  }

  if (command === 'banner') {
    const now = new Date()
    const logPath = typeof values.log === 'string' ? values.log : resolveAutohealLogPath(now)
    const entry = key ? readEntry(key) : null
    process.stdout.write(renderAutohealBanner(entry, { now, logPath }))
    return
  }

  // Unknown command — print nothing, exit 0.
}

main()
