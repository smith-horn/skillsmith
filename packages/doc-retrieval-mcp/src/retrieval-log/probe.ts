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

import { existsSync } from 'node:fs'

import { readRawState } from './state-read.js'
import type { RetrievalLogOutageMarker } from './schema.js'

/**
 * Exported (SMI-6995) so `probe.test.ts` can pin the TTL boundary against
 * the same constant `readOutageMarker` uses, instead of a second hardcoded
 * "8 days" that would silently drift from this one.
 */
export const OUTAGE_MARKER_TTL_DAYS = 7

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
    // SMI-6995 pre-merge gate: the marker file is PRESENT and cannot be
    // read. Distinct from `outage_marker_present` (a readable marker, whose
    // own contents say what broke) and emphatically distinct from `healthy`,
    // which is what this used to report.
    | 'outage_marker_malformed'
    | 'outage_marker_unreadable'
    | 'IS_DOCKER_set_on_host'
    | 'binding_unavailable_no_marker'
    | 'no_recent_rows'
    | 'low_capture_rate'
    | 'probe_disabled'
  /** ISO-8601 of the most recent `primed` row, or null if none / unknown. */
  lastRealSessionTs: string | null
  /**
   * Echoed back to the banner for context. KEPT with its pre-SMI-6995
   * meaning and type UNCHANGED (`null` on every status except `present`) so
   * the renderer's existing `probe.outageMarker?.ts ?? 'absent'` read keeps
   * working untouched — this fix is additive, not a breaking rewrite of
   * that call site. But this field alone cannot say WHY it is `null`: that
   * was always true for "never written" and "expired," and — before this
   * fix — was *also* true for "present but corrupt," which is the exact
   * defect SMI-6995 removes. See {@link outageMarkerRead} for the field
   * that can tell those apart.
   */
  outageMarker: RetrievalLogOutageMarker | null
  /**
   * SMI-6995 — the outage marker's full five-way classification (`absent` /
   * `expired` / `malformed` / `unreadable` / `present`), additive alongside
   * {@link outageMarker} rather than replacing it. A renderer that wants to
   * tell "no marker was ever written" apart from "a marker is there and
   * unreadable" — the whole point of this fix — must read THIS field, not
   * {@link outageMarker}'s nullability, which collapses three of the five
   * statuses into the same `null`.
   *
   * Carried through on EVERY return path of {@link assessInstrumentationHealth}
   * regardless of which `reason` ultimately wins, because the marker's own
   * corruption is informative on its own. A `malformed` or `unreadable`
   * marker decides the probe's outcome by itself: `stale: true` with
   * reason `outage_marker_malformed` / `outage_marker_unreadable`, even
   * when the DB is otherwise healthy.
   *
   * On the `probe_disabled` short-circuit this is hardcoded to
   * `{ status: 'absent' }` — that branch does ZERO filesystem reads by
   * design (matching its existing "benign no-op" contract), so it has not
   * actually looked at the marker file; `absent` is the closest honest
   * placeholder for "nothing to report," not a claim that the file doesn't
   * exist.
   *
   * `expired` is deliberately NOT surfaced by this function's own
   * `stale`/`reason` computation (see {@link readOutageMarker}'s doc
   * comment for why treating it like `absent` there is correct, not a
   * gap) — only `malformed`/`unreadable` are the NEW statuses a renderer
   * should act on.
   */
  outageMarkerRead: OutageMarkerClassification
  /** Echoed back so the banner can show "set" vs "unset". */
  isDockerOnHost: boolean
}

