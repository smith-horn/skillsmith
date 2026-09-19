/**
 * Core acquire loop + `StuckLockError` for the owned-lock primitive.
 * @module @skillsmith/core/config/owned-lock.acquire
 * @see owned-lock.ts for the full soundness argument and the PUBLIC API.
 * @see owned-lock.claim.ts for claim parsing, exclusive creation, and reclaim.
 *
 * INTERNAL module -- not part of the public surface (no `package.json`
 * subpath export), split out of `owned-lock.claim.ts` purely to keep both
 * files under the repo's 500-line-per-file gate. `owned-lock.ts`'s public
 * `acquireOwnedLock` is a thin wrapper over this file's
 * {@link acquireOwnedLockCore}; the cross-process race-test child harness
 * imports directly from here, by relative path, specifically to reach the
 * two destructive test-only options
 * ({@link AcquireOwnedLockCoreOptions.unsafeSkipReclaimRevalidation} and
 * `.linkSyncOverride`) that must NEVER be reachable via the public
 * `@skillsmith/core/config/owned-lock` subpath.
 */

import { hostname } from 'node:os'

import {
  classifyRefusal,
  createLockExclusive,
  isOwnerDefinitelyDead,
  makeRelease,
  randomHex,
  readClaim,
  sleepSync,
  tryReclaimUnderLock,
} from './owned-lock.claim.js'
import {
  LOCK_ACQUIRE_TIMEOUT_MS,
  LOCK_RETRY_DELAY_MS,
  RECLAIM_LOCK_TIMEOUT_MS,
  RECLAIM_PROBE_AFTER_MS,
  RECLAIM_PROBE_INTERVAL_MS,
} from './owned-lock.types.js'
import type { Claim, ReclaimOutcome, RefusalCategory, StuckLockReason } from './owned-lock.types.js'

function describeReason(reason: StuckLockReason, claim: Claim, reclaimPath: string): string {
  switch (reason) {
    case 'held':
      // No "(still alive)" here (SMI-6764): `held` is also the SAFE DEFAULT
      // when the liveness probe never ran -- a `timeoutMs` shorter than
      // `reclaimProbeAfterMs` expires first -- so this branch is reachable
      // with a pid that was never probed, and measurably was: a deliberately
      // dead pid rendered "still alive". Report the claim, not a liveness
      // conclusion this function has no standing to draw.
      return claim.kind === 'v1'
        ? `held by pid ${claim.pid} on host '${claim.host}'`
        : 'held by another process'
    case 'unreclaimable_legacy':
      return (
        'held by a legacy (pre-v1) claim' +
        (claim.kind === 'legacy' ? ` (pid ${claim.pid})` : '') +
        ' -- legacy claims carry no host attribution and are NEVER auto-reclaimed (SMI-5883 D-5)'
      )
    case 'unreclaimable_unparseable':
      return 'the lock file could not be parsed as a recognized claim -- never auto-reclaimed'
    case 'reclaim_unavailable':
      return `the reclaim lock at ${reclaimPath} is held or was orphaned by a crash inside the reclaim critical section (residual R1)`
    case 'reclaim_disabled':
      return 'auto-reclaim is disabled (SKILLSMITH_LOCK_NO_AUTO_RECLAIM=1)'
    default: {
      const exhaustive: never = reason
      return exhaustive
    }
  }
}

/**
 * What the caller should do about this refusal, per reason.
 *
 * This exists because the opening verb used to carry it and could not
 * (SMI-6764). A verb is binary; three of these five reasons have an answer
 * that depends on facts `reason` does not carry, so any binary split has to
 * guess at them. Saying "it depends, and on this" is both honest and more
 * useful than a guess -- and unlike a verb, it can be right.
 */
export function describeRemedy(reason: StuckLockReason): string {
  switch (reason) {
    case 'held':
      return 'A live holder is expected to release, so retrying is the right first response.'
    case 'reclaim_unavailable':
      // The two halves `describeReason` already names have OPPOSITE answers,
      // and nothing in `reason` separates them: a concurrent reclaim clears in
      // milliseconds, while an orphaned reclaim lock never clears at all --
      // nothing probes the reclaim lock's own owner for liveness.
      return (
        'If a reclaim is in flight, retrying clears this. If it persists, the reclaim lock named ' +
        'below was orphaned by a crash inside the critical section; nothing reclaims that one ' +
        'automatically, so only the manual steps clear it.'
      )
    case 'unreclaimable_legacy':
      return (
        'A legacy claim is never auto-reclaimed, in any configuration (SMI-5883 D-5). If its ' +
        'process is alive it still releases on its own; if it is dead, only the manual steps clear it.'
      )
    case 'unreclaimable_unparseable':
      return 'An unparseable claim is never auto-reclaimed, so only the manual steps clear it.'
    case 'reclaim_disabled':
      return (
        'The holder is already dead and auto-reclaim is off in this process, so retrying HERE ' +
        'cannot reclaim it -- though a peer process without SKILLSMITH_LOCK_NO_AUTO_RECLAIM set ' +
        'still can. Unset it here and restart this process, or use the manual steps.'
      )
    default: {
      const exhaustive: never = reason
      return exhaustive
    }
  }
}

