/**
 * SMI-6995 — the two-axis (really five-status) read + ack for
 * `mcp-disconnect-state.ts`, split out purely to stay under this repo's
 * <500-line-per-file convention (CLAUDE.md § CI Health Requirements) —
 * `mcp-disconnect-state.ts` re-exports everything below, so every caller
 * still imports from that one path. This file imports BACK from
 * `mcp-disconnect-state.ts` (`withLock`, `writeState`, `logSkippedWrite`,
 * the path resolvers, `renderDisconnectBanner`), a deliberate circular
 * module reference — the same shape `state-read.ts`/`state-read.quarantine.ts`
 * already carry, and safe for the same reason: every cross-import here is
 * used only inside a function body, never evaluated at module-top-level, so
 * Node/ESM's live-binding semantics resolve it regardless of load order.
 *
 * ## Why this module exists (see `mcp-disconnect-state.ts`'s own doc comment
 * for the full "odd one out" framing)
 *
 * `readAndAck` (the legacy accessor, unchanged, still in the main file)
 * collapses FOUR outcomes into one `null`: no state file, a corrupt state
 * file, a fully-acknowledged entry, and a lock-acquisition timeout. This
 * module adds {@link readAndAckResult}, which reports all four as distinct
 * statuses, PLUS {@link renderDisconnectBannerResult}, the banner that
 * renders three of them (silent only on genuine absence). Two rules govern
 * this, both from adversarial review rather than the original ticket:
 *
 * **RULE 1 — a `malformed` or `unreadable` read must NEVER ack.** Acking
 * writes `sinceAckCount: 0` back to disk, which would overwrite the ONLY
 * evidence that the file was corrupt in the first place. Every non-`ok`
 * branch in {@link readAndAckResult} returns from INSIDE the `withLock`
 * callback before it ever reaches the `writeState` call at the bottom —
 * there is exactly one write statement in this function, and every early
 * return in this file is a return that skips it. This is not a new
 * lock-usage pattern: `readAndAck` itself already returns from inside the
 * lock without writing when there is no entry or `sinceAckCount <= 0`
 * (`mcp-disconnect-state.ts`'s own `if (!entry || entry.sinceAckCount <= 0)
 * return null` line) — RULE 1 just adds two more branches that take the
 * same already-safe shape.
 *
 * **RULE 2 — a lock-acquisition timeout is its own status, never folded
 * into `missing`.** "Another process holds the lock" is not "nothing has
 * happened": a caller that treats the two alike will tell a developer there
 * is no disconnect when in truth it could not look. `withLock`'s own
 * `{ acquired: false }` outcome — reached only when
 * `lockAcquireTimeoutMs()`'s budget expires — maps to `{ status:
 * 'lock-timeout' }` here, a fifth value outside the four-status
 * {@link StateReadResult} union `state-read.ts` defines for every OTHER
 * sibling reader (those are pure reads with no lock to time out on).
 */

import { homedir } from 'node:os'

import {
  MCP_DISCONNECT_DISABLE_VAR,
  logSkippedWrite,
  renderDisconnectBanner,
  resolveMcpDisconnectLogPath,
  resolveMcpDisconnectStatePath,
  withLock,
  writeState,
  type McpDisconnectEntry,
  type McpDisconnectState,
  type McpServerName,
} from './mcp-disconnect-state.js'
import { readRawState, type StateReadResult } from './state-read.js'

/**
 * The consumer-facing result of {@link readAndAckResult}. Four of the five
 * values are the shared {@link StateReadResult} shape every sibling reader
 * in this sweep uses; `lock-timeout` is this module's own addition (RULE 2
 * above) — no other state module in this repo takes a lock on its read
 * path, so no other module needs this fifth value.
 */
export type McpDisconnectReadResult =
  | StateReadResult<McpDisconnectEntry>
  | { status: 'lock-timeout' }

/**
 * Complete field-by-field validator — every field {@link renderDisconnectBanner}
 * and {@link renderDisconnectBannerResult} read on the `ok` branch, not a
 * `typeof` spot-check. A validator that accepted `{containerStatus:
 * "banana"}` would still read as `ok`, and `renderDisconnectBanner`'s
 * `entry.containerStatus ?? 'unknown'` line would then happily print the
 * garbage value — the exact collapse this whole effort exists to remove,
 * recreated one layer down inside its own fix (mirrors
 * `reindex-state.ts`'s `validateReindexEntry` and
 * `ruflo-bridge-state.ts`'s validator for the same reason). `containerStatus`
 * is a literal union, checked by value; the two count fields are checked
 * with `Number.isFinite`, not `typeof === 'number'` alone, since `NaN`/
 * `Infinity` both pass the latter.
 */
function validateMcpDisconnectEntry(candidate: unknown): string | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return 'entry is not an object'
  }
  const e = candidate as Record<string, unknown>
  if (typeof e.totalCount !== 'number' || !Number.isFinite(e.totalCount)) {
    return 'totalCount is not a finite number'
  }
  if (typeof e.sinceAckCount !== 'number' || !Number.isFinite(e.sinceAckCount)) {
    return 'sinceAckCount is not a finite number'
  }
  if (e.lastTimestamp !== null && typeof e.lastTimestamp !== 'string') {
    return 'lastTimestamp is neither a string nor null'
  }
  if (e.lastTool !== null && typeof e.lastTool !== 'string') {
    return 'lastTool is neither a string nor null'
  }
  if (e.lastErrorExcerpt !== null && typeof e.lastErrorExcerpt !== 'string') {
    return 'lastErrorExcerpt is neither a string nor null'
  }
  const status = e.containerStatus
  if (
    status !== null &&
    status !== 'healthy' &&
    status !== 'unhealthy-or-starting' &&
    status !== 'down' &&
    status !== 'unknown'
  ) {
    return 'containerStatus is not one of the documented values'
  }
  return null
}

