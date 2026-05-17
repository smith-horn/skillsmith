/**
 * Meta-list (curated link-list) detection for the skill indexer (Node port)
 * @module scripts/indexer/meta-list-filter
 *
 * SMI-4842: Node-flavored sibling of
 * `supabase/functions/indexer/meta-list-filter.ts`. Repositories like
 * `awesome-claude-skills` are README-only curated lists of links to other
 * repositories — they are NOT skills and must not be indexed as such.
 *
 * The pure predicate below MIRRORS the single source of truth at
 * `packages/core/src/indexer/meta-list-filter.ts` (which carries the unit
 * tests). The `scripts/indexer/` tree is a copy-don't-symlink Node mirror of
 * the Deno Edge Function tree (SMI-4852); like `license-filter.ts` and
 * `categorization.ts`, the shared logic is duplicated rather than imported
 * from the `@skillsmith/core` workspace package so the two indexer trees stay
 * self-contained. Parity with the Deno parent is guarded by
 * `scripts/tests/indexer/parity.test.ts`.
 *
 * Decision uses THREE signals combined — name match alone is deliberately
 * insufficient so a real skill named `awesome-foo` that ships a SKILL.md is
 * never wrongly dropped:
 *
 *   1. The repo name matches `awesome-*` (case-insensitive prefix); AND
 *   2. The repo has no SKILL.md (reuses the indexer's existing SKILL.md
 *      validation signal — this module never re-fetches SKILL.md); AND
 *   3. The README is dominated by external links — strictly MORE than 70% of
 *      the non-blank README lines contain a markdown link `[...](...)`.
 *
 * `fetchRepoReadme()` is the only network-touching export; the indexer calls
 * it ONLY after signals 1 and 2 already hold, so normal skill repos pay no
 * extra request.
 */

import { validateGitHubParams, isValidBranchName, sanitizeForLog } from './_shared/validation.ts'
import { buildGitHubHeaders } from './_shared/github-auth.ts'
import { withRateLimitTracking, type RateLimitTelemetry } from './_shared/rate-limit.ts'

/**
 * Strictly-greater-than threshold for the share of non-blank README lines that
 * must contain a markdown link before the README counts as "link-dominated".
 * A README at exactly 0.70 is NOT treated as a meta-list.
 */
export const META_LIST_LINK_RATIO_THRESHOLD = 0.7

/** Cap on the README bytes fetched for link-ratio analysis. */
const MAX_README_BYTES = 256_000

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
  /** The GitHub repository name (not the display name from frontmatter). */
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
 * Returns true only when ALL THREE signals hold (see module docs). Mirrors
 * `packages/core/src/indexer/meta-list-filter.ts::isMetaListRepo`.
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

/**
 * Fetch a repository's README markdown from raw.githubusercontent.com.
 *
 * Tries the conventional `README.md` filename. Returns an empty string when no
 * README is found or the fetch fails — callers treat that as "not a meta-list"
 * (an empty README yields a link ratio of 0). Mirrors the fetch-then-classify
 * split used by license-filter.ts (`fetchRepoLicense`).
 *
 * SMI-4852: routes the fetch through `withRateLimitTracking` so the run-level
 * `RateLimitTelemetry` accumulator captures it; `_throwOnRateLimit: false`
 * because a README fetch failure is non-fatal — the empty-string return path
 * already degrades gracefully (the repo is simply not filtered).
 *
 * Intended to be called by the indexer ONLY once the cheap name + no-SKILL.md
 * signals already hold, so normal skill repos incur no extra request.
 *
 * @param owner - Repository owner (GitHub login)
 * @param repo - Repository name
 * @param branch - Default branch name
 * @param telemetry - Run-scoped rate-limit telemetry bag (SMI-4852)
 */
export async function fetchRepoReadme(
  owner: string,
  repo: string,
  branch: string,
  telemetry: RateLimitTelemetry
): Promise<string> {
  try {
    validateGitHubParams(owner, repo)
    if (!isValidBranchName(branch)) {
      console.log(`[MetaListFilter] Invalid branch name: ${sanitizeForLog(branch)}`)
      return ''
    }

    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/README.md`
    const response = await withRateLimitTracking(telemetry, url, {
      headers: await buildGitHubHeaders(),
      _throwOnRateLimit: false,
    })
    if (!response.ok) {
      return ''
    }

    const contentLength = response.headers.get('content-length')
    const parsedContentLength = contentLength ? parseInt(contentLength, 10) : NaN
    if (!isNaN(parsedContentLength) && parsedContentLength > MAX_README_BYTES) {
      // Oversized READMEs are not link-lists in practice; skip the download.
      return ''
    }

    const text = await response.text()
    return text.length > MAX_README_BYTES ? text.slice(0, MAX_README_BYTES) : text
  } catch (error) {
    console.log(
      `[MetaListFilter] Failed to fetch README for ${owner}/${repo}: ` +
        `${error instanceof Error ? error.message : 'Unknown'}`
    )
    return ''
  }
}