/**
 * Thrown when {@link acquireOwnedLockCore} (and, through it, the public
 * `acquireOwnedLock`) gives up. `reason` is a stable discriminant for
 * mechanical triage (never prose-matching); the message embeds the manual
 * unstick procedure verbatim.
 *
 * **One verb, for every reason (SMI-6764).** Two earlier rounds tried to pick
 * between "Timed out waiting" and "Could not acquire" per reason, to separate
 * ordinary contention from a state needing action. Round 1 got the reason list
 * wrong; round 2 found it duplicated across two layers; round 3 found the
 * partition does not exist. `StuckLockReason` is not a total function onto
 * "retry helps / retry does not": `reclaim_unavailable` depends on whether the
 * reclaim lock is busy or orphaned, `unreclaimable_legacy` on whether the
 * legacy holder is alive, and `reclaim_disabled` on whether a
 * differently-configured peer exists. The binary verb had to guess, and it
 * guessed wrong for an orphaned reclaim lock -- which never clears, and read
 * "Timed out waiting".
 *
 * "Could not acquire" is the honest superset: true for every reason, and it
 * asserts nothing about elapsed time or about whether retrying helps. The old
 * verb also claimed a timeout this class frequently never measured --
 * `file-lock.ts` calls in with `timeoutMs: 0` and keeps its own 30s budget
 * outside, so the wait that message described was zero milliseconds.
 * {@link describeRemedy} now carries what the verb was reaching for, per
 * reason, and can say "it depends, on this" where that is the truth.
 *
 * The unstick procedure is identical for every reason. Step 1 in particular is
 * load-bearing for `unreclaimable_legacy`, whose claim may be a LIVE process.
 */
export class StuckLockError extends Error {
  readonly lockPath: string
  readonly reclaimPath: string
  readonly reason: StuckLockReason

  constructor(
    lockPath: string,
    reclaimPath: string,
    label: string,
    reason: StuckLockReason,
    claim: Claim
  ) {
    const namesReclaim = reason === 'reclaim_unavailable'
    const message =
      `[skillsmith] Could not acquire ${label} at ${lockPath}: ` +
      `${describeReason(reason, claim, reclaimPath)}. ${describeRemedy(reason)} ` +
      `Manual unstick -- 1) confirm no skillsmith process is running: ps -ax | grep -E '[s]killsmith|[s]klx'; ` +
      `2) inspect (read-only): cat ${lockPath}${namesReclaim ? ` ; cat ${reclaimPath}` : ''}; ` +
      `3) remove ONLY the file(s) named above: rm ${lockPath}${namesReclaim ? ` ; rm ${reclaimPath}` : ''}.`
    super(message)
    this.name = 'StuckLockError'
    this.lockPath = lockPath
    this.reclaimPath = reclaimPath
    this.reason = reason
  }
}

function mapRefusalToReason(refusal: RefusalCategory | ReclaimOutcome): StuckLockReason {
  switch (refusal) {
    case 'legacy':
      return 'unreclaimable_legacy'
    case 'unparseable':
      return 'unreclaimable_unparseable'
    case 'reclaim-disabled':
      return 'reclaim_disabled'
    case 'unavailable':
      return 'reclaim_unavailable'
    default:
      // 'held' | 'not-stale' | 'gone' | 'reclaimed' (the latter two never
      // reach the caller as a refusal -- they trigger an immediate retry).
      return 'held'
  }
}

/**
 * Full internal option set, including the two options the public
 * `AcquireOwnedLockOptions` (owned-lock.types.ts) deliberately omits.
 */
