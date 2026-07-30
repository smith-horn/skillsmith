/**
 * Two-level owned-lock primitive (SMI-5883 Wave 2, design revision 4).
 * @module @skillsmith/core/config/owned-lock
 *
 * Replaces the single-level, age-based `acquireConfigLock` mechanism (which
 * `config-atomic-write.ts` now implements as a thin wrapper over
 * {@link acquireOwnedLock}). The single-level design was found unsound in
 * round-3 review: it turned "I inspected this path and concluded the holder
 * is dead" (computed in one region) into an unconditional
 * `unlinkSync(lockPath)` (performed in another), with no mutual exclusion
 * between the two. Any process that recreated the path in between had its
 * LIVE lock destroyed by a contender acting on a stale decision.
 *
 * The general defect, stated so the fix can be checked against it: it is
 * never sound to turn "I inspected this path and concluded X" into an
 * unconditional destructive operation on that path, unless the interval
 * between inspection and destruction excludes every actor that could change
 * what the path holds. This module does not make the destruction
 * conditional (POSIX offers no delete-if-inode primitive) -- it makes the
 * interval exclusive, via a SECOND lock file (`<target>.lock.reclaim`,
 * `owned-lock.claim.ts`'s `tryReclaimUnderLock`) that must be held before
 * any reclaimer may re-read and then unlink `<target>.lock`. Every
 * reclaimer therefore validates and destroys inside a region from which
 * every other reclaimer -- and, by construction, every other mutator of
 * that path -- is excluded. The authorization to reclaim can no longer go
 * stale between being computed and being consumed, because nothing that
 * could invalidate it is permitted to run in between.
 *
 * Two files, asymmetric policies:
 *   - `<target>.lock`         -- the caller's lock. Auto-reclaimed, but ONLY
 *     from inside the reclaim critical section.
 *   - `<target>.lock.reclaim` -- serializes reclaim DECISIONS about the lock
 *     above. Strict, NEVER auto-reclaimed (a staleness heuristic here would
 *     reintroduce the identical duplicate-delete race one level up).
 *
 * This module is a thin wrapper over `owned-lock.acquire.ts`'s
 * {@link acquireOwnedLockCore} -- it exists specifically so that the two
 * destructive test-only seams on the core loop's options
 * (`unsafeSkipReclaimRevalidation`, `linkSyncOverride`) are structurally
 * unreachable from the public `@skillsmith/core/config/owned-lock` subpath
 * export: this file's exported {@link AcquireOwnedLockOptions} simply does
 * not have those fields, and this file never re-exports the internal
 * `AcquireOwnedLockCoreOptions` type or `acquireOwnedLockCore` function
 * that do. See owned-lock.acquire.ts's module comment for the full rationale.
 *
 * New-race audit (N1-N9) and residual risks (R1-R5) are documented in the
 * SMI-5883 design doc; the short version: R1 (`SIGKILL` inside the
 * ~3-syscall reclaim critical section orphans the reclaim lock) is accepted
 * and loudly diagnosable ({@link StuckLockError} names both files + the
 * manual unstick procedure below); legacy (pre-v1, bare-decimal-PID) claims
 * and unparseable claims are NEVER auto-reclaimed (D-5/D-6) because they
 * carry no `host` field, so "dead on this host" cannot establish "dead" for
 * a claim that might belong to a process on a different host sharing a
 * networked `$HOME`.
 *
 * Manual unstick (required whenever a `StuckLockError` fires with a reason
 * other than `held`):
 *   1. Confirm no skillsmith process is running:
 *        ps -ax | grep -E '[s]killsmith|[s]klx'
 *   2. Inspect the claim (read-only, safe):
 *        cat <lockPath>
 *        cat <reclaimPath>          # only if the error named it
 *   3. Remove ONLY the file(s) the error named:
 *        rm <lockPath>
 *        rm <reclaimPath>
 *
 * Opt-out: `SKILLSMITH_LOCK_NO_AUTO_RECLAIM=1` disables auto-reclaim
 * entirely (degrades to the strict, no-reclaim design) -- a sound escape
 * hatch for R5 (an `os.hostname()` collision across two containers with
 * distinct PID namespaces bind-mounting the same `$HOME`). Registered in
 * `docs/internal/process/guards-and-opt-outs.md`.
 */

import { acquireOwnedLockCore, StuckLockError } from './owned-lock.acquire.js'
import type { AcquireOwnedLockOptions } from './owned-lock.types.js'

export type { AcquireOwnedLockOptions, StuckLockReason } from './owned-lock.types.js'
export {
  LOCK_ACQUIRE_TIMEOUT_MS,
  LOCK_RETRY_DELAY_MS,
  MAX_LOCK_BYTES,
  RECLAIM_LOCK_TIMEOUT_MS,
  RECLAIM_PROBE_AFTER_MS,
  RECLAIM_PROBE_INTERVAL_MS,
} from './owned-lock.types.js'
export { StuckLockError }

/**
 * Acquire an exclusive, cross-process, OWNED lock guarding `target`. Unlike
 * a plain create-exclusive lock, ownership is verified on release (a token,
 * not just presence) and staleness is verified by PROCESS LIVENESS, not file
 * age -- and reclaimed only from inside a second, strict-no-auto-reclaim
 * lock (`<target>.lock.reclaim`) that serializes reclaim decisions. See the
 * module docstring for the full soundness argument.
 *
 * @param target - Path being guarded (NOT the lock file itself -- the lock
 * file is `${target}.lock`, the reclaim lock `${target}.lock.reclaim`).
 * @returns A release function. Callers MUST call it exactly once, in a
 * `finally` block. Idempotent -- a second call is a no-op.
 *
 * SMI-5883 code-review round 2: `opts` is destructured field-by-field into a
 * FRESH object rather than forwarded as-is. TypeScript's excess-property
 * check only fires on an object LITERAL passed directly at the call site --
 * a caller passing a variable, a cast, or plain JavaScript (no type checking
 * at all) is not constrained by `AcquireOwnedLockOptions` omitting the two
 * unsafe fields, and `acquireOwnedLockCore` reads them by property name at
 * runtime. Rebuilding the object here means an injected
 * `unsafeSkipReclaimRevalidation`/`linkSyncOverride` on the caller's `opts`
 * is structurally dropped before it ever reaches the core loop, regardless
 * of what extra properties `opts` carries.
 *
 * SMI-5883 code-review round 3: the two unsafe fields are ALSO set to
 * `undefined` explicitly, as OWN properties of the fresh object, rather than
 * simply omitted. A plain `{ ...safeFields }` object still inherits from
 * `Object.prototype` -- if that prototype were ever globally polluted (a
 * distinct, severe vulnerability class in its own right, reachable only by
 * an attacker who already has arbitrary code execution in this process),
 * ordinary property access on an object with no OWN `unsafeSkipReclaimRevalidation`/
 * `linkSyncOverride` would still resolve them via the prototype chain. An
 * explicit own-property `undefined` shadows any such inherited value.
 */
export function acquireOwnedLock(target: string, opts: AcquireOwnedLockOptions = {}): () => void {
  return acquireOwnedLockCore(target, {
    timeoutMs: opts.timeoutMs,
    label: opts.label,
    reclaimProbeAfterMs: opts.reclaimProbeAfterMs,
    onReclaimBoundary: opts.onReclaimBoundary,
    onReclaimOutcome: opts.onReclaimOutcome,
    unsafeSkipReclaimRevalidation: undefined,
    linkSyncOverride: undefined,
  })
}
