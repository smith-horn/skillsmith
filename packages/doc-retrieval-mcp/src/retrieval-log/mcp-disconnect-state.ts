/**
 * SMI-5941 — MCP live-disconnect detection: shared state + lock + banner module.
 *
 * Single source of truth for the `PostToolUseFailure` guard's persisted state
 * and the SessionStart banner it feeds, mirroring the liveness/autoheal/reindex
 * sibling modules' shape (SMI-5419 cross-language-parity lesson) — imported two
 * ways:
 *   - `scripts/mcp-disconnect-state.ts` (a thin tsx CLI) for the bash
 *     `scripts/session-mcp-disconnect-guard.sh` hook; and
 *   - a direct import by `scripts/session-priming-query.ts` for the
 *     SessionStart banner surface.
 *
 * State file: `~/.skillsmith/mcp-disconnect.state` — ONE shared file (not one
 * per repo — see plan-review pass 3 finding #4), keyed first by
 * `resolveMainRepoKey()` and then by MCP server name, so multiple repos/clones
 * and multiple servers all live in one JSON document. Writes are atomic
 * (temp + rename) and reads are fail-soft (a corrupt/missing file reads as {}).
 *
 * Concurrency: guarded by {@link withLock}, a single global mkdir-based lock
 * over the whole file (not per-repo — the physical resource is the one file).
 * This is new to the codebase — none of the three sibling state modules need
 * real concurrent-writer protection (each is a single fire-and-forget cron/hook
 * write); this module's producer (any live session's `PostToolUseFailure` hook)
 * and consumer (the next `SessionStart`) can genuinely race. See plan-review
 * passes 2 and 3 (docs/internal/implementation/smi-5941-mcp-live-disconnect-detection.md)
 * for why a naive read-modify-write and a naive age-only stale-lock reclaim
 * both failed before this design.
 *
 * Spec: docs/internal/implementation/smi-5941-mcp-live-disconnect-detection.md.
 */

import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Re-export the shared main-repo key resolver — callers import from here, not autoheal-state. */
export { resolveMainRepoKey } from './autoheal-state.js'

/** Kill-switch: set to 1 to disable the guard entirely (no state write, no systemMessage). */
export const MCP_DISCONNECT_DISABLE_VAR = 'SKILLSMITH_MCP_DISCONNECT_DISABLE'

/**
 * Shadow mode: when set, the guard still writes state and logs but suppresses
 * `systemMessage` and the SessionStart banner. Defaults OFF (unlike
 * SKILLSMITH_RETRIEVAL_LIVENESS_SHADOW's default-on-until-soak) — this guard
 * never opens a GitHub issue or pages anyone, so the blast radius of shipping
 * without a soak period is a possible false-positive local warning, not
 * external noise. Re-justified per plan-review, not inherited by default.
 */
export const MCP_DISCONNECT_SHADOW_VAR = 'SKILLSMITH_MCP_DISCONNECT_SHADOW'

export type McpServerName = 'skillsmith' | 'skillsmith-doc-retrieval'

/**
 * Resolve a `tool_name` (e.g. `mcp__skillsmith__search`,
 * `mcp__skillsmith-doc-retrieval__skill_docs_search`) to the server it belongs
 * to. The two prefixes are unambiguous by construction: the doc-retrieval
 * server's name inserts `-doc-retrieval` before the double-underscore
 * delimiter, so `mcp__skillsmith-doc-retrieval__x` never matches a
 * `mcp__skillsmith__` prefix check (the character right after `skillsmith` is
 * `-` there, not `_`). Checked most-specific-first anyway, for clarity over
 * cleverness. Returns null for anything else — the hook's matcher already
 * scopes to `mcp__skillsmith`, so this should not happen in practice, but a
 * guard script must fail soft rather than assume.
 */
export function resolveServerName(toolName: string): McpServerName | null {
  if (toolName.startsWith('mcp__skillsmith-doc-retrieval__')) return 'skillsmith-doc-retrieval'
  if (toolName.startsWith('mcp__skillsmith__')) return 'skillsmith'
  return null
}

export interface McpDisconnectEntry {
  /** Lifetime count of recorded disconnects for this server in this repo. */
  totalCount: number
  /** Count since the last SessionStart banner acknowledged them. */
  sinceAckCount: number
  lastTimestamp: string | null
  lastTool: string | null
  lastErrorExcerpt: string | null
  /** Cheap `docker ps` sample taken at record time — diagnostic only. */
  containerStatus: 'healthy' | 'unhealthy-or-starting' | 'down' | 'unknown' | null
}

/** `Record<repoKey, Record<serverName, entry>>` — one shared file, two levels of keying. */
export type McpDisconnectState = Record<string, Partial<Record<McpServerName, McpDisconnectEntry>>>

function defaultEntry(): McpDisconnectEntry {
  return {
    totalCount: 0,
    sinceAckCount: 0,
    lastTimestamp: null,
    lastTool: null,
    lastErrorExcerpt: null,
    containerStatus: null,
  }
}

