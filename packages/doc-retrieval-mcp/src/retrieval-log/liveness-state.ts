/**
 * SMI-5432 W0.2 telemetry-liveness alert — shared state + re-notify + banner module.
 *
 * Single source of truth for the liveness check's persisted state, its
 * re-notify cooldown, and its banner string. Imported two ways so the bash
 * cron and the priming hook never re-implement (and drift on) the JSON shape or
 * the banner text — the SMI-5419 cross-language-parity lesson:
 *   - `scripts/retrieval-liveness-state.ts` (a thin tsx CLI) for the bash
 *     `scripts/retrieval-liveness-check.sh` cron checker; and
 *   - a direct import by `scripts/session-priming-query.ts` for the
 *     feature-branch banner surface (M2 causal linkage).
 *
 * State file: `~/.skillsmith/retrieval-liveness.state` — a JSON object keyed by
 * the resolved main-repo absolute path (so worktrees of one clone share a single
 * state entry, matching the single shared node_modules; a second clone at a
 * different path gets its own keyed entry). Writes are atomic (temp + rename) and
 * reads are fail-soft (a corrupt/missing file reads as "no entry").
 *
 * Spec: docs/internal/implementation/smi-5432-w02-liveness-alert.md §2.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Re-export the shared main-repo key resolver — callers import from here, not autoheal-state. */
export { resolveMainRepoKey } from './autoheal-state.js'

/** Kill-switch: set to 1 to disable the entire liveness check (no state write, no gh call). */
export const LIVENESS_DISABLE_VAR = 'SKILLSMITH_RETRIEVAL_LIVENESS_DISABLE'

/**
 * Shadow mode: when set (defaults to 1 in the plist template), the check computes
 * the verdict and writes state but logs `[shadow] WOULD open issue` instead of
 * touching GitHub. Ships safe-by-default regardless of the W0.1-live gate.
 */
export const LIVENESS_SHADOW_VAR = 'SKILLSMITH_RETRIEVAL_LIVENESS_SHADOW'

/**
 * Snooze: set to an epoch-seconds value; while now < SNOOZE_UNTIL the check still
 * computes the verdict and writes state + logs (observability preserved) but skips
 * the GitHub alert. Vacation / known-away-window suppression path (H5).
 */
export const LIVENESS_SNOOZE_VAR = 'SKILLSMITH_RETRIEVAL_LIVENESS_SNOOZE_UNTIL'

/**
 * Re-notify cooldown: 14 days (two eval-cron cycles). A still-dead feed pages at
 * most once per this window — enough breathing room that closing the deduped issue
 * then re-detecting on the next run doesn't loop. Named here and echoed in the
 * GitHub issue body (H4).
 */
export const RENOTIFY_SECONDS = 14 * 24 * 3600

/** Default staleness threshold in days before the verdict flips to `stale`. */
export const DEFAULT_STALE_DAYS = 7

/**
 * Per-repo liveness state entry.
 *
 * Re-notify cooldown is {@link RENOTIFY_SECONDS} (14 days): when
 * `nowEpoch - lastAlertEpoch >= RENOTIFY_SECONDS` the alert fires again.
 */
export interface LivenessEntry {
  /** Unix epoch (seconds) of the last check run. */
  lastCheckEpoch: number
  /** Verdict from the last check run. */
  lastVerdict: 'healthy' | 'stale'
  /** ISO-8601 timestamp of the earliest stale detection in the current run (null when healthy). */
  lastStaleSinceTs?: string | null
  /** Consecutive stale verdicts; resets to 0 on a healthy verdict. */
  consecutiveStale: number
  /** Unix epoch (seconds) of the last GitHub alert notification (undefined = never alerted). */
  lastAlertEpoch?: number
  /** GitHub issue number of the open deduped alert, for follow-up dedupe (optional). */
  openIssueNumber?: number
}

export type LivenessState = Record<string, LivenessEntry>

export function resolveLivenessStateDir(): string {
  // SKILLSMITH_LIVENESS_HOME isolates state/logs under a test temp dir so the
  // suite never touches the real ~/.skillsmith. Honored identically by
  // scripts/retrieval-liveness-check.sh so bash + this module always agree.
  // Unset in production → the real home dir.
  const base = process.env.SKILLSMITH_LIVENESS_HOME ?? homedir()
  return join(base, '.skillsmith')
}

export function resolveLivenessStatePath(): string {
  return join(resolveLivenessStateDir(), 'retrieval-liveness.state')
}

/** Per-day log path (LOCAL date); format matches `retrieval-autoheal-<date>.log`. */
export function resolveLivenessLogPath(now: Date): string {
  return join(resolveLivenessStateDir(), 'logs', `retrieval-liveness-${ymdLocal(now)}.log`)
}

/** Fail-soft read of the whole state object. A missing/corrupt file reads as {}. */
export function readState(path: string = resolveLivenessStatePath()): LivenessState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as LivenessState
    }
    return {}
  } catch {
    return {}
  }
}

