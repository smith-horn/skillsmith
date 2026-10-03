/**
 * SMI-6744 A5.5.2(b)/(c) delta — ruflo bridge-verdict consumer: shared state +
 * single-flight lock + liveness-counter fold + banner module.
 *
 * Mirrors `reindex-state.ts`'s shape (writer/reader split, atomic write, the
 * SMI-5419 cross-language-parity lesson), but — unlike the reindex/liveness/
 * autoheal writers, each a single fire-and-forget cron/hook — this writer now
 * fires on every merging pull, per worktree, against one singleton served
 * service (D1.3 of the spec below). That makes two of its invocations able to
 * genuinely race, so the lock here is real (acquired before the probe, held
 * through classification and the atomic write, token-validated at rename
 * time), in the `mcp-disconnect-state.ts` manner rather than the sibling
 * modules' fire-and-forget pattern.
 *
 * Two axes, never collapsed into one (the defect this delta's correction-of-
 * record section names, and A5.5.2 round-4 finding 3): the detector's VERDICT
 * (healthy / degraded / not-evaluated / malformed / unrecognized, plus
 * `unreadable`, which the detector itself never returns — it is this
 * writer's own classification for "could not even reach the server to ask")
 * is one field, persisted verbatim; the READER's own result — `ok` / `missing`
 * / `malformed` / `unreadable`, about reading *this state file* — is a
 * separate one. A state-file parse failure is never reported as "no entry",
 * and an entry whose own `verdict` field holds a token outside the known six
 * renders as not-evaluated on the verdict axis, never promoted to the
 * reader's own `malformed`.
 *
 * State file: `~/.skillsmith/ruflo-bridge.state` (or
 * `$SKILLSMITH_STATE_DIR_OVERRIDE/ruflo-bridge.state`, matching
 * `reindex-state.ts`'s override), keyed by `resolveMainRepoKey()` — resolved
 * on the HOST, never container-side (D3; SMI-6951 is the live instance of
 * getting this wrong for `reindex.state`).
 *
 * Spec: docs/internal/implementation/smi-6744-bridge-verdict-consumer.md.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Re-export the shared main-repo key resolver — callers import from here, not autoheal-state. */
export { resolveMainRepoKey } from './autoheal-state.js'

/** Kill-switch: stops the WRITER only (`scripts/ruflo-bridge-probe.mjs` checks this itself). */
export const BRIDGE_PROBE_DISABLE_VAR = 'SKILLSMITH_RUFLO_PROBE_DISABLE'

/** Silences the banner only — the writer and its state file keep working. */
export const BRIDGE_VERDICT_DISABLE_VAR = 'SKILLSMITH_RUFLO_VERDICT_DISABLE'

/**
 * Shadow mode: unset or non-'0' = shadow (log the would-be line, render
 * nothing) — the repo-wide predicate (`mcp-disconnect-state.ts`,
 * `liveness-state.ts`). D2 (owner-decided 2026-10-03): this delta ships LIVE
 * — `.claude/settings.json`'s `env` sets this to `"0"` — but the var and its
 * shadow-first predicate stay defined so the lever exists unengaged, exactly
 * matching the sibling precedent this delta cites and reverses by instance
 * (set the value), not by predicate (the unset-is-shadow rule itself stands).
 */
export const BRIDGE_VERDICT_SHADOW_VAR = 'SKILLSMITH_RUFLO_VERDICT_SHADOW'

/** D1.2: A5.5.2's own value — an earlier revision of the delta proposed 168h and withdrew it. */
export const DEFAULT_STALE_HOURS = 48
export const STALE_HOURS_VAR = 'SKILLSMITH_RUFLO_VERDICT_STALE_HOURS'

/** A5.5.2's liveness-arm default. */
export const DEFAULT_LIVENESS_DAYS = 7
export const LIVENESS_DAYS_VAR = 'SKILLSMITH_RUFLO_LIVENESS_DAYS'

/** D1.3: debounce window on the entry's own `evaluatedAt` before a new probe re-runs. */
export const DEBOUNCE_MS = 24 * 60 * 60 * 1000

/**
 * D1.3: the lock is held before the probe and through the atomic write.
 * Reclaim requires BOTH this age AND the recorded holder being independently
 * confirmed dead (liveness-verified, `mcp-disconnect-state.ts`'s pattern) —
 * age alone never reclaims a live holder. Must stay strictly ABOVE the
 * writer's SIGKILL deadline (65s, via `.husky/post-merge`'s `timeout -k 5 60`
 * / `gtimeout` / job-control-watchdog fallback — see that hook): the kill
 * deadline and this threshold are related by construction, not chosen
 * independently, and changing either requires re-checking the other (D1.3).
 */
