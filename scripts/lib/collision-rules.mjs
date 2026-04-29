// SMI-4531: Single source of truth for the three collision rules shared by
// scripts/check-publish-collision.mjs (publish.yml guard, sync, single-package)
// and scripts/prepare-release.ts (release-prep, async, multi-plan). Each rule
// is a pure function — callers fetch versions and decide what to do with the
// result (the .mjs guard maps to {code, message}; the .ts caller accumulates
// {ok, errors[], report[]}).
//
// `.mjs` (not `.ts`) so the GitHub Actions guard does not need a tsx runtime;
// .ts callers import via standard ESM interop.
//
// CANONICAL ERROR MESSAGES — STABLE CONTRACT.
// The three messages below are the public contract for both callers and for
// the snapshot tests in scripts/tests/collision-rules.test.ts. Any change
// requires an SMI ref + retro entry. CODEOWNERS pins this file to release-eng
// so a future author can't drift the strings without sign-off.
//
//   Rule 1 (reserved-range, no override):
//     "${pkg}: proposed ${target} falls inside the reserved 2.x range
//     (>=2.0.0 <3.0.0). This range is permanently deprecated on npm — the
//     next major must jump to 3.0.0 or later. No override flag applies. See
//     ADR-115 (docs/internal/adr/115-skillsmith-core-version-namespace-reconciliation.md)."
//
//   Rule 3 (already-published, no override):
//     "${pkg}: proposed ${target} is already published on npm (highest
//     published: ${maxForDiagnostic | "(none — all reserved)"}). Different
//     content under the same version is the failure mode this guard exists
//     to prevent. Revert to release, do not override."
//
//   Rule 2 (live-max <=, overridable in TS via --allow-downgrade):
//     "${pkg}: proposed ${target} <= highest published ${liveMax}. Note:
//     "highest published" spans all dist-tags — npm refuses to republish any
//     existing semver. Suggested next-available: ${suggested}. To override
//     (TS only): pass --allow-downgrade."

import semver from 'semver'

import { filterReservedVersions, isReserved } from './reserved-ranges.mjs'

/**
 * Rule 1 — reserved-range refuse (no override).
 *
 * @param {string} pkg - package name
 * @param {string} target - proposed version (must be valid semver)
 * @returns {{ok: true} | {ok: false, message: string}}
 */
export function evaluateReservedRange(pkg, target) {
  if (!semver.valid(target)) return { ok: true }
  if (!isReserved(pkg, target, semver)) return { ok: true }
  return {
    ok: false,
    message:
      `${pkg}: proposed ${target} falls inside the reserved 2.x range (>=2.0.0 <3.0.0). ` +
      `This range is permanently deprecated on npm — the next major must jump to 3.0.0 or later. ` +
      `No override flag applies. See ADR-115 (docs/internal/adr/115-skillsmith-core-version-namespace-reconciliation.md).`,
  }
}

/**
 * Rule 3 — exact-equal-published refuse (no override).
 *
 * `maxForDiagnostic` is computed from the live (filtered) pool when non-empty,
 * else from the full pool — matches both prior implementations. When every
 * entry sits in the reserved range AND the proposed version is not in the
 * full list, callers should treat this rule as a pass; the caller dispatches
 * to Rule 2 (which itself short-circuits to "no live versions, proceed" via
 * its own caller; not this module's concern).
 *
 * Special case: when the proposed version IS in the full list AND every
 * published entry sits in the reserved range, the diagnostic is "(none — all
 * reserved)" — there is no meaningful live max to display.
 *
 * @param {string} pkg
 * @param {string} target
 * @param {string[]} allVersions - raw npm view output, post valid-filter
 * @returns {{ok: true} | {ok: false, message: string, maxForDiagnostic: string | null}}
 */
