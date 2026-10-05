/**
 * SMI-5793 — doc-retrieval reindex observability: shared state + zero-touch
 * streak accounting + banner module.
 *
 * `.husky/post-commit` fires a fully fire-and-forget incremental reindex on
 * every commit with zero observability — no persisted log, no exit-code
 * check, no failure/staleness detection. This module is the state-consumer
 * half of the fix (the other half is `cli.ts`'s reindex branch persisting
 * every run's outcome via the shared SMI-5615 logger). It mirrors
 * `autoheal-state.ts`/`liveness-state.ts`'s exact shape (the SMI-5419
 * cross-language-parity lesson) so the writer (`cli.ts`, in-process — no
 * bash orchestrator bridge needed here, unlike autoheal/liveness) and the
 * reader (`scripts/session-priming-query.ts`) never drift on the JSON shape
 * or the banner text.
 *
 * State file: `~/.skillsmith/reindex.state` (or
 * `$SKILLSMITH_STATE_DIR_OVERRIDE/reindex.state` inside the container — see
 * `docker-compose.yml`'s `/skillsmith-state` bind mount) — a JSON object
 * keyed by `resolveMainRepoKey()` (re-exported, not re-implemented, from
 * `autoheal-state.ts`). Keying is main-repo-shared, NOT per-worktree: the
 * reindex corpus itself is always main-repo-shared — `.husky/post-commit`
 * always execs into `skillsmith-dev-1` (main's own container), regardless of
 * which checkout's commit triggered the hook — matching why auto-heal/
 * liveness use the same key for the same reason. Writes are atomic
 * (temp + rename) and reads are fail-soft (a corrupt/missing file reads as
 * "no entry").
 *
 * Spec: docs/internal/implementation/doc-retrieval-reindex-observability.md §2.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Re-export the shared main-repo key resolver — callers import from here, not autoheal-state. */
export { resolveMainRepoKey } from './autoheal-state.js'

// SMI-6995: the shared two-axis read `readEntry`/`readState` below cannot
// give (see `readEntry`'s own doc comment for why that is deliberate) — the
// banner consumer path uses this instead. Aliased on import because this
// module exports its own `readEntryResult` wrapper (key/path only — the
// validator is baked in below), matching `ruflo-bridge-state.ts`'s shape.
import {
  readEntryResult as readEntryResultFromSharedReader,
  type StateReadResult,
} from './state-read.js'

/**
 * Silences the session-priming banner only (all three `renderReindexBanner`
 * conditions: failed / anomaly / hung). The structured JSONL log keeps
 * writing regardless — matching the existing "detection-disable is
 * independent of the log itself" precedent for auto-heal/liveness.
 */
export const REINDEX_STALENESS_DISABLE_VAR = 'SKILLSMITH_REINDEX_STALENESS_DISABLE'

/**
 * Consecutive zero-touch runs (while HEAD keeps advancing) before the banner
 * flags a possible SMI-5786-shaped detection gap. A single zero-touch
 * incremental run is normal and common — most commits don't touch
 * `docs/internal`/`.claude/skills`. SMI-5786's actual failure mode was
 * "every run for three months," so 5 consecutive zero-touch runs while real
 * commits keep landing is a wide enough margin to never fire on a quiet-docs
 * day, while still catching a real regression within one active session.
 */
export const ANOMALY_ZERO_TOUCH_THRESHOLD = 5

/**
 * Default hours of silence (despite new commits) before the banner flags a
 * possibly-hung/not-firing reindex. Reindex fires on every commit (unlike
 * the weekly liveness cron), so 48h balances "don't page over a quiet
 * weekend" against "don't let a broken reindex run silently for a week".
 * Configurable via `SKILLSMITH_REINDEX_STALE_HOURS`, same precedent as
 * `SKILLSMITH_RETRIEVAL_LIVENESS_STALE_DAYS`.
 */
export const DEFAULT_HUNG_STALE_HOURS = 48

export interface ReindexEntry {
  /** ISO-8601 timestamp of the last run. */
  lastRunTs: string
  /** git HEAD at the time of the run; null on a detached/shallow edge state. */
  lastRunSha: string | null
  mode: 'full' | 'incremental'
  filesScanned: number
  chunksUpserted: number
  chunksDeleted: number
  durationMs: number
  success: boolean
  /** Truncated to 200 chars; present only when success=false. */
  errorReason?: string
  /**
   * Consecutive zero-touch runs while HEAD kept advancing; resets to 0 on
   * any real file-touch. See {@link recordRun} for the full transition table.
   */
  consecutiveZeroTouchRuns: number
}

/** Keyed by `resolveMainRepoKey()` — main-repo-shared, matching auto-heal/liveness. */
export type ReindexState = Record<string, ReindexEntry>

export function resolveReindexStateDir(): string {
  return process.env.SKILLSMITH_STATE_DIR_OVERRIDE || join(homedir(), '.skillsmith')
}

