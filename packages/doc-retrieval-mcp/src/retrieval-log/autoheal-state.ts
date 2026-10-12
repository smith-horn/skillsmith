/**
 * SMI-5426 W0.1 host auto-heal — shared state + cooldown + banner module.
 *
 * Single source of truth for the auto-heal's persisted state, its
 * cooldown/attempt-cap math, and its banner string. Imported two ways so the
 * bash orchestrator and the priming hook never re-implement (and drift on) the
 * JSON shape or the banner text — the SMI-5419 cross-language-parity lesson:
 *   - `scripts/retrieval-autoheal-state.ts` (a thin tsx CLI) for the bash
 *     `scripts/retrieval-autoheal.sh` orchestrator, called only on the
 *     unhealthy path; and
 *   - a direct import by `scripts/session-priming-query.ts` for the
 *     feature-branch banner surface (D5).
 *
 * State file: `~/.skillsmith/retrieval-autoheal.state` — a JSON object keyed by
 * the resolved main-repo absolute path (so the N worktrees of one clone share a
 * single cooldown, matching the one shared node_modules; a second clone at a
 * different path gets its own keyed entry). Writes are atomic (temp + rename)
 * and reads are fail-soft (a corrupt/missing file reads as "no entry").
 *
 * Spec: docs/internal/implementation/smi-5426-w01-host-autoheal.md §D4/D5.
 *
 * SMI-6995: `readState`/`readEntry` below collapse "never written", "corrupt"
 * and "could not be read" into the same `null` — correct for THEIR callers
 * (see {@link readEntry}'s own doc comment), but exactly the collapse that
 * made the banner render nothing for a corrupt state file, indistinguishable
 * from a healthy system that has simply never run. {@link readEntryResult}
 * is the consumer-facing counterpart that keeps those three cases apart,
 * delegating to the shared three-way read in `state-read.ts`;
 * {@link renderAutohealBanner} now takes that result type directly so a
 * malformed or unreadable state file renders a banner naming the fault
 * instead of looking identical to "has not run yet".
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { readEntryResult as readEntryResultShared, type StateReadResult } from './state-read.js'

/** The only pre-consent opt-out for the unattended loop. Surfaced verbatim in every banner. */
export const AUTOHEAL_DISABLE_VAR = 'SKILLSMITH_RETRIEVAL_AUTOHEAL_DISABLE'

/** Consecutive failures at which the loop stops retrying until a manual reset. */
export const ATTEMPT_CAP = 4

/**
 * Backoff window (seconds) indexed by the *current* consecutive-failure count.
 * Index 0 → no prior failure → run immediately. After the 1st/2nd/3rd failure
 * wait 1h / 4h / 24h before the next attempt; at ATTEMPT_CAP the loop is held
 * (see {@link cooldownDecision}).
 */
export const BACKOFF_SECONDS: readonly number[] = [0, 3600, 14400, 86400]

export interface AutohealEntry {
  /** Unix epoch (seconds) of the last attempt. */
  lastAttemptEpoch: number
  /** Consecutive failed heals; reset to 0 on success. */
  consecutiveFailures: number
  /** Verdict of the last attempt. */
  lastVerdict: 'ok' | 'fail'
  /** One-line root-cause reason for the last failure (≤200 chars). */
  lastFailureReason?: string
  /** Native module last repaired (diagnostic). */
  lastModule?: string
  /** Node ABI present before the repair (diagnostic). */
  priorAbi?: string
}

export type AutohealState = Record<string, AutohealEntry>

/** SMI-6995: the consumer-facing read result for a single entry — see {@link readEntryResult}. */
export type AutohealReadResult = StateReadResult<AutohealEntry>

export type CooldownDecision =
  | { action: 'run' }
  | { action: 'cooldown'; untilEpoch: number }
  | { action: 'capped' }

