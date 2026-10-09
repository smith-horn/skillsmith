/**
 * SMI-6975 — type declarations for scripts/lib/collision-rules.mjs.
 *
 * Lets scripts/lib/release-collision.ts (a .ts file) import the shared
 * publish-collision rule evaluators cleanly under this gate's bundler module
 * resolution without @ts-expect-error suppression. The .d.mts extension is
 * the correct pairing for a .mjs module, mirroring the existing
 * scripts/lib/project-dir.d.mts / scripts/lib/linear-client.d.mts convention.
 *
 * Signatures transcribed from the .mjs source's own JSDoc, not invented --
 * that file (and its CANONICAL ERROR MESSAGES header comment) is the single
 * source of truth and this declaration must not drift from it.
 */

export type RuleFailure = { ok: false; message: string }
export type RulePass = { ok: true }

/** Rule 1 -- reserved-range refuse (no override). */
export function evaluateReservedRange(pkg: string, target: string): RulePass | RuleFailure

/** Rule 3 -- exact-equal-published refuse (no override). */
export function evaluateAlreadyPublished(
  pkg: string,
  target: string,
  allVersions: string[]
): RulePass | (RuleFailure & { maxForDiagnostic: string | null })

/** Rule 2 -- proposed <= live max refuse (overridable in TS via allowDowngrade). */
export function evaluateLiveMax(
  pkg: string,
  target: string,
  live: string[],
  opts?: { allowDowngrade?: boolean }
): RulePass | (RuleFailure & { suggestedNext: string })

/** Convenience: Rules 1 -> 3 -> 2 in canonical order; first failure wins. */
export function evaluateCollisionRules(
  pkg: string,
  target: string,
  allVersions: string[],
  opts?: { allowDowngrade?: boolean }
):
  | { ok: true; message: string }
  | {
      ok: false
      message: string
      rule: 1 | 2 | 3
      suggestedNext?: string
      maxForDiagnostic?: string | null
    }