export function resolveMcpDisconnectStateDir(): string {
  // SKILLSMITH_MCP_DISCONNECT_HOME isolates state/logs/lock under a test temp
  // dir so the suite never touches the real ~/.skillsmith. Unset in production.
  const base = process.env.SKILLSMITH_MCP_DISCONNECT_HOME ?? homedir()
  return join(base, '.skillsmith')
}

export function resolveMcpDisconnectStatePath(): string {
  return join(resolveMcpDisconnectStateDir(), 'mcp-disconnect.state')
}

function resolveLockDirPath(): string {
  return `${resolveMcpDisconnectStatePath()}.lock`
}

export function resolveMcpDisconnectLogPath(now: Date): string {
  return join(resolveMcpDisconnectStateDir(), 'logs', `mcp-disconnect-${ymdLocal(now)}.log`)
}

// ── Lock: mkdir-based, PID-liveness-verified reclaim ────────────────────────
//
// A holder writes its own PID into an `owner` file inside the lock dir right
// after acquiring it. Reclaim requires BOTH the lock being older than
// STALE_MS AND the recorded owner PID being independently confirmed dead
// (process.kill(pid, 0) throws ESRCH for a truly-dead PID; a live PID either
// succeeds or throws EPERM, either of which means "still alive, do not
// reclaim"). Age alone is not sufficient — see the module doc comment for why
// that was unsafe (a caller could still be alive and legitimately working
// past the age threshold if anything inside its critical section were
// unbounded, e.g. an unbounded `docker ps` call — this module's own container
// probe below is deliberately timeout-bounded so that can't happen here).

// Read per-call (not cached at module load) so tests can shrink these via env
// vars instead of waiting out the real 10s/5s production defaults.
function lockStaleMs(): number {
  const v = Number(process.env.SKILLSMITH_MCP_DISCONNECT_LOCK_STALE_MS)
  return Number.isFinite(v) && v > 0 ? v : 10_000
}
function lockAcquireTimeoutMs(): number {
  const v = Number(process.env.SKILLSMITH_MCP_DISCONNECT_LOCK_ACQUIRE_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? v : 5_000
}
const LOCK_POLL_MS = 20

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'EPERM') return true // exists, owned by another user
    return false // ESRCH (or any other failure) — treat as dead
  }
}

function tryAcquireOnce(lockDir: string): boolean {
  try {
    mkdirSync(lockDir)
    try {
      writeFileSync(join(lockDir, 'owner'), String(process.pid))
    } catch {
      // Owner-file write failing after a successful mkdir is vanishingly rare
      // and non-fatal — an unreadable owner file just means a future
      // reclaim attempt can't verify liveness and will correctly refuse to
      // reclaim (fail toward "don't steal it") rather than crash here.
    }
    return true
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
    return false
  }
}

function maybeReclaimStaleLock(lockDir: string): void {
  let ageMs: number
  try {
    ageMs = Date.now() - statSync(lockDir).mtimeMs
  } catch {
    return // lock vanished between our failed mkdir and this stat — fine, next loop retries mkdir
  }
  if (ageMs <= lockStaleMs()) return

  let ownerPid: number | null = null
  try {
    ownerPid = Number(readFileSync(join(lockDir, 'owner'), 'utf8').trim())
  } catch {
    // Owner file missing/unreadable — cannot verify liveness. Per the
    // fail-toward-safety rule above, do NOT reclaim; just retry later.
    return
  }
  if (!Number.isFinite(ownerPid) || isProcessAlive(ownerPid)) return // still alive (or unparseable) — never reclaim

  try {
    rmSync(lockDir, { recursive: true, force: true })
  } catch {
    // Another caller may have reclaimed it first — fine, next loop retries mkdir.
  }
}

function acquireLock(): boolean {
  const lockDir = resolveLockDirPath()
  mkdirSync(dirname(lockDir), { recursive: true })
  const deadline = Date.now() + lockAcquireTimeoutMs()
  for (;;) {
    if (tryAcquireOnce(lockDir)) return true
    maybeReclaimStaleLock(lockDir)
    if (Date.now() >= deadline) return false
    sleepSyncMs(LOCK_POLL_MS)
  }
}

function releaseLock(): void {
  try {
    rmSync(resolveLockDirPath(), { recursive: true, force: true })
  } catch {
    // best-effort
  }
}

/**
 * Run `fn` with the global mcp-disconnect state lock held. Returns
 * `{ acquired: true, result }` on success, or `{ acquired: false }` if the
 * lock could not be acquired within {@link lockAcquireTimeoutMs}'s budget —
 * the caller must treat this as fail-soft (skip the durable write; the
 * `systemMessage` a producer returns does not depend on this succeeding).
 */
