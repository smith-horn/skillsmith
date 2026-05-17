/**
 * Meta-list (curated link-list) detection for the skill indexer.
 *
 * SMI-4842: Repositories like `awesome-claude-skills` are README-only curated
 * lists of links to other repositories — they are NOT skills and must not be
 * indexed as such. This module provides a conservative, dependency-free
 * predicate that rejects such repos using THREE signals combined. Name match
 * alone is deliberately insufficient, so a legitimately-named skill such as
 * `awesome-foo` that ships a SKILL.md is never wrongly dropped:
 *
 *   1. The repo name matches `awesome-*` (case-insensitive prefix); AND
 *   2. The repo has no SKILL.md (the indexer already tracks SKILL.md presence
 *      via its validation step — this module never re-fetches SKILL.md); AND
 *   3. The README is dominated by external links — strictly MORE than 70% of
 *      the non-blank README lines contain a markdown link `[...](...)`.
 *
 * This file is the single source of truth for the predicate. The indexer Edge
 * Function (`supabase/functions/indexer/meta-list-filter.ts`) mirrors this
 * logic because Deno isolates cannot import Node workspace packages; the
 * mirrored copy carries a pointer back here and is covered by the same cases.
 */

/**
 * Strictly-greater-than threshold for the share of non-blank README lines that
 * must contain a markdown link before the README counts as "link-dominated".
 * A README at exactly 0.70 is NOT treated as a meta-list.
 */
export const META_LIST_LINK_RATIO_THRESHOLD = 0.7

/** Matches a `awesome-` prefix on the repo name, case-insensitive. */
const AWESOME_NAME_PREFIX = /^awesome-/i

/** Matches a markdown link `[text](url)` anywhere on a line. */
const MARKDOWN_LINK = /\[[^\]]*\]\([^)]+\)/

/**
 * Signals required to classify a repository as a meta-list. All three are
 * cheap, in-memory values the indexer already has (or can derive without an
 * extra SKILL.md fetch).
 */
export interface MetaListSignals {
  /** The GitHub repository name (not a display name from frontmatter). */
  repoName: string
  /** Whether the repo has a valid SKILL.md (the indexer's existing signal). */
  hasSkillMd: boolean
  /** Raw README markdown content (empty string if absent). */
  readme: string
}

/**
 * Compute the fraction of non-blank README lines that contain a markdown link.
 * Returns 0 for an empty/blank README so the link-dominance signal cannot fire.
 */
export function readmeLinkRatio(readme: string): number {
  const nonBlankLines = readme.split('\n').filter((line) => line.trim().length > 0)
  if (nonBlankLines.length === 0) {
    return 0
  }
  const linkLines = nonBlankLines.filter((line) => MARKDOWN_LINK.test(line)).length
  return linkLines / nonBlankLines.length
}

/**
 * Conservative predicate: is this repository a curated `awesome-*` link-list
 * rather than an actual skill?
 *
 * Returns true only when ALL THREE signals hold (see module docs). This
 * deliberately avoids excluding a real skill named `awesome-foo` that ships a
 * SKILL.md, and avoids excluding any repo whose README is mostly prose.
 */
export function isMetaListRepo(signals: MetaListSignals): boolean {
  // Signal 1: name matches the `awesome-` prefix.
  if (!AWESOME_NAME_PREFIX.test(signals.repoName)) {
    return false
  }
  // Signal 2: no SKILL.md — a real skill named `awesome-foo` keeps its SKILL.md
  // and is therefore never excluded here.
  if (signals.hasSkillMd) {
    return false
  }
  // Signal 3: README is dominated by external links (strictly above threshold).
  return readmeLinkRatio(signals.readme) > META_LIST_LINK_RATIO_THRESHOLD
}