export function resolveAutohealStateDir(): string {
  // SKILLSMITH_AUTOHEAL_HOME isolates state/lock/logs under a test temp dir so
  // the suite never touches the real ~/.skillsmith. Honored identically by
  // scripts/retrieval-autoheal.sh so bash + this module always agree. Unset in
  // production → the real home dir.
  const base = process.env.SKILLSMITH_AUTOHEAL_HOME || homedir()
  return join(base, '.skillsmith')
}

export function resolveAutohealStatePath(): string {
  return join(resolveAutohealStateDir(), 'retrieval-autoheal.state')
}

/** Per-day log path; date format matches the existing `session-audit-<date>.log`. */
export function resolveAutohealLogPath(now: Date): string {
  return join(resolveAutohealStateDir(), 'logs', `retrieval-autoheal-${ymdLocal(now)}.log`)
}

/**
 * Resolve the main-repo absolute path used as the state key — the first
 * `worktree` entry of `git worktree list --porcelain`, which is always the main
 * working tree. Computed IDENTICALLY in `scripts/retrieval-autoheal.sh` so the
 * key never drifts across the language boundary. Returns null when git is
 * unavailable or `cwd` is not in a repo (caller degrades gracefully).
 */
export function resolveMainRepoKey(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['-C', cwd, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      timeout: 2000,
      // SMI-6976: without this, Node writes the failing child's stderr straight
      // to the PARENT's stderr — default options are not quiet. This function
      // runs on every SessionStart (startup, compact and resume) via
      // scripts/session-priming-query.ts, whose output is injected into the
      // model's context, so a git failure here puts raw `fatal:` lines in front
      // of the user from a mechanism whose entire job is to fail quietly and
      // let the banner report the problem in its own words. The return value
      // and the thrown error are identical either way; only the live bytes
      // differ.
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) return line.slice('worktree '.length).trim()
    }
    return null
  } catch {
    return null
  }
}

/** Fail-soft read of the whole state object. A missing/corrupt file reads as {}. */
export function readState(path: string = resolveAutohealStatePath()): AutohealState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as AutohealState
    }
    return {}
  } catch {
    return {}
  }
}

/**
 * The documented producer/assertion accessor — fail-soft and NULL-COLLAPSING
 * by design, not an oversight: "never written", "corrupt", and "could not be
 * read" all return the same `null`, because that is exactly what
 * `writeEntry`'s read-modify-write, `recordResult`'s prior-entry fold, and
 * every assertion in this file's own test suite need — a value they can
 * treat uniformly as "nothing to build on," regardless of WHY. 16 caller
 * files, six of them tests, depend on that collapse. Do not remove or
 * "fix" it here (SMI-6995).
 *
 * A BANNER consumer wants the opposite policy — telling "never run" apart
 * from "ran but the file is broken" is the entire point of the banner. That
 * caller wants {@link readEntryResult}, not this function.
 */
export function readEntry(
  key: string,
  path: string = resolveAutohealStatePath()
): AutohealEntry | null {
  return readState(path)[key] ?? null
}

/**
 * Validates every field {@link renderAutohealBanner} and
 * {@link cooldownDecision} read from a candidate entry — not a `typeof`
 * spot-check, which would accept `{lastVerdict: "banana"}` and recreate the
 * exact collapse this module exists to remove, one layer down: the read
 * would report `ok`, the renderer's `=== 'fail'` branch would not match a
 * value that isn't `'ok'` either, and the banner would stay silent on a
 * genuinely malformed entry (SMI-6995 plan review finding 1, the shape this
 * task's own brief names explicitly). `lastVerdict` is checked against its
 * literal union, never `typeof === 'string'`; `lastAttemptEpoch` and
 * `consecutiveFailures` are checked with `Number.isFinite` so `NaN`,
 * `Infinity`, and non-numbers are all rejected the same way — each is a
 * value {@link cooldownDecision}'s own backoff arithmetic would otherwise
 * silently miscompute on; the three optional diagnostic fields are checked
 * only when present, and must be strings when they are.
 */
