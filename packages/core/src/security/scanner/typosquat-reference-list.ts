/**
 * Typosquat reference-name list builder
 * @module @skillsmith/core/security/scanner/typosquat-reference-list
 *
 * SMI-595 §2: a name-comparison detector is only as good as its reference
 * list; a hand-maintained list goes stale the moment a new popular skill
 * ships. The reference list is built from two sources:
 *
 *  1. Every skill published by an owner in `HIGH_TRUST_OWNERS`
 *     (`packages/core/src/scripts/github-import/signal-of-intent.ts`).
 *  2. The top-N installed skills by install count (N configurable, default
 *     200) — covers popular community skills that aren't from a
 *     `HIGH_TRUST_OWNERS` publisher but are popular enough to be worth
 *     impersonating.
 *
 * Plus `BRAND_ALIASES` (`typosquat.ts` §3) — brand names not derivable from
 * either source above.
 *
 * This module is a pure builder: it accepts the two source arrays already
 * fetched by the caller (rather than querying a database or the GitHub API
 * itself), so it stays cheaply unit-testable. Wiring a *live* caller that
 * sources real `HIGH_TRUST_OWNERS`-published skill names and real
 * install-count data, refreshed on the existing metadata-refresh cadence
 * (`.claude/development/deployment-guide.md`'s "Metadata Refresh (every 4h
 * :30)" job — no new cron), is a follow-up integration point, not built out
 * this wave.
 */

import { BRAND_ALIASES } from './typosquat.js'

/** A minimal reference-skill shape: only the fields this builder needs. */
export interface ReferenceSkillEntry {
  author: string
  name: string
}

/** An installed skill together with its install count, for the top-N filter. */
export interface InstalledSkillEntry extends ReferenceSkillEntry {
  installCount: number
}

/** SMI-595 §2: default top-N cutoff for installed skills folded into the list. */
export const DEFAULT_TOP_INSTALLED_LIMIT = 200

export interface BuildTyposquatReferenceListOptions {
  /** Skills published by an owner in `HIGH_TRUST_OWNERS`. */
  highTrustOwnerSkills?: ReferenceSkillEntry[]
  /** All installed skills with a known install count; only the top N (by
   *  count, descending) are folded in. */
  installedSkills?: InstalledSkillEntry[]
  /** Max number of installed skills to fold in. Default: `DEFAULT_TOP_INSTALLED_LIMIT` (200). */
  topInstalledLimit?: number
}

/**
 * Build the lowercase reference-name set used by `scanTyposquat()`. Combines
 * HIGH_TRUST_OWNERS-published skill names, the top-N installed skills by
 * install count, and the bare brand tokens from `BRAND_ALIASES`.
 */
export function buildTyposquatReferenceList(
  options: BuildTyposquatReferenceListOptions = {}
): ReadonlySet<string> {
  const {
    highTrustOwnerSkills = [],
    installedSkills = [],
    topInstalledLimit = DEFAULT_TOP_INSTALLED_LIMIT,
  } = options

  const names = new Set<string>()

  for (const entry of highTrustOwnerSkills) {
    if (entry.name) names.add(entry.name.toLowerCase())
  }

  const topInstalled = [...installedSkills]
    .sort((a, b) => b.installCount - a.installCount)
    .slice(0, Math.max(0, topInstalledLimit))
  for (const entry of topInstalled) {
    if (entry.name) names.add(entry.name.toLowerCase())
  }

  for (const brand of Object.keys(BRAND_ALIASES)) {
    names.add(brand.toLowerCase())
  }

  return names
}
