// Single source of truth for npm reserved/deprecated version ranges. Consumed
// by `scripts/lib/collision-rules.mjs` (the unified rule pipeline shared by
// prepare-release.ts AND check-publish-collision.mjs). Drift between the two
// collision implementations is the failure mode this module exists to prevent.
//
// SMI-4207 / ADR-115: `@skillsmith/core@2.0.0`–`2.1.2` were self-published in
// January 2026 during an aborted version-strategy experiment and rolled back to
// the 0.4.x line. The full `>=2.0.0 <3.0.0` range is permanently deprecated on
// npm — the next major for `@skillsmith/core` jumps from 0.x straight to 3.0.0.
//
// `.mjs` (not `.ts`) so the existing `node scripts/check-publish-collision.mjs`
// shape — runnable from GitHub Actions without a `tsx` runtime or build step —
// continues to work. Plain ESM is interop-friendly with both .ts (tsx-callers)
// and .mjs (shim-callers).

/**
 * Map of package name → semver range that is permanently reserved on npm.
 * Versions inside the range:
 *   - MUST NOT be proposed for new publishes (collision check refuses).
 *   - MUST be filtered out of the "live max" pool (so normal patches on a
 *     newer/lower line aren't blocked by orphaned higher entries).
 *   - MUST still be refused on republish-of-existing (the `cleaned.includes`
 *     check uses the FULL list, not the filtered live list).
 */
export const RESERVED_RANGES = Object.freeze({
  '@skillsmith/core': '>=2.0.0 <3.0.0',
})

/**
 * Filter a list of published versions to exclude any that fall inside the
 * package's reserved range. Used to compute the "live max" anchor for
 * collision checks — orphaned reserved versions must not block normal bumps.
 *
 * Pure function; preserves input order. Returns the same array reference
 * (semantically) when no range is registered for the package.
 *
 * @param {string} pkg - package name (e.g., "@skillsmith/core")
 * @param {string[]} versions - candidate versions (already validated by caller)
 * @param {{satisfies: (v: string, range: string) => boolean}} semver - injected
 *   semver module so .mjs and .ts callers can both pass their own (avoids
 *   pinning this module to a specific semver version path).
 * @returns {string[]} versions outside the reserved range
 */
export function filterReservedVersions(pkg, versions, semver) {
  const range = RESERVED_RANGES[pkg]
  if (!range) return versions
  return versions.filter((v) => !semver.satisfies(v, range))
}

/**
 * Return true if `version` falls inside `pkg`'s reserved range.
 *
 * @param {string} pkg - package name
 * @param {string} version - candidate version (must be valid semver)
 * @param {{satisfies: (v: string, range: string) => boolean}} semver - injected
 * @returns {boolean}
 */
export function isReserved(pkg, version, semver) {
  const range = RESERVED_RANGES[pkg]
  return Boolean(range && semver.satisfies(version, range))
}
