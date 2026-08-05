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
  RECLAIM_PROBE_AFTER_MS,
  RECLAIM_PROBE_INTERVAL_MS,
} from './owned-lock.types.js'
import type { Claim, ReclaimOutcome, RefusalCategory, StuckLockReason } from './owned-lock.types.js'

function describeReason(reason: StuckLockReason, claim: Claim, reclaimPath: string): string {
  switch (reason) {
    case 'held':
      return claim.kind === 'v1'
        ? `held by pid ${claim.pid} on host '${claim.host}' (still alive)`
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
 * Thrown when {@link acquireOwnedLockCore} (and, through it, the public
 * `acquireOwnedLock`) times out. `reason` is a stable discriminant for
 * mechanical triage (never prose-matching); the message embeds the manual
 * unstick procedure verbatim.
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
      `[skillsmith] Timed out waiting for ${label} at ${lockPath}: ${describeReason(reason, claim, reclaimPath)}. ` +
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
  onReclaimBoundary?: () => void
  onReclaimOutcome?: (outcome: ReclaimOutcome) => void
  /** @internal NEGATIVE CONTROL ONLY (owned-lock-reclaim-race.test.ts §8b). Removes the authoritative re-read that makes this mechanism sound -- reintroduces the round-3 lock-theft race on purpose. Never set outside that spec, and never reachable via the public acquireOwnedLock(). */
  unsafeSkipReclaimRevalidation?: boolean
  /** @internal test seam (owned-lock.test.ts item 14). Never reachable via the public acquireOwnedLock(). */
  linkSyncOverride?: (existingPath: string, newPath: string) => void
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
  const timeoutMs = opts.timeoutMs ?? LOCK_ACQUIRE_TIMEOUT_MS
  const started = Date.now()
  const deadline = started + timeoutMs
  let nextProbeAt = started + (opts.reclaimProbeAfterMs ?? RECLAIM_PROBE_AFTER_MS)
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
        })
        opts.onReclaimOutcome?.(outcome)
        if (outcome === 'reclaimed' || outcome === 'gone') {
          nextProbeAt = 0 // retry create at once -- don't burn the backoff budget
          continue
        }
        lastRefusal = outcome // 'not-stale' | 'unavailable'
      } else {
        lastRefusal = classifyRefusal(claim)
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
