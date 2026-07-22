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

export function readEntry(
  key: string,
  path: string = resolveReindexStatePath()
): ReindexEntry | null {
  return readState(path)[key] ?? null
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
 * convention. A null entry (no run recorded yet) renders nothing — there is
 * no steady-state noise before the first reindex has even run once.
 */
export function renderReindexBanner(
  entry: ReindexEntry | null,
  opts: { now: Date; currentHeadSha: string | null; staleHours?: number }
): string {
  if (!entry) return ''
  const staleHours = opts.staleHours ?? DEFAULT_HUNG_STALE_HOURS
  const disable = `disable: ${REINDEX_STALENESS_DISABLE_VAR}=1`
  const logPath = `log: ${displayPath(resolveReindexLogPath(opts.now))}`

  if (!entry.success) {
    return `**[reindex]** last run failed: ${entry.errorReason ?? 'unknown'} — ${logPath} — ${disable}`
  }
  if (entry.consecutiveZeroTouchRuns >= ANOMALY_ZERO_TOUCH_THRESHOLD) {
    return `**[reindex]** ${entry.consecutiveZeroTouchRuns} consecutive commits scanned 0 files while HEAD kept advancing — expected on doc-touching commits, so this may be a detection gap (the SMI-5786 failure shape) — verify: docker exec skillsmith-dev-1 node packages/doc-retrieval-mcp/dist/src/cli.js reindex --full — ${logPath} — ${disable}`
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
