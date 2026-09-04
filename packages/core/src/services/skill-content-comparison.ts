/**
 * @fileoverview Shared skill content-hash comparator
 * @module @skillsmith/core/services/skill-content-comparison
 * @see SMI-6343 Wave 2 — repair the content-hash comparison
 *
 * A single comparison function, consumed by every "is this skill outdated"
 * reader in the codebase (`packages/mcp-server/src/tools/outdated.ts`,
 * `packages/mcp-server/src/tools/skill-updates.ts`,
 * `packages/cli/src/utils/skills-directory.ts`) so they cannot drift apart
 * on what "current" / "outdated" / "unknown" means again — exactly the class
 * of bug an adversarial review caught in SMI-6343 Wave 1, where one
 * implementation was fixed and its siblings were left broken.
 *
 * Deliberately narrow: this function only adjudicates "do these two hashes
 * agree," given whatever installed-side and registry-side hash the caller
 * already resolved (manifest-recorded hash, on-disk SHA-256, live registry
 * lookup, cached `skill_versions` row — the callers differ on where the
 * hash comes from, not on how two hashes are compared). Richer per-caller
 * diagnosis (offline, quota-exhausted, network-error, identity-mismatch,
 * etc.) is caller-specific context this function has no visibility into —
 * callers layer their own explanation on top of the `reason` this returns.
 */

/** The three possible outcomes of comparing an installed hash to a registry hash. */
export type ContentComparisonOutcome = 'current' | 'outdated' | 'unknown'

/**
 * Result of {@link compareSkillContentHashes}.
 */
export interface ContentComparisonResult {
  /** current: hashes match. outdated: hashes differ. unknown: no comparison could be made. */
  outcome: ContentComparisonOutcome
  /**
   * Populated only when `outcome === 'unknown'` — explains why no
   * comparison could be made (missing installed hash, missing registry
   * hash, or both). Always `undefined` for `current`/`outdated`.
   */
  reason?: string
}

/**
 * Normalize a hash value: `null`/`undefined`/non-string/blank all collapse
 * to `null` so every caller's "I don't have this" shape (a missing manifest
 * field, an absent DB row, an `undefined` API response field) is handled
 * uniformly regardless of how the caller spells "nothing here."
 */
function normalizeHash(hash: string | null | undefined): string | null {
  if (typeof hash !== 'string') return null
  const trimmed = hash.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Compare an installed-side content hash against a registry-side content
 * hash and return a comparison outcome plus (when `unknown`) the reason no
 * comparison could be made.
 *
 * @param installedHash SHA-256 hex digest of what is actually installed —
 *   e.g. a manifest's recorded `contentHash`/`originalContentHash`, or a
 *   freshly-computed hash of the on-disk SKILL.md.
 * @param registryHash  SHA-256 hex digest of the registry's current SKILL.md
 *   content — e.g. a live `lookupSkillFromRegistry()` result's
 *   `contentHash`, or the most-recently-synced `skill_versions.content_hash`.
 */
export function compareSkillContentHashes(
  installedHash: string | null | undefined,
  registryHash: string | null | undefined
): ContentComparisonResult {
  const installed = normalizeHash(installedHash)
  const registry = normalizeHash(registryHash)

  if (installed === null && registry === null) {
    return {
      outcome: 'unknown',
      reason: 'No installed content hash and no registry content hash available for comparison.',
    }
  }
  if (installed === null) {
    return {
      outcome: 'unknown',
      reason: 'No installed content hash recorded — cannot compare against the registry.',
    }
  }
  if (registry === null) {
    return {
      outcome: 'unknown',
      reason: 'No registry content hash available — cannot compare against the installed skill.',
    }
  }

  return installed === registry ? { outcome: 'current' } : { outcome: 'outdated' }
}
