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
 *
 * ## SMI-6995 — the two-axis read this module was missing
 *
 * {@link readState}/{@link readEntry} below collapse THREE distinct facts —
 * "this key has never run" (no entry yet), "the file is corrupt" (bytes that
 * don't parse, or an entry that doesn't shape up), and "the file could not
 * even be read" (permissions, a directory sitting where the file belongs) —
 * into the SAME `null`/`{}`. That is correct for the PRODUCER half of this
 * module (`writeEntry`/`recordCheck`: a write path must always be able to
 * overwrite corrupt state, never refuse because the prior read failed), but
 * it is exactly the blindness the banner exists to remove when the SAME
 * collapse reaches the CONSUMER half: `renderLivenessBanner` rendered
 * nothing for a corrupt state file, indistinguishable from a healthy system
 * that simply has not run yet. {@link readEntryResult} is the consumer-axis
 * fix — it reports `missing`/`malformed`/`unreadable` as three separate
 * facts, using the shared classification in `state-read.ts`, and
 * {@link renderLivenessBanner} now takes that result instead of a bare
 * `LivenessEntry | null` so a malformed or unreadable file renders a line
 * naming the fault instead of silently reading as "never run." `readEntry`
 * itself is UNCHANGED and stays exactly as it was — see its own doc comment
 * below for why the producer side keeps the old conflation on purpose.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { readEntryResult as sharedReadEntryResult, type StateReadResult } from './state-read.js'

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

/**
 * The PRODUCER/assertion accessor (SMI-6995). Deliberately conflates "this
 * key has never run," "the file is corrupt," and "the file could not be
 * read" into the same `null` — a fail-soft read is the correct contract for
 * the cron/hook write paths and test assertions that call this (16 caller
 * files as of SMI-6995, six of them tests), which only ever need "is there a
 * usable prior entry or not," never WHY one is absent. Do not change this
 * function's conflation to fix a banner — that is what {@link readEntryResult}
 * is for. A banner consumer that needs to tell "never run" apart from
 * "corrupt" must call {@link readEntryResult} instead; it is the one that
 * reports the three cases on separate axes.
 */
export function readEntry(
  key: string,
  path: string = resolveLivenessStatePath()
): LivenessEntry | null {
  return readState(path)[key] ?? null
}

/**
 * Validates every field {@link renderLivenessBanner} (and any other
 * consumer) actually reads off a `LivenessEntry` — not a `typeof`
 * spot-check. A spot-check that only confirms "it's an object with a
 * `lastVerdict` property" would accept `{lastVerdict: "banana"}`: the read
 * reports `ok`, the renderer's `=== 'stale'` branch does not match (nor does
 * any other known value), and the banner falls through to "health unknown"
 * for a payload that is actually garbage — the SMI-6995 collapse recreated
 * one layer down, inside the fix meant to remove it (this exact example was
 * a round-2 review finding against this plan's first draft). So every field
 * gets its own check: `lastVerdict` against the literal union (not merely
 * "is a string"), the two required numeric fields via a finite-number guard
 * (rejects `NaN`/`Infinity`/non-numbers alike), and the optional fields
 * checked only when present — `undefined` is valid for all three optional
 * fields, but a PRESENT value of the wrong shape is not.
 */
function validateLivenessEntry(candidate: unknown): string | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return 'entry is not an object'
  }
  const e = candidate as Record<string, unknown>

  if (!isFiniteNumber(e.lastCheckEpoch)) return 'lastCheckEpoch is not a finite number'

  if (e.lastVerdict !== 'healthy' && e.lastVerdict !== 'stale') {
    return `lastVerdict is not 'healthy' or 'stale' (got ${JSON.stringify(e.lastVerdict)})`
  }

  if (
    e.lastStaleSinceTs !== undefined &&
    e.lastStaleSinceTs !== null &&
    typeof e.lastStaleSinceTs !== 'string'
  ) {
    return 'lastStaleSinceTs is present but neither a string nor null'
  }

  if (!isFiniteNumber(e.consecutiveStale)) return 'consecutiveStale is not a finite number'

  if (e.lastAlertEpoch !== undefined && !isFiniteNumber(e.lastAlertEpoch)) {
    return 'lastAlertEpoch is present but not a finite number'
  }

  if (e.openIssueNumber !== undefined && !isFiniteNumber(e.openIssueNumber)) {
    return 'openIssueNumber is present but not a finite number'
  }

  return null
}

/**
 * The CONSUMER accessor (SMI-6995) — the fix for the defect this module was
 * filed for. Reports `missing`/`malformed`/`unreadable` as three separate
 * facts instead of {@link readEntry}'s single collapsed `null`, via the
 * shared classification in `state-read.ts` plus {@link validateLivenessEntry}
 * above. {@link renderLivenessBanner} is its intended caller; any other
 * banner/surface that needs to distinguish "never run" from "corrupt" should
 * call this too rather than `readEntry`.
 */