function validateAutohealEntry(candidate: unknown): string | null {
  if (!candidate || typeof candidate !== 'object') return 'entry is not an object'
  const c = candidate as Record<string, unknown>
  if (!Number.isFinite(c.lastAttemptEpoch)) return 'entry.lastAttemptEpoch is not a finite number'
  if (!Number.isFinite(c.consecutiveFailures))
    return 'entry.consecutiveFailures is not a finite number'
  if (c.lastVerdict !== 'ok' && c.lastVerdict !== 'fail')
    return "entry.lastVerdict is not 'ok' or 'fail'"
  if (c.lastFailureReason !== undefined && typeof c.lastFailureReason !== 'string')
    return 'entry.lastFailureReason is present but not a string'
  if (c.lastModule !== undefined && typeof c.lastModule !== 'string')
    return 'entry.lastModule is present but not a string'
  if (c.priorAbi !== undefined && typeof c.priorAbi !== 'string')
    return 'entry.priorAbi is present but not a string'
  return null
}

/**
 * The consumer-facing counterpart to {@link readEntry} (SMI-6995): reports
 * `missing` / `malformed` / `unreadable` / `ok` as four DIFFERENT facts
 * instead of collapsing the first three into one `null`, by delegating to
 * the shared three-way read in `state-read.ts` with
 * {@link validateAutohealEntry} as the validator. A caller rendering a
 * banner from this result (see {@link renderAutohealBanner}) can therefore
 * tell "has not run yet" apart from "ran, but the state file is broken" —
 * the exact distinction `readEntry`'s `null` cannot make and must keep not
 * making for ITS OWN callers (see that function's doc comment).
 */
export function readEntryResult(
  key: string,
  path: string = resolveAutohealStatePath()
): AutohealReadResult {
  return readEntryResultShared<AutohealEntry>(key, path, validateAutohealEntry)
}

/** Atomic (temp + rename) write of a single entry, preserving other keys. */
export function writeEntry(
  key: string,
  entry: AutohealEntry,
  path: string = resolveAutohealStatePath()
): void {
  const state = readState(path)
  state[key] = entry
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, path)
}

/**
 * Fold a heal result into the prior entry: success resets the failure counter;
 * failure increments it and records the reason. The single place the counter
 * advances — bash records via the CLI, never mutates the JSON itself.
 */
export function recordResult(
  prior: AutohealEntry | null,
  result: 'ok' | 'fail',
  nowEpoch: number,
  opts: { reason?: string; module?: string; abi?: string } = {}
): AutohealEntry {
  if (result === 'ok') {
    return {
      lastAttemptEpoch: nowEpoch,
      consecutiveFailures: 0,
      lastVerdict: 'ok',
      ...(opts.module ? { lastModule: opts.module } : {}),
      ...(opts.abi ? { priorAbi: opts.abi } : {}),
    }
  }
  return {
    lastAttemptEpoch: nowEpoch,
    consecutiveFailures: (prior?.consecutiveFailures ?? 0) + 1,
    lastVerdict: 'fail',
    lastFailureReason: (opts.reason ?? 'unknown').slice(0, 200),
    ...(opts.module ? { lastModule: opts.module } : {}),
    ...(opts.abi ? { priorAbi: opts.abi } : {}),
  }
}

/**
 * Whether to attempt a heal now, given the prior entry. `run` when there is no
 * prior failure or the backoff window has elapsed; `cooldown` while inside the
 * window; `capped` once ATTEMPT_CAP consecutive failures is reached (held until
 * a manual `rm` of the state file).
 */
export function cooldownDecision(entry: AutohealEntry | null, nowEpoch: number): CooldownDecision {
  if (!entry || entry.consecutiveFailures <= 0) return { action: 'run' }
  if (entry.consecutiveFailures >= ATTEMPT_CAP) return { action: 'capped' }
  const window =
    BACKOFF_SECONDS[entry.consecutiveFailures] ?? BACKOFF_SECONDS[BACKOFF_SECONDS.length - 1]
  const untilEpoch = entry.lastAttemptEpoch + window
  return nowEpoch < untilEpoch ? { action: 'cooldown', untilEpoch } : { action: 'run' }
}