export function resolveReindexStatePath(): string {
  return join(resolveReindexStateDir(), 'reindex.state')
}

/**
 * Per-day log path (LOCAL date). The JSONL structured log itself is produced
 * by the shared SMI-5615 logger via `getLogDir()` (`rotation.ts`), not this
 * function — this resolves the SAME path independently for banner display
 * purposes only, mirroring `resolveAutohealLogPath`/`resolveLivenessLogPath`
 * exactly.
 */
export function resolveReindexLogPath(now: Date): string {
  return join(resolveReindexStateDir(), 'logs', `skillsmith-doc-retrieval-${ymdLocal(now)}.jsonl`)
}

/** Fail-soft read of the whole state object. A missing/corrupt file reads as {}. */
export function readState(path: string = resolveReindexStatePath()): ReindexState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ReindexState
    }
    return {}
  } catch {
    return {}
  }
}

/**
 * The producer/assertion accessor for a single entry. Deliberately
 * collapses "file never written", "file corrupt", and "file could not be
 * read" into the same `null` — it delegates to `readState`, whose own doc
 * comment names that as fail-soft by design. Kept exactly as-is (SMI-6995):
 * 16 caller files, six of them tests, depend on this exact shape, and nothing
 * about this fix changes what they see. A **banner consumer** — anything
 * that needs to tell "has not run yet" apart from "corrupt" or "unreadable",
 * which is the entire point of SMI-6995 — must use {@link readEntryResult}
 * instead, never this function.
 */
export function readEntry(
  key: string,
  path: string = resolveReindexStatePath()
): ReindexEntry | null {
  return readState(path)[key] ?? null
}

/**
 * Complete field-by-field validator for {@link readEntryResult} — checks
 * every field {@link renderReindexBanner} reads on the `ok` branch, not a
 * `typeof` spot-check. A validator that accepts `{success: "banana"}` would
 * still read as `ok`, and `renderReindexBanner`'s `!entry.success` check
 * would then silently take the wrong branch on a truthy string — the exact
 * collapse SMI-6995 exists to remove, recreated one layer down inside this
 * module's own fix for it. Literal unions (`mode`) are checked by value, not
 * `typeof`; numeric fields are checked with `Number.isFinite`, not `typeof
 * === 'number'` alone, since `NaN`/`Infinity` both pass the latter.
 */
function validateReindexEntry(candidate: unknown): string | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return 'entry is not an object'
  }
  const e = candidate as Record<string, unknown>
  if (typeof e.lastRunTs !== 'string') return 'lastRunTs is not a string'
  if (e.lastRunSha !== null && typeof e.lastRunSha !== 'string') {
    return 'lastRunSha is neither a string nor null'
  }
  if (e.mode !== 'full' && e.mode !== 'incremental') {
    return 'mode is not "full" or "incremental"'
  }
  if (typeof e.filesScanned !== 'number' || !Number.isFinite(e.filesScanned)) {
    return 'filesScanned is not a finite number'
  }
  if (typeof e.chunksUpserted !== 'number' || !Number.isFinite(e.chunksUpserted)) {
    return 'chunksUpserted is not a finite number'
  }
  if (typeof e.chunksDeleted !== 'number' || !Number.isFinite(e.chunksDeleted)) {
    return 'chunksDeleted is not a finite number'
  }
  if (typeof e.durationMs !== 'number' || !Number.isFinite(e.durationMs)) {
    return 'durationMs is not a finite number'
  }
  if (typeof e.success !== 'boolean') return 'success is not a boolean'
  if (e.errorReason !== undefined && typeof e.errorReason !== 'string') {
    return 'errorReason is present but not a string'
  }
  if (
    typeof e.consecutiveZeroTouchRuns !== 'number' ||
    !Number.isFinite(e.consecutiveZeroTouchRuns)
  ) {
    return 'consecutiveZeroTouchRuns is not a finite number'
  }
  return null
}

/**
 * The consumer entry point for the session-priming banner — the two-axis
 * read `readEntry` deliberately does not give (see that function's own doc
 * comment). `missing` covers both "the file itself is absent" and "the file
 * is fine but this key isn't in it" — the same fact to a banner deciding
 * whether to render ("has not run yet"); `malformed`/`unreadable` are always
 * worth a line, which is exactly what {@link renderReindexBanner} does with
 * this result.
 */
export function readEntryResult(
  key: string,
  path: string = resolveReindexStatePath()
): StateReadResult<ReindexEntry> {
  return readEntryResultFromSharedReader<ReindexEntry>(key, path, validateReindexEntry)
}

/** Atomic (temp + rename) write of a single entry, preserving other keys. */
export function writeEntry(
  key: string,
  entry: ReindexEntry,
  path: string = resolveReindexStatePath()
): void {
  const state = readState(path)
  state[key] = entry
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, path)
}