export function withLock<T>(fn: () => T): { acquired: true; result: T } | { acquired: false } {
  if (!acquireLock()) return { acquired: false }
  try {
    return { acquired: true, result: fn() }
  } finally {
    releaseLock()
  }
}

// ── State read/write (call only while holding the lock, except readState for diagnostics) ──

/** Fail-soft read of the whole state object. A missing/corrupt file reads as {}. */
export function readState(path: string = resolveMcpDisconnectStatePath()): McpDisconnectState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as McpDisconnectState
    }
    return {}
  } catch {
    return {}
  }
}

function writeState(
  state: McpDisconnectState,
  path: string = resolveMcpDisconnectStatePath()
): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, path)
}

function logSkippedWrite(reason: string, now: Date = new Date()): void {
  try {
    const logPath = resolveMcpDisconnectLogPath(now)
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, `${now.toISOString()} [mcp-disconnect] skipped write: ${reason}\n`)
  } catch {
    // logging must never throw
  }
}

/** Cheap, timeout-bounded container health sample — diagnostic only, never blocks indefinitely. */
export function probeContainerStatus(): McpDisconnectEntry['containerStatus'] {
  try {
    const out = execFileSync(
      'docker',
      ['ps', '--filter', 'name=skillsmith-dev-1', '--format', '{{.Status}}'],
      { encoding: 'utf8', timeout: 2_000 }
    ).trim()
    if (!out) return 'down'
    return out.startsWith('Up') && out.includes('healthy') ? 'healthy' : 'unhealthy-or-starting'
  } catch {
    return 'unknown'
  }
}

export interface DisconnectEvent {
  tool: string
  errorExcerpt: string
  timestamp: string
}

/**
 * Producer path: record a disconnect for `server` in `repoKey`'s entry.
 * Returns whether the write was actually persisted (false only when the lock
 * could not be acquired in time — see {@link withLock}). The caller's
 * `systemMessage` must fire regardless of this return value.
 */
export function recordDisconnect(
  repoKey: string,
  server: McpServerName,
  event: DisconnectEvent
): boolean {
  const outcome = withLock(() => {
    const state = readState()
    const repoEntries = state[repoKey] ?? {}
    const prior = repoEntries[server] ?? defaultEntry()
    repoEntries[server] = {
      totalCount: prior.totalCount + 1,
      sinceAckCount: prior.sinceAckCount + 1,
      lastTimestamp: event.timestamp,
      lastTool: event.tool,
      lastErrorExcerpt: event.errorExcerpt,
      containerStatus: probeContainerStatus(),
    }
    state[repoKey] = repoEntries
    writeState(state)
  })
  if (!outcome.acquired) {
    logSkippedWrite(`lock timeout recording disconnect for ${repoKey}/${server}`)
    return false
  }
  return true
}

/**
 * Consumer path (SessionStart): if `server`'s entry in `repoKey` has
 * unacknowledged disconnects, capture a snapshot, reset `sinceAckCount` to 0,
 * and return the snapshot for banner rendering. Returns null if there's
 * nothing to report, or if the lock could not be acquired (fail-soft — the
 * banner simply doesn't render this session; the next session tries again
 * with the same unacknowledged count, so nothing is lost, just delayed).
 */
export function readAndAck(repoKey: string, server: McpServerName): McpDisconnectEntry | null {
  const outcome = withLock(() => {
    const state = readState()
    const entry = state[repoKey]?.[server]
    if (!entry || entry.sinceAckCount <= 0) return null
    const snapshot: McpDisconnectEntry = { ...entry }
    state[repoKey] = { ...state[repoKey], [server]: { ...entry, sinceAckCount: 0 } }
    writeState(state)
    return snapshot
  })
  if (!outcome.acquired) {
    logSkippedWrite(`lock timeout reading/acking ${repoKey}/${server}`)
    return null
  }
  return outcome.result
}

/**
 * SessionStart banner text, or '' if there's nothing to report. Mirrors the
 * sibling modules' bold-markdown banner convention (not a GitHub [!WARNING]
 * callout — those render as literal text inside additionalContext).
 */
export function renderDisconnectBanner(server: McpServerName, entry: McpDisconnectEntry): string {
  const count = entry.sinceAckCount > 0 ? entry.sinceAckCount : entry.totalCount
  const status = entry.containerStatus ?? 'unknown'
  const disable = `disable: ${MCP_DISCONNECT_DISABLE_VAR}=1`
  return (
    `**[mcp-disconnect]** \`${server}\` MCP has ${count} unacknowledged disconnect(s) ` +
    `(most recent: container was ${status}). If tools still seem missing, run ` +
    `\`/mcp\` → \`${server}\` → Reconnect. — ${disable}`
  )
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function sleepSyncMs(ms: number): void {
  // Deliberately synchronous — both call sites (the guard's CLI process and
  // the SessionStart consumer) are short-lived one-shot scripts, not a
  // long-running server where blocking the event loop would matter.
  const sab = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(sab, 0, 0, ms)
}

function ymdLocal(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
