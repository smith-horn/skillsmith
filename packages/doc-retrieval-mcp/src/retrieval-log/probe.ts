/**
 * SMI-4549 Wave 2 — instrumentation health probe.
 *
 * Returns a structured stale verdict for the SessionStart priming hook to
 * surface as a banner in `additionalContext`. The hook caller is expected to
 * abort silently and log a `partial_failure` row if the writer is itself
 * broken — this probe's job is to TELL the user something is wrong so the
 * 7-day soak failure mode (zero captured rows for a week) cannot recur.
 *
 * Contract — plan-review C1:
 *   This module MUST NOT statically `import 'better-sqlite3'`. The native
 *   binding fails to load on the exact host shape this probe is meant to
 *   detect; a top-level import would crash the priming hook before it could
 *   surface a banner. The SQLite read path uses `await import(...)` inside
 *   a try/catch instead.
 *
 * Read order (each independent so a failure in one doesn't mask the rest):
 *   1. Outage marker file (no SQLite dependency).
 *   2. IS_DOCKER set on host (env trap from SMI-4549 Wave 1 retro).
 *   3. SQLite row count vs. recent JSONL session count (capture-rate gate).
 *   4. Healthy.
 */

import { existsSync, readFileSync } from 'node:fs'

import type { RetrievalLogOutageMarker } from './schema.js'

const OUTAGE_MARKER_TTL_DAYS = 7

export interface ProbeInput {
  outageMarkerPath: string
  dbPath: string
  now: Date
  /** Defaults to 24. Tunable via `SKILLSMITH_RETRIEVAL_PROBE_STALE_HOURS`. */
  staleHours: number
  /**
   * Number of `~/.claude/projects/<encoded>/sessions/*.jsonl` files modified
   * in the last `staleHours`. Computed by the caller to keep this probe
   * filesystem-agnostic and unit-testable.
   */
  jsonlSessionCount24h: number
}

export interface ProbeResult {
  stale: boolean
  /**
   * Machine-readable reason. Stable identifiers are part of the contract —
   * the probe banner formatter and downstream alerting may dispatch on these.
   */
  reason:
    | 'healthy'
    | 'outage_marker_present'
    | 'IS_DOCKER_set_on_host'
    | 'binding_unavailable_no_marker'
    | 'no_recent_rows'
    | 'low_capture_rate'
    | 'probe_disabled'
  /** ISO-8601 of the most recent `primed` row, or null if none / unknown. */
  lastRealSessionTs: string | null
  /** Echoed back to the banner for context. */
  outageMarker: RetrievalLogOutageMarker | null
  /** Echoed back so the banner can show "set" vs "unset". */
  isDockerOnHost: boolean
}

function readOutageMarker(path: string, now: Date): RetrievalLogOutageMarker | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as RetrievalLogOutageMarker
    if (
      typeof parsed?.ts !== 'string' ||
      typeof parsed?.reason !== 'string' ||
      typeof parsed?.error !== 'string' ||
      typeof parsed?.hint !== 'string'
    ) {
      return null
    }
    // Self-clearing TTL — a stale 7d marker stops triggering banners even if
    // the next write never happens. The writer's own clearOutageMarker()
    // handles the happy path; this guards the "binding broken forever" case.
    const markerMs = Date.parse(parsed.ts)
    if (!Number.isFinite(markerMs)) return null
    const ageDays = (now.getTime() - markerMs) / (1000 * 60 * 60 * 24)
    if (ageDays > OUTAGE_MARKER_TTL_DAYS) return null
    return parsed
  } catch {
    // malformed JSON — treat as absent rather than crashing the hook
    return null
  }
}

function isDockerSetOnHost(): boolean {
  return process.env.IS_DOCKER === 'true' && !existsSync('/.dockerenv')
}

interface RowCount {
  count: number
  lastTs: string | null
  /** True iff better-sqlite3 loaded AND the read succeeded. */
  ok: boolean
}

/**
 * Best-effort row count of `retrieval_events` rows where trigger=session_start_priming
 * AND hook_outcome='primed' AND ts within the last `staleHours`.
 *
 * Returns `{ ok: false }` if better-sqlite3 cannot be loaded or the DB cannot
 * be opened. The caller treats `ok=false` as "binding unavailable" and falls
 * through to the `binding_unavailable_no_marker` verdict.
 */