export function evaluateAlreadyPublished(pkg, target, allVersions) {
  if (!allVersions.includes(target)) return { ok: true }
  const live = filterReservedVersions(pkg, allVersions, semver)
  let maxForDiagnostic = null
  if (live.length > 0) {
    maxForDiagnostic = live.reduce((a, b) => (semver.gt(a, b) ? a : b))
  } else if (allVersions.length > 0) {
    // Fall back to the unfiltered max only when we have something to show.
    maxForDiagnostic = allVersions.reduce((a, b) => (semver.gt(a, b) ? a : b))
  }
  // If every entry is reserved AND the proposed equals one of them, render
  // the canonical "(none — all reserved)" diagnostic instead of the reserved
  // version itself — the message is about the live line, not the orphan.
  const display =
    live.length === 0 && allVersions.length > 0 ? '(none — all reserved)' : maxForDiagnostic
  return {
    ok: false,
    message:
      `${pkg}: proposed ${target} is already published on npm (highest published: ${display}). ` +
      `Different content under the same version is the failure mode this guard exists to prevent. ` +
      `Revert to release, do not override.`,
    maxForDiagnostic,
  }
}

/**
 * Rule 2 — proposed <= live max refuse (overridable in TS via allowDowngrade).
 *
 * Caller decides whether to honor `allowDowngrade` — pass `true` to make this
 * always return `{ok: true}` when the underlying check would otherwise refuse.
 * The publish.yml guard passes `false` (no override); prepare-release passes
 * the user's flag.
 *
 * `live` MUST be the post-`filterReservedVersions` pool. If `live` is empty,
 * this rule passes (caller has no live anchor — typically wraps with its own
 * "no live versions, proceeding" message before calling).
 *
 * @param {string} pkg
 * @param {string} target
 * @param {string[]} live - post-filterReservedVersions pool
 * @param {{allowDowngrade?: boolean}} [opts]
 * @returns {{ok: true} | {ok: false, message: string, suggestedNext: string}}
 */
export function evaluateLiveMax(pkg, target, live, opts = {}) {
  if (!semver.valid(target)) return { ok: true }
  if (!live.length) return { ok: true }
  const max = live.reduce((a, b) => (semver.gt(a, b) ? a : b))
  if (semver.gt(target, max)) return { ok: true }
  if (opts.allowDowngrade) return { ok: true }
  const suggestedNext = semver.inc(max, 'patch') ?? max
  return {
    ok: false,
    message:
      `${pkg}: proposed ${target} <= highest published ${max}. ` +
      `Note: "highest published" spans all dist-tags — npm refuses to republish any existing semver. ` +
      `Suggested next-available: ${suggestedNext}. ` +
      `To override (TS only): pass --allow-downgrade.`,
    suggestedNext,
  }
}

/**
 * Convenience: evaluate Rules 1 → 3 → 2 in canonical order for a single
 * package and return the first failure. On full pass returns
 * `{ok: true, message}` with a benign proceed message. Callers that want
 * per-rule branching (e.g. to emit different reports for Rule 1 vs Rule 2)
 * should call the individual evaluators.
 *
 * Multi-package contract is the CALLER's responsibility — never short-circuit
 * across packages. Within a single package, the first failing rule wins.
 *
 * @param {string} pkg
 * @param {string} target
 * @param {string[]} allVersions - raw post-valid-filter list
 * @param {{allowDowngrade?: boolean}} [opts]
 * @returns {{ok: true, message: string} | {ok: false, message: string, rule: 1 | 2 | 3, suggestedNext?: string, maxForDiagnostic?: string | null}}
 */
export function evaluateCollisionRules(pkg, target, allVersions, opts = {}) {
  const r1 = evaluateReservedRange(pkg, target)
  if (!r1.ok) return { ok: false, message: r1.message, rule: 1 }

  const r3 = evaluateAlreadyPublished(pkg, target, allVersions)
  if (!r3.ok)
    return { ok: false, message: r3.message, rule: 3, maxForDiagnostic: r3.maxForDiagnostic }

  const live = filterReservedVersions(pkg, allVersions, semver)
  const r2 = evaluateLiveMax(pkg, target, live, opts)
  if (!r2.ok) return { ok: false, message: r2.message, rule: 2, suggestedNext: r2.suggestedNext }

  // All three rules pass. Compose a benign proceed message.
  if (!live.length) {
    return {
      ok: true,
      message: `${pkg}: no live versions published yet (all entries inside reserved range), proceeding`,
    }
  }
  const max = live.reduce((a, b) => (semver.gt(a, b) ? a : b))
  return {
    ok: true,
    message: `${pkg}: proposed ${target} > highest published ${max}, safe to publish`,
  }
}