export const LOCK_STALE_MS = 120_000

/**
 * The earliest moment a reader may treat a still-missing entry as a failure
 * rather than "this checkout has not had a post-merge fire since this
 * feature shipped" (A5.5.2's `expectedBy`, Wave 0 Step 4 — see
 * smi-6744-ruflo-intelligence-substrate-repair.md:126-130). The spec and the
 * swarm-execution-plan row name the *existence* of this gate precisely
 * (arms 6a/6b) but not a per-key derivation, and a per-key `expectedBy`
 * cannot be recorded without a writer having already run at least once for
 * that key — which is exactly the case this gate exists to cover. So this is
 * a single global constant (ship date + a one-day grace period for the
 * first post-merge to land), not a per-key record. This is a documented
 * implementation choice, not a literal spec requirement — see the delta's
 * own text for why no narrower mechanism is named. Override for tests only.
 */
export const DEFAULT_EXPECTED_BY_ISO = '2026-10-04T00:00:00.000Z'
const EXPECTED_BY_TEST_VAR = 'SKILLSMITH_RUFLO_VERDICT_EXPECTED_BY_TEST_ISO'

export function resolveExpectedByIso(): string {
  return process.env[EXPECTED_BY_TEST_VAR] || DEFAULT_EXPECTED_BY_ISO
}

/** Whether `now` is past the point a reader may expect an entry to exist. */
export function hasExpectedByPassed(now: Date): boolean {
  const t = Date.parse(resolveExpectedByIso())
  return !Number.isFinite(t) || now.getTime() >= t
}

/**
 * The detector's five-value vocabulary (`ruflo-bridge-verdict.mjs`) plus
 * `unreadable`, which the detector itself never returns — it is this
 * writer's own classification for "could not even reach the server to ask,"
 * adopted verbatim from A5.5.2. A verdict string outside this set (a future
 * upstream rewording, or a hand-edited state file) renders via
 * {@link renderBridgeVerdictLine}'s not-evaluated branch, never promoted to
 * the reader's own `malformed` axis below.
 */
export const KNOWN_VERDICTS = [
  'healthy',
  'degraded',
  'not-evaluated',
  'malformed',
  'unrecognized',
  'unreadable',
] as const
export type BridgeVerdictToken = (typeof KNOWN_VERDICTS)[number]

export function isKnownVerdict(v: string): v is BridgeVerdictToken {
  return (KNOWN_VERDICTS as readonly string[]).includes(v)
}

export interface BridgeEntry {
  /** ISO-8601 — when this probe completed (successfully or not). */
  evaluatedAt: string
  /** One of {@link KNOWN_VERDICTS}, or an out-of-set token from a future detector. */
  verdict: string
  reason: string
  /** `embeddingBackend` as observed this probe, when the payload carried one. */
  observedBackend: string | null
  /** `DERIVED_FROM.version` (ruflo-bridge-verdict.mjs) at probe time — remediation-command context. */
  derivedFromVersion: string | null
  patternsLearned: number | null
  trajectoriesRecorded: number | null
  /** A5.5.2 liveness arm: consecutive probes with neither counter moved. */
  consecutiveNoLearning: number
}

export type BridgeState = Record<string, BridgeEntry>

export function resolveBridgeStateDir(): string {
  return process.env.SKILLSMITH_STATE_DIR_OVERRIDE || join(homedir(), '.skillsmith')
}
export function resolveBridgeStatePath(): string {
  return join(resolveBridgeStateDir(), 'ruflo-bridge.state')
}
export function resolveBridgeLogPath(now: Date): string {
  return join(resolveBridgeStateDir(), 'logs', `ruflo-bridge-probe-${ymdLocal(now)}.log`)
}
/** Side file the writer saves the raw `memory_bridge_status` payload to — the not-evaluated remediation command re-runs the detector against it directly. */
export function resolveBridgePayloadPath(): string {
  return join(resolveBridgeStateDir(), 'ruflo-bridge-payload.json')
}
function resolveLockDirPath(): string {
  return `${resolveBridgeStatePath()}.lock`
}

// ---- Reader: two-axis result, never collapsing a parse failure into "no entry" ----