/**
 * SMI-6995 — the outage marker's five-way classification, replacing the
 * pre-fix THREE-way collapse. The defect this type removes: the pre-fix
 * `readOutageMarker` returned `null` for THREE different, un-distinguishable
 * situations — "never written"
 * (now `absent`), "written but past its self-clearing TTL" (now `expired`),
 * and "present but unusable" (now split into `malformed`/`unreadable`, by
 * WHICH way it's unusable). That `null` then rendered in
 * `renderInstrumentationBanner` as `Outage marker: absent` — true for the
 * first two, FALSE for the last two. Absence is the HEALTHY state for this
 * one module (unlike the other four SMI-6995 readers, where silence IS the
 * safe default) — a corrupt-but-present marker is the one case in this
 * sweep where the old behaviour wasn't just uninformative, it asserted the
 * opposite of the truth, at the exact moment (`probe.stale` already true)
 * a developer is reading the banner to find out what's broken.
 *
 * - `absent` — no marker file exists. The common, healthy case.
 * - `expired` — parsed and validated fine, but older than
 *   {@link OUTAGE_MARKER_TTL_DAYS}. Carries the marker anyway (a caller
 *   doing its own logging/auditing may still want to know what it said)
 *   even though {@link assessInstrumentationHealth} treats this exactly
 *   like `absent` for `stale`/`reason` purposes — see that function.
 * - `malformed` — present but either the bytes don't parse as JSON, the
 *   parsed value isn't a JSON object, it's missing a required field
 *   (`ts`/`reason`/`error`/`hint` must all be strings), or `ts` doesn't
 *   parse as a date. All four collapse to this ONE status deliberately: a
 *   banner treats "can't make sense of these bytes" as one fact regardless
 *   of which check rejected them; `detail` says which.
 * - `unreadable` — present but could not even be READ (permissions, a
 *   directory standing where the file is expected, or any other non-ENOENT
 *   errno — see `readRawState` in `state-read.ts`).
 * - `present` — a live (within-TTL), structurally valid outage marker.
 */
export type OutageMarkerClassification =
  | { status: 'absent' }
  | { status: 'expired'; marker: RetrievalLogOutageMarker }
  | { status: 'malformed'; detail: string }
  | { status: 'unreadable'; detail: string }
  | { status: 'present'; marker: RetrievalLogOutageMarker }

/**
 * Classifies the outage marker file — see {@link OutageMarkerClassification}
 * for the five statuses and why collapsing any pair of them was wrong.
 *
 * Delegates the file-level read to the shared `readRawState` (state-read.ts,
 * SMI-6995 Wave 1) so `malformed` vs `unreadable` is classified the SAME
 * way every other SMI-6995 reader classifies it, instead of this module
 * carrying its own copy of that `try { readFileSync + JSON.parse } catch`
 * block. This marker file is NOT a keyed-by-repo-path state object like the
 * other five readers' files — `writeOutageMarker` (writer.ts) writes the
 * marker directly as the file's whole JSON body — so `readEntryResult`'s
 * key-based consumer API does not apply here; the file-level `readRawState`
 * is the right layer to share instead.
 *
 * Never throws — every branch returns a classification instead of raising,
 * matching this function's ORIGINAL goal ("treat as absent rather than
 * crashing the hook," the comment this replaces). What changes is that
 * "treat as absent" is no longer what happens on the malformed/unreadable
 * branches: they now say what they are instead of asserting health.
 *
 * Exported (SMI-6995) so `probe.test.ts` can pin each of the five statuses
 * directly, without the assertion also depending on `assessInstrumentationHealth`'s
 * unrelated IS_DOCKER/SQLite branches.
 */