/**
 * Folds a reindex run into the prior entry's zero-touch streak:
 *  - a real file-touch (`filesScanned`/`chunksUpserted`/`chunksDeleted` > 0)
 *    OR a failed run resets the streak to 0;
 *  - a zero-touch run where HEAD genuinely advanced (a prior sha was
 *    recorded and it differs from this run's) increments the streak;
 *  - a zero-touch run against an unchanged sha (no prior entry yet, or a
 *    repeat run against the same commit with nothing new to scan) holds the
 *    streak steady — neither counted as a fresh quiet commit nor treated as
 *    a real touch, so a manual re-run can't silently clear (or inflate) a
 *    real streak.
 */
export function recordRun(
  prior: ReindexEntry | null,
  run: Omit<ReindexEntry, 'consecutiveZeroTouchRuns'>
): ReindexEntry {
  const shaAdvanced = prior?.lastRunSha != null && prior.lastRunSha !== run.lastRunSha
  const zeroTouch =
    run.success && run.filesScanned === 0 && run.chunksUpserted === 0 && run.chunksDeleted === 0
  const consecutiveZeroTouchRuns =
    zeroTouch && shaAdvanced
      ? (prior?.consecutiveZeroTouchRuns ?? 0) + 1
      : zeroTouch
        ? (prior?.consecutiveZeroTouchRuns ?? 0)
        : 0
  return { ...run, consecutiveZeroTouchRuns }
}

/**
 * The non-silent banner for the session-priming surface. Every variant names
 * the disable var, points at a concrete log path, AND gives a concrete next
 * action — matching `renderAutohealBanner`/`renderLivenessBanner`'s
 * convention.
 *
 * SMI-6995: takes the two-axis {@link StateReadResult} from
 * {@link readEntryResult} instead of a bare `ReindexEntry | null`. Before
 * this delta, `readState`'s single try/catch meant a `malformed` or
 * `unreadable` state file read as the exact same `null` as "no reindex has
 * ever run" — this function's own `if (!entry) return ''` then rendered
 * nothing for either, which is precisely the blindness this banner exists to
 * remove (a corrupt state file is usually itself a symptom worth surfacing).
 * Stays silent ONLY on `missing` — that genuinely means "nothing to report
 * yet," and rendering on every fresh checkout before the first reindex has
 * run would be noise, not signal. Unlike `ruflo-bridge-state.ts`'s banner
 * (SMI-6985 removed its `missing` grace window entirely), this one keeps
 * silence on `missing` — the two modules' writers differ: the bridge probes
 * post-merge regardless, so "never probed" is itself informative, while a
 * fresh reindex checkout legitimately has no entry yet and SHOULD be quiet.
 * `malformed`/`unreadable` are NEVER silent, matching the bridge exactly.
 * The existing failure/anomaly/hung checks on the `ok` entry are unchanged
 * in spirit — only the shape of what feeds them moved.
 */
export function renderReindexBanner(
  read: StateReadResult<ReindexEntry>,
  opts: { now: Date; currentHeadSha: string | null; staleHours?: number }
): string {
  const staleHours = opts.staleHours ?? DEFAULT_HUNG_STALE_HOURS
  const disable = `disable: ${REINDEX_STALENESS_DISABLE_VAR}=1`
  const logPath = `log: ${displayPath(resolveReindexLogPath(opts.now))}`
  const verify = `verify: docker exec skillsmith-dev-1 node packages/doc-retrieval-mcp/dist/src/cli.js reindex --full`

  if (read.status === 'missing') return ''
  if (read.status === 'malformed') {
    return `**[reindex]** state malformed at ${displayPath(resolveReindexStatePath())} — ${verify} — ${logPath} — ${disable}`
  }
  if (read.status === 'unreadable') {
    return `**[reindex]** state unreadable (${read.detail}) — ${verify} — ${logPath} — ${disable}`
  }

  const entry = read.entry
  if (!entry.success) {
    return `**[reindex]** last run failed: ${entry.errorReason ?? 'unknown'} — ${logPath} — ${disable}`
  }
  if (entry.consecutiveZeroTouchRuns >= ANOMALY_ZERO_TOUCH_THRESHOLD) {
    return `**[reindex]** ${entry.consecutiveZeroTouchRuns} consecutive commits scanned 0 files while HEAD kept advancing — expected on doc-touching commits, so this may be a detection gap (the SMI-5786 failure shape) — ${verify} — ${logPath} — ${disable}`
  }
  const hoursSince = (opts.now.getTime() - Date.parse(entry.lastRunTs)) / 3_600_000
  if (hoursSince > staleHours && opts.currentHeadSha && opts.currentHeadSha !== entry.lastRunSha) {
    return `**[reindex]** no reindex run recorded in ${Math.round(hoursSince)}h despite new commits — possibly hung or not firing — check: docker ps --format '{{.Names}}' | grep skillsmith-dev-1 — ${logPath} — ${disable}`
  }
  return ''
}

function displayPath(p: string): string {
  const home = homedir()
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p
}

function ymdLocal(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