export type BridgeReadResult =
  | { status: 'ok'; entry: BridgeEntry }
  | { status: 'missing' }
  | { status: 'malformed'; detail: string }
  | { status: 'unreadable'; detail: string }

function readRawState(
  path: string
):
  | { ok: true; state: BridgeState }
  | { ok: false; kind: 'missing' | 'malformed' | 'unreadable'; detail: string } {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT')
      return { ok: false, kind: 'missing', detail: 'state file does not exist' }
    return { ok: false, kind: 'unreadable', detail: code ?? errMessage(err) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { ok: false, kind: 'malformed', detail: `state file does not parse: ${errMessage(err)}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, kind: 'malformed', detail: 'state file is not a JSON object' }
  }
  return { ok: true, state: parsed as BridgeState }
}

/**
 * Reader entry point. Returns a typed result on a SEPARATE axis from the
 * entry's own `verdict` field — a corrupt or unreadable state file is never
 * reported as "no entry" (A5.5.2's correction-of-record finding).
 */
export function readEntryResult(
  key: string,
  path: string = resolveBridgeStatePath()
): BridgeReadResult {
  const raw = readRawState(path)
  if (!raw.ok) {
    if (raw.kind === 'missing') return { status: 'missing' }
    return { status: raw.kind, detail: raw.detail }
  }
  const entry = raw.state[key]
  if (entry === undefined || entry === null) return { status: 'missing' }
  const e = entry as Partial<BridgeEntry>
  if (
    typeof e !== 'object' ||
    typeof e.verdict !== 'string' ||
    typeof e.evaluatedAt !== 'string' ||
    typeof e.reason !== 'string'
  ) {
    return { status: 'malformed', detail: 'entry is missing required fields' }
  }
  return { status: 'ok', entry: entry as BridgeEntry }
}

/** Fail-soft whole-state read, for the writer's own debounce/liveness-fold read. `{}` on any error. */
export function readState(path: string = resolveBridgeStatePath()): BridgeState {
  const raw = readRawState(path)
  return raw.ok ? raw.state : {}
}

// ---- Writer: single-flight lock, ownership token, atomic write -----------

export interface BridgeLockHandle {
  token: string
  lockDir: string
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM' // exists, owned by another user
  }
}

function readOwner(lockDir: string): { pid: number; token: string } | null {
  try {
    const raw = readFileSync(join(lockDir, 'owner'), 'utf8').trim()
    const sp = raw.indexOf(' ')
    if (sp < 0) return null
    const pid = Number(raw.slice(0, sp))
    const token = raw.slice(sp + 1)
    if (!Number.isFinite(pid) || !token) return null
    return { pid, token }
  } catch {
    return null
  }
}

function tryAcquireOnce(lockDir: string, token: string): boolean {
  try {
    mkdirSync(lockDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
    return false
  }
  try {
    writeFileSync(join(lockDir, 'owner'), `${process.pid} ${token}`)
  } catch {
    // Non-fatal: a failed owner-file write just means a future stale-reclaim
    // check can't verify liveness and will correctly refuse to reclaim (fail
    // toward "don't steal it"), matching mcp-disconnect-state.ts's precedent.
  }
  return true
}

/** D1.3: age AND an independently-confirmed-dead holder — age alone never reclaims a live holder. */
function maybeReclaimStale(lockDir: string, staleMs: number): void {
  let ageMs: number
  try {
    ageMs = Date.now() - statSync(lockDir).mtimeMs
  } catch {
    return // lock vanished between our failed mkdir and this stat — fine, the next loop retries mkdir
  }
  if (ageMs <= staleMs) return
  const owner = readOwner(lockDir)
  if (!owner || isProcessAlive(owner.pid)) return // can't verify liveness, or still alive — never reclaim
  try {
    rmSync(lockDir, { recursive: true, force: true })
  } catch {
    // another caller may have reclaimed it first — fine, the next loop retries mkdir
  }
}

/**
 * Acquire the single-flight probe lock. `timeoutMs` bounds how long this call
 * waits for a live holder to finish — NOT the stale-reclaim threshold, which
 * is `staleMs` (defaults to {@link LOCK_STALE_MS}). The git hook's own
 * 60s-timeout/65s-SIGKILL wrapper around the whole writer process is the
 * outer bound that makes a stuck acquire harmless to the caller.
 */
export async function acquireBridgeLock(
  timeoutMs = 65_000,
  pollMs = 20,
  staleMs = LOCK_STALE_MS
): Promise<BridgeLockHandle | null> {
  const lockDir = resolveLockDirPath()
  mkdirSync(dirname(lockDir), { recursive: true })
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (tryAcquireOnce(lockDir, token)) {
      // Re-verify ownership immediately (TOCTOU: a racer could have reclaimed
      // and re-acquired in the gap between our mkdir and this read).
      const owner = readOwner(lockDir)
      if (owner && owner.token === token) return { token, lockDir }
      return null
    }
    maybeReclaimStale(lockDir, staleMs)
    if (Date.now() >= deadline) return null
    await sleep(pollMs)
  }
}

/** Whether `handle` is still the recorded owner — call immediately before the atomic rename (D1.3). */
export function bridgeLockStillHeld(handle: BridgeLockHandle): boolean {
  const owner = readOwner(handle.lockDir)
  return owner !== null && owner.token === handle.token
}

export function releaseBridgeLock(handle: BridgeLockHandle): void {
  if (bridgeLockStillHeld(handle)) {
    try {
      rmSync(handle.lockDir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
}

/**
 * Whether a new probe should run, given the prior entry — the 24h debounce
 * on `evaluatedAt` (D1.3). Call ONLY while holding the lock: a second writer
 * queued behind the first re-reads the state under the lock and observes the
 * first's entry, so it declines rather than re-probing. A malformed/missing
 * `evaluatedAt` is treated as "needs a probe" (fail toward probing, not
 * toward silence).
 */
export function shouldProbe(
  prior: BridgeEntry | null,
  nowMs: number,
  debounceMs = DEBOUNCE_MS
): boolean {
  if (!prior) return true
  const priorMs = Date.parse(prior.evaluatedAt)
  return !Number.isFinite(priorMs) || nowMs - priorMs >= debounceMs
}

/**
 * Atomic (temp + rename) write of a single entry, preserving other keys —
 * BUT aborts without writing if `handle`'s token no longer holds (D1.3's
 * takeover defence: a holder paused past {@link LOCK_STALE_MS} can be
 * displaced by a replacement, and must not be able to overwrite the
 * replacement's write on resume). The token is re-read immediately before
 * the rename, not merely at call entry, to keep the race window as small as
 * possible. No "keep-worst" special-casing — D1.3 withdrew that design
 * (it was unnecessary once the lock spans probe-through-write, and harmful:
 * it would latch a false degradation with no clearing rule). The first
 * successful write past the debounce window always writes what it measured,
 * including `healthy` over a prior `degraded`.
 */
export function writeEntryIfOwned(
  key: string,
  entry: BridgeEntry,
  handle: BridgeLockHandle,
  path: string = resolveBridgeStatePath()
): boolean {
  const state = readState(path)
  state[key] = entry
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  if (!bridgeLockStillHeld(handle)) {
    try {
      rmSync(tmp)
    } catch {
      // best-effort cleanup of the orphaned temp file
    }
    return false
  }
  renameSync(tmp, path)
  return true
}

// ---- Liveness arm (A5.5.2, in the liveness-state.ts shape) ----------------

/**
 * Folds one probe's observed counters into the prior entry's streak. Both
 * counters must be present (non-null) on both this run and the prior one to
 * count as "unmoved" — a probe that could not read them (server unreachable,
 * malformed payload) resets the streak rather than silently extending it
 * over missing data.
 */
export function foldLiveness(
  prior: BridgeEntry | null,
  patternsLearned: number | null,
  trajectoriesRecorded: number | null
): number {
  const unmoved =
    prior != null &&
    prior.patternsLearned != null &&
    prior.trajectoriesRecorded != null &&
    patternsLearned != null &&
    trajectoriesRecorded != null &&
    prior.patternsLearned === patternsLearned &&
    prior.trajectoriesRecorded === trajectoriesRecorded
  return unmoved ? prior.consecutiveNoLearning + 1 : 0
}

// ---- Render ----------------------------------------------------------
// Split into `ruflo-bridge-state.render.ts` to stay under this repo's
// <500-line-per-file convention — re-exported here so callers (and the
// writer) can import everything from this one module, matching the sibling
// state modules' single-entry-point shape.
export {
  renderBridgeBanner,
  renderBridgeLivenessLine,
  renderBridgeVerdictLine,
} from './ruflo-bridge-state.render.js'

// ---- internal helpers --------------------------------------------------

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function ymdLocal(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