export function readEntryResult(
  key: string,
  path: string = resolveLivenessStatePath()
): StateReadResult<LivenessEntry> {
  return sharedReadEntryResult<LivenessEntry>(key, path, validateLivenessEntry)
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

/** The next action for a malformed/unreadable state-file read — re-running the real cron overwrites it. */
const REFRESH_COMMAND = './scripts/retrieval-liveness-check.sh'

/**
 * The non-silent bold-markdown banner for the session-priming surface (NOT a
 * GitHub [!WARNING] callout — those render the literal text). Points at the
 * log + repair script and names the disable var verbatim so operators can
 * copy-paste it.
 *
 * SMI-6995: takes the two-axis {@link StateReadResult} from
 * {@link readEntryResult}, not a bare `LivenessEntry | null` — the whole
 * point of this change. Three branches on the READ axis, never collapsed:
 *
 * - `missing` — "has not run yet," the ordinary steady state for a fresh
 *   checkout or one simply between cron ticks — renders nothing. This is a
 *   DELIBERATE divergence from `ruflo-bridge-state`'s own banner, which
 *   renders on `missing` too (SMI-6985 deleted ITS grace window for
 *   bridge-specific reasons: that writer fires on every merge, so "never
 *   run" is itself informative there). This module's writer is a
 *   fire-and-forget cron with no such per-merge expectation, so silence on
 *   `missing` is correct here and is not copied from the bridge.
 * - `malformed`/`unreadable` — the state file exists but is corrupt or
 *   could not be read — render UNCONDITIONALLY, naming the fault, because
 *   this is exactly the case the old `LivenessEntry | null` signature made
 *   indistinguishable from `missing` (the defect this change exists to
 *   remove). Segment order matches `ruflo-bridge-state.render.ts`'s `line()`
 *   helper: `**[liveness]** <state text> — <next action> — log: … —
 *   disable: …`.
 * - `ok` — the entry parsed and validated — preserves the PRE-SMI-6995
 *   behaviour verbatim, field for field, including the M2 causal-linkage
 *   phrase ("likely the host auto-heal failure above") that `opts
 *   .autohealFailed` appends when the host auto-heal also failed, so both
 *   surfaces point at one root cause instead of two separate
 *   investigations. A healthy (non-stale) `ok` entry still renders the
 *   "health unknown" line, exactly as it always has — this branch's own
 *   behaviour did not change, only what feeds it did.
 */
export function renderLivenessBanner(
  read: StateReadResult<LivenessEntry>,
  opts: { now: Date; logPath: string; autohealFailed?: boolean }
): string {
  const disable = `disable: ${LIVENESS_DISABLE_VAR}=1`
  const logHint = `log: ${displayPath(opts.logPath)}`
  const repair = `repair: ./scripts/repair-host-native-deps.sh`

  // SMI-6995 CORRECTION: `missing` is NOT silent here, and making it silent
  // was a regression this sweep introduced and a test caught. The blanket
  // rule "render on malformed/unreadable, stay silent on missing" was
  // generalised from reindex-state, the only one of the three whose null
  // branch really was `return ''`. This module's null branch always carried a
  // real message, and that message is correct: "health unknown" is
  // already this issue's own philosophy applied -- saying "I cannot tell you"
  // rather than saying nothing. Replacing it with silence moved BACKWARDS.
  if (read.status === 'missing') {
    return `**[liveness]** retrieval feed health unknown — ${logHint} — ${disable}`
  }

  if (read.status === 'malformed' || read.status === 'unreadable') {
    const stateText =
      read.status === 'malformed'
        ? `state malformed at ${displayPath(resolveLivenessStatePath())}`
        : `state unreadable (${read.detail})`
    const nextAction = `run: ${REFRESH_COMMAND} to refresh`
    return `**[liveness]** ${stateText} — ${nextAction} — ${logHint} — ${disable}`
  }

  const { entry } = read
  if (entry.lastVerdict !== 'stale') {
    return `**[liveness]** retrieval feed health unknown — ${logHint} — ${disable}`
  }

  const sinceStr = entry.lastStaleSinceTs
    ? `since ${entry.lastStaleSinceTs}`
    : 'for an unknown duration'
  const causal = opts.autohealFailed ? ' — likely the host auto-heal failure above' : ''

  return `**[liveness]** retrieval feed stale ${sinceStr}${causal} — ${logHint} — ${repair} — ${disable}`
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** `typeof === 'number'` alone accepts `NaN`/`Infinity` — this module's numeric fields never should. */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
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
