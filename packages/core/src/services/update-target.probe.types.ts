/**
 * @fileoverview Shared types + error-sanitization helpers for the update
 * eligibility gate's probe (SMI-6532, A2 §4.2).
 * @module @skillsmith/core/services/update-target.probe.types
 *
 * WHY THIS FILE EXISTS: so `update-target.probe.ts` and
 * `update-target.probe.recovery.ts` never import FROM EACH OTHER. Before
 * this split, `probe.ts` imported the `defaultRecoveryPendingChecker` VALUE
 * from `probe.recovery.ts`, and `probe.recovery.ts` imported the
 * `RecoveryPendingChecker` TYPE back from `probe.ts` — safe today only
 * because a type-only import is erased before any runtime dependency graph
 * exists, but it READS as a circular import, and a future edit that turns
 * either side into a value import would make it a real one.
 * `RecoveryPendingChecker` lives here instead, so neither sibling module
 * imports the other at all — both depend only on this one, dependency-free
 * module. `ProbeError` lives here too: `update-target.probe.git-ancestor.ts`
 * (this probe's own bounded git-ancestor walk — see that module's
 * fileoverview) needs the identical sanitized-error shape, and importing it
 * FROM `probe.ts` would recreate the exact same "reads as circular" shape
 * this split exists to remove.
 *
 * `errnoOf`/`sanitizeError` live here for the same reason: both
 * `update-target.probe.ts` and `update-target.probe.git-ancestor.ts` need
 * the SAME error-sanitization rule (§4.2's SANITIZED ERRORS — `err.code`
 * only, never `err.message`/`err.stack`; the path THIS module asked for,
 * never one read back off the exception). Sharing this trivial extraction
 * helper is not the mistake that produced three rounds of findings on this
 * branch — sharing a WALK whose safety depended on a caller-proved
 * precondition was. A three-line string read has no precondition for a
 * caller to get wrong.
 */

/** Sanitized `{ path, errno }` — see this module's fileoverview. */
export interface ProbeError {
  path: string
  errno: string
}

/** Asked when a tracked folder is missing on every retry attempt: does a
 * `.skillsmith-staging/` record name it? See `update-target.probe.ts`'s
 * fileoverview. */
export type RecoveryPendingChecker = (input: {
  skillsDir: string
  dir: string
  dirName: string
}) => Promise<boolean>

/** `err.code`, sanitized to a bounded, known-shape errno string. */
export function errnoOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code
  return typeof code === 'string' && code ? code : 'UNKNOWN'
}

/** `{ path, errno }` from an intended path and a caught error — see this
 * module's fileoverview for why `intendedPath`, never `err.path`/`err.dest`. */
export function sanitizeError(intendedPath: string, err: unknown): ProbeError {
  return { path: intendedPath, errno: errnoOf(err) }
}