async function readRecentRowCount(
  dbPath: string,
  now: Date,
  staleHours: number
): Promise<RowCount> {
  if (!existsSync(dbPath)) return { count: 0, lastTs: null, ok: true }

  let Database: unknown
  try {
    // Dynamic import — keeps the native binding off the module-load path so
    // a missing binding can't crash the SessionStart hook before the probe
    // runs (plan-review C1).
    const mod = (await import('better-sqlite3')) as {
      default?: unknown
    } & Record<string, unknown>
    Database = mod.default ?? mod
  } catch {
    return { count: 0, lastTs: null, ok: false }
  }

  try {
    type DbCtor = new (
      path: string,
      opts?: { readonly?: boolean }
    ) => {
      prepare: (sql: string) => {
        get: (...args: unknown[]) => unknown
      }
      close: () => void
    }
    const Ctor = Database as DbCtor
    const db = new Ctor(dbPath, { readonly: true })
    try {
      const cutoffMs = now.getTime() - staleHours * 60 * 60 * 1000
      const cutoffIso = new Date(cutoffMs).toISOString()
      const row = db
        .prepare(
          `SELECT COUNT(*) AS c, MAX(ts) AS lastTs
             FROM retrieval_events
            WHERE trigger = 'session_start_priming'
              AND hook_outcome = 'primed'
              AND ts >= ?`
        )
        .get(cutoffIso) as { c: number; lastTs: string | null }
      return { count: row.c, lastTs: row.lastTs ?? null, ok: true }
    } finally {
      try {
        db.close()
      } catch {
        // ignore
      }
    }
  } catch {
    return { count: 0, lastTs: null, ok: false }
  }
}

/**
 * SMI-4549 Wave 2 — probe entry point.
 *
 * Returns a verdict; the caller is responsible for rendering the banner and
 * deciding whether the SessionStart hook still emits its priming markdown
 * (it does — a stale instrumentation banner does not block priming itself).
 *
 * Escape hatch: `SKILLSMITH_RETRIEVAL_PROBE_DISABLE=1` short-circuits to a
 * benign healthy result. Default is enabled.
 */
export async function assessInstrumentationHealth(input: ProbeInput): Promise<ProbeResult> {
  if (process.env.SKILLSMITH_RETRIEVAL_PROBE_DISABLE === '1') {
    return {
      stale: false,
      reason: 'probe_disabled',
      lastRealSessionTs: null,
      outageMarker: null,
      isDockerOnHost: false,
    }
  }

  const dockerOnHost = isDockerSetOnHost()
  const marker = readOutageMarker(input.outageMarkerPath, input.now)

  if (marker) {
    return {
      stale: true,
      reason: 'outage_marker_present',
      lastRealSessionTs: null,
      outageMarker: marker,
      isDockerOnHost: dockerOnHost,
    }
  }

  if (dockerOnHost) {
    return {
      stale: true,
      reason: 'IS_DOCKER_set_on_host',
      lastRealSessionTs: null,
      outageMarker: null,
      isDockerOnHost: true,
    }
  }

  const row = await readRecentRowCount(input.dbPath, input.now, input.staleHours)

  // Native binding failed to load AND no marker was present — this is the
  // exact silent-no-op the Wave 2 probe is meant to catch when the writer
  // never even reached its catch branch (e.g. the previous session crashed
  // before openDb ran).
  if (!row.ok) {
    return {
      stale: true,
      reason: 'binding_unavailable_no_marker',
      lastRealSessionTs: null,
      outageMarker: null,
      isDockerOnHost: false,
    }
  }

  // H3: jsonl-session-relative thresholds, NOT absolute counts.
  const sessionCount = input.jsonlSessionCount24h
  if (sessionCount > 5 && row.count === 0) {
    return {
      stale: true,
      reason: 'no_recent_rows',
      lastRealSessionTs: null,
      outageMarker: null,
      isDockerOnHost: false,
    }
  }
  if (sessionCount > 0 && row.count < 0.5 * sessionCount) {
    return {
      stale: true,
      reason: 'low_capture_rate',
      lastRealSessionTs: row.lastTs,
      outageMarker: null,
      isDockerOnHost: false,
    }
  }

  return {
    stale: false,
    reason: 'healthy',
    lastRealSessionTs: row.lastTs,
    outageMarker: null,
    isDockerOnHost: false,
  }
}