/**
 * The non-silent banner (D5). The CALLER guarantees the binding is currently
 * broken — on a healthy host both surfaces print nothing, so there is no
 * steady-state noise. The disable var appears verbatim and copy-paste-ready; at
 * the attempt cap a cooldown-reset command is appended (never a bare "re-run the
 * script that just failed"). Same text on both surfaces.
 *
 * SMI-6995: takes the shared {@link AutohealReadResult} rather than
 * `AutohealEntry | null`, so this function can tell apart the three facts
 * `readEntry`'s `null` used to collapse. The split is intentionally
 * asymmetric, matching the invariant `state-read.ts`'s own top doc comment
 * states ("a consumer must never render corrupt state as healthy"):
 *
 *   - `missing` ("has not run yet") RENDERS the pre-existing
 *     "first run launched" line — this renderer is not silent on it (see the
 *     correction comment in the body for why). Silence on `missing` is the
 *     session-priming CALLER's policy, not this function's:
 *     `scripts/session-priming-query.ts` only calls this renderer for a
 *     `malformed`/`unreadable` read or an `ok` entry whose `lastVerdict` is
 *     `fail`, so a `missing` read never reaches it from that surface. The
 *     `--print-banner` CLI does call it on `missing`, and wants the line.
 *   - `malformed`/`unreadable` RENDER unconditionally — a corrupt or
 *     unreadable state file is a symptom worth surfacing on its own, never
 *     silently treated as "no prior run."
 *   - `ok` preserves the exact prior fail/cap/regressed-launch behaviour,
 *     unchanged line for line below.
 */
export function renderAutohealBanner(
  read: AutohealReadResult,
  opts: { now: Date; logPath: string }
): string {
  const disable = `disable: ${AUTOHEAL_DISABLE_VAR}=1`
  const logHint = `log: ${displayPath(opts.logPath)}`
  const reset = `rm ${displayPath(resolveAutohealStatePath())}`

  // SMI-6995 CORRECTION: `missing` is NOT silent here, and making it silent
  // was a regression this sweep introduced and a test caught. The blanket
  // rule "render on malformed/unreadable, stay silent on missing" was
  // generalised from reindex-state, the only one of the three whose null
  // branch really was `return ''`. This module's null branch always carried a
  // real message, and that message is correct: the --print-banner CLI is
  // invoked by the heal script at the moment it launches a heal, when no state
  // exists yet, and "first run launched" is exactly what the user needs to see.
  if (read.status === 'missing') {
    return `[autoheal] first run launched — ${logHint} — ${disable}`
  }

  if (read.status === 'malformed') {
    return (
      `[autoheal] state malformed at ${displayPath(resolveAutohealStatePath())} — ` +
      `inspect it, then reset: ${reset} — ${logHint} — ${disable}`
    )
  }

  if (read.status === 'unreadable') {
    return (
      `[autoheal] state unreadable (${read.detail}) — inspect it, then reset: ${reset} — ` +
      `${logHint} — ${disable}`
    )
  }

  const entry = read.entry
  if (entry.lastVerdict === 'fail') {
    const when = fmtLocalMinute(entry.lastAttemptEpoch)
    const reason = entry.lastFailureReason ?? 'unknown'
    if (entry.consecutiveFailures >= ATTEMPT_CAP) {
      return (
        `[autoheal] last attempt ${when} failed: ${reason} — cooling down (attempt cap reached) — ` +
        `${logHint} — ${disable} — fix the root cause above, then reset: ${reset}`
      )
    }
    return `[autoheal] last attempt ${when} failed: ${reason} — ${logHint} — ${disable}`
  }
  // Last attempt healed but the binding is broken again → it regressed; the
  // about-to-run heal will retry. Surface the launch + escape hatch.
  return `[autoheal] launched — ${logHint} — ${disable}`
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

function fmtLocalMinute(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${ymdLocal(d)} ${hh}:${mm}`
}