/**
 * The result-shaped sibling of `readAndAck` (RULE 1 and RULE 2 above). Reads
 * `server`'s entry in `repoKey`, under the SAME {@link withLock} this
 * module's legacy accessor uses — acking (resetting `sinceAckCount` to 0)
 * is still a write, so it still needs the lock `readAndAck` already takes.
 *
 * The repo-keyed container (`raw.state[repoKey]`) is validated as its own
 * object BEFORE indexing into it by `server` — a repo-key entry that is
 * present but not an object (e.g. a hand-edited file with a string where an
 * object belongs) is reported as `malformed` rather than silently treated
 * as "no entry for this server," since that too is corruption worth naming.
 */
export function readAndAckResult(repoKey: string, server: McpServerName): McpDisconnectReadResult {
  const outcome = withLock((): McpDisconnectReadResult => {
    const raw = readRawState<Record<string, unknown>>(resolveMcpDisconnectStatePath())
    if (!raw.ok) {
      if (raw.kind === 'missing') return { status: 'missing' }
      // RULE 1 — no write below this line on this branch.
      return { status: raw.kind, detail: raw.detail }
    }
    const repoEntriesRaw = raw.state[repoKey]
    if (repoEntriesRaw === undefined || repoEntriesRaw === null) return { status: 'missing' }
    if (typeof repoEntriesRaw !== 'object' || Array.isArray(repoEntriesRaw)) {
      // RULE 1 — no write below this line on this branch.
      return { status: 'malformed', detail: `entry for repo key ${repoKey} is not an object` }
    }
    const candidate = (repoEntriesRaw as Record<string, unknown>)[server]
    if (candidate === undefined || candidate === null) return { status: 'missing' }
    const err = validateMcpDisconnectEntry(candidate)
    if (err) return { status: 'malformed', detail: err } // RULE 1 — no write below this line.
    const entry = candidate as McpDisconnectEntry
    if (entry.sinceAckCount <= 0) return { status: 'missing' }

    // The ONLY write in this function — every branch above returns before
    // reaching it (RULE 1).
    const snapshot: McpDisconnectEntry = { ...entry }
    const updatedRepoEntries: Record<string, unknown> = {
      ...(repoEntriesRaw as Record<string, unknown>),
      [server]: { ...entry, sinceAckCount: 0 },
    }
    const updatedState: Record<string, unknown> = { ...raw.state, [repoKey]: updatedRepoEntries }
    // Cast justified by the field-by-field validation immediately above —
    // `updatedState` is `raw.state` with exactly one already-validated
    // entry replaced, so it is a genuine `McpDisconnectState` at this point.
    writeState(updatedState as McpDisconnectState)
    return { status: 'ok', entry: snapshot }
  })
  if (!outcome.acquired) {
    // RULE 2 — reported as its own status below, never as `missing`.
    logSkippedWrite(`lock timeout reading/acking ${repoKey}/${server} (result reader)`)
    return { status: 'lock-timeout' }
  }
  return outcome.result
}

function displayPath(p: string): string {
  const home = homedir()
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p
}

/**
 * The result-shaped sibling of `renderDisconnectBanner`, matching
 * `renderReindexBanner`'s segment convention: `**[mcp-disconnect]** <state
 * text> — <next action> — log: … — disable: …`. Silent ONLY on `missing` —
 * that genuinely means "nothing to report," and a fresh checkout that has
 * never seen a disconnect should stay quiet. `ok` delegates to
 * `renderDisconnectBanner` so the entry wording lives in exactly one place.
 *
 * `malformed`/`unreadable` both point at the state path to inspect, since
 * either is itself a symptom worth surfacing rather than silently
 * recovering from. `lock-timeout` is worded DIFFERENTLY on purpose (RULE
 * 2): nothing is broken — another process simply held the lock — so its
 * next action is "retry," never a repair instruction; wording it like a
 * fault would send a developer chasing a problem that doesn't exist.
 */
export function renderDisconnectBannerResult(
  server: McpServerName,
  result: McpDisconnectReadResult,
  now: Date = new Date()
): string {
  if (result.status === 'missing') return ''
  if (result.status === 'ok') return renderDisconnectBanner(server, result.entry)

  const disable = `disable: ${MCP_DISCONNECT_DISABLE_VAR}=1`
  const log = `log: ${displayPath(resolveMcpDisconnectLogPath(now))}`

  if (result.status === 'malformed') {
    return (
      `**[mcp-disconnect]** \`${server}\` disconnect state could not be parsed ` +
      `(${result.detail}) — next: inspect ${displayPath(resolveMcpDisconnectStatePath())} — ${log} — ${disable}`
    )
  }
  if (result.status === 'unreadable') {
    return (
      `**[mcp-disconnect]** \`${server}\` disconnect state could not be read ` +
      `(${result.detail}) — next: inspect ${displayPath(resolveMcpDisconnectStatePath())} — ${log} — ${disable}`
    )
  }
  // result.status === 'lock-timeout' — RULE 2: nothing is broken, so the
  // next action is retry, never a repair instruction.
  return (
    `**[mcp-disconnect]** \`${server}\` disconnect state could not be read — ` +
    `another process held the lock — next: retry — ${log} — ${disable}`
  )
}