export interface AcquireOwnedLockCoreOptions {
  timeoutMs?: number
  label?: string
  reclaimProbeAfterMs?: number
  reclaimLockTimeoutMs?: number
  onReclaimBoundary?: () => void
  onReclaimOutcome?: (outcome: ReclaimOutcome) => void
  /** @internal NEGATIVE CONTROL ONLY (owned-lock-reclaim-race.test.ts §8b). Removes the authoritative re-read that makes this mechanism sound -- reintroduces the round-3 lock-theft race on purpose. Never set outside that spec, and never reachable via the public acquireOwnedLock(). */
  unsafeSkipReclaimRevalidation?: boolean
  /** @internal test seam (owned-lock.test.ts item 14). Never reachable via the public acquireOwnedLock(). */
  linkSyncOverride?: (existingPath: string, newPath: string) => void
}

/**
 * A timing option as a finite, non-negative number of milliseconds. Anything
 * else (NaN, Infinity, a negative number) falls back to `fallback`: a NaN
 * deadline never passes, so it hung the synchronous wait loop forever
 * (SMI-6529 round 9).
 */
export function toTimingMs(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * The full acquire loop. `owned-lock.ts`'s public `acquireOwnedLock` is a
 * thin wrapper over this that only ever forwards the PUBLIC-SAFE option
 * subset -- see the module-level comment above for why the two unsafe
 * options must never be reachable from there.
 */
export function acquireOwnedLockCore(
  target: string,
  opts: AcquireOwnedLockCoreOptions = {}
): () => void {
  const lockPath = `${target}.lock`
  const reclaimPath = `${lockPath}.reclaim`
  const token = randomHex(8)
  const label = opts.label ?? 'lock'
  const timeoutMs = toTimingMs(opts.timeoutMs, LOCK_ACQUIRE_TIMEOUT_MS)
  const reclaimLockTimeoutMs = toTimingMs(opts.reclaimLockTimeoutMs, RECLAIM_LOCK_TIMEOUT_MS)
  const started = Date.now()
  const deadline = started + timeoutMs
  let nextProbeAt = started + toTimingMs(opts.reclaimProbeAfterMs, RECLAIM_PROBE_AFTER_MS)
  let lastRefusal: RefusalCategory | ReclaimOutcome = 'held' // safe default: EEXIST already implies SOMETHING is there
  let lastObservedClaim: Claim = { kind: 'absent' }

  for (;;) {
    const record =
      JSON.stringify({ v: 1, pid: process.pid, token, host: hostname(), acquiredAt: Date.now() }) +
      '\n'
    if (createLockExclusive(lockPath, record, opts.linkSyncOverride)) {
      return makeRelease(lockPath, token)
    }

    // ---- contended ----
    if (Date.now() >= nextProbeAt) {
      const claim = readClaim(lockPath)
      lastObservedClaim = claim
      if (isOwnerDefinitelyDead(claim)) {
        opts.onReclaimBoundary?.()
        const outcome: ReclaimOutcome = tryReclaimUnderLock(lockPath, reclaimPath, {
          unsafeSkipRevalidation: opts.unsafeSkipReclaimRevalidation,
          linkSyncOverride: opts.linkSyncOverride,
          reclaimLockTimeoutMs,
        })
        opts.onReclaimOutcome?.(outcome)
        if (outcome === 'reclaimed' || outcome === 'gone') {
          nextProbeAt = 0 // retry create at once -- don't burn the backoff budget
          continue
        }
        lastRefusal = outcome // 'not-stale' | 'unavailable'
      } else {
        // SMI-6529 round 8: a claim that vanished between our EEXIST and this
        // read was released by a live holder. That is contention, not a
        // corrupt lock; calling it 'unparseable' made a non-waiting caller
        // give up and advise `rm` on a lock another process may just have taken.
        lastRefusal = claim.kind === 'absent' ? 'held' : classifyRefusal(claim)
      }
      nextProbeAt = Date.now() + RECLAIM_PROBE_INTERVAL_MS
    }

    if (Date.now() >= deadline) {
      // A final, read-only claim fetch purely for an accurate message -- does
      // NOT affect the reclaim decision or `lastRefusal`. Needed because a
      // very tight `timeoutMs` (shorter than `reclaimProbeAfterMs`) can
      // otherwise expire before the periodic probe above ever runs once.
      if (lastObservedClaim.kind === 'absent') {
        lastObservedClaim = readClaim(lockPath)
      }
      throw new StuckLockError(
        lockPath,
        reclaimPath,
        label,
        mapRefusalToReason(lastRefusal),
        lastObservedClaim
      )
    }
    sleepSync(LOCK_RETRY_DELAY_MS)
  }
}