export function readEntry(
  key: string,
  path: string = resolveLivenessStatePath()
): LivenessEntry | null {
  return readState(path)[key] ?? null
}

/** Atomic (temp + rename) write of a single entry, preserving other keys. */
export function writeEntry(
  key: string,
  entry: LivenessEntry,
  path: string = resolveLivenessStatePath()
): void {
  const state = readState(path)
  state[key] = entry
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, path)
}

/**
 * Fold a liveness verdict into the prior entry:
 *  - healthy → resets consecutiveStale to 0, clears lastStaleSinceTs, and
 *              clears the alert fields so a fresh stale cycle always notifies.
 *  - stale   → increments consecutiveStale; sets lastStaleSinceTs only on
 *              the first stale detection in a run (first-time-only semantics:
 *              once set, the timestamp is preserved across subsequent stale
 *              checks so it reflects when the outage began, not the last tick).
 *              Preserves lastAlertEpoch and openIssueNumber across stale ticks.
 * Always updates lastCheckEpoch.
 */
export function recordCheck(
  prior: LivenessEntry | null,
  verdict: 'healthy' | 'stale',
  nowEpoch: number,
  opts: { staleSinceTs?: string | null } = {}
): LivenessEntry {
  if (verdict === 'healthy') {
    return {
      lastCheckEpoch: nowEpoch,
      lastVerdict: 'healthy',
      lastStaleSinceTs: null,
      consecutiveStale: 0,
      // Clear alert fields: a new stale cycle must notify fresh.
    }
  }
  // stale — preserve staleSince and alert history across ticks.
  return {
    lastCheckEpoch: nowEpoch,
    lastVerdict: 'stale',
    // Keep the original detection timestamp (first-time-only); null prior → use opts.
    lastStaleSinceTs: prior?.lastStaleSinceTs ?? opts.staleSinceTs ?? null,
    consecutiveStale: (prior?.consecutiveStale ?? 0) + 1,
    ...(prior?.lastAlertEpoch != null ? { lastAlertEpoch: prior.lastAlertEpoch } : {}),
    ...(prior?.openIssueNumber != null ? { openIssueNumber: prior.openIssueNumber } : {}),
  }
}

/**
 * Whether to notify or dedupe. Returns `notify` when the verdict is stale AND
 * either no prior alert exists (lastAlertEpoch undefined) or the 14-day
 * re-notify cooldown has elapsed. Returns `dedupe` otherwise.
 *
 * The caller is expected to invoke this only on a stale verdict; snooze and
 * shadow gating are handled in bash, not here.
 */
export function alertDecision(entry: LivenessEntry | null, nowEpoch: number): 'notify' | 'dedupe' {
  if (!entry || entry.lastVerdict !== 'stale') return 'dedupe'
  if (entry.lastAlertEpoch == null) return 'notify'
  return nowEpoch - entry.lastAlertEpoch >= RENOTIFY_SECONDS ? 'notify' : 'dedupe'
}

/**
 * Record that an alert was sent: stamps lastAlertEpoch and, when provided,
 * persists the GitHub issue number for follow-up dedupe (comment vs. create).
 */
export function recordAlert(
  entry: LivenessEntry,
  nowEpoch: number,
  issueNumber?: number
): LivenessEntry {
  return {
    ...entry,
    lastAlertEpoch: nowEpoch,
    ...(issueNumber != null ? { openIssueNumber: issueNumber } : {}),
  }
}

/**
 * The non-silent bold-markdown banner for the session-priming surface (NOT a
 * GitHub [!WARNING] callout — those render the literal text). States the feed
 * has been stale since lastStaleSinceTs, points at the log + repair script,
 * and names the disable var verbatim so operators can copy-paste it.
 *
 * When `opts.autohealFailed` is true, appends the M2 causal-linkage phrase so
 * a dead binding that causes BOTH the autoheal failure AND feed staleness is
 * surfaced as one root cause, not two separate investigations.
 */
export function renderLivenessBanner(
  entry: LivenessEntry | null,
  opts: { now: Date; logPath: string; autohealFailed?: boolean }
): string {
  const disable = `disable: ${LIVENESS_DISABLE_VAR}=1`
  const logHint = `log: ${displayPath(opts.logPath)}`
  const repair = `repair: ./scripts/repair-host-native-deps.sh`

  if (!entry || entry.lastVerdict !== 'stale') {
    return `**[liveness]** retrieval feed health unknown — ${logHint} — ${disable}`
  }

  const sinceStr = entry.lastStaleSinceTs
    ? `since ${entry.lastStaleSinceTs}`
    : 'for an unknown duration'
  const causal = opts.autohealFailed ? ' — likely the host auto-heal failure above' : ''

  return `**[liveness]** retrieval feed stale ${sinceStr}${causal} — ${logHint} — ${repair} — ${disable}`
}

// ── Internal helpers ──────────────────────────────────────────────────────────

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