export function readOutageMarker(path: string, now: Date): OutageMarkerClassification {
  const raw = readRawState<Record<string, unknown>>(path)
  if (!raw.ok) {
    if (raw.kind === 'missing') return { status: 'absent' }
    // `raw.kind` is narrowed to 'malformed' | 'unreadable' here, matching
    // this type's own two detail-bearing statuses exactly.
    return { status: raw.kind, detail: raw.detail }
  }

  const parsed = raw.state
  if (
    typeof parsed.ts !== 'string' ||
    typeof parsed.reason !== 'string' ||
    typeof parsed.error !== 'string' ||
    typeof parsed.hint !== 'string'
  ) {
    return {
      status: 'malformed',
      detail:
        'outage marker is missing a required field (ts/reason/error/hint must all be strings)',
    }
  }
  const marker = parsed as unknown as RetrievalLogOutageMarker

  const markerMs = Date.parse(marker.ts)
  if (!Number.isFinite(markerMs)) {
    return {
      status: 'malformed',
      detail: `outage marker's ts does not parse as a date: ${JSON.stringify(marker.ts)}`,
    }
  }

  // Self-clearing TTL — a stale 7d marker stops triggering banners even if
  // the next write never happens. The writer's own clearOutageMarker()
  // handles the happy path; this guards the "binding broken forever" case.
  // MUST stay silent in `assessInstrumentationHealth`'s own `stale`/`reason`
  // computation (SMI-6995) — that would reintroduce exactly the failure
  // this TTL was added to remove.
  const ageDays = (now.getTime() - markerMs) / (1000 * 60 * 60 * 24)
  if (ageDays > OUTAGE_MARKER_TTL_DAYS) {
    return { status: 'expired', marker }
  }

  return { status: 'present', marker }
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
      // This short-circuit does ZERO filesystem reads (its existing "benign
      // no-op" contract) — it has not looked at the marker file at all, so
      // `absent` is the closest honest placeholder for "nothing to
      // report," not a claim that the file doesn't exist. See this field's
      // own doc comment on `ProbeResult`.
      outageMarkerRead: { status: 'absent' },
      isDockerOnHost: false,
    }
  }

  const dockerOnHost = isDockerSetOnHost()
  const markerRead = readOutageMarker(input.outageMarkerPath, input.now)
  // `expired` is deliberately treated the same as `absent`, matching the
  // PRE-fix behaviour exactly (both used to collapse to the same `null`) —
  // the TTL exists precisely so an old marker stops tripping this branch
  // even if the next write never happens.
  //
  // `malformed` and `unreadable` do NOT fall through. An earlier revision of
  // SMI-6995 let them, on the reasoning that they "newly surface" via the
  // `outageMarkerRead` field instead. The pre-merge gate found that reasoning
  // false: the only consumer of that field is `renderInstrumentationBanner`,
  // which the caller invokes solely when `stale` is true. Measured against a
  // healthy baseline (no DB file, zero JSONL sessions), a corrupt marker
  // returned `stale: false, reason: 'healthy'` and rendered nothing — a
  // positive health claim about a damaged record, which is the same defect
  // one level up from the one SMI-6995 exists to fix.
  //
  // So they get their own reasons below, and `present` is checked first
  // because a readable marker is the more specific signal.
  const marker = markerRead.status === 'present' ? markerRead.marker : null

  if (marker) {
    return {
      stale: true,
      reason: 'outage_marker_present',
      lastRealSessionTs: null,
      outageMarker: marker,
      outageMarkerRead: markerRead,
      isDockerOnHost: dockerOnHost,
    }
  }

  if (markerRead.status === 'malformed' || markerRead.status === 'unreadable') {
    return {
      stale: true,
      reason:
        markerRead.status === 'malformed' ? 'outage_marker_malformed' : 'outage_marker_unreadable',
      lastRealSessionTs: null,
      // `outageMarker` keeps its pre-SMI-6995 contract: non-null only for a
      // readable `present` marker. The fault detail travels on
      // `outageMarkerRead`, which the banner reads.
      outageMarker: null,
      outageMarkerRead: markerRead,
      isDockerOnHost: dockerOnHost,
    }
  }

  if (dockerOnHost) {
    return {
      stale: true,
      reason: 'IS_DOCKER_set_on_host',
      lastRealSessionTs: null,
      outageMarker: null,
      outageMarkerRead: markerRead,
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
      outageMarkerRead: markerRead,
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
      outageMarkerRead: markerRead,
      isDockerOnHost: false,
    }
  }
  if (sessionCount > 0 && row.count < 0.5 * sessionCount) {
    return {
      stale: true,
      reason: 'low_capture_rate',
      lastRealSessionTs: row.lastTs,
      outageMarker: null,
      outageMarkerRead: markerRead,
      isDockerOnHost: false,
    }
  }

  return {
    stale: false,
    reason: 'healthy',
    lastRealSessionTs: row.lastTs,
    outageMarker: null,
    outageMarkerRead: markerRead,
    isDockerOnHost: false,
  }
}
